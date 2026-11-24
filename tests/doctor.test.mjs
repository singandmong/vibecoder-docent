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
	assert.deepEqual(oldReport.telegram, { enabled: false, paired: false, username: null, lastError: null });
	const unpaired = await botServer(t, { enabled: true, username: "docent_bot", paired: false, following: false, lastError: null });
	const unpairedOut = await doctor(["--port", unpaired], env);
	assert.match(unpairedOut.stdout, /\[!!\] 텔레그램 봇 켜짐, 아직 연결 안 됨: docent telegram pair/);
	assert.match(unpairedOut.stdout, /- 텔레그램 봇이 켜져 있지만/);
	const paired = await botServer(t, { enabled: true, username: "docent_bot", paired: true, following: true, lastError: null });
	assert.match((await doctor(["--port", paired], env)).stdout, /\[ok\] 텔레그램 봇 @docent_bot 연결됨/);
	const pairedReport = JSON.parse((await doctor(["--json", "--port", paired], env)).stdout);
	assert.deepEqual(pairedReport.telegram, { enabled: true, paired: true, username: "docent_bot", lastError: null });
	assert.equal(pairedReport.ok, oldReport.ok, "telegram state never changes ok");
	for (const isPaired of [false, true]) {
		const broken = await botServer(t, { enabled: true, username: null, paired: isPaired, following: false, lastError: "토큰이 올바르지 않아요" });
		const out = (await doctor(["--port", broken], env)).stdout;
		assert.match(out, /\[!!\] 텔레그램 봇 켜짐, 문제가 있어요: 토큰이 올바르지 않아요/);
		assert.match(out, /DOCENT_TELEGRAM_TOKEN 이 맞는지/);
		assert.equal(out.includes("@null"), false);
		assert.equal(out.includes("연결됨"), false);
		const report = JSON.parse((await doctor(["--json", "--port", broken], env)).stdout);
		assert.equal(report.telegram.lastError, "토큰이 올바르지 않아요");
	}
	const transient = await botServer(t, { enabled: true, username: "docent_bot", paired: true, following: false, lastError: "텔레그램 getUpdates 요청 실패 (409)" });
	const transientOut = (await doctor(["--port", transient], env)).stdout;
	assert.match(transientOut, /\[!!\] 텔레그램 봇 켜짐, 문제가 있어요: 텔레그램 getUpdates 요청 실패 \(409\)/);
	assert.match(transientOut, /연결이 잠시 끊겼을 수 있어요/);
	assert.equal(transientOut.includes("DOCENT_TELEGRAM_TOKEN"), false);
	const starting = await botServer(t, { enabled: true, username: null, paired: false, following: false, lastError: null });
	const startingOut = (await doctor(["--port", starting], env)).stdout;
	assert.match(startingOut, /문제가 있어요: 아직 시작 중이에요/);
	assert.match(startingOut, /봇이 아직 시작 중이에요\. 잠시 뒤 다시 확인하세요\./);
	assert.equal(startingOut.includes("DOCENT_TELEGRAM_TOKEN"), false);
});
