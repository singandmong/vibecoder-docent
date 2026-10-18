import assert from "node:assert/strict";
import test from "node:test";
import { capacity } from "../app/capacity.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("상한을 넘은 일은 자리가 날 때까지 순서대로 기다린다", async () => {
	const gate = capacity(2);
	const first = await gate.acquire();
	const second = await gate.acquire();
	let third = null;
	gate.acquire().then((free) => { third = free; });
	await tick();
	assert.equal(third, null, "세 번째는 아직 자리가 없다");
	assert.equal(gate.active, 2);
	assert.equal(gate.waiting, 1);
	first();
	await tick();
	assert.ok(third, "자리가 나면 들어간다");
	second();
	third();
	assert.equal(gate.active, 0);
});

test("기다리다 중단되면 대기에서 빠지고 오류로 끝난다", async () => {
	const gate = capacity(1);
	const held = await gate.acquire();
	const controller = new AbortController();
	const waiting = gate.acquire(controller.signal).then(() => "granted", (error) => error);
	controller.abort();
	const result = await waiting;
	assert.ok(result instanceof Error, "중단되면 오류로 끝난다");
	assert.equal(gate.waiting, 0);
	held();
	assert.equal(gate.active, 0);
});

test("이미 중단된 신호로는 시작하지 않는다", async () => {
	const gate = capacity(1);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => gate.acquire(controller.signal));
	assert.equal(gate.active, 0);
});
