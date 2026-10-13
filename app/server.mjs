// 도슨트 로컬 웹앱. 서버는 Node 내장 모듈, 설명 렌더러는 로컬 빌드 자산을 사용한다.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeAdapter } from "../scripts/transcript-claude.mjs";
import { ompAdapter } from "../scripts/transcript-omp.mjs";
import { codexAdapter } from "../scripts/transcript-codex.mjs";
import { geminiAdapter } from "../scripts/transcript-gemini.mjs";
import { piAdapter } from "../scripts/transcript-pi.mjs";
import { jevEnabled } from "./jev.mjs";
import { localProviders, sessionCatalog } from "./catalog.mjs";
import { glossary } from "./review.mjs";
import { KEYWORD_PROMPT, extractInput, parseExtract, wiki } from "./wiki.mjs";
import { parsePeers, peerProvider } from "./peers.mjs";
import { config, favorites, history, saveConfig, saveKeywords, setFavorite } from "./store.mjs";
import { resolveEvidence } from "./evidence.mjs";
import { modelCatalog, selectedModel } from "./models.mjs";
import { DOMAINS_PROMPT } from "./depth.mjs";
import { httpError } from "./errors.mjs";
import { PLANNING_PROMPT, createProfile, feedback, learningItems, profile, profiles, updateProfile } from "./learning.mjs";
import { displayOf, parseFocus } from "./dialogue.mjs";
import { createRunner } from "./runner.mjs";
import { createAsk } from "./ask.mjs";
import { prefetchHub } from "./prefetch.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
// 화면 하단 정보 줄에 보여 줄 버전. 설치 패키지와 저장소 모두 package.json 이 함께 온다.
const VERSION = JSON.parse(readFileSync(join(ROOT, "../package.json"), "utf8")).version;
const STATIC_ASSETS = new Map([
	["/assets/docent-markdown.js", ["assets/docent-markdown.js", "text/javascript; charset=utf-8"]],
	["/assets/docent-markdown.css", ["assets/docent-markdown.css", "text/css; charset=utf-8"]],
	["/assets/PretendardVariable.woff2", ["assets/PretendardVariable.woff2", "font/woff2", "public, max-age=604800"]],
	["/assets/Pretendard-LICENSE.txt", ["assets/Pretendard-LICENSE.txt", "text/plain; charset=utf-8"]],
	["/mobile.css", ["mobile.css", "text/css; charset=utf-8"]],
	["/mobile.mjs", ["mobile.mjs", "text/javascript; charset=utf-8"]],
	["/conversations.mjs", ["conversations.mjs", "text/javascript; charset=utf-8"]],
	["/transport.mjs", ["transport.mjs", "text/javascript; charset=utf-8"]],
	["/session-client.mjs", ["session-client.mjs", "text/javascript; charset=utf-8"]],
	["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
	["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
	["/offline.html", ["offline.html", "text/html; charset=utf-8"]],
	["/app-icon-192.png", ["assets/app-icon-192.png", "image/png"]],
	["/app-icon-512.png", ["assets/app-icon-512.png", "image/png"]],
]);
const PROMPT = resolve(ROOT, "../prompt/docent.md");
const CONFIG = await config();
const PORT = Number(process.env.DOCENT_PORT ?? CONFIG.port ?? 4747);
const HOST_INPUT = process.env.DOCENT_HOST ?? CONFIG.host ?? "127.0.0.1";
// host=tailscale 은 loopback 에 더해 테일스케일 주소에도 여는 뜻이다. 테일스케일 주소는 늦게 생길 수 있어 아래에서 따로 연다.
const HOST = HOST_INPUT === "tailscale" ? "127.0.0.1" : HOST_INPUT;
const PEERS = parsePeers(process.env.DOCENT_PEERS, CONFIG.peers);
const OMP_BIN = process.env.OMP_BIN ?? "omp";
const OMP_TIMEOUT_MS = 180_000;

const HOME = process.env.HOME ?? homedir();

/** 이 컴퓨터의 테일스케일 IPv4. 못 찾으면 null. */
async function tailscaleIp() {
	const bins = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
	for (const bin of bins) {
		const ip = await new Promise((res) => execFile(bin, ["ip", "-4"], (err, out) => res(err ? null : out.trim().split("\n")[0])));
		if (ip) return ip;
	}
	return null;
}

const TAILSCALE_RETRY_MS = [5_000, 10_000, 30_000, 60_000];

// 호스트별 세션 제공자. 새 호스트는 adapter 모듈 하나 + 여기 한 줄. 뒤에 원격 docent(peers)가 붙는다.
const catalog = sessionCatalog([
	...localProviders([ompAdapter, claudeAdapter, codexAdapter, geminiAdapter, piAdapter], { home: HOME }),
	...Object.entries(PEERS).map(([name, base]) => peerProvider(name, base)),
]);

const json = (r, code, body) => {
	r.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	r.end(JSON.stringify(body));
};

const readBody = (req) =>
	new Promise((res, rej) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				chunks.length = 0;
				rej(httpError(413, "요청 본문이 너무 커요."));
			} else chunks.push(chunk);
		});
		req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
		req.on("error", rej);
	});

