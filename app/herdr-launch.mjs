// `docent herdr`: 지금 Herdr 창 오른쪽에 도슨트 터미널을 띄운다 (ADR 0044). OMP `/docent` 도 이 명령을 부른다.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server-process.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TUI_BIN = resolve(here, "../bin/docent-tui.mjs");

const herdr = (bin, args) => new Promise((resolveRun, reject) => {
	execFile(bin, args, { timeout: 10_000 }, (error, stdout) => (error ? reject(new Error(`herdr ${args.slice(0, 2).join(" ")} 실패: ${error.message}`)) : resolveRun(String(stdout))));
});

/** POSIX 셸 한 단어로 감싼다. herdr pane run 은 명령 문자열을 그 창의 셸로 실행한다. */
export const shellWord = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

const getJson = (url, ms = 3000) => fetch(url, { signal: AbortSignal.timeout(ms) }).then((response) => (response.ok ? response.json() : null)).catch(() => null);

/** 세션 파일 경로 > 명시한 id > 이 폴더의 가장 최근 세션 순으로 고른다. 못 고르면 null (목록에서 고른다). */
async function pickSession(base, { session, sessionFile, cwd }) {
	if (sessionFile) {
		const found = await getJson(`${base}/api/sessions/resolve?path=${encodeURIComponent(resolve(sessionFile))}`);
		if (found?.id) return found.id;
	}
	if (session) return session;
	const list = await getJson(`${base}/api/sessions`, 15_000);
	const dir = resolve(cwd);
	return (Array.isArray(list) ? list : []).find((entry) => !entry.host && entry.cwd && resolve(entry.cwd) === dir)?.id ?? null;
}

/**
 * @returns {Promise<{ action: "opened" | "focused", pane: string, session: string | null, startedServer: boolean }>}
 */
export async function launchInHerdr({ env = process.env, cwd = process.cwd(), port = 4747, session = null, sessionFile = null } = {}) {
	const pane = env.HERDR_PANE_ID;
	const bin = env.HERDR_BIN_PATH;
	if (env.HERDR_ENV !== "1" || !pane || !bin) throw Object.assign(new Error("Herdr 창 안에서 실행하세요. Herdr 밖에서는 다른 터미널에서 docent-tui 를 실행하면 돼요."), { code: "NOT_HERDR" });
	const base = `http://127.0.0.1:${port}`;
	const { started: startedServer } = await startServer({ port, env });
	const target = await pickSession(base, { session, sessionFile, cwd });

	// 같은 작업 공간에 이미 도슨트가 있으면 새로 만들지 않고 그 창으로 간다.
	const agents = JSON.parse(await herdr(bin, ["agent", "list"])).result?.agents ?? [];
	const existing = agents.find((agent) => agent.agent === "docent" && (!env.HERDR_WORKSPACE_ID || agent.workspace_id === env.HERDR_WORKSPACE_ID));
	if (existing) {
		await herdr(bin, ["agent", "focus", existing.pane_id]);
		return { action: "focused", pane: existing.pane_id, session: target, startedServer };
	}

	const split = JSON.parse(await herdr(bin, ["pane", "split", pane, "--direction", "right", "--cwd", resolve(cwd)]));
	const created = split.result?.pane?.pane_id;
	if (!created) throw new Error("Herdr 창을 나누지 못했어요.");
	const command = [process.execPath, TUI_BIN, "--url", base, ...(target ? ["--session", target] : [])].map(shellWord).join(" ");
	await herdr(bin, ["pane", "run", created, command]);
	return { action: "opened", pane: created, session: target, startedServer };
}
