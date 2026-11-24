import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./omp-fixture.mjs";

const docent = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin/docent.mjs");
const doctor = (args, env) => new Promise((resolve) => {
	execFile(process.execPath, [docent, "doctor", ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
});

test("doctor reports a ready install with sessions and a real model probe, without exposing secrets", async (t) => {
	const f = await fixture(t);
	const port = new URL(f.address).port;
	const before = (await f.calls()).length;
	const { code, stdout } = await doctor(["--json", "--probe", "--port", port], { OMP_BIN: f.ompBin, TYPESAFE_API_KEY: "never-print-this-key" });
	const report = JSON.parse(stdout);
	assert.equal(code, 0);
	assert.equal(report.ok, true);
	assert.equal(report.omp.found, true);
	assert.equal(report.omp.chatModels, 2);
	assert.equal(report.server.running, true);
	assert.deepEqual(report.server.sessions, { claude: 1 });
	assert.equal(report.probe.ok, true);
	assert.equal(report.jev.configured, true);
	assert.deepEqual(report.next, []);
	assert.equal(stdout.includes("never-print-this-key"), false);
	assert.equal((await f.calls()).length - before, 1, "only --probe calls the model, exactly once");
});

test("doctor fails with next steps when omp is missing and the server is off", async () => {
	const { code, stdout } = await doctor(["--port", "1"], { OMP_BIN: "/nonexistent/omp" });
	assert.equal(code, 1);
	assert.match(stdout, /\[!!\] omp 없음/);
	assert.match(stdout, /omp를 설치하세요/);
	assert.match(stdout, /docent --no-open/);
});

const botServer = async (t, bot) => {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url === "/api/health") return response.end(JSON.stringify({ app: "vibecoder-docent", version: "0.0.0" }));
		if (request.url === "/api/sessions") return response.end("[]");
		if (request.url === "/api/bot" && bot) return response.end(JSON.stringify(bot));
		response.statusCode = 404;
		response.end("{}");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return String(server.address().port);
};

test("doctor shows the telegram bot state without affecting ok", async (t) => {
	const env = { OMP_BIN: "/nonexistent/omp" };
	const off = await botServer(t, { enabled: false });
	assert.match((await doctor(["--port", off], env)).stdout, /\[--\] 텔레그램 봇 꺼짐 \(선택 사항\)/);
	const old = await botServer(t, null);
	const oldReport = JSON.parse((await doctor(["--json", "--port", old], env)).stdout);
	assert.deepEqual(oldReport.telegram, { enabled: false, paired: false, username: null });
	const unpaired = await botServer(t, { enabled: true, username: "docent_bot", paired: false, following: false, lastError: null });
	const unpairedOut = await doctor(["--port", unpaired], env);
	assert.match(unpairedOut.stdout, /\[!!\] 텔레그램 봇 켜짐, 아직 연결 안 됨: docent telegram pair/);
	assert.match(unpairedOut.stdout, /- 텔레그램 봇이 켜져 있지만/);
	const paired = await botServer(t, { enabled: true, username: "docent_bot", paired: true, following: true, lastError: null });
	assert.match((await doctor(["--port", paired], env)).stdout, /\[ok\] 텔레그램 봇 @docent_bot 연결됨/);
	const pairedReport = JSON.parse((await doctor(["--json", "--port", paired], env)).stdout);
	assert.deepEqual(pairedReport.telegram, { enabled: true, paired: true, username: "docent_bot" });
	assert.equal(pairedReport.ok, oldReport.ok, "telegram state never changes ok");
});
