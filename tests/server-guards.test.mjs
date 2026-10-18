import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { fixture } from "./omp-fixture.mjs";

/** Host 헤더를 직접 넣어 보낸다. fetch 는 Host 를 바꿀 수 없다. */
function getWithHost(port, host, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path: "/api/health", method: "GET", headers: { host, ...extraHeaders } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

test("Host 가 이 컴퓨터의 주소나 아는 이름일 때만 받는다", async (t) => {
	const f = await fixture(t);
	const port = new URL(f.address).port;
	const allowed = [`127.0.0.1:${port}`, "localhost", "100.101.102.103:4747", "192.168.0.9:4747", "10.0.0.5", "mac-mini.tail79fba7.ts.net", "mini.local"];
	for (const host of allowed) {
		assert.equal((await getWithHost(port, host)).status, 200, `${host} 는 받는다`);
	}
	const blocked = ["evil.example", "attacker.test:4747", "example.com"];
	for (const host of blocked) {
		assert.equal((await getWithHost(port, host)).status, 403, `${host} 는 거절한다`);
	}
	assert.equal((await getWithHost(port, `127.0.0.1:${port}`, { "sec-fetch-site": "cross-site" })).status, 403, "다른 사이트에서 보낸 요청은 거절한다");
	assert.equal((await getWithHost(port, `127.0.0.1:${port}`, { "sec-fetch-site": "same-origin" })).status, 200, "우리 화면에서 보낸 요청은 받는다");
	assert.equal((await getWithHost(port, `127.0.0.1:${port}`, { "sec-fetch-site": "none" })).status, 200, "주소를 직접 열거나 브라우저 밖 클라이언트는 받는다");
});

test("본문은 application/json 만 받는다: 다른 사이트가 프리플라이트 없이 보내는 형식을 거절한다", async (t) => {
	const f = await fixture(t);
	const url = `${f.address}/api/favorites`;
	const body = JSON.stringify({ profileId: "default", id: f.sessionId, favorite: true });
	const crossSite = await fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" }, body });
	assert.equal(crossSite.status, 415);
	assert.deepEqual((await f.api("/api/favorites?profileId=default")).body, []);
	const sameOrigin = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
	assert.equal(sameOrigin.status, 200);
	assert.equal((await f.api("/api/favorites?profileId=default")).body.length, 1);
});