const tmpRoot = await mkdtemp(join(tmpdir(), "docent-"));
const plannerPrompt = join(tmpRoot, "learning-planner.txt");
await writeFile(plannerPrompt, PLANNING_PROMPT);
const keywordPrompt = join(tmpRoot, "keyword-extractor.txt");
await writeFile(keywordPrompt, KEYWORD_PROMPT);
const domainsPrompt = join(tmpRoot, "domain-classifier.txt");
await writeFile(domainsPrompt, DOMAINS_PROMPT);
const runner = await createRunner({ bin: OMP_BIN, tmpRoot, timeoutMs: OMP_TIMEOUT_MS });
const extracting = new Map();
const asks = createAsk({
	runner,
	providerOf: catalog.providerOf,
	prompts: { docent: PROMPT, planner: plannerPrompt, domains: domainsPrompt },
	notify: (sessionId, profileId, payload) => hub.notify(sessionId, profileId, payload),
});

/** 아직 단어를 뽑지 않은 문답을 모델 호출 한 번으로 정리한다. 같은 프로필의 동시 요청은 하나로 합친다. */
function extractKeywords(profileId) {
	if (extracting.has(profileId)) return extracting.get(profileId);
	const job = (async () => {
		const current = await profile(profileId);
		const { ids, input } = extractInput(await history(undefined, profileId));
		if (!ids.length) return { updated: 0 };
		const model = await selectedModel(current.model);
		let byId;
		try {
			byId = parseExtract(await runner.once({ system: keywordPrompt, input, task: "위 문답 목록에서 용어를 뽑아 형식대로 출력한다.", model }), ids);
		} catch (error) {
			if (error.status) throw error;
			throw httpError(502, "용어 추출 결과를 읽지 못했어요. 다시 시도해 주세요.");
		}
		return { updated: await saveKeywords(profileId, byId) };
	})();
	extracting.set(profileId, job);
	job.finally(() => extracting.delete(profileId)).catch(() => {});
	return job;
}

