// 실제 서버와 가짜 텔레그램 서버(node:http)로 도슨트 봇 조립을 시험한다 (ADR 0076).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fixture, until } from "./omp-fixture.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = "test-token-123";
const BOT = "docent_test_bot";
const question = "보유 계정 기준으로 어디에 리얼타임을 둘까?";

/** 가짜 Bot API. 받은 호출을 모두 기록하고, getUpdates 는 큐가 비면 200ms 뒤 빈 배열로 답한다. */
async function fakeTelegram(t) {
	const calls = [];
	const queue = [];
	let nextUpdate = 1;
	let nextMessage = 1;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : {};
		const method = req.url.split("/").pop();
		if (!req.url.startsWith(`/bot${TOKEN}/`)) {
			res.writeHead(404, { "content-type": "application/json" });
			return res.end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }));
		}
		calls.push({ method, body });
		const reply = (result) => {
			if (res.destroyed) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, result }));
		};
		if (method === "getMe") return reply({ id: 1000, is_bot: true, first_name: "Docent", username: BOT });
		if (method === "getUpdates") {
			const send = () => { reply(queue.splice(0)); };
			if (queue.length) return send();
			const timer = setTimeout(send, 200);
			res.on("close", () => clearTimeout(timer));
			return;
		}
		if (method === "sendMessage" || method === "editMessageText") return reply({ message_id: nextMessage++, chat: { id: body.chat_id, type: "private" }, text: body.text });
		return reply(true);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		calls,
		count: (method) => calls.filter((call) => call.method === method).length,
		sent: () => calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text ?? "")),
		/** 개인 채팅 글 한 건을 큐에 넣는다. */
		push(fromId, text, chat = { id: fromId, type: "private" }) {
			queue.push({ update_id: nextUpdate++, message: { message_id: nextUpdate + 100, from: { id: fromId, is_bot: false, first_name: "x" }, chat, date: Math.floor(Date.now() / 1000), text } });
		},
	};
}

const botStatus = async (f) => (await f.api("/api/bot")).body;
const followingUp = (f) => until(async () => (await botStatus(f)).following === true);
const started = (f) => until(async () => Boolean((await botStatus(f)).username));

/** 가짜 omp 호출 수가 400ms 동안 변하지 않을 때까지 기다린다(미리 설명이 끝난 뒤를 기준으로 삼기 위해). */
async function settled(f) {
	let last = -1;
	let stableSince = Date.now();
	while (Date.now() - stableSince < 400) {
		const now = (await f.calls()).length;
		if (now !== last) { last = now; stableSince = Date.now(); }
		await delay(50);
	}
	return last;
}

const ownerConfig = (owner = 42) => ({ telegram: { owner } });
const withBot = (api, config) => ({ env: { DOCENT_TELEGRAM_TOKEN: TOKEN, DOCENT_TELEGRAM_API: api.url }, ...(config ? { config } : {}) });
const configOwner = async (f) => JSON.parse(await readFile(join(f.stateHome, "config.json"), "utf8").catch(() => "{}")).telegram?.owner;

test("(a) 토큰이 없으면 봇이 꺼져 있고 텔레그램 서버를 부르지 않는다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, { env: { DOCENT_TELEGRAM_API: api.url }, config: ownerConfig() });
	assert.deepEqual(await botStatus(f), { enabled: false });
	assert.match(f.serverOutput(), /telegram: off/);
	await delay(500);
	assert.equal(api.calls.length, 0);
});

