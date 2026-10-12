// 스레드 (ADR 0022·0028). 한 질문 대상(없으면 세션 전체)을 두고 이어 가는 대화의 식별자.
// 서버만 계산한다. 화면은 서버가 준 `thread` 를 받아 쓴다.
import { createHash } from "node:crypto";

/** 질문 대상 내용의 비교 형태. 공백 차이는 같은 스레드로 본다. 빈 문자열은 세션 전체 대화. */
export const threadText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** 스레드 식별자. "" 는 세션 전체 대화. */
export const threadKey = (text) => {
	const normalized = threadText(text);
	return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 16) : "";
};
