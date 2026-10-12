import assert from "node:assert/strict";
import test from "node:test";
import { ompAdapter } from "../scripts/transcript-omp.mjs";
import { claudeAdapter } from "../scripts/transcript-claude.mjs";
import { prepareEvidence, retainEvidence, extractCitations, resolveEvidence } from "../app/evidence.mjs";
import { trimTranscript } from "../app/trim.mjs";
import { jsonl, sessionFixture } from "./session-fixture.mjs";

const session = "omp:project/session.jsonl";
const message = (id, role, text) => ({ type: "message", id, message: { role, content: [{ type: "text", text }] } });
const normalize = (entries) => ompAdapter.transcript(jsonl(entries));

test("existing citations survive appends, but not edited source content", () => {
	const entries = [{ type: "session", id: "session" }, message("u", "user", "질문"), message("a", "assistant", "설명"), {
		type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: { i: "Reading source" } }] },
	}];
	const before = prepareEvidence(normalize(entries), session);
	const ids = [...before.sources.keys()];
	const appended = [...entries, { type: "message", id: "result", message: { role: "toolResult", toolCallId: "tool", content: "원문" } }];
	for (const id of ids) assert.equal(resolveEvidence(normalize(appended), session, id).selected.text, before.sources.get(id).text);
	const changed = structuredClone(entries);
	changed[2].message.content[0].text = "바뀐 설명";
	assert.equal(resolveEvidence(normalize(changed), session, ids[1]).available, false);
	const cited = extractCitations(`설명\n근거: [ref:${ids[1]}] [ref:${ids[1]}] [ref:s_${"0".repeat(40)}]`, before);
	assert.deepEqual(cited.citations.map((citation) => citation.id), [ids[1]]);
	assert.equal(cited.raw, "설명");
});

test("trimming does not split literal user headings or corrupt retained code", () => {
	const literal = "코드 예제\n\n\n```md\n## user\n  literal indentation\n```";
	const entries = [{ type: "session", id: "long" }];
	for (let index = 0; index < 20; index++) entries.push(message(`u${index}`, "user", `사용자 질문 ${index}`), message(`a${index}`, "assistant", "긴 설명 ".repeat(400) + (index === 19 ? literal : "")));
	const prepared = prepareEvidence(normalize(entries), session);
	const shortened = trimTranscript(prepared.transcript, 12_000);
	const retained = retainEvidence(prepared, shortened);
	const last = [...prepared.sources.values()].at(-1);
	assert.equal(retained.sources.get(last.id)?.text, last.text);
	assert.equal(resolveEvidence(normalize(entries), session, last.id).selected.text, last.text);
	const first = [...prepared.sources.keys()][0];
	assert.equal(retained.sources.has(first), false);
	assert.deepEqual(extractCitations(`説明\n근거: [ref:${first}]`, retained).citations, []);
	assert.match(shortened, /## user\n\n사용자 질문 0/);
});

test("child citations resolve to the child, with distinct duplicate UUID fragments", async (t) => {
	const main = [{ type: "user", uuid: "user", message: { content: "작업해줘" } }, { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "spawn", name: "Agent", input: { description: "조사" } }] } }];
	const child = [{ type: "assistant", uuid: "fragment", message: { content: [{ type: "text", text: "원인 조사" }] } }, { type: "assistant", uuid: "fragment", message: { content: [{ type: "text", text: "원인 확인" }] } }];
	const subagents = ".claude/projects/project/session/subagents";
	const { transcript: md } = await sessionFixture(t, claudeAdapter, "project/session.jsonl", main, {
		[`${subagents}/agent-child.jsonl`]: jsonl(child),
		[`${subagents}/agent-child.meta.json`]: JSON.stringify({ toolUseId: "spawn", agentType: "scout" }),
	});
	const sources = [...prepareEvidence(md, "claude:project/session.jsonl").sources.values()].filter((source) => source.agent);
	assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
	for (const phrase of ["원인 조사", "원인 확인"]) {
		const source = sources.find((item) => item.text.includes(phrase));
		assert.ok(source);
		const result = resolveEvidence(md, "claude:project/session.jsonl", source.id);
		assert.equal(result.selected.agent, source.agent);
		assert.equal(result.selected.text, source.text);
	}
});
