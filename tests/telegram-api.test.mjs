import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../app/store.mjs";
import { TelegramError, redactToken, telegramApi } from "../app/telegram-api.mjs";

const TOKEN = "123456:SECRET-token_abc";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("성공 응답이면 result 를 돌려주고 토큰 경로로 JSON 을 POST 한다", async () => {
	const seen = [];
	const fetch = async (url, init) => {
		seen.push({ url, init });
		return json({ ok: true, result: [{ update_id: 1 }] });
	};
	const api = telegramApi({ token: TOKEN, base: "http://fake/", fetch });
	assert.deepEqual(await api.call("getUpdates", { offset: 5 }), [{ update_id: 1 }]);
	assert.equal(seen[0].url, `http://fake/bot${TOKEN}/getUpdates`);
	assert.equal(seen[0].init.method, "POST");
	assert.equal(seen[0].init.redirect, "manual");
	assert.deepEqual(JSON.parse(seen[0].init.body), { offset: 5 });
	assert.ok(seen[0].init.signal instanceof AbortSignal);
});

test("429 는 retryAfter 를 싣는다", async () => {
	const fetch = async () => json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }, 429);
	const e = await telegramApi({ token: TOKEN, base: "http://fake", fetch }).call("sendMessage").catch((x) => x);
	assert.ok(e instanceof TelegramError);
	assert.equal(e.status, 429);
	assert.equal(e.retryAfter, 7);
	assert.equal(e.method, "sendMessage");
	assert.match(e.description, /Too Many/);
});

test("401 은 status 401 이고 retryAfter 가 없다", async () => {
	const fetch = async () => json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
	const e = await telegramApi({ token: TOKEN, base: "http://fake", fetch }).call("getMe").catch((x) => x);
	assert.equal(e.status, 401);
	assert.equal(e.retryAfter, null);
});

test("JSON 이 아닌 응답도 TelegramError 로 바뀐다", async () => {
	const fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
	const e = await telegramApi({ token: TOKEN, base: "http://fake", fetch }).call("getMe").catch((x) => x);
	assert.ok(e instanceof TelegramError);
	assert.equal(e.status, 502);
});

test("fetch 가 토큰이 든 URL 을 던져도 오류 어디에도 토큰이 없다", async () => {
	const fetch = async (url) => {
		const err = new TypeError(`fetch failed for ${url}`);
		err.cause = Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED" });
		throw err;
	};
	const e = await telegramApi({ token: TOKEN, base: "http://fake", fetch }).call("getUpdates").catch((x) => x);
	assert.ok(e instanceof TelegramError);
	assert.equal(e.status, 0);
	assert.equal(e.message, "텔레그램 getUpdates 요청 실패 (ECONNREFUSED)");
	for (const text of [e.message, String(e), JSON.stringify(e), e.stack ?? "", String(e.cause ?? "")]) {
		assert.ok(!text.includes(TOKEN), text);
		assert.ok(!text.includes("SECRET"), text);
	}
});

test("호출자가 중단하면 요청 실패로 끝난다", async () => {
	const fetch = (url, { signal }) =>
		new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
	const ctl = new AbortController();
	const pending = telegramApi({ token: TOKEN, base: "http://fake", fetch }).call("getUpdates", {}, { signal: ctl.signal }).catch((x) => x);
	ctl.abort();
	const e = await pending;
	assert.ok(e instanceof TelegramError);
	assert.equal(e.status, 0);
});

test("redactToken 은 토큰을 <token> 으로 바꾼다", () => {
	assert.equal(redactToken(`GET /bot${TOKEN}/x and ${TOKEN}`, TOKEN), "GET /bot<token>/x and <token>");
	assert.equal(redactToken("그대로", ""), "그대로");
	assert.equal(redactToken(undefined, TOKEN), "");
});

test("writeJsonAtomic 은 JSON 을 쓰고 0600 으로 만든다", async () => {
	const dir = await mkdtemp(join(tmpdir(), "docent-atomic-"));
	try {
		const path = join(dir, "sub", "x.json");
		const value = { a: 1, b: ["가", "나"] };
		await writeJsonAtomic(path, value);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value);
		await writeJsonAtomic(path, { a: 2 });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { a: 2 });
		if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
