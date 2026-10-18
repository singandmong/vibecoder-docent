import assert from "node:assert/strict";
import test from "node:test";
import { peerProvider } from "../app/peers.mjs";

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
