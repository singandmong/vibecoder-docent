import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "docent-learning-test-"));
process.env.DOCENT_HOME = home;
const learning = await import("../app/learning.mjs");
const records = await import("../app/store.mjs");
const { history } = records;
const source = { sessionId: "claude:project/test.jsonl", project: "project:local:/project", fingerprint: "source-version", cwd: "/project" };
const answer = { raw: "답변", headline: "답변", difficulty: "HARD", citations: [] };

const classify = (context, priorId = null, relation = "same-incident") => learning.parsePlan(JSON.stringify({
	kind: "why", domains: ["frontend"], concepts: [{ concept: "검색 상태", scope: "general", targets: ["code"], domains: ["frontend"], doubt: "왜 검색 중 버튼을 막는가", priorId, sameDoubt: Boolean(priorId), relation, strategy: "단계 추적" }],
}), context);

/** 서버의 요청 흐름과 같다: 시작 기록 → 생성 → 완료. 저장된 결과가 있으면 재생한다. */
async function ask(profileId, requestId, payload, generate) {
	const begun = await records.beginRequest(profileId, requestId, records.requestSignature(payload));
	if (begun.answer) return begun.answer;
	if (begun.error) throw begun.error;
	return generate(begun.request);
}

/** 답을 먼저 저장하고, 뒤에서 학습 분류를 붙인다 (ADR 0032). */
async function finish(request, context, plan) {
	const { response, startedAt } = await records.completeAnswer(request, context, answer, {});
	return learning.applyClassification(context, response.recordId, plan, startedAt);
}

test("a fresh install starts with pre-explanation off for the default profile and for new profiles", async () => {
	assert.equal((await learning.profile("default")).autoExplain, false);
	assert.equal((await learning.createProfile("새 사람")).autoExplain, false);
});

test("learning preserves profile isolation, explicit feedback, repeat and retry boundaries", async () => {
	try {
		const alice = await learning.createProfile("Alice");
		const bob = await learning.createProfile("Bob");
		await learning.updateProfile(alice.id, { defaultDifficulty: "NORMAL", domainDifficulties: { frontend: "HARD" } });
		const context = await learning.planningContext(alice.id, source, "왜 막아?", false);
		const plan = classify(context);
		const titled = (title) => learning.parsePlan(JSON.stringify({ kind: "why", domains: [], concepts: [], keywords: [], title }), context).title;
		assert.equal(titled("  로그인 방식 선택 "), "로그인 방식 선택");
		assert.equal(titled("x".repeat(41)), "");
		assert.equal(titled(3), "");
		let invocations = 0;
		const generate = async (request) => { invocations++; return finish(request, context, plan); };
		const first = await ask(alice.id, "first", { question: context.question }, generate);
		const duplicate = await ask(alice.id, "first", { question: context.question }, generate);
		assert.equal(invocations, 1);
		assert.equal(first.recordId, duplicate.recordId);
		const id = first.learning.concepts[0].id;
		assert.deepEqual(await learning.learningItems(bob.id), []);
		assert.deepEqual(await history(undefined, bob.id), []);
		await assert.rejects(learning.feedback(id, bob.id, "understood"), { status: 404 });
		await learning.feedback(id, alice.id, "understood", "");

		const repeatContext = await learning.planningContext(alice.id, source, "다시 설명해줘", false);
		const repeatPlan = classify(repeatContext, id);
		const repeated = await ask(alice.id, "repeat", {}, (request) => finish(request, repeatContext, repeatPlan));
		assert.equal(repeated.learning.repeated, true);
		assert.equal(repeated.learning.concepts[0].status, "unresolved");
		assert.notEqual(repeatPlan.concepts[0].strategy, plan.concepts[0].strategy);

		await learning.feedback(id, alice.id, "understood", "理解できた");
		const autoContext = await learning.planningContext(alice.id, source, "自動説明", true);
		const autoPlan = classify(autoContext, id);
		const automatic = await ask(alice.id, "auto", {}, (request) => finish(request, autoContext, autoPlan));
		assert.equal(automatic.learning.repeated, false);
		assert.equal(automatic.learning.concepts[0].status, "understood");
		const item = (await learning.learningItems(alice.id))[0];
		assert.equal(item.questionCount, 2);
		assert.equal(item.autoCount, 1);
		assert.equal(item.explanations.length, 3);
		assert.equal(item.explanations[0].explanation, answer.raw);

		const newContext = await learning.planningContext(alice.id, { ...source, fingerprint: "new-incident" }, "別の障害", false);
		const newPlan = classify(newContext, id, "new-incident");
		const fresh = await ask(alice.id, "new-incident", {}, (request) => finish(request, newContext, newPlan));
		assert.equal(fresh.learning.repeated, false);

		const pendingContext = await learning.planningContext(alice.id, source, "再説明", false);
		const pendingPlan = classify(pendingContext, id);
		await ask(alice.id, "feedback-during-answer", {}, async (request) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await learning.feedback(id, alice.id, "review", "後で復習");
			return finish(request, pendingContext, pendingPlan);
		});
		assert.equal((await learning.learningItems(alice.id))[0].status, "review");
		await assert.rejects(ask(alice.id, "first", { question: "changed" }, generate), { status: 409 });
		const replay = await ask(alice.id, "first", { question: context.question }, generate);
		assert.equal(replay.recordId, first.recordId);
		assert.equal(invocations, 1);
		// 중단한 요청은 같은 ID로 다시 보내도 모델을 부르지 않고 중단으로 남는다.
		await assert.rejects(ask(alice.id, "stopped", {}, async (request) => {
			await records.settleRequest(request, { cancelled: true });
			throw Object.assign(new Error("stopped"), { cancelled: true });
		}), { cancelled: true });
		await assert.rejects(ask(alice.id, "stopped", {}, generate), { status: 409, cancelled: true });
		assert.equal(invocations, 1);
		const unknown = learning.parsePlan('{"kind":"why","domains":["frontend"],"concepts":[{"priorId":"someone-else"}]}', context);
		assert.equal(unknown.classification, "unknown");
		assert.deepEqual(unknown.concepts, []);
		const stored = JSON.parse(await readFile(join(home, "learning.json"), "utf8"));
		assert.equal(stored.records.length, 5);
		assert.ok(Object.values(stored.requests).every((request) => !Object.hasOwn(request, "answer")));
		assert.ok(stored.items.every((value) => value.explanations.every((entry) => !Object.hasOwn(entry, "explanation") && !Object.hasOwn(entry, "evidence"))));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
