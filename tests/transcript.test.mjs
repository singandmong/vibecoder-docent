import assert from "node:assert/strict";
import test from "node:test";
import { ompAdapter } from "../scripts/transcript-omp.mjs";
import { claudeAdapter } from "../scripts/transcript-claude.mjs";
import { prepareEvidence } from "../app/evidence.mjs";

const jsonl = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");

const ompAsk = [
	{ type: "session", id: "session", cwd: "/tmp/work", timestamp: "2026-09-25T00:00:00Z" },
	{ type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "어디에 저장할까?" }] } },
	{
		type: "message", id: "a", message: {
			role: "assistant",
			content: [{
				type: "toolCall", id: "ask-1", name: "ask",
				arguments: {
					i: "저장 위치 묻기",
					questions: [
						{
							id: "where", question: "결과를 어디에 저장할까요?", recommended: 1,
							options: [
								{ label: "docs 폴더", description: "문서와 함께 둔다" },
								{ label: "루트", description: "프로젝트 맨 위에 둔다" },
							],
						},
						{
							id: "format", question: "어떤 형식으로보낼까요?", multi: true,
							options: [{ label: "markdown", description: "읽기 쉬운 문서" }, { label: "json" }],
						},
					],
				},
			}],
		},
	},
];

const claudeAsk = [
	{ type: "user", sessionId: "claude-session", cwd: "/tmp/work", timestamp: "2026-09-25T00:00:00Z", message: { content: "진행 방식을 골라줘" } },
	{
		type: "assistant", sessionId: "claude-session", timestamp: "2026-09-25T00:00:01Z",
		message: {
			role: "assistant",
			content: [{
				type: "tool_use", id: "toolu_1", name: "AskUserQuestion",
				input: {
					questions: [
						{
							question: "어느 브랜치에서 작업할까요?", header: "브랜치", multiSelect: true,
							options: [
								{ label: "main", description: "기본 브랜치" },
								{ label: "feature/docent", description: "도슨트 작업 브랜치" },
							],
						},
						{
							question: "테스트를 돌릴까요?",
							options: [{ label: "돌린다", description: "전체 테스트 실행" }],
						},
					],
				},
			}],
		},
	},
];

/** 질문·선택지가 전사 본문과 하나의 인용 source 안에 모두 보이는지 확인. */
const assertAskVisible = (md, sessionId, phrases) => {
	for (const phrase of phrases) assert.ok(md.includes(phrase), `transcript missing: ${phrase}`);
	const { sources } = prepareEvidence(md, sessionId);
	const source = [...sources.values()].find((item) => phrases.every((phrase) => item.text.includes(phrase)));
	assert.ok(source, "no single source block contains the call, questions, and options");
	assert.match(source.text, /^→ (ask|AskUserQuestion)\(/);
};

test("omp ask call keeps question text and options inside its source block", () => {
	assertAskVisible(ompAdapter.transcript(jsonl(ompAsk), "omp:test/session.jsonl"), "omp:test/session.jsonl", [
		"결과를 어디에 저장할까요?", "어떤 형식으로보낼까요?",
		"docs 폴더", "문서와 함께 둔다", "루트", "프로젝트 맨 위에 둔다",
		"markdown", "읽기 쉬운 문서", "json",
	]);
});

test("claude AskUserQuestion keeps question text and options inside its source block", async () => {
	assertAskVisible(await claudeAdapter.transcript(jsonl(claudeAsk)), "claude:test/session.jsonl", [
		"어느 브랜치에서 작업할까요?", "테스트를 돌릴까요?",
		"main", "기본 브랜치", "feature/docent", "도슨트 작업 브랜치",
		"돌린다", "전체 테스트 실행",
	]);
});

test("answered ask still shows the user answer under the call", () => {
	const answered = [...ompAsk, {
		type: "message", id: "r", message: { role: "toolResult", toolCallId: "ask-1", content: "docs 폴더에 markdown으로" },
	}];
	const md = ompAdapter.transcript(jsonl(answered));
	assert.match(md, /⇒ ask 사용자 답:\n {2}docs 폴더에 markdown으로/);
	assert.ok(md.includes("결과를 어디에 저장할까요?"));
});
