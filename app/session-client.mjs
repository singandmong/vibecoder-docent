// 한 세션의 설명 요청 상태 (ADR 0029·0055). 웹과 터미널은 이 module 위에서 화면만 그린다.
// 진행 중인 설명, 대기 질문, 중단과 바로잡기, 같은 requestId 로 다시 붙기, 미리 설명 작업, 실시간 사건 연결을 맡는다.
// 웹이 /session-client.mjs 정적 파일로 불러오므로 node: module 을 쓰지 않는다. 스레드는 서버가 준 값만 쓴다.
import { cardsPayload, excerpt } from "./conversations.mjs";

const LIVE_RETRY_FIRST = 500;
const LIVE_RETRY_MAX = 8000;

function pause(ms, signal) {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});
}

/**
 * @typedef {{profileId: string, sessionId: string, thread: string}} DraftPlace 질문이 돌아갈 입력창 자리
 * @typedef {object} Job 설명 작업 하나. 화면은 읽기만 하고, 자기 표시 상태는 job.view 에 둔다.
 * @property {string} requestId
 * @property {boolean} auto 미리 설명이면 참
 * @property {string} question
 * @property {string|null} display 화면에 보일 짧은 질문
 * @property {{label: string, text: string}|null} focus 질문 대상
 * @property {string} thread 서버가 정한 스레드. "" 는 세션 전체 대화
 * @property {string|null} stage null(보내는 중), "queued", "planning", "explaining"
 * @property {string} text 지금까지 받은 설명
 * @property {string[]} steers 바로잡기 문장
 * @property {boolean} cancelling 중단을 요청하는 중
 * @property {boolean} disconnected 연결이 끊김. 서버의 작업은 계속될 수 있어 resume 으로 다시 붙는다
 * @property {boolean} detached 다른 화면이 보낸 질문. 지켜보기만 하고 중단·바로잡기·입력창 복원을 하지 않는다
 * @property {object|null} outcome 끝난 결과
 * @property {object} view 화면 전용 자리
 */

/**
 * @param {object} options
 * @param {{ask: Function, cancel: Function, steer: Function, jobs: Function, events: Function}} options.transport 서버 port (HttpTransport 또는 테스트용 가짜)
 * @param {{read: (place: DraftPlace) => string|null, write: (place: DraftPlace, text: string) => void}} options.drafts 입력창. read 가 null 이면 그 자리에 되돌리지 않는다
 * @param {() => {thread: string, label: string}[]} [options.cards] 새 질문과 함께 보낼 지금 카드 목록
 * @param {() => string} [options.newRequestId]
 * @param {(change: object) => void} [options.onChange] 바뀔 때마다 {type: "job"|"end"|"queue"|"live"|"live-status", ...}
 */
