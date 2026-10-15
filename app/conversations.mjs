// 대화 목록과 스레드 소속 (ADR 0022·0038·0053). 서버, 웹, 터미널이 같은 규칙을 쓴다.
// 웹이 정적 파일로 불러오므로 node: module 을 쓰지 않는다. 스레드 식별자는 계산하지 않고 서버가 붙인 `thread` 만 본다.

/** 질문 대상 내용의 상한. 서버 입력 상한(8000자) 안쪽이다. */
export const FOCUS_MAX = 7800;
const LABEL_MAX = 200;
const CARDS_MAX = 40;
const THREAD_ID = /^[a-f0-9]{16}$/;

/** 글의 첫 의미 있는 줄. 카드와 답의 제목으로 쓴다. */
export function blockTitle(text) {
	const lines = String(text ?? "").split("\n").map((line) => line.replace(/^\s*(?:[#>*+-]+\s*|\d+[.)]\s+)*/, "").replace(/[*_`]/g, "").replace(/^\s*[✅⏳⛔]\s*/u, "").trim()).filter(Boolean);
	const line = lines.find((entry) => entry.length > 8) || lines[0] || "";
	return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** 카드에는 설명의 앞부분만 평문 3문장 이내로 둔다. 전문은 대화에서 본다 (ADR 0018). */
export function summarySentences(text, max = 3) {
	const lines = String(text ?? "").replace(/```[\s\S]*?```/g, "").split("\n")
		.filter((line) => !/^\s*\|/.test(line))
		.map((line) => line.replace(/^\s*(?:[#>*+-]+\s*|\d+[.)]\s+)*/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim())
		.filter(Boolean);
	return lines.flatMap((line) => line.split(/(?<=[.!?。])\s+/)).filter(Boolean).slice(0, max).join(" ");
}

/**
 * 카드 한 장에 보이는 제목과 요약. 답이 있으면 답에서 만들고, 없으면 질문 대상 제목만 있다.
 * 서버에 보내는 질문 대상은 사건 원문 그대로이고 이 제목은 화면용이다.
 * @param {{title?: string, headline?: string, explain?: string, details?: string[]}|null|undefined} answer
 * @param {string} label 사건의 질문 대상 제목
 */
export function cardDisplay(answer, label) {
	if (!answer) return { title: label, summary: "" };
	const title = answer.title || blockTitle(answer.headline) || label;
	const conclusion = answer.title ? blockTitle(answer.headline) : "";
	return { title, summary: summarySentences([conclusion, answer.explain || answer.details?.[0]].filter(Boolean).join("\n")) };
}

/** 긴 내용은 앞뒤를 남기고 가운데를 줄인다. 카드의 질문 대상이 이 모양이라 표시를 바꾸면 스레드가 달라진다. */
export function excerpt(text, max = FOCUS_MAX) {
	const value = String(text ?? "");
	if (value.length <= max) return value;
	const half = Math.floor((max - 48) / 2);
	return `${value.slice(0, half)}\n\n[중간 생략 — 전체 내용은 세션 전사에서 확인]\n\n${value.slice(-half)}`;
}

/** 답 하나를 질문 대상으로 삼을 때(설명 방식 메뉴로 다시 설명)의 모양. 서버는 이 내용으로 원래 답이 있던 스레드를 찾는다. */
export function answerFocus(answer) {
	const details = Array.isArray(answer?.details) ? answer.details : [];
	return { label: blockTitle(answer?.headline) || "최근 설명", text: excerpt([answer?.headline, answer?.explain, ...details].filter(Boolean).join("\n\n")) };
}

/** 문답이 이 스레드에 속하는지. "" 는 세션 전체 대화. */
export const inThread = (row, thread) => (row?.thread || "") === (thread || "");

/** 한 스레드에 보이는 문답. 순서는 받은 그대로(시간순). */
export const threadRows = (rows, thread) => rows.filter((row) => inThread(row, thread));

/**
 * 세션의 대화 목록. 세션 전체 대화, 사건 카드(받은 순서, 같은 스레드는 처음 카드 하나),
 * 카드가 목록에 없는 저장 스레드(마지막 문답이 최근인 순)다.
 * @param {{thread?: string, ts?: string, focus?: {label?: string, text?: string}}[]} rows 서버 history() 문답(시간순)
 * @param {{thread?: string, focus?: {label: string, text: string}}[]} cards 서버가 질문 대상과 스레드를 붙인 카드
 * @returns {{kind: "all"|"card"|"saved", thread: string, focus: {label: string, text: string}|null, card: object|null, label: string, count: number, lastTs: string|null, answer: object|null}[]} answer 는 그 스레드의 마지막 문답의 답
 */
export function conversationList(rows, cards) {
	const byThread = new Map();
	for (const row of rows) {
		const thread = row.thread || "";
		if (!byThread.has(thread)) byThread.set(thread, []);
		byThread.get(thread).push(row);
	}
	const activity = (thread) => {
		const own = byThread.get(thread) ?? [];
		return { count: own.length, lastTs: own.at(-1)?.ts ?? null, answer: own.at(-1)?.answer ?? null };
	};
	const list = [{ kind: "all", thread: "", focus: null, card: null, label: "세션 전체 대화", ...activity("") }];
	const seen = new Set([""]);
	for (const card of cards) {
		if (!card?.thread || !card.focus?.text || seen.has(card.thread)) continue;
		seen.add(card.thread);
		list.push({ kind: "card", thread: card.thread, focus: { label: card.focus.label, text: card.focus.text }, card, label: card.focus.label, ...activity(card.thread) });
	}
	const saved = [...byThread.keys()].filter((thread) => !seen.has(thread)).map((thread) => {
		const last = byThread.get(thread).at(-1);
		return {
			kind: "saved", thread,
			focus: last?.focus?.text ? { label: last.focus.label || "질문 대상", text: last.focus.text } : null,
			card: null,
			label: last?.focus?.label || "주제 없는 저장 대화",
			...activity(thread),
		};
	});
	saved.sort((a, b) => String(b.lastTs ?? "").localeCompare(String(a.lastTs ?? "")) || a.thread.localeCompare(b.thread));
	return [...list, ...saved];
}

/** 설명 요청에 같이 보내는 카드 목록. 서버가 준 스레드만, 같은 스레드는 한 번, 제목은 200자, 최근 40개. */
export function cardsPayload(cards) {
	const byThread = new Map();
	for (const card of cards) {
		const thread = card?.thread;
		const label = String(card?.label ?? "").trim().slice(0, LABEL_MAX).trim();
		if (typeof thread !== "string" || !THREAD_ID.test(thread) || !label || byThread.has(thread)) continue;
		byThread.set(thread, { thread, label });
	}
	return [...byThread.values()].slice(-CARDS_MAX);
}
