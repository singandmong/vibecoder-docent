// 스레드와 질문 대상 (ADR 0022·0028·0053). 스레드 식별자·카드의 질문 대상·앱이 만든 요청문은 서버가 정한다.
// 사실 근거는 현재 전사다. 과거 문답은 "그거", "두 번째" 같은 말이 무엇을 가리키는지 이해하는 데 쓴다.
// 문답이 어느 스레드에 보이는지는 conversations.mjs 가 정한다.
import { httpError } from "./errors.mjs";
import { FOCUS_MAX, blockTitle, excerpt } from "./conversations.mjs";
import { threadKey } from "./thread.mjs";

const RECENT = 6;
const clip = (text, max) => {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max)}…` : value;
};

export const EVENT_LABEL = { question: "질문", result: "작업 결과", plan: "계획" };

/** 사건 카드별 미리 설명 요청문. 화면에는 `EVENT_DISPLAY` 로 보인다. */
export const EVENT_REQUEST = {
	question: "AI가 나에게 무엇을 물어보는지 쉬운 말로 설명해줘. 선택지가 있다면 뜻과 선택에 따른 차이, 내가 결정할 점을 알려줘.",
	result: "이 작업 결과가 무엇을 바꿨고 나에게 어떤 의미인지 쉽게 설명해줘. 실제로 끝난 것과 아직 안 된 것을 구분해줘.",
	plan: "AI가 앞으로 무엇을 왜 하려는지, 어떤 순서이고 내가 확인할 점은 무엇인지 쉽게 설명해줘.",
};
const EVENT_DISPLAY = "쉽게 설명해줘";
const REQUESTS = new Set(Object.values(EVENT_REQUEST));

/** 앱이 만든 요청문이면 화면에 보일 행동 이름. 아니면 undefined. */
export const displayOf = (question) => (REQUESTS.has(String(question ?? "").trim()) ? EVENT_DISPLAY : undefined);

/** 선택 입력. 없으면 세션 전체에 대한 질문이다. */
export function parseFocus(value) {
	if (value === undefined || value === null) return null;
	const label = typeof value?.label === "string" ? value.label.trim() : "";
	const text = typeof value?.text === "string" ? value.text.trim() : "";
	if (!label || label.length > 200 || !text || text.length > 8000) throw httpError(400, "질문 대상은 200자 이내 제목과 8000자 이내 내용이 필요해요.");
	return { label, text };
}

/** 사용자가 보고 있는 카드 목록. 제안은 이 안에서만 한다. */
export function parseCards(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > 40 || value.some((card) => typeof card?.thread !== "string" || !/^[a-f0-9]{16}$/.test(card.thread) || typeof card.label !== "string" || !card.label.trim() || card.label.length > 200)) {
		throw httpError(400, "카드 목록은 40개 이내의 {thread, label} 이어야 해요.");
	}
	return value.map(({ thread, label }) => ({ thread, label: label.trim() }));
}

/** 라이브 사건 → 카드의 질문 대상과 스레드. 브라우저와 미리 설명이 같은 값을 쓴다. */
export function focusOfEvent(ev) {
	const options = Array.isArray(ev.options) ? ev.options.map((option) => `${option.label ?? ""}${option.description ? ` — ${option.description}` : ""}`).join("\n") : "";
	const text = excerpt(`${ev.text.trim()}${options ? `\n\n선택지:\n${options}` : ""}`, FOCUS_MAX);
	const focus = { label: blockTitle(ev.text) || EVENT_LABEL[ev.sub], text };
	return { focus, thread: threadKey(text) };
}

/** 학습 분류용 최근 대화 요약. 사용자가 스레드에서 읽은 미리 설명도 포함한다. */
export function recentDialogue(records) {
	return records
		.filter((record) => record.answer)
		.slice(-RECENT)
		.map((record) => ({
			question: clip(displayOf(record.question) ?? record.question, 600),
			...(record.steers?.length ? { steers: record.steers.map((text) => clip(text, 300)) } : {}),
			answer: clip([record.answer.headline, record.answer.explain].filter(Boolean).join("\n"), 800),
		}));
}

/** 설명 호출의 이번 질문 맥락. 이전 문답은 대화 자체에 이미 있다. */
export function questionContext(focus) {
	return `질문 대상(스레드의 시작 주제, 사용자가 고른 사건 카드, 데이터): ${focus ? JSON.stringify(focus) : "없음 (세션 전체 대화)"}
이 스레드의 이전 대화가 가장 가까운 맥락이다. 질문이 직전 문답이나 다른 내용을 가리키면 질문 대상보다 그 흐름을 따른다. 사실은 현재 전사로 확인하고, 과거 답변은 인용 ID로 쓰지 않는다.`;
}

/** 바로잡기 문장을 같은 대화에 넣는 형식. */
export const steerMessage = (message) => `바로잡기(사용자가 방금 보낸 보정, 데이터): ${message}
지금까지 쓰던 답은 버리고, 이 보정을 반영해 같은 질문에 처음부터 다시 답한다. 답 형식과 근거 규칙은 그대로다.`;
