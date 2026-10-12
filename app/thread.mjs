// 스레드 (ADR 0022·0028·0053). 한 질문 대상(없으면 세션 전체)을 두고 이어 가는 대화의 식별자.
// 서버만 계산한다. 화면은 서버가 준 `thread` 를 받아 쓰고, 소속 규칙은 conversations.mjs 하나다.
import { createHash } from "node:crypto";
import { answerFocus } from "./conversations.mjs";

/** 질문 대상 내용의 비교 형태. 공백 차이는 같은 스레드로 본다. 빈 문자열은 세션 전체 대화. */
export const threadText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** 스레드 식별자. "" 는 세션 전체 대화. */
export const threadKey = (text) => {
	const normalized = threadText(text);
	return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 16) : "";
};

/**
 * 질문 대상 → 스레드. 질문 대상이 같은 세션의 앞선 답이면(설명 방식 메뉴로 다시 설명) 그 답이 있던 스레드에 남는다.
 * 세션 전체 대화에서 다시 설명한 답은 세션 전체 대화에 남는다 (ADR 0022). 저장 형식은 그대로라 옛 문답에도 같은 규칙이 적용된다.
 */
function threadResolver() {
	const answers = new Map();
	const answerKey = (sessionId, text) => `${sessionId ?? ""}\n${threadText(text)}`;
	return {
		of(sessionId, focus) {
			if (!threadText(focus?.text)) return "";
			return answers.get(answerKey(sessionId, focus.text)) ?? threadKey(focus.text);
		},
		/**
		 * 스레드가 붙은 문답의 답을 기억한다. 같은 내용의 답이 여러 스레드에 있으면 가장 먼저 나온 답의 스레드다.
		 * 나중에 쌓이는 문답이 이미 정한 스레드를 바꾸지 않으므로, 질문을 열 때 정한 스레드와 저장 뒤 붙는 스레드가 같다.
		 */
		add(row) {
			if (!row.answer) return;
			const key = answerKey(row.sessionId, answerFocus(row.answer).text);
			if (!answers.has(key)) answers.set(key, row.thread);
		},
	};
}

/** 시간순 문답마다 스레드(`thread`)를 붙인다. */
export function withThreads(rows) {
	const resolver = threadResolver();
	return rows.map((row) => {
		const tagged = { ...row, thread: resolver.of(row.sessionId, row.focus) };
		resolver.add(tagged);
		return tagged;
	});
}

/** 새 질문의 스레드. `rows` 는 `withThreads` 가 붙인 그 세션의 문답(시간순)이다. */
export function threadOf(sessionId, focus, rows) {
	const resolver = threadResolver();
	for (const row of rows) resolver.add(row);
	return resolver.of(sessionId, focus);
}
