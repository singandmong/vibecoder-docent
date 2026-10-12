#!/usr/bin/env node
// pi (pi-mono) 세션 adapter (~/.pi/agent/sessions/--<경로>--/<ts>_<id>.jsonl).
// omp 가 pi-mono 에서 갈라져 나왔고 메시지·도구·압축 엔트리 모양이 같아서
// omp adapter 를 그대로 쓴다. 다른 점 두 개만 줄을 읽을 때 한 번 맞춘다:
//   - 세션 이름은 헤더 title 이 아니라 session_info 엔트리의 name 에 있다 → title 엔트리로 변환
//   - model_change 는 {provider, modelId} 다 → omp 의 {model} 로 변환
// pi 에는 omp 의 title 엔트리, ask 도구, session_exit 기록이 없다. 사용자 발화가 없는 세션은 목록에서 숨긴다.
// CLI:    scripts/transcript-pi.mjs <session.jsonl> [out.md]
// module: import { piAdapter } from "./transcript-pi.mjs"
import { ompShapedAdapter } from "./transcript-omp.mjs";
import { transcriptCli } from "./transcript-jsonl.mjs";

/** pi 엔트리를 omp 엔트리 모양으로. 나머지는 그대로 통과한다. */
const adapt = (e) => {
	if (e.type === "session_info") return { ...e, type: "title", title: e.name };
	if (e.type === "model_change" && e.model === undefined)
		return { ...e, model: [e.provider, e.modelId].filter(Boolean).join("/") || "?" };
	return e;
};

export const piAdapter = ompShapedAdapter({ id: "pi", dir: ".pi/agent/sessions", adapt, requireUser: true });

await transcriptCli(import.meta.url, piAdapter);
