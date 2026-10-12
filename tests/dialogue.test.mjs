import assert from "node:assert/strict";
import test from "node:test";
import { focusOfEvent, parseCards, parseFocus, recentDialogue, threadRecords } from "../app/dialogue.mjs";
import { threadKey } from "../app/thread.mjs";

const record = (n, extra = {}) => ({ question: `질문 ${n}`, answer: { headline: `결론 ${n}`, explain: `설명 ${n}` }, ...extra });

test("the classifier sees the latest six turns the user actually read in the thread, including pre-explanations and corrections", () => {
	const records = [
		...Array.from({ length: 6 }, (_, n) => record(n)),
		record("자동", { auto: true }),
		record("보정", { steers: ["리얼타임 질문 말이야"] }),
	];
	const recent = recentDialogue(records);
	assert.deepEqual(recent.map((turn) => turn.question), ["질문 2", "질문 3", "질문 4", "질문 5", "질문 자동", "질문 보정"]);
	assert.deepEqual(recent.at(-1).steers, ["리얼타임 질문 말이야"]);
});

test("a card event and the answers asked about it share one server-issued thread", () => {
	const { focus, thread } = focusOfEvent({ kind: "question", sub: "question", text: "보유 계정 기준으로 어디에 리얼타임을 둘까?", options: [{ label: "Supabase Realtime", description: "이미 보유" }, { label: "Colyseus Cloud" }] });
	assert.match(focus.text, /Supabase Realtime — 이미 보유/);
	assert.match(focus.text, /Colyseus Cloud/);
	assert.match(thread, /^[a-f0-9]{16}$/);
	// 브라우저가 보낸 질문 대상이 공백만 달라도 같은 스레드다.
	assert.equal(threadKey(focus.text.replace(/\n/g, "\n\n")), thread);
	assert.equal(threadKey(""), "");
	assert.deepEqual(parseCards([{ thread, label: " 리얼타임 위치 " }]), [{ thread, label: "리얼타임 위치" }]);
	assert.throws(() => parseCards([{ thread: "../x", label: "a" }]), { status: 400 });
});

test("a malformed focus is rejected instead of silently asking about the whole session", () => {
	for (const invalid of [{}, { label: "제목" }, { label: "", text: "내용" }, { label: "x".repeat(201), text: "내용" }, { label: "제목", text: "x".repeat(8001) }, "제목"]) {
		assert.throws(() => parseFocus(invalid), { status: 400 });
	}
	assert.equal(parseFocus(undefined), null);
});

test("each card keeps its own conversation; whitespace differences stay in the same thread", () => {
	const card = { label: "로그인", text: "이메일과  소셜 중\n선택" };
	const records = [record("세션"), record("카드", { focus: { label: "로그인", text: "이메일과 소셜 중 선택" } }), record("다른 카드", { focus: { label: "배포", text: "배포 결과" } })];
	assert.deepEqual(threadRecords(records, card).map((r) => r.question), ["질문 카드"]);
	assert.deepEqual(threadRecords(records, null).map((r) => r.question), ["질문 세션"]);
});
