// 스레드 소속과 대화 목록 (ADR 0053). 서버가 붙인 스레드와 화면의 소속 규칙이 같은 문답에 같은 답을 내는지 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DOCENT_HOME = await mkdtemp(join(tmpdir(), "docent-conversations-test-"));
process.env.TYPESAFE_API_KEY = "";
const { answerFocus, cardsPayload, conversationList, excerpt, threadRows } = await import("../app/conversations.mjs");
const { threadKey, threadOf, withThreads } = await import("../app/thread.mjs");
const { focusOfEvent } = await import("../app/dialogue.mjs");
const { createAsk } = await import("../app/ask.mjs");
const { history } = await import("../app/store.mjs");
const { createProfile } = await import("../app/learning.mjs");

const S = "fake:session";
const answer = (n) => ({ headline: `결론 ${n}`, explain: `설명 ${n}`, details: [`자세히 ${n}`] });
const row = (question, ts, extra = {}) => ({ sessionId: S, question, ts, answer: answer(question), ...extra });
const card = (text) => ({ kind: "assistant", sub: "result", text, ...focusOfEvent({ sub: "result", text }) });
const questions = (rows) => rows.map((entry) => entry.question);

test("a re-explained answer from the whole-session conversation stays in the whole-session conversation", () => {
	const first = row("전체 질문", "2026-10-12T01:00:00Z");
	const again = row("다시 설명", "2026-10-12T01:01:00Z", { focus: answerFocus(first.answer) });
	const twice = row("또 다시", "2026-10-12T01:02:00Z", { focus: answerFocus(again.answer) });
	const rows = withThreads([first, again, twice]);
	assert.deepEqual(rows.map((entry) => entry.thread), ["", "", ""]);
	assert.deepEqual(questions(threadRows(rows, "")), ["전체 질문", "다시 설명", "또 다시"]);
	const list = conversationList(rows, []);
	assert.deepEqual(list.map((option) => [option.kind, option.count]), [["all", 3]]);
	// 같은 답 내용이라도 다른 세션의 답이면 따로다.
	assert.notEqual(threadOf("fake:other", answerFocus(first.answer), rows), "");
});

test("a re-explained answer inside a card conversation stays in that card's thread", () => {
	const source = card("배포를 마쳤어요. 서버 두 대를 바꿨습니다.");
	const first = row("카드 질문", "2026-10-12T01:00:00Z", { focus: source.focus });
	const again = row("다시 설명", "2026-10-12T01:01:00Z", { focus: answerFocus(first.answer) });
	const rows = withThreads([first, again]);
	assert.deepEqual(rows.map((entry) => entry.thread), [source.thread, source.thread]);
	assert.deepEqual(questions(threadRows(rows, "")), []);
});

test("when the same answer text exists in two threads, the earliest one decides and later records never move it", () => {
	const same = answer("같은 답");
	const whole = row("전체 질문", "2026-10-12T01:00:00Z", { answer: same });
	const cardRow = row("카드 질문", "2026-10-12T01:01:00Z", { answer: same, focus: { label: "카드", text: "카드 내용" } });
	const opened = threadOf(S, answerFocus(same), withThreads([whole, cardRow]));
	const again = row("다시 설명", "2026-10-12T01:03:00Z", { focus: answerFocus(same) });
	const later = row("카드 다시", "2026-10-12T01:02:00Z", { answer: same, focus: { label: "카드", text: "카드 내용" } });
	assert.equal(opened, "");
	assert.equal(withThreads([whole, cardRow, later, again]).at(-1).thread, opened);
});

test("a saved thread whose card is not in the list gets its own conversation, not the whole-session one", () => {
	const rows = withThreads([
		row("전체 질문", "2026-10-12T01:00:00Z"),
		row("지난 카드 질문", "2026-10-12T01:01:00Z", { focus: { label: "지난 카드", text: "예전 결과" } }),
	]);
	const list = conversationList(rows, []);
	assert.deepEqual(list.map((option) => [option.kind, option.label, option.count]), [["all", "세션 전체 대화", 1], ["saved", "지난 카드", 1]]);
	assert.deepEqual(list[1].focus, { label: "지난 카드", text: "예전 결과" });
	assert.deepEqual(questions(threadRows(rows, "")), ["전체 질문"]);
	assert.deepEqual(questions(threadRows(rows, list[1].thread)), ["지난 카드 질문"]);
});

test("duplicate cards are one conversation and the cards sent with a question are only server-issued ones", () => {
	const a = card("검색 결과를 정리했어요"), b = card("다음 계획을 세웠어요");
	const list = conversationList([], [a, { ...a, past: true }, b]);
	assert.deepEqual(list.map((option) => [option.kind, option.thread]), [["all", ""], ["card", a.thread], ["card", b.thread]]);
	assert.equal(list[1].card, a);
	const many = Array.from({ length: 45 }, (_, n) => ({ thread: threadKey(`카드 ${n}`), label: `카드 ${n}` }));
	const sent = cardsPayload([
		{ thread: a.thread, label: `  ${"긴 제목".repeat(80)}  ` },
		{ thread: a.thread, label: "같은 카드" },
		{ thread: "", label: "스레드 없음" },
		{ thread: "../x", label: "잘못된 스레드" },
		{ thread: b.thread, label: "   " },
		...many,
	]);
	assert.equal(sent.length, 40);
	assert.deepEqual(sent.at(-1), many.at(-1));
	assert.ok(sent.every((entry) => /^[a-f0-9]{16}$/.test(entry.thread) && entry.label.trim() && entry.label.length <= 200));
	assert.equal(new Set(sent.map((entry) => entry.thread)).size, sent.length);
	assert.deepEqual(cardsPayload([{ thread: a.thread, label: `  ${"긴 제목".repeat(80)}  ` }])[0].label.length, 200);
});