test("(b) 주인의 개인 채팅 질문이 설명으로 만들어지고 답이 오며 기록에 남는다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api, ownerConfig()));
	await followingUp(f);
	assert.match(f.serverOutput(), /telegram: on/);
	api.push(42, "지금 뭐 했어?");
	await until(() => api.sent().some((text) => text.includes("설명 깊이와 출력을")), 15000);
	const stored = await f.stored();
	assert.ok(JSON.stringify(stored.records).includes("지금 뭐 했어?"), "records 에 질문이 있어야 해요");
	const history = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}&profileId=default`)).body;
	assert.ok(JSON.stringify(history).includes("지금 뭐 했어?"), "history 에 질문이 보여야 해요");
});

test("(c) 주인이 아닌 계정의 글은 무시한다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api, ownerConfig()));
	await followingUp(f);
	const before = await settled(f);
	const sentBefore = api.count("sendMessage");
	api.push(7, "지금 뭐 했어?");
	await delay(800);
	assert.equal(api.count("sendMessage"), sentBefore);
	assert.equal((await f.calls()).length, before);
});

test("(d) 질문 없이 켠 서버가 세션을 따라가다가 새 질문 카드를 알린다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api, ownerConfig()));
	await followingUp(f);
	// 켜기 전부터 있던 미리 설명 답은 카드 알림과 따로 센다.
	const preReplies = api.count("sendMessage");
	await f.appendSession({ type: "assistant", uuid: "a-card", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "tool-card", name: "AskUserQuestion", input: { questions: [{ question, options: [{ label: "Supabase Realtime", description: "이미 보유" }] }] } }] } });
	await until(() => api.sent().some((text) => text.includes("AI가 물어봐요")), 15000);
	const cards = api.sent().filter((text) => text.includes("AI가 물어봐요"));
	assert.equal(cards.length, 1);
	assert.ok(cards[0].includes(question), cards[0]);
	assert.equal(cards[0].includes("이미 보유"), false);
	assert.ok(api.count("sendMessage") >= preReplies + 1);
});

test("(e) 토큰은 상태 API, 서버 출력, omp 자식 환경 어디에도 없다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api, ownerConfig()));
	await followingUp(f);
	api.push(42, "지금 뭐 했어?");
	await until(() => api.sent().some((text) => text.includes("설명 깊이와 출력을")), 15000);
	const status = await f.api("/api/bot");
	assert.equal(JSON.stringify(status.body).includes(TOKEN), false);
	assert.equal(typeof status.body.following, "boolean");
	assert.equal(f.serverOutput().includes(TOKEN), false);
	const calls = await f.calls();
	assert.ok(calls.length > 0);
	assert.equal(calls.some((call) => call.telegramToken), false);
});

test("(f) 서버가 SIGTERM 으로 정상 종료하면 getUpdates 도 멈춘다", { skip: process.platform === "win32" && "Windows 에는 정상 종료 신호가 없어요" }, async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api, ownerConfig()));
	await followingUp(f);
	await until(() => api.count("getUpdates") > 0);
	const exit = await f.terminate();
	assert.equal(exit.code, 0);
	const polls = api.count("getUpdates");
	await delay(700);
	assert.equal(api.count("getUpdates"), polls);
});

/** `docent telegram pair` 를 서버와 같은 홈으로 실행하고 출력 링크의 코드를 돌려준다. */
async function runPair(f) {
	const child = spawn(process.execPath, [join(root, "bin/docent.mjs"), "telegram", "pair", "--port", new URL(f.address).port], { cwd: root, env: { ...process.env, HOME: f.home, DOCENT_HOME: f.stateHome }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	const [code] = await once(child, "exit");
	assert.equal(code, 0, output);
	const match = new RegExp(`https://t\\.me/${BOT}\\?start=([A-Za-z0-9_-]+)`).exec(output);
	assert.ok(match, output);
	return match[1];
}

test("짝짓기: pair 명령의 코드로 /start 하면 config.json 에 주인이 저장된다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api));
	await started(f);
	assert.equal((await botStatus(f)).paired, false);
	const code = await runPair(f);
	api.push(99, `/start ${code}`);
	await until(async () => (await configOwner(f)) === 99, 10000);
	await until(async () => (await botStatus(f)).paired === true);
	await until(() => stat(join(f.stateHome, "telegram-pair.json")).then(() => false, () => true));
	assert.equal(f.serverOutput().includes(code), false);
});

test("짝짓기: 만료된 코드는 저장하지 않는다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api));
	await started(f);
	await mkdir(f.stateHome, { recursive: true });
	await writeFile(join(f.stateHome, "telegram-pair.json"), JSON.stringify({ code: "expiredcode123", expiresAt: Date.now() - 1000 }));
	api.push(99, "/start expiredcode123");
	await delay(800);
	assert.equal(await configOwner(f), undefined);
	assert.equal(api.count("sendMessage"), 0);
});

test("짝짓기: 틀린 코드는 저장하지 않고 답하지 않는다", async (t) => {
	const api = await fakeTelegram(t);
	const f = await fixture(t, withBot(api));
	await started(f);
	await writeFile(join(f.stateHome, "telegram-pair.json"), JSON.stringify({ code: "rightcode123456", expiresAt: Date.now() + 600_000 }));
	api.push(99, "/start wrongcode123456");
	await delay(800);
	assert.equal(await configOwner(f), undefined);
	assert.equal(api.count("sendMessage"), 0);
});
