import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { claudeAdapter } from "../scripts/transcript-claude.mjs";
import { jsonl, sessionFixture } from "./session-fixture.mjs";

const at = (s) => `2026-09-25T00:00:${String(s).padStart(2, "0")}Z`;
const fixture = [
	{ type: "user", sessionId: "sess-1", cwd: "/work/claude", timestamp: at(0), message: { content: "로그인 버그 조사해줘" } },
	{ type: "assistant", sessionId: "sess-1", timestamp: at(1), message: { model: "claude-test", content: [{ type: "text", text: "조사를 맡길게요." }, { type: "tool_use", id: "spawn", name: "Agent", input: { description: "원인 조사" } }] } },
	{ type: "user", sessionId: "sess-1", timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "spawn", is_error: true, content: "agent crashed" }] } },
	{ type: "assistant", sessionId: "sess-1", isSidechain: true, timestamp: at(3), message: { content: [{ type: "text", text: "사이드체인 발화" }] } },
	{
		type: "assistant", sessionId: "sess-1", timestamp: at(4), message: {
			content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "다시 시도할까요?", options: [{ label: "예" }] }] } }],
		},
	},
];
const child = [
	{ type: "user", uuid: "c1", timestamp: at(1), message: { content: "로그인 코드에서 원인을 찾아" } },
	{ type: "assistant", uuid: "c2", timestamp: at(2), message: { content: [{ type: "text", text: "토큰 만료 처리가 빠졌어요." }] } },
];
const subagents = ".claude/projects/-work-claude/sess-1/subagents";

test("claude session file through the adapter: subagents folded in, whole file and a cut mid-line", async (t) => {
	const file = await sessionFixture(t, claudeAdapter, "-work-claude/sess-1.jsonl", fixture, {
		[`${subagents}/agent-child.jsonl`]: `${jsonl(child)}\n`,
		[`${subagents}/agent-child.meta.json`]: JSON.stringify({ agentType: "scout", toolUseId: "spawn", description: "원인 조사" }),
	});
	assert.deepEqual(file.meta, { title: "로그인 버그 조사해줘", cwd: "/work/claude", started: at(0), first: "로그인 버그 조사해줘" });
	assert.ok(file.transcript.startsWith(`# 로그인 버그 조사해줘\n\n- 원본: ${file.path}\n- 작업 폴더: /work/claude\n- 시작: ${at(0)}\n`));
	// 서브에이전트 전사는 Agent 호출 줄 아래에 접혀 들어가고, 사이드체인은 빠진다.
	assert.match(file.transcript, /→ Agent\(원인 조사\)[\s\S]*서브에이전트 scout 「원인 조사」 이 한 일:[\s\S]*토큰 만료 처리가 빠졌어요\./);
	assert.ok(!file.transcript.includes("사이드체인 발화"));
	assert.deepEqual(file.events.map((e) => e.kind), ["user", "assistant", "error", "question"]);
	// 오류 줄 가운데서 자르면 꼬리는 그 뒤(사이드체인은 빠지고 질문만).
	const cut = await file.cutAt(2);
	assert.deepEqual(cut.events, file.events.slice(3));
	assert.deepEqual(cut.meta, file.meta);

	// 서브에이전트가 진행되면 본 파일이 그대로여도 변경 표시가 바뀌고 전사에 새 일이 들어간다.
	const before = await claudeAdapter.stamp(file.path);
	await appendFile(join(file.home, `${subagents}/agent-child.jsonl`), `${JSON.stringify({ type: "assistant", uuid: "c3", timestamp: at(5), message: { content: [{ type: "text", text: "고친 방법도 정리했어요." }] } })}\n`);
	assert.notEqual(await claudeAdapter.stamp(file.path), before);
	assert.match(await claudeAdapter.transcript(fixture.map((e) => JSON.stringify(e)).join("\n"), file.path), /고친 방법도 정리했어요\./);
});

test("claude sessions without a user utterance are hidden from the list", async (t) => {
	const file = await sessionFixture(t, claudeAdapter, "-work-claude/login.jsonl", [
		{ type: "user", isMeta: true, cwd: "/work/claude", timestamp: at(0), message: { content: "<local-command-stdout>Login successful</local-command-stdout>" } },
		{ type: "assistant", timestamp: at(1), message: { content: [{ type: "text", text: "안녕하세요" }] } },
	]);
	assert.equal(file.meta, null);
	assert.match(file.transcript, /^# \(제목 없음\)$/m);
});
