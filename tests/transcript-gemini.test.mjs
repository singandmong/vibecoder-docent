import assert from "node:assert/strict";
import test from "node:test";
import { prepareEvidence } from "../app/evidence.mjs";
import { geminiAdapter } from "../scripts/transcript-gemini.mjs";
import { jsonl, sessionFixture } from "./session-fixture.mjs";

const header = {
	sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	projectHash: "deadbeef",
	startTime: "2026-09-25T01:00:00.000Z",
	lastUpdated: "2026-09-25T01:00:00.000Z",
	kind: "main",
};

const sessionContext = {
	id: "ctx-1",
	timestamp: "2026-09-25T01:00:00.000Z",
	type: "user",
	content: [{ text: "<session_context>\nThis is the Gemini CLI.\n- **Workspace Directories:**\n  - /work/demo\n</session_context>" }],
};

const base = [
	header,
	sessionContext,
	{ id: "u-1", timestamp: "2026-09-25T01:00:10.000Z", type: "user", content: [{ text: "로그인 버그를 고쳐줘" }] },
	{
		id: "g-1",
		timestamp: "2026-09-25T01:00:20.000Z",
		type: "gemini",
		content: [{ text: "원인을 찾아볼게요." }],
		toolCalls: [
			{
				id: "call-1",
				name: "run_shell_command",
				args: { command: "npm test" },
				status: "success",
				timestamp: "2026-09-25T01:00:21.000Z",
				result: [{ text: "3 tests passed\n0 failed" }],
			},
			{
				id: "call-2",
				name: "read_file",
				args: { absolute_path: "/work/demo/src/auth.ts" },
				status: "error",
				timestamp: "2026-09-25T01:00:22.000Z",
				result: [{ text: "ENOENT: no such file or directory" }],
			},
		],
	},
	{ $set: { summary: "로그인 버그 수정", lastUpdated: "2026-09-25T01:00:30.000Z" } },
];

test("gemini transcript shows user and assistant sections, tool calls and results", () => {
	const md = geminiAdapter.transcript(jsonl(base), "gemini:project/chats/session-x.jsonl");
	assert.ok(md.includes("# 로그인 버그 수정"));
	assert.ok(md.includes("- 원본: gemini:project/chats/session-x.jsonl"));
	assert.ok(md.includes("- 시작: 2026-09-25T01:00:00.000Z"));
	assert.ok(md.includes("## user"));
	assert.ok(md.includes("로그인 버그를 고쳐줘"));
	assert.ok(!md.includes("session_context"), "injected context must be skipped");
	assert.ok(md.includes("## assistant"));
	assert.ok(md.includes("원인을 찾아볼게요."));
	assert.ok(md.includes("→ run_shell_command(npm test)"));
	assert.match(md, /⇒ run_shell_command ok\b.*2줄/);
	assert.ok(md.includes("⇒ read_file 에러"));
	assert.ok(md.includes("ENOENT: no such file or directory"));
});

test("gemini transcript marks pending tool calls and cancelled ones as errors", () => {
	const md = geminiAdapter.transcript(jsonl([
		header,
		{ id: "u-1", timestamp: "t", type: "user", content: [{ text: "확인해줘" }] },
		{
			id: "g-1", timestamp: "t", type: "gemini", content: "",
			toolCalls: [
				{ id: "c-1", name: "glob", args: { pattern: "*.ts" }, status: "executing", timestamp: "t" },
				{ id: "c-2", name: "edit", args: {}, status: "cancelled", timestamp: "t" },
			],
		},
	]));
	assert.ok(md.includes("→ glob(*.ts)"));
	assert.ok(md.includes("(결과 없음)"));
	assert.ok(md.includes("⇒ edit 에러"));
});