test("saved conversations are ordered by their last activity, cards keep arrival order", () => {
	const shown = card("화면에 있는 카드");
	const rows = withThreads([
		row("옛 주제 첫 질문", "2026-10-12T01:00:00Z", { focus: { label: "옛 주제", text: "옛 주제" } }),
		row("새 주제", "2026-10-12T02:00:00Z", { focus: { label: "새 주제", text: "새 주제" } }),
		row("카드 질문", "2026-10-12T02:30:00Z", { focus: shown.focus }),
		row("옛 주제 다시", "2026-10-12T03:00:00Z", { focus: { label: "옛 주제", text: "옛 주제" } }),
		row("중간 주제", "2026-10-12T02:10:00Z", { focus: { label: "중간 주제", text: "중간 주제" } }),
	].sort((x, y) => x.ts.localeCompare(y.ts)));
	const list = conversationList(rows, [shown]);
	assert.deepEqual(list.map((option) => [option.kind, option.label, option.lastTs]), [
		["all", "세션 전체 대화", null],
		["card", shown.focus.label, "2026-10-12T02:30:00Z"],
		["saved", "옛 주제", "2026-10-12T03:00:00Z"],
		["saved", "중간 주제", "2026-10-12T02:10:00Z"],
		["saved", "새 주제", "2026-10-12T02:00:00Z"],
	]);
});

test("whitespace variants of the same focus are one thread", () => {
	const rows = withThreads([
		row("첫 질문", "2026-10-12T01:00:00Z", { focus: { label: "로그인", text: "이메일과  소셜 중\n선택" } }),
		row("둘째 질문", "2026-10-12T01:01:00Z", { focus: { label: "로그인", text: " 이메일과 소셜 중 선택 " } }),
	]);
	assert.equal(rows[0].thread, rows[1].thread);
	assert.equal(threadOf(S, { label: "로그인", text: "이메일과 소셜\t중 선택" }, rows), rows[0].thread);
	assert.deepEqual(conversationList(rows, []).map((option) => [option.kind, option.count]), [["all", 0], ["saved", 2]]);
	// 긴 답의 줄임 표시는 카드와 같다. 다시 설명할 때 보낸 내용이 같은 답을 가리킨다.
	assert.equal(answerFocus({ headline: "결론", explain: "가".repeat(9000) }).text, excerpt(`결론\n\n${"가".repeat(9000)}`));
});

/** 대화마다 받은 질문을 기록하고 바로 답하는 runner. 새 대화가 몇 번 열렸는지 센다. */
function answeringRunner() {
	const conversations = [];
	let n = 0;
	return {
		conversations,
		once: async ({ system }) => (system === "planner" ? JSON.stringify({ kind: "why", domains: [], concepts: [] }) : "[]"),
		conversation() {
			const messages = [];
			conversations.push(messages);
			return {
				alive: true, busy: false, steer: () => true, close() {},
				async ask(message, { onDelta }) {
					messages.push(message);
					const text = `결론 ${++n}\n\n설명 ${n}`;
					onDelta?.(text);
					return text;
				},
			};
		},
	};
}

test("the server's thread for a question and the client's conversation rows agree on the same records", async () => {
	const runner = answeringRunner();
	const asks = createAsk({
		runner,
		providerOf: () => ({ id: "fake", transcript: async () => "# 세션\n\n## user\n\n설명해줘\n" }),
		prompts: { docent: "docent", planner: "planner", domains: "domains" },
		notify: () => {},
	});
	const { id: profileId } = await createProfile("대화 목록");
	const first = await (await asks.open({ id: S, profileId, question: "지금 뭐 했어?", requestId: "whole" })).done;
	const job = await asks.open({ id: S, profileId, question: "다른 방식으로 다시 설명해줘", focus: answerFocus(first), requestId: "again" });
	assert.equal(job.meta.thread, "");
	const again = await job.done;
	assert.equal(again.thread, "");
	const rows = await history(S, profileId);
	assert.deepEqual(rows.map((entry) => entry.thread), ["", ""]);
	const whole = conversationList(rows, []);
	assert.deepEqual(whole.map((option) => [option.kind, option.count]), [["all", 2]]);
	// 다시 설명은 세션 전체 대화의 같은 대화에서 이어 묻는다.
	assert.equal(runner.conversations.length, 1);
	assert.equal(runner.conversations[0].length, 2);
	await asks.close();
});