export function createSessionClient({ transport, drafts, cards = () => [], newRequestId = () => globalThis.crypto.randomUUID(), onChange = () => {} }) {
	let context = null;
	let generation = 0;
	let active = null;
	const manual = [];
	const auto = new Map();
	let queue = [];
	let live = null;

	const emit = (change) => onChange(change);
	const isCurrent = (job) => Boolean(context && job.generation === context.generation);

	function makeJob(fields) {
		return {
			requestId: fields.requestId ?? newRequestId(),
			auto: Boolean(fields.auto),
			question: fields.question,
			display: fields.display || null,
			focus: fields.focus?.text ? { label: fields.focus.label, text: fields.focus.text } : null,
			thread: typeof fields.thread === "string" ? fields.thread : "",
			difficulty: fields.difficulty || null,
			profileId: context.profileId,
			sessionId: context.sessionId,
			generation: context.generation,
			stage: fields.stage ?? null,
			text: "",
			steers: [],
			cancelling: false,
			steering: false,
			disconnected: false,
			detached: Boolean(fields.detached),
			outcome: null,
			startedAt: Date.now(),
			body: null,
			controller: null,
			view: {},
		};
	}

	function bodyOf(job, withCards) {
		const body = { id: job.sessionId, profileId: job.profileId, question: job.question, requestId: job.requestId };
		if (job.auto) body.auto = true;
		if (job.focus) body.focus = { label: String(job.focus.label ?? "").slice(0, 200), text: excerpt(job.focus.text) };
		if (job.difficulty) body.difficulty = job.difficulty;
		if (withCards) body.cards = cardsPayload(cards());
		return body;
	}

	/** 보낸 질문은 그 자리의 입력창이 비어 있을 때만 돌아간다. 새로 쓴 초안은 덮어쓰지 않는다 (ADR 0029 §2, 0038 §8). */
	function restore(job) {
		const place = { profileId: job.profileId, sessionId: job.sessionId, thread: job.thread };
		const draft = drafts.read(place);
		if (typeof draft !== "string" || draft.trim()) return false;
		drafts.write(place, job.question);
		return true;
	}

	function progress(job, event) {
		if (event.type === "queued") job.stage = "queued";
		else if (event.type === "stage") job.stage = event.stage;
		else if (event.type === "delta") job.text += String(event.text ?? "");
		else if (event.type === "reset") job.text = "";
		else if (event.type === "steer") {
			if (typeof event.message !== "string" || job.steers.includes(event.message)) return;
			job.steers.push(event.message);
		} else return;
		emit({ type: "job", job, event });
	}

	/** 같은 requestId 로 스트림에 붙는다. 서버는 쌓인 글을 delta 하나로 다시 보내므로 받은 글은 비우고 시작한다. */
	async function attach(job, body) {
		job.controller?.abort();
		const controller = new AbortController();
		job.controller = controller;
		job.body = body;
		job.text = "";
		job.disconnected = false;
		emit({ type: "job", job });
		let outcome;
		try {
			outcome = await transport.ask(body, controller.signal, (event) => {
				if (job.controller === controller && isCurrent(job)) progress(job, event);
			});
		} catch (error) {
			if (job.controller !== controller || controller.signal.aborted) return;
			if (error?.status) outcome = { type: "error", error: error.message, status: error.status };
			else if (job.auto) outcome = { type: "error", error: error?.message || "연결이 끊겼어요." };
			else {
				// 연결이 끊긴 것만으로는 중단하지 않는다. 설명은 서버에서 계속될 수 있다 (ADR 0029 §2).
				job.controller = null;
				job.disconnected = true;
				emit({ type: "job", job, error: error?.message || "연결이 끊겼어요." });
				return;
			}
		}
		if (job.controller !== controller) return;
		job.controller = null;
		end(job, outcome);
	}

	function end(job, outcome) {
		if (job.outcome) return;
		job.outcome = outcome;
		job.controller?.abort();
		job.controller = null;
		job.cancelling = false;
		job.disconnected = false;
		if (!isCurrent(job)) return;
		if (job.auto) auto.delete(job.requestId);
		else if (manual.includes(job)) manual.splice(manual.indexOf(job), 1);
		if (active === job) active = null;
		const result = outcome.type === "cancelled" && !job.auto && !job.detached ? { ...outcome, restored: restore(job) } : outcome;
		emit({ type: "end", job, outcome: result });
		drain();
	}

	function start(job) {
		job.startedAt = Date.now();
		manual.push(job);
		active = job;
		void attach(job, bodyOf(job, true));
	}

	/** 진행 중인 설명이 없으면 대기 질문을 들어온 순서대로 하나 보낸다. 다른 세션·프로필에서 쌓인 질문은 보내지 않는다. */
	function drain() {
		let changed = false;
		while (!active && queue.length) {
			const job = queue.shift();
			changed = true;
			if (isCurrent(job)) start(job);
		}
		if (changed) emit({ type: "queue" });
	}

	function close() {
		live?.abort();
		live = null;
		const dropped = queue;
		queue = [];
		for (const job of [...manual, ...auto.values()]) {
			job.controller?.abort();
			job.controller = null;
		}
		manual.length = 0;
		auto.clear();
		active = null;
		// 보내지 못한 대기 질문은 그 자리의 빈 입력창으로 돌아간다.
		const restored = dropped.filter((job) => restore(job));
		context = null;
		if (dropped.length) emit({ type: "queue", dropped, restored });
	}

	return {
		get context() { return context ? { profileId: context.profileId, sessionId: context.sessionId } : null; },
		/** 이 화면에서 보낸 설명 중 지금 진행 중인 것. 연결이 끊겨도 서버에서 끝날 때까지 남는다. */
		get active() { return active; },
		/** 대기 질문(보낼 순서). */
		get queue() { return [...queue]; },
		/** 이 세션에서 따라가는 사용자 질문 작업(진행 중인 것과 다른 화면이 보낸 것). */
		get manual() { return [...manual]; },
		autoJob: (requestId) => auto.get(requestId) ?? null,

		/** 세션·프로필을 연다. 이전 세션의 스트림은 끊고(서버 작업은 계속) 대기 질문은 그 입력창으로 돌려보낸다. */
		open({ profileId, sessionId }) {
			close();
			context = { profileId, sessionId, generation: ++generation };
		},
		close,

		/** 질문을 보낸다. 설명이 진행 중이면 대기 질문이 된다 (ADR 0029 §4). 접수한 작업을 돌려준다. */
		ask({ question, focus = null, thread, display = null, difficulty = null }) {
			const text = String(question ?? "").trim();
			if (!context || !text) return null;
			const job = makeJob({ question: text, focus, thread: thread ?? focus?.thread ?? "", display, difficulty });
			if (active) {
				queue.push(job);
				emit({ type: "queue" });
			} else start(job);
			return job;
		},

		/** 대기 질문을 차례 전에 뺀다(고치기, 지우기). */
		unqueue(job) {
			const index = queue.indexOf(job);
			if (index < 0) return false;
			queue.splice(index, 1);
			emit({ type: "queue" });
			return true;
		},

		/** 진행 중인 설명을 멈춘다. 서버가 멈췄으면 보낸 질문은 빈 입력창으로 돌아간다. */
		async stop() {
			const job = active;
			if (!job || job.cancelling) return null;
			job.cancelling = true;
			emit({ type: "job", job });
			let result;
			try {
				result = await transport.cancel(job.profileId, job.requestId);
			} catch (error) {
				job.cancelling = false;
				emit({ type: "job", job });
				throw error;
			}
			if (result?.cancelled) {
				end(job, { type: "cancelled" });
				return { cancelled: true };
			}
			job.cancelling = false;
			emit({ type: "job", job });
			return { cancelled: false };
		},

		/** 진행 중인 설명을 바로잡는다 (ADR 0029 §3). 보냈으면 참. */
		async steer(message) {
			const job = active;
			const text = String(message ?? "").trim();
			if (!job || !text || job.steering) return false;
			job.steering = true;
			try {
				await transport.steer(job.profileId, job.requestId, text);
			} finally {
				job.steering = false;
			}
			if (!job.steers.includes(text)) {
				job.steers.push(text);
				emit({ type: "job", job });
			}
			return true;
		},

		/** 서버에 남은 이 세션의 작업에 같은 requestId 로 다시 붙는다(새로고침, 다시 열기). 사용자 질문 첫 작업이 진행 중인 설명이 된다. */
		async rejoin() {
			const opened = context;
			if (!opened) return;
			const list = await transport.jobs(opened.sessionId, opened.profileId);
			if (context !== opened || !Array.isArray(list)) return;
			for (const entry of list) {
				if (typeof entry?.requestId !== "string" || typeof entry.question !== "string") continue;
				if (auto.has(entry.requestId) || manual.some((job) => job.requestId === entry.requestId)) continue;
				const job = makeJob({
					requestId: entry.requestId, auto: entry.auto === true, question: entry.question, display: entry.display,
					focus: entry.focus, thread: entry.thread, difficulty: entry.difficulty, stage: entry.stage ?? "queued",
					detached: entry.auto !== true && Boolean(active),
				});
				if (job.auto) auto.set(job.requestId, job);
				else {
					manual.push(job);
					if (!job.detached) active = job;
				}
				void attach(job, bodyOf(job, false));
			}
		},

		/** 서버가 미리 설명을 붙인 카드의 작업에 붙는다. 이미 따라가는 작업이면 그것을 돌려준다. */
		attachAuto({ requestId, question, display = null, difficulty = null, focus = null, thread = "" }) {
			if (!context || typeof requestId !== "string" || typeof question !== "string") return null;
			const existing = auto.get(requestId);
			if (existing) return existing;
			const job = makeJob({ requestId, auto: true, question, display, difficulty, focus, thread });
			auto.set(requestId, job);
			void attach(job, bodyOf(job, false));
			return job;
		},

		/**
		 * 같은 requestId 로 결과를 다시 받는다. 끊긴 설명에 다시 붙거나, 실패로 끝난 요청의 저장된 결과를 확인한다.
		 * 이미 연결되어 있거나, 다른 설명이 진행 중이면 거짓.
		 */
		resume(job) {
			if (!job || !isCurrent(job) || job.controller) return false;
			if (job.outcome) {
				if (!job.auto && active) return false;
				job.outcome = null;
				if (job.auto) auto.set(job.requestId, job);
				else {
					job.detached = false;
					manual.push(job);
					active = job;
				}
			} else if (!job.disconnected) return false;
			void attach(job, job.body ?? bodyOf(job, false));
			return true;
		},

		/** 끊긴 사용자 질문을 더 따라가지 않는다(서버 작업은 계속). 다음 대기 질문이 이어진다. */
		abandon(job) {
			if (!job || job.auto || !manual.includes(job)) return false;
			job.controller?.abort();
			job.controller = null;
			job.outcome = { type: "abandoned" };
			manual.splice(manual.indexOf(job), 1);
			if (active === job) active = null;
			drain();
			return true;
		},

		/** 세션의 실시간 사건을 받는다. 연결이 닫히거나 실패하면 알리고 0.5초부터 8초까지 늘려 다시 붙는다. */
		async follow() {
			const opened = context;
			if (!opened) return;
			live?.abort();
			const controller = new AbortController();
			live = controller;
			let delay = LIVE_RETRY_FIRST;
			while (!controller.signal.aborted && context === opened) {
				try {
					await transport.events(opened.sessionId, opened.profileId, controller.signal, (event) => {
						if (!controller.signal.aborted && context === opened) emit({ type: "live", event });
					});
					if (controller.signal.aborted) return;
					emit({ type: "live-status", status: "closed" });
					delay = LIVE_RETRY_FIRST;
				} catch (error) {
					if (controller.signal.aborted) return;
					emit({ type: "live-status", status: "failed", error: error?.message || "실시간 연결에 실패했어요." });
				}
				await pause(delay, controller.signal);
				delay = Math.min(delay * 2, LIVE_RETRY_MAX);
			}
		},
	};
}
