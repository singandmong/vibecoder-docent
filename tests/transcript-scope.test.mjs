import assert from "node:assert/strict";
import test from "node:test";
import { sourceScope } from "../app/learning.mjs";
import { codexAdapter } from "../scripts/transcript-codex.mjs";
import { ompAdapter } from "../scripts/transcript-omp.mjs";
import { jsonl } from "./session-fixture.mjs";

test("sessions without a working folder get no project scope instead of sharing one", () => {
	const omp = ompAdapter.transcript(jsonl([{ type: "session", id: "a" }, { type: "message", message: { role: "user", content: "질문" } }]), "a.jsonl");
	const codex = codexAdapter.transcript(jsonl([
		{ type: "session_meta", payload: { id: "b" } },
		{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "다른 질문" }] } },
	]), "b.jsonl");
	// 모델이 읽는 전사에는 모른다는 표시가 그대로 남는다.
	assert.match(omp, /^- 작업 폴더: \?$/m);
	for (const [id, md] of [["omp:a.jsonl", omp], ["codex:b.jsonl", codex], ["peer:c.jsonl", omp]]) {
		const scope = sourceScope(id, id.startsWith("peer") ? "peer" : null, md);
		assert.equal(scope.project, null, id);
		assert.equal(scope.cwd, null, id);
	}
	const known = ompAdapter.transcript(jsonl([{ type: "session", id: "d", cwd: "/work/app" }]), "d.jsonl");
	assert.deepEqual([sourceScope("omp:d.jsonl", null, known).project, sourceScope("peer:d.jsonl", "mini", known).project], ["project:local:/work/app", "project:mini:/work/app"]);
});