test("gemini ask_user renders question and options inside one source block", () => {
	const md = geminiAdapter.transcript(jsonl([
		header,
		{ id: "u-1", timestamp: "t", type: "user", content: [{ text: "어디에 둘까?" }] },
		{
			id: "g-1", timestamp: "t", type: "gemini", content: "",
			toolCalls: [{
				id: "ask-1", name: "ask_user", status: "success", timestamp: "t",
				args: {
					questions: [{
						question: "결과를 어디에 저장할까요?", header: "저장", type: "choice",
						options: [
							{ label: "docs 폴더", description: "문서와 함께 둔다" },
							{ label: "루트", description: "맨 위에 둔다" },
						],
					}],
				},
				result: [{ text: "docs 폴더" }],
			}],
		},
	]), "gemini:test/session.jsonl");
	for (const phrase of ["결과를 어디에 저장할까요?", "docs 폴더", "문서와 함께 둔다", "루트", "⇒ ask_user 사용자 답:"])
		assert.ok(md.includes(phrase), `transcript missing: ${phrase}`);
	const { sources } = prepareEvidence(md, "gemini:test/session.jsonl");
	const source = [...sources.values()].find((item) => item.text.includes("질문:") && item.text.includes("docs 폴더"));
	assert.ok(source, "no single source block contains the ask_user call, question, and options");
	assert.match(source.text, /^→ ask_user\(/);
});

test("gemini meta reads summary, directories, and first real user utterance", () => {
	const withDirs = jsonl([{ ...header, directories: ["/work/demo"] }, sessionContext, ...base.slice(2)]);
	const meta = geminiAdapter.meta(withDirs);
	assert.equal(meta.title, "로그인 버그 수정");
	assert.equal(meta.cwd, "/work/demo");
	assert.equal(meta.started, "2026-09-25T01:00:00.000Z");
	assert.equal(meta.first, "로그인 버그를 고쳐줘");
});

test("gemini meta is null when the session has no real user utterance", () => {
	assert.equal(geminiAdapter.meta(jsonl([header, sessionContext])), null);
	assert.equal(geminiAdapter.meta(jsonl([header, { id: "u", timestamp: "t", type: "user", content: [{ text: "/help" }] }])), null);
});

test("gemini transcript yields citable sources", () => {
	const md = geminiAdapter.transcript(jsonl(base), "gemini:test/session.jsonl");
	const { sources } = prepareEvidence(md, "gemini:test/session.jsonl");
	assert.ok(sources.size > 0);
	assert.ok([...sources.values()].some((s) => s.text.includes("로그인 버그를 고쳐줘")));
});

test("gemini events extract user, assistant, question, and error", () => {
	const events = geminiAdapter.events(jsonl([
		...base,
		{
			id: "g-2", timestamp: "t", type: "gemini", content: "",
			toolCalls: [{
				id: "ask-1", name: "ask_user", status: "success", timestamp: "t",
				args: { questions: [{ question: "계속할까요?", type: "choice", options: [{ label: "예", description: "진행" }, { label: "아니오" }] }] },
			}],
		},
	]));
	const kinds = events.map((e) => e.kind);
	assert.ok(kinds.includes("user"));
	assert.ok(kinds.includes("assistant"));
	assert.ok(kinds.includes("question"));
	assert.ok(kinds.includes("error"));
	const q = events.find((e) => e.kind === "question");
	assert.equal(q.text, "계속할까요?");
	assert.deepEqual(q.options[0], { label: "예", description: "진행" });
	assert.ok(!events.some((e) => e.text?.includes("session_context")), "injected context must not be an event");
});

test("gemini $rewindTo drops messages from that id on", () => {
	const md = geminiAdapter.transcript(jsonl([
		header,
		{ id: "u-1", timestamp: "t", type: "user", content: [{ text: "첫 질문" }] },
		{ id: "g-1", timestamp: "t", type: "gemini", content: [{ text: "첫 답" }] },
		{ id: "u-2", timestamp: "t", type: "user", content: [{ text: "되돌릴 질문" }] },
		{ id: "g-2", timestamp: "t", type: "gemini", content: [{ text: "되돌릴 답" }] },
		{ $rewindTo: "u-2" },
	]));
	assert.ok(md.includes("첫 질문"));
	assert.ok(md.includes("첫 답"));
	assert.ok(!md.includes("되돌릴 질문"));
	assert.ok(!md.includes("되돌릴 답"));
});

test("gemini $set.messages checkpoint replaces earlier messages", () => {
	const md = geminiAdapter.transcript(jsonl([
		header,
		{ id: "u-1", timestamp: "t", type: "user", content: [{ text: "옛날 질문" }] },
		{ $set: { messages: [{ id: "u-9", timestamp: "t", type: "user", content: [{ text: "체크포인트 질문" }] }] } },
	]));
	assert.ok(!md.includes("옛날 질문"));
	assert.ok(md.includes("체크포인트 질문"));
});

test("gemini session file through the adapter: working folder from .project_root, whole file and a cut mid-line", async (t) => {
	const files = { ".gemini/tmp/demo/.project_root": "/work/demo\n" };
	const file = await sessionFixture(t, geminiAdapter, "demo/chats/session-2026-09-25T01-00-abcdef12.jsonl", base, files);
	assert.deepEqual(file.meta, { title: "로그인 버그 수정", cwd: "/work/demo", started: "2026-09-25T01:00:00.000Z", first: "로그인 버그를 고쳐줘" });
	assert.ok(file.transcript.startsWith(`# 로그인 버그 수정\n\n- 원본: ${file.path}\n- 작업 폴더: /work/demo\n- 시작: 2026-09-25T01:00:00.000Z\n`));
	assert.deepEqual(file.events.map((e) => e.kind), ["user", "assistant", "error"]);
	// 사용자 발화 줄 가운데서 자르면 꼬리는 그다음 답부터, 머리에는 진짜 발화가 없어 숨긴다.
	const cut = await file.cutAt(2);
	assert.deepEqual(cut.events, file.events.slice(1));
	assert.equal(cut.meta, null);
	// 제목($set) 줄이 잘린 머리는 아직 제목이 없다.
	assert.equal((await file.cutAt(4)).meta.title, "(제목 없음)");
	// 서브에이전트 세션(chats/<parentId>/)도 두 단계 위의 표시 파일을 쓴다.
	const sub = await sessionFixture(t, geminiAdapter, "demo/chats/parent-session-id/child-id.jsonl", base, files);
	assert.equal(sub.meta.cwd, "/work/demo");
	assert.match(sub.transcript, /^- 작업 폴더: \/work\/demo$/m);
});
