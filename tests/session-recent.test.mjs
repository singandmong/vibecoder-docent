import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSentence, recentLine } from "../app/session-recent.mjs";

test("첫 문장은 Markdown 기호와 코드 블록, 표를 건너뛰고 문장 끝에서 자른다", () => {
	assert.equal(firstSentence("```sh\nnpm test\n```\n\n| a | b |\n## **화살표 키**를 [고쳤습니다](x.md). 다음은 배포."), "화살표 키를 고쳤습니다.");
	assert.equal(firstSentence("- `v0.18.1`을 배포했고 둘 다 업데이트했습니다"), "v0.18.1을 배포했고 둘 다 업데이트했습니다");
	assert.equal(firstSentence("버전 0.18.1 배포 완료."), "버전 0.18.1 배포 완료.");
	assert.equal(firstSentence("가".repeat(200)).length, 160);
});

test("최근 작업은 마지막 에이전트 답의 첫 문장, 답 글이 없으면 마지막 사용자 요청", () => {
	const events = [
		{ kind: "user", text: "세션 선택창 고쳐줘" },
		{ kind: "assistant", text: "선택창을 카드로 바꿨습니다. 테스트도 통과했습니다." },
		{ kind: "user", text: "커밋해줘" },
		{ kind: "assistant", text: "```\n```" },
	];
	assert.equal(recentLine(events), "선택창을 카드로 바꿨습니다.");
	assert.equal(recentLine(events.filter((event) => event.kind === "user")), "커밋해줘");
	assert.equal(recentLine([]), "");
});
