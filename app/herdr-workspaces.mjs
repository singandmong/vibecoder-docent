// Herdr 작업 공간 이름과 순서 (ADR 0060). 세션 파일이 Herdr 의 어느 작업 공간(사이드바 번호, 사용자가 붙인 이름)의 어느 창에 열려 있는지 알려 준다.
// `herdr agent list` 가 창마다 에이전트가 연 세션 파일 경로를, `herdr workspace list` 가 작업 공간 이름과 번호를 준다.
// 서버는 launchd 처럼 HERDR_* 환경변수와 최소 PATH 로 돌 수 있어 환경변수에 기대지 않는다. herdr 는 PATH 에서 찾고, 없으면 ~/.local/bin/herdr 를 쓴다.
// herdr 가 없거나, 실패하거나, 오래 걸리면 정보 없음으로 둔다. 세션 목록은 그대로 나가야 한다.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HERDR_CACHE_MS = 3000;
export const HERDR_TIMEOUT_MS = 1500;

const MAX_OUTPUT = 8 * 1024 * 1024;

const run = (bin, args, timeoutMs) => new Promise((resolveRun, reject) => {
	const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolveRun(String(stdout))));
	child.stdin?.end();
});

/** 기본 실행기: PATH 의 herdr, 없으면 ~/.local/bin/herdr. 한 번 돌아간 명령은 기억한다. */
export function defaultHerdrExec({ home = homedir(), timeoutMs = HERDR_TIMEOUT_MS } = {}) {
	const candidates = ["herdr", join(home, ".local", "bin", "herdr")];
	let found = null;
	return async (args) => {
		if (found) return run(found, args, timeoutMs);
		let last;
		for (const bin of candidates) {
			try {
				const out = await run(bin, args, timeoutMs);
				found = bin;
				return out;
			} catch (error) {
				last = error;
				if (error?.code !== "ENOENT") throw error;
			}
		}
		throw last;
	};
}

const paneNumber = (pane) => {
	const match = /:p(\d+)$/.exec(String(pane ?? ""));
	return match ? Number(match[1]) : Number.NaN;
};

/** 두 명령의 JSON 을 세션 파일 경로 → `{ workspace, label, number, pane }` 로. 모양이 다른 항목은 건너뛴다. */
export function mapSessions(agentsJson, workspacesJson) {
	const workspaces = new Map();
	for (const w of workspacesJson?.result?.workspaces ?? []) {
		if (typeof w?.workspace_id === "string" && Number.isFinite(w.number)) workspaces.set(w.workspace_id, w);
	}
	const found = new Map();
	for (const agent of agentsJson?.result?.agents ?? []) {
		const session = agent?.agent_session;
		if (session?.kind !== "path" || typeof session.value !== "string" || !session.value) continue;
		const pane = typeof agent.pane_id === "string" ? agent.pane_id : "";
		const workspace = pane.includes(":") ? pane.slice(0, pane.indexOf(":")) : agent.workspace_id;
		const meta = workspaces.get(workspace);
		if (!meta) continue;
		const label = typeof meta.label === "string" ? meta.label.trim() : "";
		const entry = { workspace, label: label || `작업 공간 ${meta.number}`, number: meta.number, pane };
		const key = resolve(session.value);
		const same = found.get(key);
		// 같은 세션이 두 창에 열려 있으면 사이드바에서 더 앞의 창을 보인다.
		if (!same || entry.number < same.number || (entry.number === same.number && paneNumber(entry.pane) < paneNumber(same.pane))) found.set(key, entry);
	}
	return found;
}

/**
 * `sessions()` → Promise<Map<세션 파일 절대 경로, {workspace, label, number, pane}>>. 실패하면 빈 Map.
 * 결과(실패 포함)는 `ttlMs` 동안 기억하고, 그 사이 동시에 부른 쪽은 같은 조회를 기다린다.
 * `exec(args)` 는 herdr 의 표준 출력 문자열, `now()` 는 밀리초: 시험이 가짜를 넘긴다.
 */
export function herdrWorkspaces({ exec = defaultHerdrExec(), now = Date.now, ttlMs = HERDR_CACHE_MS } = {}) {
	let cached = null;
	const read = async () => {
		try {
			const [agents, workspaces] = await Promise.all([exec(["agent", "list"]), exec(["workspace", "list"])]);
			return mapSessions(JSON.parse(agents), JSON.parse(workspaces));
		} catch {
			return new Map();
		}
	};
	return {
		sessions() {
			if (!cached || now() - cached.at >= ttlMs) {
				cached = { at: now(), value: read() };
			}
			return cached.value;
		},
	};
}

/** 목록 순서의 칸 번호: 작업 공간 번호와 창 번호. 숫자가 아니면 null (정렬에서 제외). */
export function herdrRank(herdr) {
	if (!herdr || !Number.isFinite(herdr.number)) return null;
	const pane = paneNumber(herdr.pane);
	return { number: herdr.number, pane: Number.isFinite(pane) ? pane : Number.MAX_SAFE_INTEGER };
}

/**
 * 목록 정렬 비교: Herdr 에 열린 이 컴퓨터의 세션(작업 공간 번호, 창 번호), 다른 컴퓨터의 Herdr 세션(컴퓨터별로 묶어 같은 규칙),
 * 나머지 순. 같은 칸이면 최근 활동이 먼저. `hostOrder(host)` 는 다른 컴퓨터의 제공자 순서(0부터).
 */
export function compareSessions(a, b, hostOrder = () => 0) {
	const rank = (s) => {
		const r = herdrRank(s.herdr);
		return r && [s.host ? 1 + hostOrder(s.host) : 0, r.number, r.pane];
	};
	const ra = rank(a);
	const rb = rank(b);
	if (ra && !rb) return -1;
	if (!ra && rb) return 1;
	if (ra && rb) {
		for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
	}
	return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0;
}
