// 세션 지켜보기와 미리 설명 (ADR 0031). 세션마다 감시기 하나를 두고 화면 구독자와 미리 설명이 함께 쓴다.
// 프로필이 세션을 열면 12시간 동안 탭을 닫아도 새 사건 카드를 EASY로 미리 설명한다.
import { createHash } from "node:crypto";
import { EVENT_REQUEST, focusOfEvent } from "./dialogue.mjs";

const WATCH_MS = 12 * 60 * 60 * 1000;
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const RECENT_MAX = 5;

/** 10분 창 안의 미리 설명 예약 수. 예약 시점에 세야 몰려온 사건도 상한을 지킨다. */
function startLimit() {
	const profiles = new Map();
	const of = (id) => {
		if (!profiles.has(id)) profiles.set(id, []);
		const starts = profiles.get(id);
		while (starts.length && starts[0] <= Date.now() - WINDOW_MS) starts.shift();
		return starts;
	};
	return {
		claim(id) { of(id).push(Date.now()); },
		used: (id) => of(id).length,
	};
}

export const prefetchRequestId = (profileId, sessionId, thread) => `auto-${createHash("sha256").update(`${profileId}\n${sessionId}\n${thread}`).digest("hex").slice(0, 32)}`;

/**
 * 미리 설명 작업은 설명 요청 module(ask.mjs)이 연다. 사용자 질문과의 차례도 그쪽이 정한다.
 * @param {{watch: (sessionId: string, emit: (ev: object) => void) => () => void, profile: (id: string) => Promise<object>, startJob: (input: object) => Promise<object>, hasJob: (profileId: string, requestId: string) => boolean, waiting: (profileId: string) => number}} deps
 */
export function prefetchHub({ watch, profile, startJob, hasJob, waiting }) {
	const limit = startLimit();
	const sessions = new Map();

	const expire = () => {
		const now = Date.now();
		for (const [sessionId, entry] of sessions) {
			for (const [profileId, until] of entry.watchers) if (until <= now) entry.watchers.delete(profileId);
			if (!entry.subscribers.size && !entry.watchers.size) {
				entry.stop();
				sessions.delete(sessionId);
			}
		}
	};
	setInterval(expire, 60_000).unref();

	async function decorate(profileId, sessionId, card) {
		if (card.past) return { ...card, ask: null, autoState: "past" };
		const current = await profile(profileId).catch(() => null);
		if (!current?.autoExplain) return { ...card, ask: null, autoState: "disabled" };
		const requestId = prefetchRequestId(profileId, sessionId, card.thread);
		const ask = { requestId, question: EVENT_REQUEST[card.sub], display: "쉽게 설명해줘", difficulty: "EASY" };
		const entry = sessions.get(sessionId);
		if (hasJob(profileId, requestId) || entry?.scheduled.has(`${profileId}\n${requestId}`)) return { ...card, ask, autoState: "duplicate" };
		if (limit.used(profileId) >= LIMIT) return { ...card, ask: null, autoState: "limited" };
		entry?.scheduled.add(`${profileId}\n${requestId}`);
		limit.claim(profileId);
		try {
			// 작업이 등록된 뒤에 카드를 보내야 브라우저가 같은 요청으로 붙을 수 있다.
			await startJob({ id: sessionId, profileId, question: ask.question, focus: card.focus, auto: true, difficulty: "EASY", requestId });
		} catch (error) {
			console.error(`docent: 미리 설명을 예약하지 못했어요 (${error.message})`);
			return { ...card, ask: null, autoState: "disabled" };
		}
		return { ...card, ask, autoState: "queued" };
	}

	function ensure(sessionId) {
		let entry = sessions.get(sessionId);
		if (entry) return entry;
		entry = { subscribers: new Set(), watchers: new Map(), recent: [], scheduled: new Set(), hello: null, chain: Promise.resolve(), stop: () => {} };
		sessions.set(sessionId, entry);
		const handle = async (ev) => {
			if (!["question", "assistant"].includes(ev.kind) || !ev.sub || typeof ev.text !== "string" || !ev.text.trim()) {
				if (ev.kind === "hello") entry.hello = ev;
				for (const subscriber of entry.subscribers) subscriber.send(ev);
				return;
			}
			const { ask: _remoteAsk, autoState: _remoteState, ...plain } = ev;
			const card = { ...plain, ...focusOfEvent(plain) };
			entry.recent.push({ ...card, past: true });
			if (entry.recent.length > RECENT_MAX) entry.recent.shift();
			const profiles = new Set([...entry.watchers.keys(), ...[...entry.subscribers].map((subscriber) => subscriber.profileId)]);
			for (const profileId of profiles) {
				const decorated = await decorate(profileId, sessionId, card);
				for (const subscriber of entry.subscribers) if (subscriber.profileId === profileId) subscriber.send(decorated);
			}
		};
		// 사건 순서를 지키도록 한 줄로 처리한다.
		entry.stop = watch(sessionId, (ev) => {
			entry.chain = entry.chain.then(() => handle(ev)).catch((error) => console.error(`docent: 미리 설명 예약 실패 (${error.message})`));
		});
		return entry;
	}

	return {
		/** 화면 구독. 최근 카드를 past 로 먼저 보내고 이후 사건을 보낸다. */
		subscribe({ sessionId, profileId, send }) {
			const fresh = !sessions.has(sessionId);
			const entry = ensure(sessionId);
			entry.watchers.set(profileId, Date.now() + WATCH_MS);
			const subscriber = { profileId, send };
			if (!fresh) {
				for (const card of entry.recent) send({ ...card, ask: null, autoState: "past" });
				if (entry.hello) send(entry.hello);
			}
			entry.subscribers.add(subscriber);
			return () => {
				entry.subscribers.delete(subscriber);
				entry.watchers.set(profileId, Date.now() + WATCH_MS);
			};
		},
		status(profileId) {
			return { used: limit.used(profileId), queued: waiting(profileId), limit: LIMIT };
		},
		/** 이 세션을 보고 있는 같은 프로필 화면에 알린다(예: 뒤에서 끝난 학습 분류). */
		notify(sessionId, profileId, payload) {
			for (const subscriber of sessions.get(sessionId)?.subscribers ?? []) if (subscriber.profileId === profileId) subscriber.send(payload);
		},
	};
}
