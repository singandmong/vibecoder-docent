import assert from "node:assert/strict";
import test from "node:test";
import { sessionCatalog } from "../app/catalog.mjs";

/** 감시기 시작·정지 횟수를 세는 가짜 제공자. */
function stubProvider() {
	const state = { starts: 0, stops: 0, send: null };
	const provider = {
		id: "stub",
		host: null,
		owns: (sid) => sid.startsWith("stub:"),
		check: () => {},
		list: async () => [],
		describe: async (sessions) => sessions,
		transcript: async () => "",
		watch(_sessionId, send) {
			state.starts++;
			state.send = send;
			return () => { state.stops++; };
		},
		idOf: async () => null,
	};
	return { provider, state };
}

test("같은 세션을 지켜보는 구독은 감시기 하나를 나눠 쓰고, 모두 떠나면 멈춘다", () => {
	const { provider, state } = stubProvider();
	const catalog = sessionCatalog([provider]);
	const seen = [];
	const stopA = catalog.watch("stub:a", (ev) => seen.push(["a", ev]));
	const stopB = catalog.watch("stub:a", (ev) => seen.push(["b", ev]));
	assert.equal(state.starts, 1, "같은 세션은 감시기를 하나만 만든다");
	state.send({ kind: "card" });
	assert.deepEqual(seen, [["a", { kind: "card" }], ["b", { kind: "card" }]], "모든 구독이 같은 사건을 받는다");
	stopA();
	assert.equal(state.stops, 0, "구독이 남아 있으면 감시기를 멈추지 않는다");
	stopB();
	assert.equal(state.stops, 1, "마지막 구독이 떠나면 멈춘다");
});

test("다른 세션은 감시기를 따로 만든다", () => {
	const { provider, state } = stubProvider();
	const catalog = sessionCatalog([provider]);
	const stopA = catalog.watch("stub:a", () => {});
	const stopB = catalog.watch("stub:b", () => {});
	assert.equal(state.starts, 2);
	stopA();
	stopB();
	assert.equal(state.stops, 2);
});

test("한 세션의 구독이 상한을 넘으면 503 으로 거절한다", () => {
	const { provider } = stubProvider();
	const catalog = sessionCatalog([provider]);
	const stops = [];
	let error;
	for (let i = 0; i < 17; i++) {
		try { stops.push(catalog.watch("stub:a", () => {})); } catch (e) { error = e; }
	}
	assert.equal(stops.length, 16);
	assert.equal(error?.status, 503);
	for (const stop of stops) stop();
});
