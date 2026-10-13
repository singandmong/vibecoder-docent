// `docent doctor`: 설치 상태를 한 번에 점검한다. 사람과 설치 에이전트가 같은 결과를 읽는다 (ADR 0041).
// 모델 호출은 --probe 를 줄 때만 한 번 한다. 비밀값은 있는지 여부만 보고 값은 읽거나 출력하지 않는다.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ompCommand } from "./omp-bin.mjs";

export const MIN_NODE = "22.19.0";

const newer = (version, minimum) => {
	const a = String(version).replace(/^v/, "").split(".").map(Number);
	const b = minimum.split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
	return true;
};

const run = (bin, args, timeout) => new Promise((resolveRun) => {
	const target = ompCommand(bin, args);
	const child = execFile(target.command, target.args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TERM: "dumb" } }, (error, stdout) => resolveRun(error ? null : String(stdout)));
	child.stdin?.end();
});

async function packageVersion() {
	const file = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
	return JSON.parse(await readFile(file, "utf8")).version;
}

async function server(port) {
	const url = `http://127.0.0.1:${port}/`;
	const health = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(3000) }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
	const list = await fetch(`${url}api/sessions`, { signal: AbortSignal.timeout(15000) }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
	// 0.17 이전 서버에는 /api/health 가 없다. docent 명령과 같은 기준(/api/sessions 응답)으로 켜져 있음을 판단한다.
	if (health?.app !== "vibecoder-docent" && !Array.isArray(list)) return { running: false, url };
	const sessions = {};
	for (const session of Array.isArray(list) ? list : []) sessions[session.provider || "unknown"] = (sessions[session.provider || "unknown"] ?? 0) + 1;
	return { running: true, url, version: health?.app === "vibecoder-docent" ? health.version : null, sessions };
}

/** 모델 한 번 호출로 omp 로그인과 기본 모델 연결을 확인한다. 도슨트와 같은 격리 실행 정책을 쓴다. */
async function probe(bin) {
	const tmpRoot = await mkdtemp(join(tmpdir(), "docent-doctor-"));
	const started = Date.now();
	try {
		const { createRunner } = await import("./runner.mjs");
		const runner = await createRunner({ bin, tmpRoot, timeoutMs: 90_000 });
		try {
			await runner.once({ system: "Reply with the single word OK.", task: "OK" });
			return { ok: true, ms: Date.now() - started };
		} finally {
			await runner.close();
		}
	} catch (error) {
		return { ok: false, error: String(error?.message || error) };
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

/**
 * @param {{ port: number, probe?: boolean, env?: NodeJS.ProcessEnv }} options
 */
export async function diagnose({ port, probe: wantProbe = false, env = process.env }) {
	const bin = env.OMP_BIN ?? "omp";
	const ompVersion = await run(bin, ["--version"], 15_000);
	const catalog = ompVersion ? await run(bin, ["models", "--json"], 30_000) : null;
	let models = null;
	try { models = catalog ? JSON.parse(catalog).models.filter((model) => model?.kind === "chat").length : null; } catch { models = null; }
	const report = {
		docent: { version: await packageVersion() },
		node: { version: process.versions.node, required: MIN_NODE, ok: newer(process.versions.node, MIN_NODE) },
		omp: { found: Boolean(ompVersion), version: ompVersion?.trim().split("\n")[0] ?? null, chatModels: models },
		server: await server(port),
		probe: wantProbe && ompVersion ? await probe(bin) : null,
		jev: { configured: Boolean(env.TYPESAFE_API_KEY) },
	};
	const next = [];
	if (!report.node.ok) next.push(`Node.js ${MIN_NODE} 이상으로 올리세요. 지금은 ${report.node.version}이에요.`);
	if (!report.omp.found) next.push("omp를 설치하세요 (https://omp.sh). 설치 뒤 omp를 한 번 실행해 로그인하세요.");
	else if (!report.omp.chatModels) next.push("omp 모델 목록을 읽지 못했어요. omp를 실행해 로그인과 모델 공급자 설정을 마치세요.");
	if (report.probe && !report.probe.ok) next.push("omp로 모델을 부르지 못했어요. omp를 실행해 로그인했는지, 기본 모델이 쓸 수 있는지 확인하세요.");
	if (!report.server.running) next.push(`도슨트 서버가 꺼져 있어요. docent --no-open 으로 켜세요 (주소 ${report.server.url}).`);
	else {
		if (report.server.version !== report.docent.version) next.push(`켜져 있는 서버가 설치한 도슨트와 다른 버전(${report.server.version ?? "0.17 이전"})이에요. 켜 둔 docent를 끄고 docent --no-open 으로 다시 켜세요.`);
		if (!Object.keys(report.server.sessions).length) next.push("읽을 수 있는 세션이 아직 없어요. omp, Claude Code, Codex, Gemini CLI, pi 중 하나로 작업을 한 번 시작하세요.");
	}
	report.ok = report.node.ok && report.omp.found && Boolean(report.omp.chatModels) && (report.probe ? report.probe.ok : true);
	report.next = next;
	return report;
}

export function formatReport(report) {
	const mark = (ok) => (ok ? "[ok]" : "[!!]");
	const lines = [
		`도슨트 ${report.docent.version} 점검`,
		`${mark(report.node.ok)} Node.js ${report.node.version} (필요 ${report.node.required} 이상)`,
		`${mark(report.omp.found)} omp ${report.omp.version ?? "없음"}`,
		`${mark(Boolean(report.omp.chatModels))} omp 채팅 모델 ${report.omp.chatModels ? `${report.omp.chatModels}개` : "확인 못 함"}`,
	];
	if (report.probe) lines.push(`${mark(report.probe.ok)} 모델 호출 ${report.probe.ok ? `성공 (${Math.round(report.probe.ms / 100) / 10}초)` : "실패"}`);
	else lines.push("[--] 모델 호출은 확인하지 않았어요. docent doctor --probe 로 한 번 확인할 수 있어요.");
	const sessions = Object.entries(report.server.sessions ?? {}).map(([provider, count]) => `${provider} ${count}`).join(", ");
	lines.push(report.server.running
		? `[ok] 서버 ${report.server.url} (${report.server.version ? `v${report.server.version}` : "0.17 이전 버전"}), 세션 ${sessions || "없음"}`
		: `[--] 서버 꺼짐 (${report.server.url})`);
	lines.push(`[--] Jev 자동 선별 키 ${report.jev.configured ? "있음" : "없음 (선택 사항)"}, 이 셸의 환경변수 기준`);
	if (report.next.length) lines.push("", "다음에 할 일:", ...report.next.map((step) => `- ${step}`));
	else lines.push("", "준비됐어요. docent 를 실행하면 브라우저가 열려요.");
	return lines.join("\n");
}