async function body(req) {
	let value;
	try {
		value = JSON.parse(await readBody(req));
	} catch (error) {
		if (error.status) throw error;
		throw httpError(400, "JSON 요청 본문이 올바르지 않아요.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "JSON 객체가 필요해요.");
	return value;
}

const hub = prefetchHub({
	watch: catalog.watch,
	profile,
	startJob: asks.open,
	hasJob: asks.has,
	waiting: asks.waiting,
});

const NDJSON = "application/x-ndjson";

async function respondAsk(req, res, input) {
	const opened = await asks.open(input);
	const stream = (req.headers.accept ?? "").includes(NDJSON);
	const failure = (error) => ({ type: error.cancelled ? "cancelled" : "error", ...(error.cancelled ? {} : { status: error.status ?? 500, error: String(error.message ?? error) }) });
	if (!opened.subscribe) {
		if (stream) {
			res.writeHead(200, { "content-type": `${NDJSON}; charset=utf-8`, "cache-control": "no-store" });
			return res.end(`${JSON.stringify(opened.answer ? { type: "answer", answer: opened.answer } : failure(opened.error))}\n`);
		}
		if (opened.answer) return json(res, 200, opened.answer);
		return json(res, opened.error.status ?? 500, { error: opened.error.message, ...(opened.error.cancelled ? { cancelled: true } : {}) });
	}
	if (!stream) {
		try {
			return json(res, 200, await opened.done);
		} catch (error) {
			return json(res, error.status ?? 500, { error: String(error.message ?? error), ...(error.cancelled ? { cancelled: true } : {}) });
		}
	}
	res.writeHead(200, { "content-type": `${NDJSON}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
	// 연결이 끊겨도 작업은 계속한다. 같은 요청으로 다시 붙을 수 있다.
	const stop = opened.subscribe((line) => {
		if (res.writableEnded) return;
		res.write(`${JSON.stringify(line)}\n`);
		if (["answer", "error", "cancelled"].includes(line.type)) res.end();
	});
	req.on("close", stop);
	res.on("close", stop);
}

async function evidenceFor(sessionId, ref, profileId) {
	if (!sessionId || typeof ref !== "string" || !/^s_[a-f0-9]{40}$/.test(ref)) throw httpError(400, "유효한 세션과 근거 ID가 필요해요.");
	const rows = await history(sessionId, profileId);
	const saved = rows.flatMap((row) => row.answer?.citations ?? []).find((citation) => citation.id === ref && citation.sessionId === sessionId);
	if (!saved) throw httpError(404, "이 프로필이 저장한 근거를 찾을 수 없어요.");
	try {
		const result = resolveEvidence(await catalog.transcript(sessionId), sessionId, ref);
		if (result.available) return result;
	} catch {
		// 원격 오프라인·원본 삭제도 저장된 근거와 구분해서 보여 준다.
	}
	return { available: false, message: "원본 전사가 없거나 변경되어 원문을 열 수 없어요. 아래는 이 프로필의 답변에 저장된 당시 발췌예요.", selected: { id: saved.id, text: saved.excerpt, role: saved.role, timestamp: saved.timestamp, agent: saved.agent }, before: [], after: [] };
}

const handler = async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	// Personal records must never enter browser/proxy caches, including PWA use.
	if (url.pathname.startsWith("/api/")) res.setHeader("cache-control", "no-store");
	try {
		if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { app: "vibecoder-docent", version: VERSION, pid: process.pid });
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			// 화면의 버전 표시 칸을 package.json 버전으로 채운다.
			return res.end((await readFile(join(ROOT, "index.html"), "utf8")).replaceAll("__DOCENT_VERSION__", VERSION));
		}
		if (req.method === "GET" && url.pathname === "/favicon.svg") {
			res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-cache" });
			return res.end(await readFile(join(ROOT, "favicon.svg")));
		}
		const asset = STATIC_ASSETS.get(url.pathname);
		if (req.method === "GET" && asset) {
			const content = await readFile(join(ROOT, asset[0]));
			res.writeHead(200, { "content-type": asset[1], "cache-control": asset[2] ?? "no-cache", "x-content-type-options": "nosniff" });
			return res.end(content);
		}
		if (req.method === "GET" && url.pathname === "/api/host") return json(res, 200, hostStatus());
		if (req.method === "POST" && url.pathname === "/api/host") {
			const input = await body(req);
			if (typeof input.tailscale !== "boolean") throw httpError(400, "tailscale 는 참/거짓이어야 해요.");
			return json(res, 200, await setTailscaleShare(input.tailscale));
		}
		if (req.method === "GET" && url.pathname === "/api/models") return json(res, 200, await modelCatalog());
		if (req.method === "GET" && url.pathname === "/api/profiles") return json(res, 200, await profiles());
		if (req.method === "POST" && url.pathname === "/api/profiles") return json(res, 201, await createProfile((await body(req)).name));
		const profileRoute = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
		if (req.method === "PATCH" && profileRoute) return json(res, 200, await updateProfile(decodeURIComponent(profileRoute[1]), await body(req)));
		if (req.method === "GET" && url.pathname === "/api/learning") return json(res, 200, { items: await learningItems(url.searchParams.get("profileId") ?? "default") });
		const learningRoute = /^\/api\/learning\/([^/]+)$/.exec(url.pathname);
		if (req.method === "PATCH" && learningRoute) {
			const input = await body(req);
			return json(res, 200, await feedback(decodeURIComponent(learningRoute[1]), input.profileId ?? "default", input.status, input.unresolved));
		}
		if (req.method === "GET" && url.pathname === "/api/evidence") {
			return json(res, 200, await evidenceFor(url.searchParams.get("id"), url.searchParams.get("ref"), url.searchParams.get("profileId") ?? "default"));
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") return json(res, 200, await catalog.list());
		// 에이전트가 자기 세션 파일 경로를 알려 주면 도슨트 세션 id 로 바꾼다 (docent herdr, ADR 0044). 목록에 없는 파일·빈 파일은 404, 호출자는 폴더 기준 최근 세션으로 넘어간다.
		if (req.method === "GET" && url.pathname === "/api/sessions/resolve") return json(res, 200, { id: await catalog.resolve(url.searchParams.get("path") ?? "") });
		if (req.method === "GET" && url.pathname === "/api/transcript") {
			const id = url.searchParams.get("id") ?? "";
			const md = await catalog.transcript(id);
			res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
			return res.end(md);
		}
		if (req.method === "GET" && url.pathname === "/api/history") {
			const id = url.searchParams.get("id") || undefined;
			// 원격의 같은 이름/ID는 같은 사람이라는 증거가 아니다. 여기서 선택한 프로필의 기록만 읽는다.
			return json(res, 200, (await history(id, url.searchParams.get("profileId") ?? "default")).map((row) => (displayOf(row.question) ? { ...row, display: displayOf(row.question) } : row)));
		}
		if (req.method === "GET" && url.pathname === "/api/glossary") return json(res, 200, glossary(await history(undefined, url.searchParams.get("profileId") ?? "default")));
		if (req.method === "GET" && url.pathname === "/api/favorites") return json(res, 200, await favorites(url.searchParams.get("profileId") ?? "default", url.searchParams.get("id") || undefined));
		if (req.method === "POST" && url.pathname === "/api/favorites") {
			const input = await body(req);
			if (typeof input.id !== "string" || !input.id || input.id.length > 2048 || typeof input.favorite !== "boolean") throw httpError(400, "세션 id와 즐겨찾기 여부가 필요해요.");
			return json(res, 200, await setFavorite(input.profileId ?? "default", input.id, parseFocus(input.focus), input.favorite));
		}
		if (req.method === "GET" && url.pathname === "/api/wiki") return json(res, 200, wiki(await history(undefined, url.searchParams.get("profileId") ?? "default")));
		if (req.method === "POST" && url.pathname === "/api/wiki/extract") {
			const profileId = (await body(req)).profileId ?? "default";
			return json(res, 200, await extractKeywords(profileId));
		}
		if (req.method === "GET" && url.pathname === "/api/live") {
			const id = url.searchParams.get("id") ?? "";
			const profileId = url.searchParams.get("profileId");
			// 모르는 세션 id, 잘못된 id 는 스트림을 열기 전에 400 으로 답한다.
			catalog.providerOf(id);
			if (profileId) await profile(profileId);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			res.write(`: jev=${jevEnabled}\n\n`);
			const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
			// 프로필 없이 여는 구독(다른 컴퓨터의 docent)은 미리 설명을 예약하지 않는다.
			const stop = profileId ? hub.subscribe({ sessionId: id, profileId, send }) : catalog.watch(id, send);
			const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
			req.on("close", () => {
				stop();
				clearInterval(ping);
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask") return await respondAsk(req, res, await body(req));
		if (req.method === "POST" && url.pathname === "/api/ask/cancel") return json(res, 200, { cancelled: await asks.cancel(await body(req)) });
		if (req.method === "POST" && url.pathname === "/api/ask/steer") {
			await asks.steer(await body(req));
			return json(res, 200, { steered: true });
		}
		if (req.method === "GET" && url.pathname === "/api/jobs") return json(res, 200, await asks.list(url.searchParams.get("profileId") ?? "default", url.searchParams.get("id") ?? ""));
		if (req.method === "GET" && url.pathname === "/api/prefetch") {
			const profileId = url.searchParams.get("profileId") ?? "default";
			const current = await profile(profileId);
			return json(res, 200, { enabled: current.autoExplain, ...hub.status(profileId) });
		}
		json(res, 404, { error: "not found" });
	} catch (e) {
		json(res, e.status ?? (e.code === "ENOENT" ? 404 : e instanceof URIError ? 400 : 500), { error: String(e.message ?? e) });
	}
};

// 테일스케일 등 다른 주소에 열어도 이 컴퓨터의 `docent` 명령이 127.0.0.1 로 살아 있는지 확인하므로 loopback 은 항상 연다.
const listeners = new Map();
const tsShare = { on: false, ip: null };

function listenOn(h) {
	return new Promise((res, rej) => {
		const server = createServer(handler);
		server.once("error", rej);
		server.listen(PORT, h, () => {
			listeners.set(h, server);
			const peers = Object.keys(PEERS);
			console.log(`docent: http://${h}:${PORT}/  (prompt: ${PROMPT}, jev: ${jevEnabled ? "on" : "off"}${peers.length ? `, peers: ${peers.join(" ")}` : ""})`);
			res(server);
		});
	});
}

