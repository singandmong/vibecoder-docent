// 새 버전 확인과 설치 (ADR 0072). 웹, 터미널, `docent update` 가 같이 쓴다.
// 새 버전은 GitHub Release 의 `vibecoder-docent-<버전>.tgz` 한 곳에서만 받는다. GitHub 가 알려 준 sha256 과 맞지 않으면 설치하지 않는다.
// 설치는 이 서버를 설치한 npm 전역 위치(prefix)에 `npm install -g` 로 한다. 저장소 실행과 macOS 앱의 묶음 서버는 건드리지 않는다.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { httpError } from "./errors.mjs";

const REPO = "singandmong/vibecoder-docent";
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** 시험에서만 쓰는 릴리스 주소 바꾸기(DOCENT_UPDATE_API). 바꾸면 내려받는 주소 검사도 건너뛴다. 서버와 `docent update` 가 같은 값을 쓴다. */
const releaseApi = () => process.env.DOCENT_UPDATE_API || RELEASE_API;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCENT_BIN = join(PACKAGE_ROOT, "bin", "docent.mjs");
const CHECK_CACHE_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 180_000;

/** "v1.2.3" 또는 "1.2.3" 을 [1, 2, 3] 으로. 시험판(1.2.3-rc.1)이나 다른 모양은 null. */
export function parseVersion(text) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? "").trim());
	return match ? match.slice(1).map(Number) : null;
}

/** latest 가 current 보다 새 버전인가. 읽을 수 없으면 거짓. */
export function isNewer(latest, current) {
	const a = parseVersion(latest), b = parseVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

const cache = { at: 0, key: "", value: null };

/**
 * 가장 새 정식 릴리스를 확인한다.
 * @param {{ current: string, fetchImpl?: typeof fetch, api?: string, trustAnyUrl?: boolean, fresh?: boolean }} options
 * @returns {Promise<{ current: string, latest: string, available: boolean, installable: boolean, reason?: string, url?: string, sha256?: string, publishedAt?: string }>}
 * installable 은 받을 곳이 이 저장소의 릴리스이고 sha256 이 있을 때만 참이다.
 */
export async function checkLatest({ current, fetchImpl = fetch, api = releaseApi(), trustAnyUrl = api !== RELEASE_API, fresh = false }) {
	const key = `${api}|${current}`;
	if (!fresh && cache.key === key && Date.now() - cache.at < CHECK_CACHE_MS) return cache.value;
	let response;
	try {
		response = await fetchImpl(api, { headers: { accept: "application/vnd.github+json", "user-agent": "vibecoder-docent" }, signal: AbortSignal.timeout(10_000) });
	} catch (error) {
		throw httpError(502, `새 버전을 확인하지 못했어요. 인터넷 연결을 확인하세요 (${error?.cause?.code || error?.message || "연결 실패"}).`);
	}
	if (!response.ok) throw httpError(502, `새 버전을 확인하지 못했어요 (GitHub HTTP ${response.status}).`);
	const release = await response.json().catch(() => null);
	const latest = parseVersion(release?.tag_name) ? String(release.tag_name).replace(/^v/, "") : null;
	if (!latest || release.draft || release.prerelease) throw httpError(502, "GitHub 에서 읽을 수 있는 정식 릴리스를 찾지 못했어요.");
	const available = isNewer(latest, current);
	const asset = (release.assets ?? []).find((entry) => entry?.name === `vibecoder-docent-${latest}.tgz`);
	const sha256 = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? "")?.[1]?.toLowerCase();
	const url = asset?.browser_download_url;
	let reason;
	if (available && !asset) reason = "릴리스에 설치 파일이 없어요.";
	else if (available && !sha256) reason = "릴리스 파일의 sha256 을 확인할 수 없어 설치하지 않아요.";
	else if (available && !trustAnyUrl && !String(url).startsWith(DOWNLOAD_PREFIX)) reason = "릴리스 파일 주소가 이 프로젝트의 것이 아니에요.";
	const value = { current, latest, available, installable: available && !reason, ...(reason ? { reason } : {}), ...(available && !reason ? { url, sha256 } : {}), publishedAt: release.published_at };
	Object.assign(cache, { at: Date.now(), key, value });
	return value;
}

/**
 * 이 패키지가 npm 전역으로 설치된 곳의 prefix. 저장소에서 실행하거나 앱에 묶여 있으면 null.
 * POSIX 는 `<prefix>/lib/node_modules/vibecoder-docent`, Windows 는 `<prefix>\node_modules\vibecoder-docent`.
 */
export async function installPrefix(root = PACKAGE_ROOT) {
	let real;
	try { real = await realpath(root); } catch { return null; }
	const modules = dirname(real);
	if (basename(real) !== "vibecoder-docent" || basename(modules) !== "node_modules") return null;
	const above = dirname(modules);
	if (process.platform === "win32") return above;
	return basename(above) === "lib" ? dirname(above) : null;
}

const npmInstall = (args) => new Promise((done, fail) => {
	execFile("npm", args, { timeout: INSTALL_TIMEOUT_MS, shell: process.platform === "win32", env: process.env }, (error, _stdout, stderr) => {
		if (error) fail(new Error(String(stderr || error.message).trim().split("\n").slice(-3).join(" ")));
		else done();
	});
});

/**
 * 릴리스 파일을 받아 sha256 을 확인하고 전역 prefix 에 설치한다. 확인이 어긋나면 설치하지 않는다.
 * 설치 스크립트는 실행하지 않는다(--ignore-scripts).
 * @param {{ url: string, sha256: string, prefix: string, fetchImpl?: typeof fetch, run?: (args: string[]) => Promise<void> }} options
 */
export async function installRelease({ url, sha256, prefix, fetchImpl = fetch, run = npmInstall }) {
	let bytes;
	try {
		const response = await fetchImpl(url, { headers: { "user-agent": "vibecoder-docent" }, signal: AbortSignal.timeout(60_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw httpError(502, `새 버전을 내려받지 못했어요 (${error?.message || "연결 실패"}).`);
	}
	if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw httpError(502, "내려받은 파일이 GitHub 가 알려 준 sha256 과 달라요. 설치하지 않았어요.");
	const dir = await mkdtemp(join(tmpdir(), "docent-update-"));
	try {
		const file = join(dir, basename(new URL(url).pathname));
		await writeFile(file, bytes);
		await run(["install", "-g", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", file]);
	} catch (error) {
		throw httpError(500, `설치하지 못했어요: ${error.message}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** launchd 나 systemd 같은 서비스 관리자가 이 프로세스를 다시 띄워 주는가. */
export const supervised = (env = process.env) => Boolean((env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0") || env.INVOCATION_ID);

/**
 * 이 서버가 곧 끝난 뒤 새 파일로 다시 켜지게 한다. 관리자가 있으면 그쪽에 맡기고, 없으면 떨어진 프로세스가 포트가 비기를 기다려 `docent start` 를 한다.
 * 호출한 쪽이 이어서 프로세스를 끝내야 한다.
 * @returns {"supervisor" | "respawn"}
 */
export function scheduleRestart({ port, env = process.env }) {
	if (supervised(env)) return "supervisor";
	const script = `setTimeout(() => { require("node:child_process").spawn(process.execPath, [${JSON.stringify(DOCENT_BIN)}, "start", "--port", ${JSON.stringify(String(port))}], { detached: true, stdio: "ignore", env: process.env }).unref(); }, 2500);`;
	spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", env }).unref();
	return "respawn";
}
