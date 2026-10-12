import assert from "node:assert/strict";
import test from "node:test";
import { ompAdapter } from "../scripts/transcript-omp.mjs";
import { sessionFixture } from "./session-fixture.mjs";

const fixture = [
	{ type: "session", id: "omp-1", cwd: "/work/omp", timestamp: "2026-09-25T00:00:00Z" },
	{ type: "title", title: "저장 위치 정하기" },
	{ type: "message", id: "u", timestamp: "2026-09-25T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "결과를 어디에 둘까?" }] } },
	{
		type: "message", id: "a", timestamp: "2026-09-25T00:00:02Z", message: {
			role: "assistant",
			content: [
				{ type: "text", text: "먼저 물어볼게요." },
				{ type: "toolCall", id: "ask-1", name: "ask", arguments: { questions: [{ question: "어디에 저장할까요?", options: [{ label: "docs", description: "문서 폴더" }, { label: "루트" }] }] } },
			],
		},
	},
	{ type: "message", id: "r", timestamp: "2026-09-25T00:00:03Z", message: { role: "toolResult", toolCallId: "ask-1", toolName: "read", isError: true, content: "ENOENT: no such file" } },
	{ type: "custom", customType: "session_exit", timestamp: "2026-09-25T00:00:04Z" },
];

test("omp session file through the adapter: whole file and a cut mid-line", async (t) => {
	const file = await sessionFixture(t, ompAdapter, "--work-omp--/omp-1.jsonl", fixture);
	assert.deepEqual(file.meta, { title: "저장 위치 정하기", cwd: "/work/omp", started: "2026-09-25T00:00:00Z", first: "결과를 어디에 둘까?" });
	assert.ok(file.transcript.startsWith(`# 저장 위치 정하기\n\n- 원본: ${file.path}\n- 작업 폴더: /work/omp\n- 시작: 2026-09-25T00:00:00Z\n`));
	assert.match(file.transcript, /→ ask\(/);
	assert.deepEqual(file.events.map((e) => e.kind), ["user", "assistant", "question", "error", "done"]);
	assert.deepEqual(file.events[2].options, [{ label: "docs", description: "문서 폴더" }, { label: "루트", description: "" }]);
	// 답 줄 가운데서 자르면 꼬리는 도구 오류부터. 머리에는 아직 사용자 발화만 있다.
	const cut = await file.cutAt(3);
	assert.deepEqual(cut.events, file.events.slice(3));
	assert.deepEqual(cut.meta, file.meta);
	// omp 는 발화 전 세션도 목록에 보인다(제목 없음).
	assert.deepEqual((await file.cutAt(1)).meta, { title: "(제목 없음)", cwd: "/work/omp", started: "2026-09-25T00:00:00Z", first: null });
});
