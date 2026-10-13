import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import baseTest from "node:test";
import { launchInHerdr, launchInPlace, shellWord, shouldOpenInPlace } from "../app/herdr-launch.mjs";
import { fixture } from "./omp-fixture.mjs";

// 가짜 herdr 는 shebang 스크립트라 Windows 에서는 실행되지 않는다.
const test = (name, fn) => baseTest(name, { skip: process.platform === "win32" && "Herdr is not available on Windows" }, fn);

/** A fake herdr CLI: records each call and answers like Herdr 0.9.3. `agents` is the current agent list. */
async function fakeHerdr(t, agents = []) {
	const dir = await mkdtemp(join(tmpdir(), "docent-fake-herdr-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.jsonl");
	const bin = join(dir, "herdr");
	await writeFile(log, "");
	await writeFile(bin, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "list") console.log(JSON.stringify({ result: { agents: ${JSON.stringify(agents)} } }));
else if (args[0] === "pane" && args[1] === "split") console.log(JSON.stringify({ result: { pane: { pane_id: "w9:p2" } } }));
else console.log(JSON.stringify({ result: { type: "ok" } }));
`, { mode: 0o755 });
	return { bin, calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

const herdrEnv = (bin) => ({ HERDR_ENV: "1", HERDR_PANE_ID: "w9:p1", HERDR_BIN_PATH: bin, HERDR_WORKSPACE_ID: "w9" });

test("outside Herdr the launcher refuses without touching anything", async () => {
	await assert.rejects(launchInHerdr({ env: {}, port: 1 }), (error) => error.code === "NOT_HERDR");
});

test("the agent's own session file opens beside it in a right split", async (t) => {
	const f = await fixture(t);
	const fake = await fakeHerdr(t);
	const port = Number(new URL(f.address).port);
	const result = await launchInHerdr({ env: herdrEnv(fake.bin), port, sessionFile: f.sessionFile, cwd: "/elsewhere" });
	assert.deepEqual({ action: result.action, pane: result.pane, session: result.session, startedServer: result.startedServer }, { action: "opened", pane: "w9:p2", session: f.sessionId, startedServer: false });
	const calls = await fake.calls();
	assert.deepEqual(calls.find((args) => args[1] === "split"), ["pane", "split", "w9:p1", "--direction", "right", "--cwd", "/elsewhere"]);
	const run = calls.find((args) => args[1] === "run");
	assert.equal(run[2], "w9:p2");
	assert.ok(run[3].endsWith(`'--session' ${shellWord(f.sessionId)}`), run[3]);
	assert.ok(run[3].includes(`'--url' 'http://127.0.0.1:${port}'`), run[3]);
});

test("without a session file the most recent session of the working folder opens", async (t) => {
	const f = await fixture(t);
	const fake = await fakeHerdr(t);
	const result = await launchInHerdr({ env: herdrEnv(fake.bin), port: Number(new URL(f.address).port), cwd: "/project" });
	assert.equal(result.session, f.sessionId);
	const other = await launchInHerdr({ env: herdrEnv(fake.bin), port: Number(new URL(f.address).port), cwd: "/no-sessions-here" });
	assert.equal(other.session, null, "no match falls back to the session list");
	assert.equal((await fake.calls()).filter((args) => args[1] === "run").at(-1)[3].includes("--session"), false);
});

test("an existing docent pane in the same workspace is focused instead of splitting again", async (t) => {
	const f = await fixture(t);
	const fake = await fakeHerdr(t, [{ agent: "docent", pane_id: "w8:p3", workspace_id: "w8" }, { agent: "docent", pane_id: "w9:p4", workspace_id: "w9" }]);
	const result = await launchInHerdr({ env: herdrEnv(fake.bin), port: Number(new URL(f.address).port), cwd: "/project" });
	assert.deepEqual([result.action, result.pane], ["focused", "w9:p4"]);
	const calls = await fake.calls();
	assert.equal(calls.some((args) => args[1] === "split"), false);
	assert.deepEqual(calls.at(-1), ["agent", "focus", "w9:p4"]);
});

test("shell words survive quotes so session ids reach docent-tui unchanged", () => {
	assert.equal(shellWord("a'b c"), `'a'\\''b c'`);
});

test("in a TTY without --split the launcher opens in place; otherwise it splits", () => {
	assert.equal(shouldOpenInPlace({ isTTY: true }), true);
	assert.equal(shouldOpenInPlace({ isTTY: true, split: true }), false);
	assert.equal(shouldOpenInPlace({ isTTY: false }), false);
});

test("in place spawns docent-tui with inherited stdio and returns its exit code", async (t) => {
	const f = await fixture(t);
	const port = Number(new URL(f.address).port);
	const calls = [];
	const spawn = (cmd, args, options) => {
		calls.push({ cmd, args, options });
		const child = new EventEmitter();
		setImmediate(() => child.emit("exit", 3, null));
		return child;
	};
	const result = await launchInPlace({ env: {}, port, sessionFile: f.sessionFile, cwd: "/elsewhere", spawn });
	assert.equal(result.code, 3);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].options.stdio, "inherit");
	assert.deepEqual(calls[0].args.slice(1), ["--url", `http://127.0.0.1:${port}`, "--session", f.sessionId]);
});
