import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareSessions, defaultHerdrExec, herdrWorkspaces, mapSessions } from "../app/herdr-workspaces.mjs";

/** 세션 파일 경로. 서버는 키를 resolve 한 절대 경로로 쓰므로 시험도 같은 모양으로 둔다. */
const P = (name) => resolve("/s", name);
const agent = (pane, value, extra = {}) => ({ agent: "omp", agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value }, pane_id: pane, ...extra });
const agentsJson = (...agents) => JSON.stringify({ id: "cli:agent:list", result: { agents } });
const workspacesJson = (...workspaces) => JSON.stringify({ id: "cli:workspace:list", result: { type: "workspace_list", workspaces } });
const space = (workspace_id, number, label) => ({ workspace_id, number, label, focused: false });

test("each open session file maps to its workspace name, number and pane", () => {
	const found = mapSessions(
		JSON.parse(agentsJson(
			agent("w4B:p2", P("a.jsonl")),
			agent("w3K:p1", P("b.jsonl")),
			{ agent: "docent", pane_id: "w3K:p2" },
			agent("w9Z:p1", P("unknown-workspace.jsonl")),
			{ ...agent("w3K:p3", P("c.jsonl")), agent_session: { kind: "id", value: "abc" } },
		)),
		JSON.parse(workspacesJson(space("w3K", 1, "백업 작업"), space("w4B", 4, "  vibecoder-docent  "))),
	);
	assert.deepEqual([...found.keys()].sort(), [P("a.jsonl"), P("b.jsonl")]);
	assert.deepEqual(found.get(P("a.jsonl")), { workspace: "w4B", label: "vibecoder-docent", number: 4, pane: "w4B:p2" });
	assert.deepEqual(found.get(P("b.jsonl")), { workspace: "w3K", label: "백업 작업", number: 1, pane: "w3K:p1" });
});

test("an unnamed workspace is labelled by its number, and a session open in two panes keeps the earlier one", () => {
	const found = mapSessions(
		JSON.parse(agentsJson(agent("w4B:p5", P("a.jsonl")), agent("w3K:p9", P("a.jsonl")), agent("w3K:p2", P("a.jsonl")))),
		JSON.parse(workspacesJson(space("w3K", 1, ""), space("w4B", 4, "뒤쪽"))),
	);
	assert.deepEqual(found.get(P("a.jsonl")), { workspace: "w3K", label: "작업 공간 1", number: 1, pane: "w3K:p2" });
});

test("herdr is read once per few seconds and a renamed workspace shows after the cache expires", async () => {
	let clock = 1000;
	let label = "처음 이름";
	const calls = [];
	const exec = async (args) => {
		calls.push(args.join(" "));
		return args[0] === "agent" ? agentsJson(agent("w1:p1", P("a.jsonl"))) : workspacesJson(space("w1", 1, label));
	};
	const herdr = herdrWorkspaces({ exec, now: () => clock, ttlMs: 3000 });
	const [first, concurrent] = await Promise.all([herdr.sessions(), herdr.sessions()]);
	assert.equal(first.get(P("a.jsonl")).label, "처음 이름");
	assert.equal(concurrent, first, "calls at the same time share one read");
	label = "바뀐 이름";
	clock += 2999;
	assert.equal((await herdr.sessions()).get(P("a.jsonl")).label, "처음 이름");
	assert.deepEqual(calls.sort(), ["agent list", "workspace list"]);
	clock += 1;
	assert.equal((await herdr.sessions()).get(P("a.jsonl")).label, "바뀐 이름");
	assert.equal(calls.length, 4);
});

test("a missing, failing or garbled herdr gives no data instead of an error", async () => {
	const cases = {
		throws: async () => { throw Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }); },
		garbled: async () => "not json",
		oneFails: async (args) => { if (args[0] === "workspace") throw new Error("timeout"); return agentsJson(agent("w1:p1", P("a.jsonl"))); },
		empty: async () => "{}",
	};
	for (const [name, exec] of Object.entries(cases)) {
		const found = await herdrWorkspaces({ exec }).sessions();
		assert.equal(found.size, 0, name);
	}
});

test("the list order: this computer's Herdr sessions by workspace then pane then recency, peer Herdr sessions by machine, then the rest by recency", () => {
	const s = (id, updated, herdr, host = null) => ({ id, updated, host, ...(herdr ? { herdr } : {}) });
	const at = (number, pane) => ({ workspace: `w${number}`, label: `공간 ${number}`, number, pane: `w${number}:p${pane}` });
	const sessions = [
		s("plain-new", "2026-10-05"),
		s("ws3-p10", "2026-10-01", at(3, 10)),
		s("ws3-p2", "2026-10-01", at(3, 2)),
		s("ws1-p1-old", "2026-10-01", at(1, 1)),
		s("ws1-p1-new", "2026-10-03", at(1, 1)),
		s("peer-ws1", "2026-10-09", at(1, 1), "book"),
		s("peer2-ws1", "2026-10-09", at(1, 1), "mini"),
		s("peer-plain", "2026-10-08", null, "book"),
		s("peer-bad-number", "2026-10-07", { workspace: "w1", label: "x", number: "1", pane: "w1:p1" }, "book"),
		s("plain-old", "2026-10-02"),
	];
	const hostOrder = (host) => ["book", "mini"].indexOf(host);
	const order = sessions.sort((a, b) => compareSessions(a, b, hostOrder)).map((x) => x.id);
	assert.deepEqual(order, ["ws1-p1-new", "ws1-p1-old", "ws3-p2", "ws3-p10", "peer-ws1", "peer2-ws1", "peer-plain", "peer-bad-number", "plain-new", "plain-old"]);
});

test("the default runner falls back to ~/.local/bin/herdr when herdr is not on PATH", { skip: process.platform === "win32" }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "docent-herdr-bin-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, ".local", "bin"), { recursive: true });
	const bin = join(home, ".local", "bin", "herdr");
	await writeFile(bin, `#!/bin/sh\necho "$1 $2"\n`);
	await chmod(bin, 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = join(home, "empty");
	t.after(() => { process.env.PATH = savedPath; });
	const exec = defaultHerdrExec({ home });
	assert.equal((await exec(["workspace", "list"])).trim(), "workspace list");
	assert.equal((await exec(["agent", "list"])).trim(), "agent list");
	await assert.rejects(defaultHerdrExec({ home: join(home, "nowhere") })(["agent", "list"]), { code: "ENOENT" });
});