const hostStatus = () => ({ tailscale: tsShare.on, url: tsShare.on && tsShare.ip ? `http://${tsShare.ip}:${PORT}/` : null });

/** 설정창에서 켜는 테일스케일 추가 대기. loopback 은 건드리지 않는다. */
async function openTailscaleListener() {
	if (tsShare.on) return hostStatus();
	const ip = await tailscaleIp();
	if (!ip) throw httpError(503, "테일스케일 주소를 찾지 못했어요. Tailscale 이 켜져 있는지 확인하세요.");
	if (!listeners.has(ip)) await listenOn(ip);
	tsShare.on = true;
	tsShare.ip = ip;
	console.log(`docent: 테일스케일 공유를 켰어요 (${tsShare.ip})`);
	return hostStatus();
}

async function closeTailscaleListener() {
	const server = tsShare.ip ? listeners.get(tsShare.ip) : null;
	if (server) {
		listeners.delete(tsShare.ip);
		server.closeAllConnections?.();
		await new Promise((res) => server.close(res));
	}
	tsShare.on = false;
	tsShare.ip = null;
	console.log("docent: 테일스케일 공유를 껐어요");
	return hostStatus();
}

/**
 * 시작할 때 테일스케일 공유를 연다. 부팅 직후처럼 Tailscale 이 아직 주소를 받지 못했거나 그 주소에 열 수 없으면
 * 서버를 끄지 않고 점점 간격을 늘려 다시 시도한다. loopback 은 그동안에도 응답한다. 설정창에서 끄면 멈춘다.
 */
