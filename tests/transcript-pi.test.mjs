import assert from "node:assert/strict";
import test from "node:test";
import { prepareEvidence } from "../app/evidence.mjs";
import { piAdapter } from "../scripts/transcript-pi.mjs";
import { jsonl, sessionFixture } from "./session-fixture.mjs";

// pi-mono 세션 형식: 헤더 {type:"session", id, timestamp, cwd} + 엔트리 {type, id, parentId, timestamp}.
// 이름은 헤더가 아니라 session_info 엔트리에, 모델은 {provider, modelId} 로 온다.
const base = [
	{ type: "session", version: 3, id: "pi-session-1", timestamp: "2026-09-25T02:00:00.000Z", cwd: "/work/pi-proj" },
	{ type: "session_info", id: "si-1", parentId: null, timestamp: "2026-09-25T02:00:01.000Z", name: "인증 리팩터링" },
	{
		type: "message", id: "m-1", parentId: null, timestamp: "2026-09-25T02:00:10.000Z",
		message: { role: "user", content: [{ type: "text", text: "세션 만료 버그를 봐줘" }], timestamp: 1760000000000 },
	},
	{
		type: "message", id: "m-2", parentId: "m-1", timestamp: "2026-09-25T02:00:20.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "토큰 갱신 코드를 확인할게요." },
				{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "grep -rn refresh src/" } },
			],
			timestamp: 1760000000000,
		},
	},
	{
		type: "message", id: "m-3", parentId: "m-2", timestamp: "2026-09-25T02:00:30.000Z",
		message: {
			role: "toolResult", toolCallId: "tc-1", toolName: "bash",
			content: [{ type: "text", text: "src/auth.ts:12: refresh()" }], isError: false, timestamp: 1760000000000,
		},
	},
	{ type: "model_change", id: "mc-1", parentId: "m-3", timestamp: "2026-09-25T02:00:40.000Z", provider: "anthropic", modelId: "claude-sonnet-4-5" },
	{
		type: "compaction", id: "cp-1", parentId: "mc-1", timestamp: "2026-09-25T02:00:50.000Z",
		summary: "이전 대화 요약", firstKeptEntryId: "m-1", tokensBefore: 30000,
	},
];

test("pi transcript shows user and assistant sections, tool call and result", () => {
	const md = piAdapter.transcript(jsonl(base), "pi:--work--/session.jsonl");
	assert.ok(md.includes("# 인증 리팩터링"));
	assert.ok(md.includes("- 원본: pi:--work--/session.jsonl"));
	assert.ok(md.includes("- 작업 폴더: /work/pi-proj"));
	assert.ok(md.includes("- 시작: 2026-09-25T02:00:00.000Z"));
	assert.ok(md.includes("## user"));
	assert.ok(md.includes("세션 만료 버그를 봐줘"));
	assert.ok(md.includes("## assistant"));
	assert.ok(md.includes("토큰 갱신 코드를 확인할게요."));
	assert.ok(md.includes("→ bash(grep -rn refresh src/)"));
	assert.match(md, /⇒ bash ok\b.*1줄/);
	assert.ok(md.includes("(모델: anthropic/claude-sonnet-4-5)"));
	assert.match(md, /이전 대화가 요약.*압축/);
});

test("pi transcript shows tool errors and pending calls", () => {
	const md = piAdapter.transcript(jsonl([
		base[0],
		{
			type: "message", id: "m-1", parentId: null, timestamp: "t",
			message: { role: "user", content: "테스트 돌려줘", timestamp: 1 },
		},
		{
			type: "message", id: "m-2", parentId: "m-1", timestamp: "t",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "x.ts" } },
				],
				timestamp: 1,
			},
		},
		{
			type: "message", id: "m-3", parentId: "m-2", timestamp: "t",
			message: { role: "toolResult", toolCallId: "tc-1", toolName: "bash", content: [{ type: "text", text: "Error: 2 failed" }], isError: true, timestamp: 1 },
		},
	]));
	assert.ok(md.includes("⇒ bash 에러"));
	assert.ok(md.includes("Error: 2 failed"));
	assert.ok(md.includes("→ read(x.ts)"));
	assert.ok(md.includes("(결과 없음)"));
});

test("pi meta reads session_info name, cwd, and first user utterance", () => {
	const meta = piAdapter.meta(jsonl(base));
	assert.equal(meta.title, "인증 리팩터링");
	assert.equal(meta.cwd, "/work/pi-proj");
	assert.equal(meta.started, "2026-09-25T02:00:00.000Z");
	assert.equal(meta.first, "세션 만료 버그를 봐줘");
});

test("pi meta is null without a user utterance", () => {
	assert.equal(piAdapter.meta(jsonl([base[0], base[1]])), null);
});

test("pi transcript yields citable sources", () => {
	const md = piAdapter.transcript(jsonl(base), "pi:test/session.jsonl");
	const { sources } = prepareEvidence(md, "pi:test/session.jsonl");
	assert.ok(sources.size > 0);
	assert.ok([...sources.values()].some((s) => s.text.includes("세션 만료 버그를 봐줘")));
});

test("pi events extract user, assistant, and tool errors", () => {
	const events = piAdapter.events(jsonl([
		...base,
		{
			type: "message", id: "m-4", parentId: "cp-1", timestamp: "t",
			message: { role: "toolResult", toolCallId: "tc-9", toolName: "bash", content: [{ type: "text", text: "fatal: not a git repository" }], isError: true, timestamp: 1 },
		},
	]));
	const kinds = events.map((e) => e.kind);
	assert.ok(kinds.includes("user"));
	assert.ok(kinds.includes("assistant"));
	assert.ok(kinds.includes("error"));
	const err = events.find((e) => e.kind === "error");
	assert.ok(err.text.includes("fatal: not a git repository"));
});

test("pi session file through the adapter: whole file and a cut mid-line", async (t) => {
	const file = await sessionFixture(t, piAdapter, "--work-pi-proj--/2026-09-25T02-00-00_pi-session-1.jsonl", base);
	assert.deepEqual(file.meta, { title: "인증 리팩터링", cwd: "/work/pi-proj", started: "2026-09-25T02:00:00.000Z", first: "세션 만료 버그를 봐줘" });
	assert.ok(file.transcript.startsWith(`# 인증 리팩터링\n\n- 원본: ${file.path}\n- 작업 폴더: /work/pi-proj\n- 시작: 2026-09-25T02:00:00.000Z\n`));
	assert.ok(file.transcript.includes("(모델: anthropic/claude-sonnet-4-5)"));
	assert.deepEqual(file.events, [
		{ kind: "user", text: "세션 만료 버그를 봐줘" },
		{ kind: "assistant", text: "토큰 갱신 코드를 확인할게요.", ts: "2026-09-25T02:00:20.000Z" },
	]);
	// 사용자 발화 줄 가운데서 자르면 꼬리는 답부터, 머리는 발화가 없어 숨긴다.
	const cut = await file.cutAt(2);
	assert.deepEqual(cut.events, file.events.slice(1));
	assert.equal(cut.meta, null);
	assert.deepEqual((await file.cutAt(3)).meta, file.meta);
});
