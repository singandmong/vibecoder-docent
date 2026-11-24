// 도슨트 봇 (ADR 0076). 주인의 텔레그램 개인 채팅에서 같은 서버의 설명을 주고받는다.
// 모델은 부르지 않는다. 설명은 ports.open(= asks.open)으로만 만들고, 카드와 스레드는 서버가 준 값만 쓴다.
// 서버에는 전역 unhandledRejection 처리기가 없다. 따로 도는 promise 는 모두 detach() 로 잡아 로그한다.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { EXPLAIN_ACTIONS } from "./conversations.mjs";
import { EVENT_REQUEST } from "./dialogue.mjs";
import { writeJsonAtomic } from "./store.mjs";
import { redactToken } from "./telegram-api.mjs";
import { answerMessages, cardText, sourceText } from "./telegram-format.mjs";

const MESSAGES_MAX = 300;
const FOCUSES_MAX = 50;
const BUTTONS_MAX = 300;
const QUEUE_MAX = 5;
const PAST_MAX = 3;
const SESSION_BUTTONS = 8;
const CARD_BUTTONS = 8;
const ALLOWED_UPDATES = ["message", "callback_query", "stopped_message_generation"];

/**
 * 시험용으로 줄일 수 있는 시간 값. 기본값이 운영 값이다.
 * @typedef {object} Timing
 * @property {number} [followMs=60000] 따라가는 세션 다시 보기 간격
 * @property {number} [chunkGapMs=1100] 긴 답을 나눠 보낼 때 조각 사이 간격
 * @property {number} [draftMs=1500] 초안 갱신 최소 간격
 * @property {number[]} [backoffMs=[1000,2000,5000,10000,30000]] 일반 오류 뒤 대기
 * @property {number} [conflictMs=60000] 409(다른 소비자나 웹훅) 뒤 대기
 * @property {number} [retryUnitMs=1000] 429 의 retry_after 한 단위(초)가 몇 ms 인지
 * @property {number} [pollTimeout=50] getUpdates 긴 대기 시간(초)
 * @property {number} [requestTimeoutMs=65000] getUpdates 요청 시간 제한
 */
const TIMING = { followMs: 60_000, chunkGapMs: 1100, draftMs: 1500, backoffMs: [1000, 2000, 5000, 10_000, 30_000], conflictMs: 60_000, retryUnitMs: 1000, pollTimeout: 50, requestTimeoutMs: 65_000 };

const ALIASES = { 시작: "start", 세션: "session", 카드: "cards", 중단: "stop", 바로잡기: "steer", 상태: "status", 도움말: "help" };
const COMMANDS = [
	{ command: "start", description: "시작하기" },
	{ command: "session", description: "따라갈 세션 고르기" },
	{ command: "cards", description: "받은 카드 다시 보기" },
	{ command: "stop", description: "지금 설명 멈추기" },
	{ command: "steer", description: "지금 설명 바로잡기" },
	{ command: "status", description: "지금 상태 보기" },
	{ command: "help", description: "쓰는 방법 보기" },
];
const HELP = `도슨트 봇이에요. 글로 물어보면 따라가는 세션을 쉽게 설명해 드려요.
카드 알림의 답장이나 버튼으로 그 카드에 대해 이어서 물을 수 있어요.

/session 따라갈 세션 고르기
/cards 받은 카드 다시 보기
/stop 지금 설명 멈추기
/steer 문장: 지금 설명 바로잡기
/status 지금 상태 보기
/help 이 안내`;

const clip = (text, max) => {
	const chars = [...String(text ?? "")];
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};
const validMs = (value) => {
	const ms = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};

function emptyState() {
	return { offset: 0, following: null, lastCardAt: {}, messages: [], focuses: {}, buttons: {}, next: 1 };
}