const tsRetry = { timer: null, attempt: 0 };
function keepOpeningTailscale() {
	clearTimeout(tsRetry.timer);
	tsRetry.timer = null;
	openTailscaleListener().then(() => { tsRetry.attempt = 0; }, (error) => {
		const wait = TAILSCALE_RETRY_MS[Math.min(tsRetry.attempt, TAILSCALE_RETRY_MS.length - 1)];
		if (tsRetry.attempt === 0) console.error(`docent: 테일스케일 공유를 아직 열 수 없어요. ${wait / 1000}초 뒤부터 다시 시도해요 (${error.message})`);
		tsRetry.attempt++;
		tsRetry.timer = setTimeout(keepOpeningTailscale, wait);
		tsRetry.timer.unref();
	});
}

/** 켜고 끈 상태는 config.json 의 tailscale 에 저장해 재시작 뒤에도 유지한다. 옛 host=tailscale 설정은 여기로 옮겨 둔다. */
async function setTailscaleShare(on) {
	clearTimeout(tsRetry.timer);
	tsRetry.timer = null;
	tsRetry.attempt = 0;
	if (on) await openTailscaleListener();
	else await closeTailscaleListener();
	CONFIG.tailscale = on;
	const legacy = !process.env.DOCENT_HOST && CONFIG.host === "tailscale";
	if (legacy) CONFIG.host = "127.0.0.1";
	await saveConfig({ tailscale: on, ...(legacy ? { host: "127.0.0.1" } : {}) });
	return hostStatus();
}

const baseHosts = HOST === "127.0.0.1" ? [HOST] : [...new Set([HOST, "127.0.0.1"])];
for (const h of baseHosts) {
	listenOn(h).then(() => {
		// Windows 의 start 는 명령이 아니라 cmd 의 내장 명령이므로 cmd 로 부른다.
		const openers = { darwin: ["open"], win32: ["cmd", "/c", "start", ""], linux: ["xdg-open"] };
		const opener = openers[process.platform];
		if (h === "127.0.0.1" && process.env.DOCENT_ON_LISTEN === "open" && opener) {
			execFile(opener[0], [...opener.slice(1), `http://${h}:${PORT}/`], () => {});
		}
	}, (error) => {
		console.error(`docent: ${h}:${PORT} 을 열 수 없어요 (${error.message})`);
		process.exit(1);
	});
}
// 옛 host=tailscale 설정이나 설정창에서 켜 둔 공유(tailscale 참)는 loopback 과 따로 연다. 실패해도 loopback 은 살아 있다.
if (HOST_INPUT === "tailscale" || CONFIG.tailscale === true) keepOpeningTailscale();

// 앱이 소유한 서버를 종료할 때 설명과 뒤늦은 학습 분류 프로세스도 함께 끝낸다.
let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	for (const server of listeners.values()) server.close();
	// 작업을 먼저 중단해야 요청이 실패가 아니라 중단으로 남는다.
	const stopped = asks.close();
	await Promise.allSettled([runner.close(), stopped]);
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
