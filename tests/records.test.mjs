// 문답·요청 기록 module 을 임시 DOCENT_HOME 으로 시험한다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "docent-records-test-"));
process.env.DOCENT_HOME = home;
const records = await import("../app/store.mjs");
const { createProfile } = await import("../app/learning.mjs");
const { threadKey } = await import("../app/thread.mjs");

test("every read and write refuses a profile that does not exist", async () => {
	const missing = "no-such-profile";
	const focus = { label: "카드", text: "내용" };
	for (const attempt of [
		() => records.history(undefined, missing),
		() => records.favorites(missing),
		() => records.setFavorite(missing, "s", focus, true),
		() => records.saveKeywords(missing, {}),
		() => records.storedRequest(missing, "r", "sig"),
		() => records.beginRequest(missing, "r", "sig"),
	]) await assert.rejects(attempt(), { status: 404 });
	await assert.rejects(records.history(undefined, ""), { status: 400 });
});

test("old questions.jsonl rows belong to the default profile only, tagged with the same thread as new answers", async () => {
	await writeFile(join(home, "questions.jsonl"), [
		JSON.stringify({ ts: "2026-01-01T00:00:00Z", sessionId: "s1", question: "옛 질문", focus: { label: "카드", text: "이메일과  소셜 중\n선택" }, answer: { raw: "옛 답" } }),
		"{잘린 줄",
		"",
	].join("\n"));
	const other = await createProfile("다른 사람");
	const [legacy] = await records.history("s1", "default");
	assert.equal(legacy.question, "옛 질문");
	assert.equal(legacy.thread, threadKey("이메일과 소셜 중 선택"));
	assert.deepEqual(await records.history("s1", other.id), []);
	await records.saveKeywords("default", { [records.rowKey(legacy)]: [{ term: "OAuth", gloss: "다른 서비스 계정으로 로그인" }] });
	assert.deepEqual((await records.history("s1", "default"))[0].keywords, [{ term: "OAuth", gloss: "다른 서비스 계정으로 로그인" }]);
});
