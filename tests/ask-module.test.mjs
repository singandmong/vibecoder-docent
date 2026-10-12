// 설명 요청 module 을 프로세스 없이 시험한다. runner 는 각본대로 답하고, 테스트가 설명의 끝을 쥐고 있다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DOCENT_HOME = await mkdtemp(join(tmpdir(), "docent-ask-test-"));
process.env.TYPESAFE_API_KEY = "";
const { createAsk } = await import("../app/ask.mjs");
const { history } = await import("../app/store.mjs");
const { createProfile, updateProfile } = await import("../app/learning.mjs");
const { CancelledError } = await import("../app/runner.mjs");

const TRANSCRIPT = "# 세션\n\n- 작업 폴더: /project\n\n## user\n\n검색 상태를 설명해줘\n";
const focus = { label: "리얼타임 위치", text: "어디에 리얼타임을 둘까?" };
const pause = (ms) => new Promise((res) => setTimeout(res, ms));

/** 설명 턴마다 테스트가 끝을 정한다. 실제 RPC 대화처럼 한 번에 한 질문만 받는다. */
function scriptedRunner({ plan = () => JSON.stringify({ kind: "why", domains: [], concepts: [] }), domains = () => "[]" } = {}) {
	const turns = [];
	const once = async ({ system, signal }) => {
		if (signal?.aborted) throw new CancelledError();
		return system === "planner" ? plan() : domains(signal);
	};
	const conversation = () => {
		let busy = false;
		return {
			alive: true,
			get busy() { return busy; },
			async ask(message, { onDelta, signal }) {
				if (busy) throw new Error("conversation is busy");
				busy = true;
				try {
					return await new Promise((res, rej) => {
						const turn = { message, finish: (text = "# 답\n\n설명") => { onDelta?.(text); res(text); } };
						signal?.addEventListener("abort", () => rej(new CancelledError()), { once: true });
						turns.push(turn);
					});
				} finally {
					busy = false;
				}
			},
			steer: () => true,
			close() {},
		};
	};
	return { once, conversation, turns };
}

function setup(runner) {
	const notices = [];
	const asks = createAsk({
		runner,
		providerOf: () => ({ id: "fake", transcript: async () => TRANSCRIPT }),
		prompts: { docent: "docent", planner: "planner", domains: "domains" },
		notify: (sessionId, profileId, payload) => notices.push({ sessionId, profileId, payload }),
	});
	return { asks, notices };
}

const until = async (check) => {
	const deadline = Date.now() + 3000;
	while (!check() && Date.now() < deadline) await pause(5);
	assert.ok(check(), "condition never held");
};

test("questions on one thread run one at a time in arrival order, and each answers", async () => {
	const runner = scriptedRunner();
	const { asks } = setup(runner);
	const { id: profileId } = await createProfile("순서");
	const sessionId = "fake:order";
	const first = await asks.open({ id: sessionId, profileId, question: "첫 질문", focus, auto: true, requestId: "a" });
	await until(() => runner.turns.length === 1);
	const second = await asks.open({ id: sessionId, profileId, question: "둘째 질문", focus, requestId: "b" });
	const third = await asks.open({ id: sessionId, profileId, question: "셋째 질문", focus, requestId: "c" });
	await pause(100);
	assert.equal(runner.turns.length, 1, "a later question started while the thread was busy");
	runner.turns[0].finish();
	await first.done;
	await until(() => runner.turns.length === 2);
	assert.match(runner.turns[1].message, /둘째 질문/);
	runner.turns[1].finish();
	await second.done;
	await until(() => runner.turns.length === 3);
	assert.match(runner.turns[2].message, /셋째 질문/);
	runner.turns[2].finish();
	await third.done;
	assert.deepEqual((await history(sessionId, profileId)).map((row) => row.question), ["첫 질문", "둘째 질문", "셋째 질문"]);
});

test("different threads of one session do not wait for each other", async () => {
	const runner = scriptedRunner();
	const { asks } = setup(runner);
	const { id: profileId } = await createProfile("병렬");
	const whole = await asks.open({ id: "fake:parallel", profileId, question: "전체 질문", requestId: "w" });
	const card = await asks.open({ id: "fake:parallel", profileId, question: "카드 질문", focus, requestId: "f" });
	await until(() => runner.turns.length === 2);
	for (const turn of runner.turns) turn.finish();
	await Promise.all([whole.done, card.done]);
});

test("stopping a question that is still waiting its turn leaves no record and lets the next one run", async () => {
	const runner = scriptedRunner();
	const { asks } = setup(runner);
	const { id: profileId } = await createProfile("대기 중단");
	const sessionId = "fake:cancel";
	const first = await asks.open({ id: sessionId, profileId, question: "첫 질문", requestId: "a" });
	await until(() => runner.turns.length === 1);
	const waiting = await asks.open({ id: sessionId, profileId, question: "멈출 질문", requestId: "b" });
	const after = await asks.open({ id: sessionId, profileId, question: "다음 질문", requestId: "c" });
	const lines = [];
	waiting.subscribe((line) => lines.push(line.type));
	assert.equal(await asks.cancel({ profileId, requestId: "b" }), true);
	await assert.rejects(waiting.done, (error) => error.cancelled === true);
	assert.deepEqual(lines, ["queued", "cancelled"]);
	runner.turns[0].finish();
	await first.done;
	await until(() => runner.turns.length === 2);
	assert.match(runner.turns[1].message, /다음 질문/);
	runner.turns[1].finish();
	await after.done;
	assert.deepEqual((await history(sessionId, profileId)).map((row) => row.question), ["첫 질문", "다음 질문"]);
});

test("a correction sent while the field is being judged is folded into the question", async () => {
	let releaseJudge;
	const judged = new Promise((res) => { releaseJudge = res; });
	const runner = scriptedRunner({ domains: async () => { await judged; return JSON.stringify(["frontend"]); } });
	const { asks } = setup(runner);
	const { id: profileId } = await createProfile("판정 중 보정");
	await updateProfile(profileId, { domainDifficulties: { frontend: "HARD" } });
	const job = await asks.open({ id: "fake:steer", profileId, question: "이 선택지 뭐야?", requestId: "s" });
	await until(() => job.stage === "planning");
	await asks.steer({ profileId, requestId: "s", message: "리얼타임 쪽 말이야" });
	releaseJudge();
	await until(() => runner.turns.length === 1);
	assert.match(runner.turns[0].message, /이 선택지 뭐야\?\n\(바로잡기\) 리얼타임 쪽 말이야/);
	runner.turns[0].finish();
	const answer = await job.done;
	assert.equal(answer.difficulty, "HARD");
	const [row] = await history("fake:steer", profileId);
	assert.deepEqual(row.steers, ["리얼타임 쪽 말이야"]);
});

test("a failed classification keeps the answer and tells the open page with a warning", async () => {
	const runner = scriptedRunner({ plan: () => { throw new Error("planner down"); } });
	const { asks, notices } = setup(runner);
	const { id: profileId } = await createProfile("분류 실패");
	const job = await asks.open({ id: "fake:classify", profileId, question: "지금 뭐 했어?", requestId: "k" });
	await until(() => runner.turns.length === 1);
	runner.turns[0].finish();
	const answer = await job.done;
	await until(() => notices.length === 1);
	assert.equal(notices[0].payload.recordId, answer.recordId);
	assert.match(notices[0].payload.answer.learning.warning, /학습 분류를 실행하지 못했어요/);
});