function sameCode(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {object} options
 * @param {{call: (method: string, params?: object, options?: {signal?: AbortSignal, timeoutMs?: number}) => Promise<any>}} options.api
 * @param {{owner: number|null, profileId: string, token?: string}} options.config token 은 로그에서 지울 값이다. 없으면 DOCENT_TELEGRAM_TOKEN 환경변수를 쓴다.
 * @param {string} options.statePath
 * @param {string} options.pairPath
 * @param {object} options.ports 서버가 채우는 기능 모음(listSessions, subscribe, open, cancel, steer, history, evidence, profile, saveOwner)
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 * @param {Timing} [options.timing]
 */
export function createTelegramBot({ api, config, statePath, pairPath, ports, now = Date.now, log = console.error, timing = {} }) {
	const T = { ...TIMING, ...timing };
	const profileId = config.profileId ?? "default";
	const secret = () => config.token ?? process.env.DOCENT_TELEGRAM_TOKEN ?? "";
	const abort = new AbortController();
	const signal = abort.signal;

	let state = emptyState();
	let owner = Number.isSafeInteger(config.owner) ? config.owner : null;
	let username = null;
	let lastError = null;
	let started = false;
	let stopped = false;
	let startedAt = 0;
	let lastCheckAt = 0;
	let sub = null; // 지금 구독 중인 세션 {sessionId, title, host, alive, stop, ...}
	let active = null; // 진행 중인 사용자 질문
	let queue = [];
	let draftSeq = 0;
	let epoch = 0; // 주인이 바뀔 때마다 올린다. 이전 주인의 작업 출력은 epoch 가 달라 버려진다.
	let saving = Promise.resolve();
	let followLock = Promise.resolve();
	const seen = new Set(); // 이미 알린 thread
	const received = []; // 이번 실행에서 받은 카드
	const failedAuto = new Set();
	const inflight = new Set();
	const loops = [];

	const logError = (what, error) => {
		try {
			log(`docent: 텔레그램 ${what}: ${redactToken(error?.message ?? error, secret())}`);
		} catch {
			// 로그 실패가 봇을 멈추게 하지 않는다.
		}
	};
	const logLine = (text) => {
		try {
			log(redactToken(text, secret()));
		} catch {
			// 위와 같다.
		}
	};

	/** 따로 도는 promise 는 반드시 여기를 거친다. */
	function detach(promise, what) {
		const p = Promise.resolve(promise).catch((error) => logError(what, error));
		inflight.add(p);
		p.finally(() => inflight.delete(p));
		return p;
	}

	function sleep(ms, { unref = false } = {}) {
		return new Promise((resolve) => {
			if (signal.aborted) return resolve();
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			if (unref) timer.unref?.();
			signal.addEventListener("abort", done, { once: true });
		});
	}

	// 상태 파일 -------------------------------------------------------------
	async function loadState() {
		let text;
		try {
			text = await readFile(statePath, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") logError("상태 파일을 읽지 못해 빈 상태로 시작해요", error);
			return;
		}
		try {
			const raw = JSON.parse(text);
			const base = emptyState();
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("객체가 아니에요");
			state = {
				offset: Number.isSafeInteger(raw.offset) ? raw.offset : 0,
				following: raw.following && typeof raw.following.sessionId === "string" ? { sessionId: raw.following.sessionId, explicit: raw.following.explicit === true } : null,
				lastCardAt: raw.lastCardAt && typeof raw.lastCardAt === "object" && !Array.isArray(raw.lastCardAt) ? raw.lastCardAt : base.lastCardAt,
				messages: Array.isArray(raw.messages) ? raw.messages.filter((m) => Array.isArray(m) && m[1] && typeof m[1].sessionId === "string") : [],
				focuses: raw.focuses && typeof raw.focuses === "object" && !Array.isArray(raw.focuses) ? raw.focuses : base.focuses,
				buttons: raw.buttons && typeof raw.buttons === "object" && !Array.isArray(raw.buttons) ? raw.buttons : base.buttons,
				next: Number.isSafeInteger(raw.next) && raw.next > 0 ? raw.next : 1,
			};
		} catch (error) {
			state = emptyState();
			logError("상태 파일이 망가져 빈 상태로 시작해요", error);
		}
	}

	function save() {
		saving = saving.then(() => writeJsonAtomic(statePath, state)).catch((error) => logError("상태 파일을 저장하지 못했어요", error));
		return saving;
	}

	function remember(messageId, sessionId, thread) {
		if (!Number.isSafeInteger(messageId)) return;
		state.messages = state.messages.filter(([id]) => id !== messageId);
		state.messages.push([messageId, { sessionId, thread: thread ?? "" }]);
		if (state.messages.length > MESSAGES_MAX) state.messages = state.messages.slice(-MESSAGES_MAX);
	}
	const messageRef = (messageId) => state.messages.find(([id]) => id === messageId)?.[1] ?? null;

	function setFocus(thread, focus) {
		if (!thread || !focus) return;
		delete state.focuses[thread];
		state.focuses[thread] = { label: focus.label, text: focus.text };
		const keys = Object.keys(state.focuses);
		for (const key of keys.slice(0, Math.max(0, keys.length - FOCUSES_MAX))) delete state.focuses[key];
	}

	function addButton(record) {
		const n = state.next++;
		state.buttons[n] = record;
		const keys = Object.keys(state.buttons).sort((a, b) => a - b);
		for (const key of keys.slice(0, Math.max(0, keys.length - BUTTONS_MAX))) delete state.buttons[key];
		return n;
	}

	// 보내기 ----------------------------------------------------------------
	/** 429 면 retry_after 만큼 기다려 같은 호출을 한 번 더 한다. 실패는 로그만 하고 null 을 돌려준다. */
	async function send(method, params) {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (stopped) return null;
			try {
				return await api.call(method, params, { signal });
			} catch (error) {
				if (error?.status === 429 && attempt === 0 && !stopped) {
					await sleep((Number.isFinite(error.retryAfter) ? error.retryAfter : 1) * T.retryUnitMs);
					continue;
				}
				if (!stopped) logError(`${method} 실패`, error);
				return null;
			}
		}
		return null;
	}
	const sendText = (text, extra = {}, chatId = owner) => send("sendMessage", { chat_id: chatId, text, ...extra });
	const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } });

	async function sendParts(parts, { replyTo, buttons, sessionId, thread, epoch: bound }) {
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) await sleep(T.chunkGapMs);
			if (stopped || (bound !== undefined && bound !== epoch)) return;
			const params = { chat_id: owner, text: parts[i], parse_mode: "HTML", link_preview_options: { is_disabled: true } };
			if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
			if (buttons && i === parts.length - 1) params.reply_markup = { inline_keyboard: buttons };
			const sent = await send("sendMessage", params);
			if (sent?.message_id !== undefined && sessionId) remember(sent.message_id, sessionId, thread);
		}
	}

	async function sendAnswer(answer, ctx) {
		if (ctx.epoch !== epoch) return;
		const thread = typeof answer.thread === "string" ? answer.thread : "";
		if (thread && ctx.focus) setFocus(thread, ctx.focus);
		const rows = [EXPLAIN_ACTIONS.map((action, index) => ({ text: action.name[0], callback_data: `a:${addButton({ kind: "a", sessionId: ctx.sessionId, thread, action: index })}` }))];
		const ref = answer.citations?.find?.((citation) => typeof citation?.id === "string")?.id;
		if (ref) rows[0].push({ text: "원문", callback_data: `r:${addButton({ kind: "r", sessionId: ctx.sessionId, thread, ref })}` });
		const raw = typeof answer.raw === "string" ? answer.raw : [answer.headline, answer.explain].filter(Boolean).join("\n\n");
		await sendParts(answerMessages(raw), { replyTo: ctx.replyTo, buttons: rows, sessionId: ctx.sessionId, thread, epoch: ctx.epoch });
		await save();
	}

	// 설명 스트림 -----------------------------------------------------------
	/** 작업의 줄을 받아 초안(수동 질문만)과 최종 메시지로 보낸다. 끝나거나 stop() 이면 풀린다. */
	function followJob(job, ctx) {
		return new Promise((resolve) => {
			let text = "";
			let settled = false;
			let chain = Promise.resolve();
			let timer = null;
			let lastDraft = 0;
			let unsubscribe = null;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				unsubscribe?.();
				resolve();
			};
			const sendDraft = async () => {
				timer = null;
				if (ctx.epoch !== epoch) return;
				lastDraft = Date.now();
				const ok = await send("sendMessageDraft", { chat_id: owner, draft_id: ctx.draftId, text: text.slice(0, 4000), can_stop: true });
				if (ok === null) ctx.draft = false;
			};
			const scheduleDraft = () => {
				if (!ctx.draft || timer || settled) return;
				const wait = Math.max(0, lastDraft + T.draftMs - Date.now());
				timer = setTimeout(() => detach(sendDraft(), "초안"), wait);
			};
			const handle = async (line) => {
				if (ctx.epoch !== epoch) return;
				if (line.type === "answer") await sendAnswer(line.answer, ctx);
				else if (line.type === "error") await sendText(`설명하지 못했어요: ${line.error}`);
				else if (line.type === "cancelled") await sendText("멈췄어요.");
			};
			const onLine = (line) => {
				if (settled || !line || typeof line !== "object") return;
				if (line.type === "delta" && typeof line.text === "string") {
					text += line.text;
					scheduleDraft();
				} else if (line.type === "reset") text = "";
				else if (line.type === "queued" || line.type === "stage") scheduleDraft();
				else if (["answer", "error", "cancelled"].includes(line.type)) {
					clearTimeout(timer);
					timer = null;
					chain = chain.then(() => handle(line)).catch((error) => logError("설명 결과를 보내지 못했어요", error)).then(finish);
					return;
				}
			};
			signal.addEventListener("abort", finish, { once: true });
			try {
				unsubscribe = job.subscribe(onLine);
			} catch (error) {
				logError("설명 작업에 붙지 못했어요", error);
				finish();
				return;
			}
			if (settled) unsubscribe?.();
		});
	}

	async function runResult(res, ctx) {
		if (ctx.epoch !== epoch) return; // 주인이 바뀐 뒤 늦게 온 결과는 보내지 않는다
		if (res?.subscribe) await followJob(res, ctx);
		else if (res?.answer) await sendAnswer(res.answer, ctx);
		else if (res?.error) {
			if (res.error.cancelled) await sendText("멈췄어요.");
			else if (ctx.auto) logError("미리 설명이 실패했어요", res.error);
			else await sendText(`설명하지 못했어요: ${res.error.message ?? res.error}`);
		}
	}

	// 질문 ------------------------------------------------------------------
	async function runItem(item) {
		const run = { requestId: randomUUID(), draftId: ++draftSeq, cancelRequested: false, opened: false, epoch };
		active = run;
		const ctx = { sessionId: item.sessionId, focus: item.focus ?? null, replyTo: item.replyTo, draft: true, draftId: run.draftId, auto: false, epoch: run.epoch };
		try {
			let res;
			try {
				res = await ports.open({
					id: item.sessionId,
					profileId,
					question: item.question,
					requestId: run.requestId,
					...(item.focus ? { focus: item.focus } : {}),
					...(item.difficulty ? { difficulty: item.difficulty } : {}),
				});
			} catch (error) {
				if (run.epoch === epoch) await sendText(`설명하지 못했어요: ${error?.message ?? error}`);
				return;
			}
			run.opened = true;
			if (run.cancelRequested) await cancelJob(run.requestId);
			await runResult(res, ctx);
		} finally {
			if (active === run) active = null;
		}
	}

	function launch(item) {
		detach(runItem(item), "질문 처리").finally(() => {
			if (!stopped && !active && queue.length) launch(queue.shift());
		});
	}

	/** 진행 중이면 대기 질문으로, 아니면 바로 시작한다. */
	async function ask(item) {
		if (!active) return launch(item);
		if (queue.length >= QUEUE_MAX) return void (await sendText("대기 질문이 많아요. 지금 설명이 끝난 뒤 다시 보내 주세요."));
		queue.push(item);
		await sendText(`대기 질문으로 받았어요 (${queue.length}번째)`);
	}

	async function focusFor(sessionId, thread) {
		if (!thread) return { ok: true, focus: null };
		const known = state.focuses[thread];
		if (known) return { ok: true, focus: known };
		try {
			const rows = await ports.history(sessionId, profileId);
			const row = [...(rows ?? [])].reverse().find((entry) => entry.thread === thread && entry.focus?.text);
			if (row) {
				setFocus(thread, row.focus);
				return { ok: true, focus: state.focuses[thread] };
			}
		} catch (error) {
			logError("기록에서 질문 대상을 찾지 못했어요", error);
		}
		await sendText("오래된 카드라 이어 묻지 못해요. /cards 로 다시 골라 주세요.");
		return { ok: false };
	}

	async function askAbout({ sessionId, thread, question, difficulty, replyTo }) {
		const target = await focusFor(sessionId, thread);
		if (!target.ok) return;
		await ask({ sessionId, question, focus: target.focus, difficulty, replyTo });
	}

	// 카드 알림 -------------------------------------------------------------
	const baselineOf = (s) => validMs(state.lastCardAt[s.sessionId]) ?? s.baselineMs;

	async function notifyCard(s, card, { fresh }) {
		const { thread, focus } = card;
		setFocus(thread, focus);
		const eButton = { text: "쉽게 설명해줘", callback_data: `e:${addButton({ kind: "e", sessionId: s.sessionId, thread, sub: card.sub })}` };
		const oButton = { text: "원문 보기", callback_data: `o:${addButton({ kind: "o", sessionId: s.sessionId, thread })}` };
		const sent = await sendText(cardText(card), { parse_mode: "HTML", ...keyboard([[eButton, oButton]]) });
		if (sent?.message_id !== undefined) remember(sent.message_id, s.sessionId, thread);
		if (fresh) {
			const ts = validMs(card.ts);
			const stamp = new Date(ts ?? now()).toISOString();
			const previous = validMs(state.lastCardAt[s.sessionId]);
			if (previous === null || Date.parse(stamp) > previous) state.lastCardAt[s.sessionId] = stamp;
		}
		await save();
		const ask = card.ask;
		if (fresh && ask?.requestId && ask.question) detach(runAuto(s, card, ask, sent?.message_id), "미리 설명");
	}

	function register(s, card) {
		received.push({ sessionId: s.sessionId, sub: card.sub, thread: card.thread, focus: card.focus });
		if (received.length > 100) received.shift();
	}

	async function runAuto(s, card, ask, replyTo) {
		const bound = epoch;
		let res;
		try {
			res = await ports.open({ id: s.sessionId, profileId, question: ask.question, focus: card.focus, auto: true, difficulty: ask.difficulty, requestId: ask.requestId });
		} catch (error) {
			logError("미리 설명에 붙지 못했어요", error);
			return;
		}
		await runResult(res, { sessionId: s.sessionId, focus: card.focus, replyTo, draft: false, auto: true, epoch: bound });
	}

	const enqueue = (s, fn, what) => {
		s.chain = s.chain.then(fn).catch((error) => logError(what, error));
	};

	function onEvent(s, ev) {
		if (!s.alive || stopped || !ev || typeof ev !== "object") return;
		if (!["question", "assistant"].includes(ev.kind) || !ev.sub || typeof ev.thread !== "string" || !ev.thread || typeof ev.focus?.text !== "string" || !ev.focus.text.trim()) return;
		if (seen.has(ev.thread)) return;
		if (ev.past) {
			s.pending.push(ev);
			if (!s.flushing) {
				s.flushing = true;
				queueMicrotask(() => {
					s.flushing = false;
					enqueue(s, () => flushPast(s), "지난 카드 알림");
				});
			}
			return;
		}
		seen.add(ev.thread);
		register(s, ev);
		enqueue(s, () => notifyCard(s, ev, { fresh: true }), "카드 알림");
	}

	async function flushPast(s) {
		const batch = s.pending.splice(0).filter((ev) => !seen.has(ev.thread));
		if (!batch.length || !s.alive) return;
		const baseline = baselineOf(s);
		const fresh = [];
		for (const ev of batch) {
			if (seen.has(ev.thread)) continue;
			seen.add(ev.thread);
			register(s, ev);
			setFocus(ev.thread, ev.focus);
			const ts = validMs(ev.ts);
			if (ts !== null && ts > baseline) fresh.push(ev);
		}
		const shown = fresh.slice(-PAST_MAX);
		for (const ev of shown) {
			if (!s.alive || stopped) return;
			await notifyCard(s, ev, { fresh: true });
		}
		const more = fresh.length - shown.length;
		if (more > 0) await sendText(`그사이 카드가 ${more}개 더 있어요. /cards 로 볼 수 있어요.`);
		await save();
	}

	// 따라가는 세션 ---------------------------------------------------------
	const locked = (fn) => {
		const run = followLock.then(fn, fn);
		followLock = run.catch(() => {});
		return run;
	};

	function release(s) {
		if (!s) return;
		s.alive = false;
		try {
			s.stop?.();
		} catch (error) {
			logError("구독을 끝내지 못했어요", error);
		}
	}

	async function attach(session, baselineMs) {
		const s = { sessionId: session.id, title: session.title || session.id, host: session.host ?? null, baselineMs, alive: true, stop: null, pending: [], flushing: false, chain: Promise.resolve() };
		s.stop = await ports.subscribe({ sessionId: session.id, profileId, send: (ev) => onEvent(s, ev) });
		if (stopped) {
			release(s);
			return null;
		}
		return s;
	}

	/** 이전 구독을 끝내고 새 세션을 구독한다. 실패하면 이전 세션을 되살리고 거짓을 돌려준다. */
	async function switchTo(session, { explicit, baselineMs }) {
		const previous = sub;
		const keep = previous && state.following ? { session: { id: previous.sessionId, title: previous.title, host: previous.host } } : null;
		release(previous);
		sub = null;
		try {
			sub = await attach(session, baselineMs);
		} catch (error) {
			logError("세션을 구독하지 못했어요", error);
			if (keep) {
				try {
					sub = await attach(keep.session, now());
				} catch (again) {
					logError("이전 세션을 다시 구독하지 못했어요", again);
				}
			}
			return false;
		}
		if (!sub) return false;
		state.following = { sessionId: session.id, explicit: Boolean(explicit) };
		await save();
		return true;
	}

	const unfollowable = "이 세션을 지금 따라갈 수 없어요. 잠시 뒤 다시 골라 주세요.";

	/** 목록 첫 항목으로 자동 따라가기. initial 이면 봇 시작 시각이, 아니면 직전 확인 시각이 지난 카드의 기준이다. */
	async function autoFollow({ initial, announce, list: given }) {
		let list = given;
		if (!list) {
			try {
				list = await ports.listSessions();
			} catch (error) {
				logError("세션 목록을 읽지 못했어요", error);
				return null;
			}
		}
		const checkedAt = now();
		const baseline = initial ? startedAt : lastCheckAt;
		const top = Array.isArray(list) ? list[0] : null;
		lastCheckAt = checkedAt;
		if (!top || stopped) return top ?? null;
		if (sub?.alive && sub.sessionId === top.id) {
			if (!state.following) {
				state.following = { sessionId: top.id, explicit: false };
				await save();
			}
			return top;
		}
		if (await switchTo(top, { explicit: false, baselineMs: baseline })) {
			failedAuto.delete(top.id);
			if (announce && !initial && owner !== null) await sendText(`${sub.title} 세션으로 옮겨 따라가요`);
		} else if (!failedAuto.has(top.id)) {
			failedAuto.add(top.id);
			if (owner !== null) await sendText(unfollowable);
		}
		return top;
	}

	/** 시작 때와 짝지은 직후. explicit 로 저장된 세션이 있으면 그것을 되살린다. */
	async function resumeFollow() {
		if (owner === null || stopped) return;
		const saved = state.following;
		if (saved?.explicit) {
			let list = [];
			try {
				list = await ports.listSessions();
			} catch (error) {
				logError("세션 목록을 읽지 못했어요", error);
			}
			const session = Array.isArray(list) ? list.find((entry) => entry.id === saved.sessionId) : null;
			if (session && (await switchTo(session, { explicit: true, baselineMs: startedAt }))) return;
			state.following = null;
			await sendText("이 세션을 찾지 못했어요. /session 으로 다시 골라 주세요.");
			await autoFollow({ initial: true, announce: false, list });
			return;
		}
		await autoFollow({ initial: true, announce: false });
	}

	async function followLoop() {
		while (!stopped) {
			await sleep(T.followMs, { unref: true });
			if (stopped) break;
			if (owner === null || state.following?.explicit) continue;
			await locked(() => autoFollow({ initial: false, announce: true })).catch((error) => logError("세션 다시 보기 실패", error));
		}
	}

	// 명령 ------------------------------------------------------------------
	function parseCommand(text) {
		const m = typeof text === "string" ? /^\/([^\s@]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim()) : null;
		if (!m) return null;
		return { name: ALIASES[m[1]] ?? m[1].toLowerCase(), arg: (m[2] ?? "").trim() };
	}

	async function readPair() {
		try {
			const raw = JSON.parse(await readFile(pairPath, "utf8"));
			if (typeof raw?.code === "string" && raw.code && typeof raw.expiresAt === "number") return raw;
		} catch {
			// 없거나 망가진 파일은 코드가 없는 것이다.
		}
		return null;
	}

	/** `/start <코드>`. 맞으면 보낸 사람을 주인으로 저장한다. 틀리면 아무 답도 하지 않는다. */
	async function tryPair(message, code) {
		const pair = await readPair();
		if (!pair || !sameCode(pair.code, code) || !(now() < pair.expiresAt)) return false;
		const id = message.from.id;
		if (!Number.isSafeInteger(id)) return false;
		await ports.saveOwner(id);
		await rm(pairPath, { force: true }).catch((error) => logError("짝짓기 파일을 지우지 못했어요", error));
		if (owner !== id) {
			// 이전 주인의 작업은 멈추고, 그 출력은 epoch 가 달라 새 주인에게 가지 않는다.
			const old = active;
			epoch++;
			active = null;
			queue = [];
			received.length = 0;
			state.messages = [];
			state.buttons = {};
			state.focuses = {};
			state.lastCardAt = state.lastCardAt ?? {};
			if (old) {
				old.cancelRequested = true;
				if (old.opened) await cancelJob(old.requestId);
			}
		}
		owner = id;
		state.following = null;
		let list = [];
		try {
			list = await ports.listSessions();
		} catch (error) {
			logError("세션 목록을 읽지 못했어요", error);
		}
		const top = Array.isArray(list) ? list[0] : null;
		await sendText(top ? `연결했어요. 지금 ${top.title || top.id} 세션을 따라가요. /session 으로 바꿀 수 있어요.` : "연결했어요. 아직 따라갈 세션이 없어요. 세션이 생기면 자동으로 따라가요. /session 으로 바꿀 수 있어요.", {}, message.chat.id);
		await locked(() => autoFollow({ initial: true, announce: false, list }));
		await save();
		return true;
	}

	async function showSessions() {
		let list = [];
		try {
			list = await ports.listSessions();
		} catch (error) {
			logError("세션 목록을 읽지 못했어요", error);
		}
		const top = (Array.isArray(list) ? list : []).slice(0, SESSION_BUTTONS);
		if (!top.length) return void (await sendText("열려 있는 세션이 없어요."));
		const rows = top.map((session) => {
			const minutes = Math.max(0, Math.round((now() - (validMs(session.updated) ?? now())) / 60_000));
			const host = session.host ? ` (${session.host})` : "";
			return [{ text: `${clip(session.title || session.id, 40)} (${minutes}분 전)${host}`, callback_data: `s:${addButton({ kind: "s", sessionId: session.id })}` }];
		});
		rows.push([{ text: "자동으로 따라가기", callback_data: `s:${addButton({ kind: "s", action: "auto" })}` }]);
		await sendText("어떤 세션을 따라갈까요?", keyboard(rows));
		await save();
	}

	async function showCards() {
		if (!sub) return void (await sendText("따라가는 세션이 없어요. /session 으로 골라 주세요."));
		const mine = received.filter((card) => card.sessionId === sub.sessionId).slice(-CARD_BUTTONS);
		if (!mine.length) return void (await sendText("아직 받은 카드가 없어요."));
		const rows = mine.reverse().map((card) => [{ text: clip(card.focus.label, 40), callback_data: `c:${addButton({ kind: "c", sessionId: card.sessionId, thread: card.thread, sub: card.sub })}` }]);
		await sendText("받은 카드예요. 누르면 다시 보여 드려요.", keyboard(rows));
		await save();
	}

	async function showStatus() {
		let profile = null;
		try {
			profile = await ports.profile(profileId);
		} catch (error) {
			logError("프로필을 읽지 못했어요", error);
		}
		const mode = state.following?.explicit ? "직접 고름" : "자동";
		const lines = [
			sub ? `따라가는 세션: ${sub.title} (${mode})` : "따라가는 세션: 없어요",
			`프로필: ${profile?.name ?? profileId}, 미리 설명 ${profile?.autoExplain ? "켜짐" : "꺼짐"}`,
			`진행 중 ${active ? 1 : 0}개, 대기 ${queue.length}개`,
		];
		await sendText(lines.join("\n"));
	}

	async function cancelJob(requestId) {
		try {
			await ports.cancel({ profileId, requestId });
		} catch (error) {
			logError("중단하지 못했어요", error);
		}
	}

	async function stopCurrent() {
		if (!active) return false;
		active.cancelRequested = true;
		if (active.opened) await cancelJob(active.requestId);
		return true;
	}

	async function command(message, cmd) {
		switch (cmd.name) {
			case "session":
				return showSessions();
			case "cards":
				return showCards();
			case "stop":
				if (!(await stopCurrent())) await sendText("지금 진행 중인 설명이 없어요.");
				return;
			case "steer": {
				if (!active) return void (await sendText("지금 진행 중인 설명이 없어요."));
				if (!cmd.arg) return void (await sendText("/steer 뒤에 바로잡을 문장을 함께 보내 주세요."));
				try {
					await ports.steer({ profileId, requestId: active.requestId, message: cmd.arg });
					await sendText("바로잡기를 보냈어요.");
				} catch (error) {
					await sendText(`바로잡지 못했어요: ${error?.message ?? error}`);
				}
				return;
			}
			case "status":
				return showStatus();
			default:
				return void (await sendText(HELP));
		}
	}

	// 수신 ------------------------------------------------------------------
	async function handleMessage(message) {
		const from = message?.from;
		if (!from || message.chat?.type !== "private") return;
		const cmd = parseCommand(message.text);
		if (cmd?.name === "start" && cmd.arg) {
			await tryPair(message, cmd.arg);
			return;
		}
		if (owner === null || from.id !== owner) return;
		if (cmd) return command(message, cmd);
		if (typeof message.text !== "string" || !message.text.trim()) return void (await sendText("글로 물어봐 주세요."));
		const question = message.text.trim();
		const replied = message.reply_to_message?.message_id;
		const ref = replied !== undefined ? messageRef(replied) : null;
		if (ref) return askAbout({ sessionId: ref.sessionId, thread: ref.thread, question, replyTo: message.message_id });
		if (!sub) return void (await sendText("따라가는 세션이 없어요. /session 으로 골라 주세요."));
		return ask({ sessionId: sub.sessionId, question, focus: null, replyTo: message.message_id });
	}

	async function pick(button) {
		let list = [];
		try {
			list = await ports.listSessions();
		} catch (error) {
			logError("세션 목록을 읽지 못했어요", error);
		}
		if (button.action === "auto") {
			state.following = state.following ? { ...state.following, explicit: false } : null;
			await locked(() => autoFollow({ initial: false, announce: false, list }));
			await sendText(sub ? `자동으로 따라가요. 지금은 ${sub.title} 세션이에요.` : "자동으로 따라가요. 세션이 생기면 알려 드릴게요.");
			return;
		}
		const session = Array.isArray(list) ? list.find((entry) => entry.id === button.sessionId) : null;
		if (!session) return void (await sendText("이 세션을 찾지 못했어요. /session 으로 다시 골라 주세요."));
		const ok = await locked(() => switchTo(session, { explicit: true, baselineMs: now() }));
		await sendText(ok ? `${sub.title} 세션을 따라가요.` : unfollowable);
	}

	async function handleCallback(query) {
		const from = query?.from;
		const chat = query?.message?.chat;
		if (owner === null || !from || from.id !== owner || chat?.type !== "private") return;
		const match = /^([a-z]):(\d+)$/.exec(String(query.data ?? ""));
		const button = match ? state.buttons[match[2]] : null;
		if (!button || button.kind !== match[1]) {
			await send("answerCallbackQuery", { callback_query_id: query.id, text: "오래된 버튼이에요. 다시 물어봐 주세요." });
			return;
		}
		await send("answerCallbackQuery", { callback_query_id: query.id });
		const replyTo = query.message?.message_id;
		switch (button.kind) {
			case "s":
				return pick(button);
			case "e":
				return askAbout({ sessionId: button.sessionId, thread: button.thread, question: EVENT_REQUEST[button.sub] ?? EVENT_REQUEST.question, difficulty: "EASY", replyTo });
			case "a": {
				const action = EXPLAIN_ACTIONS[button.action];
				if (!action) return;
				return askAbout({ sessionId: button.sessionId, thread: button.thread, question: action.prompt, difficulty: action.difficulty, replyTo });
			}
			case "o": {
				const target = await focusFor(button.sessionId, button.thread);
				if (!target.ok) return;
				return sendParts(sourceText(target.focus.text), { replyTo, sessionId: button.sessionId, thread: button.thread });
			}
			case "r": {
				let result = null;
				try {
					result = await ports.evidence(button.sessionId, button.ref, profileId);
				} catch (error) {
					await sendText(`원문을 열지 못했어요: ${error?.message ?? error}`);
					return;
				}
				const text = result?.selected?.text;
				if (typeof text !== "string" || !text.trim()) return void (await sendText("원문을 찾지 못했어요."));
				return sendParts(sourceText(text), { replyTo });
			}
			case "c": {
				const focus = state.focuses[button.thread];
				if (!focus) return void (await sendText("오래된 카드라 다시 보여 드리지 못해요."));
				const target = { sessionId: button.sessionId };
				return notifyCard(target, { sub: button.sub, thread: button.thread, focus }, { fresh: false });
			}
			default:
		}
	}

	async function handleStopped(info) {
		if (owner === null || info?.chat?.type !== "private" || info.chat.id !== owner) return;
		if (active && info.draft_id === active.draftId) await stopCurrent();
	}

	async function handleUpdate(update) {
		if (update.callback_query) return handleCallback(update.callback_query);
		if (update.stopped_message_generation) return handleStopped(update.stopped_message_generation);
		if (update.message) return handleMessage(update.message);
	}

	async function pollLoop() {
		let failures = 0;
		while (!stopped) {
			let updates;
			try {
				updates = await api.call("getUpdates", { offset: state.offset, timeout: T.pollTimeout, allowed_updates: ALLOWED_UPDATES }, { signal, timeoutMs: T.requestTimeoutMs });
				failures = 0;
				lastError = null;
			} catch (error) {
				if (stopped) break;
				lastError = redactToken(error?.message ?? "알 수 없는 오류", secret());
				if (error?.status === 401) {
					lastError = "토큰이 올바르지 않아요";
					logLine(`docent: 텔레그램 ${lastError}`);
					return;
				}
				let wait;
				if (error?.status === 429) wait = (Number.isFinite(error.retryAfter) ? error.retryAfter : 1) * T.retryUnitMs;
				else if (error?.status === 409) {
					logLine("docent: 텔레그램 다른 곳에서도 업데이트를 받고 있어요 (409). 60초 뒤 다시 해요");
					wait = T.conflictMs;
				} else wait = T.backoffMs[Math.min(failures, T.backoffMs.length - 1)];
				failures++;
				logError("업데이트를 받지 못했어요", error);
				await sleep(wait);
				continue;
			}
			if (!Array.isArray(updates)) {
				await sleep(T.backoffMs[0]);
				continue;
			}
			for (const update of updates) {
				if (stopped) break;
				try {
					await handleUpdate(update);
				} catch (error) {
					logError("업데이트를 처리하지 못했어요", error);
				}
				if (Number.isSafeInteger(update?.update_id)) state.offset = Math.max(state.offset, update.update_id + 1);
			}
			if (updates.length) save();
		}
	}

	// 수명 ------------------------------------------------------------------
	async function start() {
		if (started) return;
		started = true;
		startedAt = now();
		lastCheckAt = startedAt;
		await loadState();
		let failures = 0;
		while (!stopped) {
			try {
				const me = await api.call("getMe", {}, { signal });
				username = typeof me?.username === "string" ? me.username : null;
				lastError = null;
				break;
			} catch (error) {
				if (stopped) return;
				if (error?.status === 401) {
					lastError = "토큰이 올바르지 않아요";
					logLine(`docent: 텔레그램 ${lastError}`);
					return;
				}
				lastError = redactToken(error?.message ?? "알 수 없는 오류", secret());
				logError("getMe 실패", error);
				await sleep(T.backoffMs[Math.min(failures++, T.backoffMs.length - 1)]);
			}
		}
		if (stopped) return;
		await api.call("setMyCommands", { commands: COMMANDS }, { signal }).catch((error) => logError("명령 등록 실패", error));
		loops.push(detach(pollLoop(), "수신 루프"));
		loops.push(detach(followLoop(), "세션 따라가기 루프"));
		if (owner !== null) await locked(resumeFollow).catch((error) => logError("세션 따라가기를 시작하지 못했어요", error));
	}

	async function stop() {
		if (stopped) return;
		stopped = true;
		abort.abort();
		release(sub);
		// 어떤 이유로든 정리가 멈추지 않도록 기다림에 상한을 둔다.
		let guard;
		const limit = new Promise((resolve) => { guard = setTimeout(resolve, 3000); });
		await Promise.race([Promise.allSettled([...loops, ...inflight]), limit]);
		clearTimeout(guard);
		await saving;
		if (started) await save();
	}

	return {
		start,
		stop,
		status: () => ({ enabled: true, username, paired: owner !== null, following: Boolean(sub?.alive), lastError }),
	};
}
