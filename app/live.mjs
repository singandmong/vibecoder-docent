// 세션 파일을 폴링해 새 줄만 읽고 사건 카드로 바꾼다. SSE 연결 하나당 watcher 하나.
// 바이트 읽기는 session-file.mjs, 줄 해석은 호스트 adapter 의 events 가 맡는다.
import { EVENT_QUESTIONS, jevEnabled, judge } from "./jev.mjs";
import { followFile } from "./session-file.mjs";

const POLL_MS = 1000;
const REPLAY_BYTES = 512 * 1024; // 구독 시 꼬리에서 다시 보여 줄 범위. 도구 결과가 커서 64KB 로는 이벤트가 거의 안 잡힌다
const REPLAY_MAX = 5;
const EVENT_STATE_MAX = 12_000;
const OMITTED = "\n\n[중간 기록 생략]\n\n";
const EVENT_EDGE = Math.floor((EVENT_STATE_MAX - OMITTED.length) / 2);

/** 재생과 새 이벤트에 같은 의미 필터를 적용한다. 원문은 설명의 근거로 보존한다. */
async function filterEvent(ev, warnReduced) {
	if (ev.kind === "question") return { ...ev, sub: "question" };
	if (ev.kind !== "assistant") return null;
	const state = ev.text.length > EVENT_STATE_MAX ? `${ev.text.slice(0, EVENT_EDGE)}${OMITTED}${ev.text.slice(-EVENT_EDGE)}` : ev.text;
	const answer = await judge(state, EVENT_QUESTIONS);
	const probability = answer?.notable?.noul;
	const category = answer?.kind?.choice;
	if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !["question", "result", "plan", "routine"].includes(category)) {
		warnReduced();
		return null;
	}
	if (probability < 0.6 || category === "routine") return null;
	return { ...ev, sub: category, by: "jev", p: probability };
}

/** 파일 꼬리의 최근 사건 카드를 past 표시로 먼저 보낸다 (ADR 0012). */
async function replay(tail, adapter, send, warnReduced) {
	const kept = [];
	for (const ev of adapter.events(tail)) {
		const selected = await filterEvent(ev, warnReduced);
		if (selected) kept.push(selected);
	}
	const at = new Date().toISOString();
	for (const ev of kept.slice(-REPLAY_MAX)) send({ ...ev, past: true, at });
}

/**
 * @param {string} path 세션 jsonl
 * @param {{events:(chunk:string)=>object[]}} adapter 새로 끝난 줄들 → 사건 카드 후보
 * @param {(ev:object)=>void} send
 * @returns {() => void} stop
 */
export function watchSession(path, adapter, send) {
	const file = followFile(path);
	let started = false; // 첫 읽기에서 꼬리를 재생하고 파일 끝부터 이어 읽는다
	let stopped = false;
	let busy = false;
	let reducedReported = false;
	const warnReduced = () => {
		if (reducedReported || stopped) return;
		reducedReported = true;
		send({
			kind: "warn",
			code: "classifier-unavailable",
			text: "의미 분류를 사용할 수 없어 분류하지 못한 메시지는 건너뛰어요. 명시적인 질문 도구로 보낸 질문은 계속 보이지만, 일반 문장의 질문, 작업 결과, 계획은 빠질 수 있어요.",
			at: new Date().toISOString(),
		});
	};

	const tick = async () => {
		if (stopped || busy) return;
		busy = true;
		if (!jevEnabled) warnReduced();
		try {
			if (!started) {
				const tail = await file.start(REPLAY_BYTES);
				if (tail === null) return;
				started = true;
				await replay(tail, adapter, send, warnReduced);
				send({ kind: "hello", text: "이 세션을 지켜보고 있어요", at: new Date().toISOString() });
				return;
			}
			const complete = await file.next();
			if (!complete) return;
			for (const ev of adapter.events(complete)) {
				const selected = await filterEvent(ev, warnReduced);
				if (selected) send({ ...selected, at: new Date().toISOString() });
			}
		} catch (e) {
			send({ kind: "warn", text: String(e.message ?? e), at: new Date().toISOString() });
		} finally {
			busy = false;
		}
	};

	const timer = setInterval(tick, POLL_MS);
	tick();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
