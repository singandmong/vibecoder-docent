import assert from "node:assert/strict";
import test from "node:test";
import { catalog, firstModel, fixture as startFixture, secondModel, until } from "./omp-fixture.mjs";

/** 모델 호출 기록에서 이 테스트가 보는 필드만. */
async function fixture(t) {
	const f = await startFixture(t);
	const calls = f.calls.bind(f);
	f.calls = async () => (await calls()).map(({ planning, model, provider }) => ({ planning, model, provider }));
	return f;
}

const rows = async (f, profileId = "default") => (await f.api(`/api/history?profileId=${profileId}`)).body;

test("profile model selection is exact, isolated, snapshotted for the answer and its later classification, and replayed from history", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.api("/api/profiles")).body[0].model, null);
	const listed = await f.api("/api/models");
	assert.equal(listed.status, 200);
	assert.equal(listed.body.source, "omp");
	assert.deepEqual(listed.body.models, catalog.models.slice(0, 2).map(({ selector, provider, name, cost }) => ({ selector, provider, name, cost })));
	assert.equal(JSON.stringify(listed.body).includes("never-expose-catalog-secret"), false);
	const other = (await f.api("/api/profiles", "POST", { name: "Other profile" })).body;
	assert.equal((await f.api("/api/profiles/default", "PATCH", { model: firstModel })).status, 200);
	for (const invalid of ["cheap", "fixture/vendor/cheap ", "fixture/embed", 4]) {
		assert.equal((await f.api("/api/profiles/default", "PATCH", { model: invalid })).status, 400);
	}
	assert.equal((await f.api("/api/profiles")).body.find((p) => p.id === other.id).model, null);
	assert.equal((await f.api("/api/profiles")).body[0].model, firstModel);
	// 답은 분류를 기다리지 않는다. 분류는 요청 시작 때 고른 모델로 뒤에서 돈다.
	await f.control({ holdPlanning: true });
	const result = await f.ask("snapshot");
	assert.equal(result.status, 200);
	assert.equal(result.body.model, firstModel);
	await until(async () => (await f.calls()).some((call) => call.planning));
	assert.equal((await f.api("/api/profiles/default", "PATCH", { model: secondModel })).status, 200);
	await f.release();
	await until(async () => (await rows(f))[0]?.answer.learning.classification !== "pending");
	assert.deepEqual(await f.calls(), [
		{ planning: false, provider: "fixture", model: firstModel },
		{ planning: true, provider: "fixture", model: firstModel },
	]);
	await f.restart();
	assert.equal((await f.api("/api/profiles")).body[0].model, secondModel);
	// A stale/unavailable current catalog must not invalidate an already completed request.
	await f.catalog({ models: [] });
	const replay = await f.ask("snapshot");
	assert.equal(replay.body.recordId, result.body.recordId);
	assert.equal(replay.body.model, firstModel);
	assert.equal((await f.calls()).length, 2);
	assert.equal((await rows(f))[0].answer.model, firstModel);
	assert.deepEqual(await rows(f, other.id), []);
	const stored = await f.stored();
	assert.equal(Object.hasOwn(stored.requests["default:snapshot"], "answer"), false);
	assert.equal((await f.ask("unavailable")).status, 400);
	assert.equal((await f.calls()).length, 2);
});

test("a failed classification never blocks or reroutes the answer, and a failed explanation never falls back to another model", async (t) => {
	const f = await fixture(t);
	await f.api("/api/profiles/default", "PATCH", { model: firstModel });
	await f.control({ failPlanning: true });
	const answered = await f.ask("classification-failed");
	assert.equal(answered.status, 200);
	await until(async () => (await rows(f))[0]?.answer.learning.classification === "unknown");
	assert.match((await rows(f))[0].answer.learning.warning, /학습 분류/);
	assert.deepEqual(await f.calls(), [
		{ planning: false, model: firstModel, provider: "fixture" },
		{ planning: true, model: firstModel, provider: "fixture" },
	]);
	await f.control({ failExplanation: true });
	const failed = await f.ask("explanation-failed");
	assert.equal(failed.status, 502);
	assert.equal(JSON.stringify(failed.body).includes("never-expose-execution-secret"), false);
	assert.deepEqual((await f.calls()).slice(2), [{ planning: false, model: firstModel, provider: "fixture" }]);
	assert.equal((await rows(f)).length, 1);
	await f.api("/api/profiles/default", "PATCH", { model: null });
	assert.deepEqual(await f.ask("explanation-failed"), failed);
	assert.equal((await f.calls()).length, 3);
	await f.catalog({ error: "never-expose-catalog-secret" });
	const catalogFailure = await f.api("/api/models");
	assert.equal(catalogFailure.status, 502);
	assert.equal(JSON.stringify(catalogFailure.body).includes("never-expose-catalog-secret"), false);
});

