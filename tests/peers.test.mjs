import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { peerHealth, peerProvider } from "../app/peers.mjs";

test("peer 목록 항목은 이 컴퓨터가 쓰는 필드만, 맞는 형식일 때만 남긴다", async () => {
	const remote = [
		{ id: "claude:a", provider: "claude", title: { nope: 1 }, recent: "<script>x</script>", host: null },
		{ id: "claude:b", provider: "claude", title: "정상", bytes: "9", host: null, herdr: { label: "w", number: "3", pane: {} } },
		{ id: "claude:c", provider: "claude", host: "evil", title: "자기 컴퓨터라고 주장" },
		{ id: 7, title: "id 없음" },
	];
	const fetch = async () => new Response(JSON.stringify(remote));
	const list = await peerProvider("book", "http://b", { fetch }).list();
	assert.deepEqual(list, [
		{ id: "@book/claude:a", provider: "claude", recent: "<script>x</script>", host: "book" },
		{ id: "@book/claude:b", provider: "claude", title: "정상", herdr: { label: "w", number: "3" }, host: "book" },
	]);
});

test("peer 응답이 상한을 넘거나 배열이 아니면 받지 않는다", async () => {
	const fetch = async () => new Response(JSON.stringify({ not: "a list" }));
	assert.deepEqual(await peerProvider("book", "http://b", { fetch }).list(), []);
	const big = "x".repeat(5 * 1024 * 1024);
	const oversized = async () => new Response(big, { headers: { "content-length": String(big.length) } });
	assert.deepEqual(await peerProvider("book", "http://b", { fetch: oversized }).list(), []);
	const huge = async () => new Response("x", { headers: { "content-length": String(80 * 1024 * 1024 + 1) } });
	await assert.rejects(() => peerProvider("book", "http://b", { fetch: huge }).transcript("claude:a"), /너무 커요/);
});

test("peer 는 리디렉트를 따라가지 않는다", async () => {
	let called = [];
	const fetch = async (url) => {
		called.push(url);
		return new Response("", { status: 302, headers: { location: "http://127.0.0.1:1/other" } });
	};
	await assert.rejects(() => peerProvider("book", "http://b", { fetch }).transcript("claude:a"), /book: 302/);
	assert.equal(called.length, 1);
});

/** 요청마다 handler 로 답하는 로컬 서버. 끝나면 닫는다. */
async function healthServer(t, handler) {
	const server = createServer(handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	return `http://127.0.0.1:${server.address().port}`;
}
const jsonReply = (body) => (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("peerHealth 는 도슨트 /api/health 의 버전만 돌려준다", async (t) => {
	const base = await healthServer(t, jsonReply({ app: "vibecoder-docent", version: "0.33.0", pid: 1 }));
	assert.deepEqual(await peerHealth("book", base), { name: "book", version: "0.33.0" });
	assert.deepEqual(await peerHealth("book", `${base}/`), { name: "book", version: "0.33.0" });
});

test("peerHealth 는 리디렉트를 따라가지 않고, 큰 응답·다른 앱·이상한 버전은 null 이다", async (t) => {
	let followed = 0;
	const target = await healthServer(t, (req, res) => { followed++; jsonReply({ app: "vibecoder-docent", version: "9.9.9" })(req, res); });
	const redirect = await healthServer(t, (req, res) => { res.writeHead(302, { location: `${target}/api/health` }); res.end(); });
	assert.deepEqual(await peerHealth("book", redirect), { name: "book", version: null });
	assert.equal(followed, 0);

	const big = await healthServer(t, jsonReply({ app: "vibecoder-docent", version: "0.33.0", pad: "x".repeat(5000) }));
	assert.deepEqual(await peerHealth("book", big), { name: "book", version: null });

	const other = await healthServer(t, jsonReply({ app: "something-else", version: "0.33.0" }));
	assert.deepEqual(await peerHealth("book", other), { name: "book", version: null });

	for (const version of ["0.33", "v0.33.0", "0.33.0-rc.1", 33, null]) {
		const odd = await healthServer(t, jsonReply({ app: "vibecoder-docent", version }));
		assert.deepEqual(await peerHealth("book", odd), { name: "book", version: null }, String(version));
	}
});

test("peerHealth 는 연결이 안 되어도 던지지 않는다", async () => {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	server.close();
	await once(server, "close");
	assert.deepEqual(await peerHealth("book", `http://127.0.0.1:${port}`), { name: "book", version: null });
});
