import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCENT = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin/docent.mjs");
const line = (value) => JSON.stringify(value) + "\n";

async function freePort() {
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const { port } = reservation.address();
	await new Promise((resolve) => reservation.close(resolve));
	return port;
}

const docent = (args, env) => new Promise((resolve) => {
	execFile(process.execPath, [DOCENT, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});
const health = (port) => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.json()).catch(() => null);

test("docent start keeps a server running apart from the command, its omp sessions open by a /-separated id, and docent stop ends it", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "docent-start-"));
	const port = await freePort();
	const { DOCENT_PORT: _port, ...inherited } = process.env;
	// omp 는 시작 확인(`omp --version`)만 거친다. 이 테스트는 모델을 부르지 않는다.
	const env = { ...inherited, HOME: home, USERPROFILE: home, DOCENT_HOME: join(home, "state"), DOCENT_HOST: "127.0.0.1", DOCENT_PEERS: "", TYPESAFE_API_KEY: "", OMP_BIN: process.execPath };
	t.after(async () => {
		const running = await health(port);
		if (Number.isInteger(running?.pid)) process.kill(running.pid);
		await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	const file = "2026-10-14T00-00-00-000Z_s1.jsonl";
	await mkdir(join(home, ".omp/agent/sessions/-proj"), { recursive: true });
	await writeFile(join(home, ".omp/agent/sessions/-proj", file), [
		line({ type: "session", id: "s1", cwd: join(home, "proj"), timestamp: "2026-10-14T00:00:00Z" }),
		line({ type: "title", title: "시작 명령 확인" }),
		line({ type: "message", id: "u", timestamp: "2026-10-14T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "서버를 켜 줘" }] } }),
	].join(""));

	const started = await docent(["start", "--port", String(port)], env);
	assert.equal(started.code, 0, started.stderr);
	assert.match(started.stdout, /백그라운드로 켰어요/);
	const running = await health(port);
	assert.equal(running?.app, "vibecoder-docent");
	assert.ok(Number.isInteger(running.pid) && running.pid !== process.pid);

	// 세션 id 의 경로 부분은 운영체제와 관계없이 `/` 이고, 그 id 로 전사를 연다.
	const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json());
	const id = `omp:-proj/${file}`;
	assert.ok(sessions.some((session) => session.id === id), JSON.stringify(sessions.map((session) => session.id)));
	const transcript = await fetch(`http://127.0.0.1:${port}/api/transcript?id=${encodeURIComponent(id)}`);
	assert.equal(transcript.status, 200);
	assert.match(await transcript.text(), /서버를 켜 줘/);

	const again = await docent(["start", "--port", String(port)], env);
	assert.equal(again.code, 0, again.stderr);
	assert.match(again.stdout, /이미 켜져 있어요/);
	assert.equal((await health(port))?.pid, running.pid, "a second start reuses the running server");

	const stopped = await docent(["stop", "--port", String(port)], env);
	assert.equal(stopped.code, 0, stopped.stderr);
	assert.match(stopped.stdout, /서버를 껐어요/);
	assert.equal(await health(port), null);
	const idle = await docent(["stop", "--port", String(port)], env);
	assert.match(idle.stdout, /켜져 있는 서버가 없어요/);
});