const modelTurn = (uuid, model, timestamp) => ({ type: "assistant", uuid, timestamp, message: { role: "assistant", model, content: [{ type: "text", text: "작업했어요." }] } });

test("without a profile model the explanation and its classification use the session's last model, and a chosen model wins", async (t) => {
	const f = await fixture(t);
	await f.appendSession(modelTurn("m1", "vendor/cheap", "2026-01-01T00:01:00Z"));
	await f.appendSession(modelTurn("m2", "other", "2026-01-01T00:02:00Z"));
	const probe = await f.api(`/api/session-model?id=${encodeURIComponent(f.sessionId)}`);
	assert.equal(probe.status, 200);
	assert.equal(probe.body.raw, "other");
	assert.equal(probe.body.model.selector, secondModel, "the last marker names the session model");
	assert.equal(JSON.stringify(probe.body).includes("never-expose-catalog-secret"), false);
	const answered = await f.ask("from-session");
	assert.equal(answered.body.model, secondModel);
	assert.equal(answered.body.modelSource, "session");
	await until(async () => (await f.calls()).filter((call) => call.planning).length === 1);
	assert.deepEqual(await f.calls(), [
		{ planning: false, provider: "fixture", model: secondModel },
		{ planning: true, provider: "fixture", model: secondModel },
	]);
	assert.equal((await f.api("/api/profiles/default", "PATCH", { model: firstModel })).status, 200);
	const chosen = await f.ask("chosen", "default", { question: "다른 질문이에요" });
	assert.equal(chosen.body.model, firstModel);
	assert.equal(chosen.body.modelSource, "profile");
});

test("a session model that the catalog cannot name falls back to the omp default and says so", async (t) => {
	const f = await fixture(t);
	await f.appendSession(modelTurn("m1", "claude-unknown-9", "2026-01-01T00:01:00Z"));
	assert.equal((await f.api(`/api/session-model?id=${encodeURIComponent(f.sessionId)}`)).body.model, null);
	const answered = await f.ask("unknown-session-model");
	assert.equal(answered.status, 200);
	assert.equal(answered.body.model, null);
	assert.equal(answered.body.modelSource, "default");
	assert.deepEqual((await f.calls())[0], { planning: false, provider: null, model: null });
});

test("a model scope accepts only catalog models, is stored per profile, and an empty list means every model", async (t) => {
	const f = await fixture(t);
	const other = (await f.api("/api/profiles", "POST", { name: "Other profile" })).body;
	assert.equal(other.modelScope, null);
	assert.equal((await f.api("/api/profiles")).body[0].modelScope, null, "profiles saved before scopes existed read as unrestricted");
	assert.equal((await f.api("/api/profiles/default", "PATCH", { modelScope: [secondModel, secondModel] })).body.modelScope.length, 1, "duplicates collapse");
	for (const invalid of ["fixture/other", [4], ["not/in-catalog"], { 0: secondModel }]) {
		assert.equal((await f.api("/api/profiles/default", "PATCH", { modelScope: invalid })).status, 400);
	}
	assert.deepEqual((await f.api("/api/profiles")).body.find((p) => p.id === "default").modelScope, [secondModel]);
	assert.equal((await f.api("/api/profiles")).body.find((p) => p.id === other.id).modelScope, null);
	assert.equal((await f.api("/api/profiles/default", "PATCH", { modelScope: [] })).body.modelScope, null);
	await f.restart();
	assert.deepEqual((await f.api("/api/profiles/default", "PATCH", { modelScope: [firstModel, secondModel] })).body.modelScope, [firstModel, secondModel]);
});
