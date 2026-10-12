import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Capture a test credential before module initialization; every request is intercepted below.
const originalKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = "semantic-feed-test-key";
const { watchSession } = await import("../app/live.mjs");
if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
else process.env.TYPESAFE_API_KEY = originalKey;

const jsonl = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const adapter = { events: (chunk) => chunk.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
const messages = (events) => events.filter((event) => event.kind !== "hello" && event.kind !== "warn");
async function waitUntil(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for session events");
		await delay(10);
	}
}
async function startSession(t, initial) {
	const directory = await mkdtemp(join(tmpdir(), "docent-live-test-"));
	const path = join(directory, "session.jsonl");
	let stop;
	t.after(async () => { stop?.(); await rm(directory, { recursive: true, force: true }); });
	await writeFile(path, jsonl(initial));
	const sent = [];
	stop = watchSession(path, adapter, (event) => sent.push(event));
	await waitUntil(() => sent.some((event) => event.kind === "hello"));
	return { sent, append: (events) => appendFile(path, jsonl(events)) };
}

test("replay and new events expose only semantic questions, results, and plans, retaining long-message conclusions", async (t) => {
	const progress = "지금 파일을 읽고 있어요. ".repeat(1000);
	const longResult = `${progress}\n요청한 변경을 마쳤고 저장 동작까지 확인했어요.`;
	const replies = new Map([
		["어느 저장 방식을 원하세요?", ["question", 0.98]],
		["입력부터 확인한 뒤 저장과 복원을 나누어 구현할 계획이에요.", ["plan", 0.98]],
		["작업을 완료하지 못했어요. 기존 값은 바꾸지 않았어요.", ["result", 0.98]],
		["완료 여부를 아직 확인하고 있어요.", ["result", 0.3]],
	]);
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		const { state } = JSON.parse(init.body);
		const [choice, noul] = state.endsWith("요청한 변경을 마쳤고 저장 동작까지 확인했어요.")
			? ["result", 0.99] : (replies.get(state) ?? ["routine", 0.99]);
		return { ok: true, json: async () => ({ answers: { notable: { noul }, kind: { choice } } }) };
	});
	const input = [
		{ kind: "user", text: "작업해줘" }, { kind: "assistant", text: progress },
		{ kind: "error", text: "raw tool failed" }, { kind: "done", text: "세션 종료" },
		{ kind: "assistant", text: "어느 저장 방식을 원하세요?" },
		{ kind: "assistant", text: "입력부터 확인한 뒤 저장과 복원을 나누어 구현할 계획이에요." },
		{ kind: "assistant", text: "완료 여부를 아직 확인하고 있어요." },
		{ kind: "assistant", text: "작업을 완료하지 못했어요. 기존 값은 바꾸지 않았어요." },
		{ kind: "assistant", text: longResult },
		{ kind: "question", text: "진행할까요?", options: [{ label: "진행", description: "변경을 시작해요" }] },
	];
	const { sent, append } = await startSession(t, input);
	const past = messages(sent);
	assert.deepEqual(past.map((event) => [event.kind, event.sub]), [
		["assistant", "question"], ["assistant", "plan"], ["assistant", "result"], ["assistant", "result"], ["question", "question"],
	]);
	assert.equal(past[3].text, longResult);
	assert.deepEqual(past[4].options, input.at(-1).options);
	assert.ok(past.every((event) => event.past));
	await append(input);
	await waitUntil(() => messages(sent).filter((event) => !event.past).some((event) => event.kind === "question"));
	const current = messages(sent).filter((event) => !event.past);
	assert.deepEqual(current.map(({ kind, sub, text, options }) => ({ kind, sub, text, options })), past.map(({ kind, sub, text, options }) => ({ kind, sub, text, options })));
});

test("classification outages and malformed answers never fall back to length, warn once, and retain explicit asks", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		const { state } = JSON.parse(init.body);
		if (state.startsWith("outage")) throw new Error("classifier offline");
		return { ok: true, json: async () => ({ answers: { notable: { noul: 0.99 }, kind: { choice: "blocked" } } }) };
	});
	const explicit = { kind: "question", text: "この操作を許可しますか?", options: [{ label: "許可", description: "" }] };
	const input = [
		{ kind: "assistant", text: "outage ".repeat(100) },
		{ kind: "assistant", text: "unrecognized category ".repeat(100) },
		{ kind: "error", text: "tool error" }, { kind: "done", text: "session ended" }, explicit,
	];
	const { sent, append } = await startSession(t, input);
	assert.deepEqual(messages(sent).map(({ kind, sub, text, options }) => ({ kind, sub, text, options })), [{ ...explicit, sub: "question" }]);
	await append(input);
	await waitUntil(() => messages(sent).some((event) => !event.past));
	assert.deepEqual(messages(sent).map((event) => event.kind), ["question", "question"]);
	assert.deepEqual(sent.filter((event) => event.kind === "warn").map((event) => event.code), ["classifier-unavailable"]);
});

test("an absent Jev credential reports no classification instead of using a fabricated local result", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ answers: { notable: { noul: 0.99 }, kind: { choice: "result" } } }) }));
	const key = process.env.TYPESAFE_API_KEY;
	delete process.env.TYPESAFE_API_KEY;
	let jev;
	try { jev = await import("../app/jev.mjs?without-key"); }
	finally {
		if (key === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = key;
	}
	assert.equal(jev.jevEnabled, false);
	assert.equal(await jev.judge("긴 진행 보고 ".repeat(100), jev.EVENT_QUESTIONS), null);
	assert.equal(fetch.mock.callCount(), 0);
});
