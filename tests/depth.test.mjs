import assert from "node:assert/strict";
import test from "node:test";
import { depthDecider } from "../app/depth.mjs";
import { CancelledError } from "../app/runner.mjs";

/** 분야 판정만 흉내 내는 runner. 불린 횟수를 센다. */
function judge(answer) {
	const runner = { calls: 0, async once() { runner.calls++; return answer(); } };
	return runner;
}

const plain = { defaultDifficulty: "NORMAL", domainDifficulties: {} };
const frontendHard = { defaultDifficulty: "NORMAL", domainDifficulties: { frontend: "HARD" } };
const model = { provider: "fixture", selector: "fixture/cheap" };

test("a profile without per-field depth uses its default and never calls the judge", async () => {
	const runner = judge(() => "[\"frontend\"]");
	const depth = await depthDecider({ runner, prompt: "p" })({ profile: plain, question: "왜?" });
	assert.deepEqual(depth, { difficulty: "NORMAL", difficultySource: "profile", thinking: "low" });
	assert.equal(runner.calls, 0);
});

test("the question's own depth wins without judging the field", async () => {
	const runner = judge(() => "[\"frontend\"]");
	const depth = await depthDecider({ runner, prompt: "p" })({ profile: frontendHard, override: "EASY", question: "왜?" });
	assert.deepEqual(depth, { difficulty: "EASY", difficultySource: "question", thinking: "low" });
	assert.equal(runner.calls, 0);
});

test("an unknown requested depth is a 400 before any model call", async () => {
	const runner = judge(() => "[]");
	await assert.rejects(depthDecider({ runner, prompt: "p" })({ profile: frontendHard, override: "EXPERT", question: "왜?" }), { status: 400 });
	assert.equal(runner.calls, 0);
});

test("the harder of the default and the judged field's depth is chosen", async () => {
	const decide = depthDecider({ runner: judge(() => "```json\n[\"frontend\"]\n```"), prompt: "p" });
	assert.deepEqual(await decide({ profile: frontendHard, question: "버튼 왜 막아?" }), { difficulty: "HARD", difficultySource: "domain", thinking: "medium" });
	assert.deepEqual(await decide({ profile: { defaultDifficulty: "HARD", domainDifficulties: { frontend: "EASY" } }, question: "버튼 왜 막아?" }), { difficulty: "HARD", difficultySource: "profile", thinking: "medium" });
});

test("a failed judge falls back to the default only when no model was chosen", async () => {
	const failing = () => { throw Object.assign(new Error("judge down"), { status: 502 }); };
	let judging = 0;
	const decide = depthDecider({ runner: judge(failing), prompt: "p" });
	assert.deepEqual(await decide({ profile: frontendHard, question: "왜?", onJudging: () => judging++ }), { difficulty: "NORMAL", difficultySource: "profile", thinking: "low" });
	assert.equal(judging, 1);
	await assert.rejects(decide({ profile: frontendHard, question: "왜?", model }), { status: 502 });
	await assert.rejects(depthDecider({ runner: judge(() => { throw new CancelledError(); }), prompt: "p" })({ profile: frontendHard, question: "왜?" }), { cancelled: true });
});
