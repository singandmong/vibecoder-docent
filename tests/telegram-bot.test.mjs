import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { EXPLAIN_ACTIONS } from "../app/conversations.mjs";
import { EVENT_REQUEST } from "../app/dialogue.mjs";
import { httpError } from "../app/errors.mjs";
import { TelegramError } from "../app/telegram-api.mjs";
import { createTelegramBot } from "../app/telegram-bot.mjs";

const TOKEN = "123456:SECRET-token_abc";
const OWNER = 42;
const T0 = 1_700_000_000_000;
const CODE = "pair-code_ABC123";
const RAW = "✅ 결론이에요\n\n쉬운 설명이에요.";

// 전역 감시: 어떤 시험에서도 놓친 거부가 있으면 안 된다.
const rejections = [];
const onRejection = (reason) => rejections.push(reason);
process.on("unhandledRejection", onRejection);
after(() => {
	process.off("unhandledRejection", onRejection);
	assert.deepEqual(rejections, []);
});

const S1 = { id: "claude:a", title: "첫 세션", updated: new Date(T0).toISOString(), host: null };
const S2 = { id: "claude:b", title: "둘째 세션", updated: new Date(T0).toISOString(), host: null };
const S3 = { id: "@book:c", title: "셋째 세션", updated: new Date(T0).toISOString(), host: "book" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await fn();
		if (value) return value;
		await sleep(5);
	}
	assert.fail(`시간 안에 되지 않았어요: ${label}`);
}

function fakeApi() {
	const calls = [];
	const updates = [];
	const handlers = {};
	let mid = 100;
	const api = {
		calls,
		handlers,
		push: (batch) => updates.push(batch),
		of: (method) => calls.filter((c) => c.method === method),
		texts: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params.text),
		async call(method, params = {}, { signal } = {}) {
			const entry = { method, params, at: Date.now() };
			calls.push(entry);
			if (handlers[method]) {
				const count = calls.filter((c) => c.method === method).length;
				const result = await handlers[method](params, count);
				if (result !== undefined) return result;
			}
			if (method === "getMe") return { username: "docent_bot" };
			if (method === "getUpdates") {
				if (updates.length) {
					const next = updates.shift();
					if (next instanceof Error) throw next;
					return next;
				}
				await new Promise((resolve) => {
					const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
					const timer = setTimeout(done, 15);
					signal?.addEventListener("abort", done, { once: true });
				});
				if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
				return [];
			}
			if (method === "sendMessage") {
				entry.result = ++mid;
				return { message_id: entry.result };
			}
			return true;
		},
	};
	return api;
}

function fakeJob(requestId) {
	const subs = new Set();
	const job = {
		requestId,
		terminal: null,
		emit(line) {
			if (job.terminal) return;
			if (["answer", "error", "cancelled"].includes(line.type)) job.terminal = line;
			for (const fn of subs) fn(line);
		},
		subscribe(fn) {
			if (job.terminal) {
				fn(job.terminal);
				return () => {};
			}
			fn({ type: "queued" });
			subs.add(fn);
			return () => subs.delete(fn);
		},
		cancel() {
			job.emit({ type: "cancelled" });
			return true;
		},
	};
	return job;
}

function fakePorts() {
	const p = {
		sessions: [S1],
		subscribes: [],
		stops: 0,
		opens: [],
		jobs: [],
		cancels: [],
		steers: [],
		saved: [],
		evidences: [],
		rows: [],
		listSessions: async () => p.sessions.map((s) => ({ ...s })),
		async subscribe(arg) {
			p.subscribes.push(arg);
			await p.subscribeImpl?.(arg, p.subscribes.length);
			return () => { p.stops++; };
		},
		async open(input) {
			p.opens.push(input);
			if (p.openImpl) return p.openImpl(input);
			const job = fakeJob(input.requestId);
			p.jobs.push(job);
			return job;
		},
		async cancel(arg) {
			p.cancels.push(arg);
			return p.jobs.find((job) => job.requestId === arg.requestId)?.cancel() ?? false;
		},
		async steer(arg) { p.steers.push(arg); },
		history: async () => p.rows,
		async evidence(...args) {
			p.evidences.push(args);
			return { selected: { text: "원문 본문" } };
		},
		profile: async () => ({ name: "기본", autoExplain: true }),
		async saveOwner(id) { p.saved.push(id); },
	};
	return p;
}

async function setup(t, { owner = OWNER, timing = {}, dir: given, state, pair } = {}) {
	const dir = given ?? (await mkdtemp(join(tmpdir(), "tgbot-")));
	const cleanups = [];
	t.after(async () => {
		for (const fn of cleanups) await fn();
		await rm(dir, { recursive: true, force: true });
	});
	const statePath = join(dir, "telegram.json");
	const pairPath = join(dir, "telegram-pair.json");
	if (state !== undefined) await writeFile(statePath, typeof state === "string" ? state : JSON.stringify(state));
	if (pair) await writeFile(pairPath, JSON.stringify(pair));
	const api = fakeApi();
	const ports = fakePorts();
	const clock = { t: T0 };
	const logs = [];
	const bot = createTelegramBot({
		api,
		config: { owner, profileId: "default", token: TOKEN },
		statePath,
		pairPath,
		ports,
		now: () => clock.t,
		log: (...args) => logs.push(args.join(" ")),
		timing: { followMs: 40, chunkGapMs: 5, draftMs: 10, backoffMs: [10, 10, 10], conflictMs: 60, retryUnitMs: 10, pollTimeout: 1, ...timing },
	});
	cleanups.push(() => bot.stop());
	let uid = 0;
	let mid = 1000;
	const h = {
		dir, statePath, pairPath, api, ports, clock, logs, bot,
		msg: (text, extra = {}, from = OWNER) => ({ update_id: ++uid, message: { message_id: ++mid, from: { id: from }, chat: { id: from, type: "private" }, text, ...extra } }),
		cb: (data, messageId = 1, from = OWNER) => ({ update_id: ++uid, callback_query: { id: `cb${uid}`, from: { id: from }, data, message: { message_id: messageId, chat: { id: from, type: "private" } } } }),
		stopped: (draftId) => ({ update_id: ++uid, stopped_message_generation: { chat: { id: OWNER, type: "private" }, draft_id: draftId } }),
		get lastId() { return uid; },
		/** 이 id 까지의 업데이트가 처리돼 다음 getUpdates 가 나갈 때까지. */
		processed: (id) => until(() => api.of("getUpdates").some((c) => c.params.offset > id), `update ${id} 처리`),
		send: async (update) => {
			api.push([update]);
			await h.processed(update.update_id);
		},
		text: (needle) => until(() => api.texts().find((x) => x.includes(needle)), `메시지 ${needle}`),
		/** 보낸 카드 알림 메시지(사건 종류 문구가 든 것). */
		cards: () => api.of("sendMessage").filter((c) => c.params.text.startsWith("AI가 물어봐요")),
		async startBot() {
			await bot.start();
			return h;
		},
		subscribed: (n = 1) => until(() => ports.subscribes.length >= n, `subscribe ${n}회`),
	};
	return h;
}

/** 진행 중인 설명이 모두 끝날 때까지(상태 문구가 진행 중 0개). */
async function idle(h) {
	await until(async () => {
		const before = h.api.texts().length;
		await h.send(h.msg("/status"));
		return h.api.texts().slice(before).some((x) => x.includes("진행 중 0개") && x.includes("대기 0개"));
	}, "설명이 끝나기");
}

const card = (n, extra = {}) => ({ kind: "assistant", sub: "question", text: `질문 ${n}`, thread: n.toString(16).padStart(16, "0"), focus: { label: `카드 ${n}`, text: `카드 ${n} 전문` }, ...extra });
const buttonsOf = (call) => (call.params.reply_markup?.inline_keyboard ?? []).flat();
const dataOf = (call, textPart) => buttonsOf(call).find((b) => b.text.includes(textPart))?.callback_data;
const answerOf = (extra = {}) => ({ raw: RAW, thread: "", citations: [], ...extra });

test("시작하면 getMe 로 이름을 얻고 명령 7개를 영어 소문자 이름으로 등록한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	assert.equal(h.bot.status().username, "docent_bot");
	const commands = h.api.of("setMyCommands")[0].params.commands;
	assert.deepEqual(commands.map((c) => c.command), ["start", "session", "cards", "stop", "steer", "status", "help"]);
	assert.ok(commands.every((c) => /^[a-z]+$/.test(c.command) && c.description));
});

test("주인이 아닌 사람과 그룹 채팅은 아무 일도 일으키지 않는다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	h.api.push([
		h.msg("질문이에요", {}, 7),
		{ update_id: 900, message: { message_id: 1, from: { id: OWNER }, chat: { id: -100, type: "group" }, text: "질문이에요" } },
		h.msg("/help", {}, 7),
	]);
	await h.processed(900);
	assert.equal(h.ports.opens.length, 0);
	assert.equal(h.api.of("sendMessage").length, 0);
});

test("주인이 아닌 계정의 콜백 버튼은 open 도 답도 만들지 않는다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.cb("e:1", 1, 7));
	assert.equal(h.ports.opens.length, 0);
	assert.equal(h.api.of("sendMessage").length, 0);
	assert.equal(h.api.of("answerCallbackQuery").length, 0);
});

test("맞는 코드로 /start 하면 주인이 저장되고 파일이 지워지고 답 하나와 구독 하나가 생긴다", async (t) => {
	const h = await setup(t, { owner: null, pair: { code: CODE, expiresAt: T0 + 600_000 } });
	await h.startBot();
	assert.equal(h.bot.status().paired, false);
	assert.equal(h.ports.subscribes.length, 0);
	await h.send(h.msg(`/start ${CODE}`, {}, 99));
	assert.deepEqual(h.ports.saved, [99]);
	await assert.rejects(stat(h.pairPath), { code: "ENOENT" });
	const replies = h.api.of("sendMessage");
	assert.equal(replies.length, 1);
	assert.ok(replies[0].params.text.includes("연결했어요") && replies[0].params.text.includes("첫 세션"));
	await h.subscribed();
	assert.equal(h.ports.subscribes.length, 1);
	assert.equal(h.ports.subscribes[0].sessionId, S1.id);
	assert.equal(h.bot.status().paired, true);
});

test("틀린 코드와 만료된 코드에는 아무 호출도 하지 않는다", async (t) => {
	const h = await setup(t, { owner: null, pair: { code: CODE, expiresAt: T0 + 1000 } });
	await h.startBot();
	await h.send(h.msg("/start wrong-code", {}, 99));
	h.clock.t = T0 + 5000;
	await h.send(h.msg(`/start ${CODE}`, {}, 99));
	assert.deepEqual(h.ports.saved, []);
	assert.equal(h.api.of("sendMessage").length, 0);
	assert.equal(h.ports.subscribes.length, 0);
});

test("주인이 코드 없이 /start 하면 도움말 하나를 받는다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.msg("/start"));
	const texts = h.api.texts();
	assert.equal(texts.length, 1);
	assert.ok(texts[0].includes("/session") && texts[0].includes("/stop"));
});

test("다시 짝짓기: 새 주인의 글만 처리되고 이전 주인의 글은 무시된다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await writeFile(h.pairPath, JSON.stringify({ code: CODE, expiresAt: T0 + 600_000 }));
	await h.send(h.msg(`/start ${CODE}`, {}, 99));
	assert.deepEqual(h.ports.saved, [99]);
	await h.send(h.msg("이전 주인의 질문", {}, OWNER));
	assert.equal(h.ports.opens.length, 0);
	await h.send(h.msg("새 주인의 질문", {}, 99));
	await until(() => h.ports.opens.length === 1, "새 주인 질문");
	assert.equal(h.ports.opens[0].question, "새 주인의 질문");
});

test("자동 따라가기: 시작하면 첫 세션을 구독하고 첫 항목이 바뀌면 옮기며 안내한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	assert.equal(h.ports.opens.length, 0);
	assert.equal(h.ports.subscribes.length, 1);
	assert.equal(h.ports.subscribes[0].sessionId, S1.id);
	h.ports.sessions = [S2, S1];
	await h.subscribed(2);
	assert.equal(h.ports.subscribes[1].sessionId, S2.id);
	assert.equal(h.ports.stops, 1);
	const notice = await h.text("옮겨 따라가요");
	assert.ok(notice.includes("둘째 세션"));
	await sleep(150);
	assert.equal(h.api.texts().filter((x) => x.includes("옮겨 따라가요")).length, 1);
});

test("/session 버튼: 제목과 몇 분 전과 peer 표시, 직접 고르면 고정되어 옮기지 않는다", async (t) => {
	const h = await setup(t);
	h.ports.sessions = [S2, S1, S3];
	await h.startBot();
	await h.send(h.msg("/session"));
	const menu = await until(() => h.api.of("sendMessage").find((c) => c.params.text.includes("어떤 세션")), "세션 목록");
	const labels = buttonsOf(menu).map((b) => b.text);
	assert.ok(labels.some((x) => x.includes("셋째 세션") && x.includes("(0분 전)") && x.includes("(book)")));
	assert.equal(labels.at(-1), "자동으로 따라가기");
	assert.ok(buttonsOf(menu).every((b) => /^s:\d+$/.test(b.callback_data)));
	await h.send(h.cb(dataOf(menu, "첫 세션")));
	await h.subscribed(2);
	assert.equal(h.ports.subscribes[1].sessionId, S1.id);
	assert.equal(h.api.of("answerCallbackQuery").length, 1);
	h.ports.sessions = [S3, S2, S1];
	await sleep(200);
	assert.equal(h.ports.subscribes.length, 2);
	assert.equal(h.ports.stops, 1);
	const saved = JSON.parse(await readFile(h.statePath, "utf8"));
	assert.deepEqual(saved.following, { sessionId: S1.id, explicit: true });
});

test("subscribe 가 던지면 안내 하나만 보내고 예외 없이 계속한다", async (t) => {
	const h = await setup(t);
	h.ports.subscribeImpl = () => { throw httpError(503, "구독이 너무 많아요"); };
	await h.startBot();
	await h.text("따라갈 수 없어요");
	await sleep(150);
	assert.equal(h.api.texts().filter((x) => x.includes("따라갈 수 없어요")).length, 1);
	assert.equal(h.bot.status().following, false);
});

test("status().following 은 subscribe 가 돌아온 뒤에만 참이다", async (t) => {
	const h = await setup(t);
	let release;
	h.ports.subscribeImpl = () => new Promise((resolve) => { release = resolve; });
	const started = h.bot.start();
	await h.subscribed();
	assert.equal(h.bot.status().following, false);
	release();
	await started;
	assert.equal(h.bot.status().following, true);
});

test("질문은 작업을 열고 초안을 여러 번 보낸 뒤 HTML 최종 메시지를 보내고 표에 남긴다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	const question = h.msg("이게 뭐예요?");
	await h.send(question);
	await until(() => h.ports.opens.length === 1, "open");
	const input = h.ports.opens[0];
	assert.equal(input.id, S1.id);
	assert.equal(input.question, "이게 뭐예요?");
	assert.equal(typeof input.requestId, "string");
	assert.equal(input.focus, undefined);
	const job = h.ports.jobs[0];
	job.emit({ type: "stage", stage: "explain" });
	await until(() => h.api.of("sendMessageDraft").length >= 1, "첫 초안");
	for (const piece of ["안녕", "하세요", "요"]) {
		job.emit({ type: "delta", text: piece });
		await sleep(25);
	}
	await until(() => h.api.of("sendMessageDraft").length >= 2, "여러 초안");
	const drafts = h.api.of("sendMessageDraft");
	assert.ok(drafts.every((c) => c.params.can_stop === true && Number.isInteger(c.params.draft_id) && c.params.draft_id !== 0));
	assert.ok(drafts.at(-1).params.text.includes("안녕"));
	job.emit({ type: "answer", answer: answerOf({ thread: "abcdef0123456789" }) });
	const finalCall = await until(() => h.api.of("sendMessage").find((c) => c.params.parse_mode === "HTML"), "최종 메시지");
	assert.ok(finalCall.params.text.includes("결론이에요"));
	assert.equal(finalCall.params.reply_parameters.message_id, question.message.message_id);
	assert.deepEqual(finalCall.params.link_preview_options, { is_disabled: true });
	assert.deepEqual(buttonsOf(finalCall).map((b) => b.text), EXPLAIN_ACTIONS.map((a) => a.name[0]));
	await h.bot.stop();
	const saved = JSON.parse(await readFile(h.statePath, "utf8"));
	assert.ok(saved.messages.some(([id, ref]) => id === finalCall.result && ref.sessionId === S1.id && ref.thread === "abcdef0123456789"));
});

test("open 이 저장된 답을 주면 초안 없이 최종 메시지, 저장된 오류와 던진 오류는 오류 문구", async (t) => {
	const h = await setup(t);
	await h.startBot();
	h.ports.openImpl = async () => ({ answer: answerOf() });
	await h.send(h.msg("저장된 답"));
	await h.text("결론이에요");
	await idle(h);
	assert.equal(h.api.of("sendMessageDraft").length, 0);
	h.ports.openImpl = async () => ({ error: httpError(409, "이 요청은 이전 실행에서 중단되었어요") });
	await h.send(h.msg("저장된 오류"));
	await h.text("설명하지 못했어요: 이 요청은 이전 실행에서 중단되었어요");
	await idle(h);
	h.ports.openImpl = async () => { throw httpError(400, "질문이 너무 길어요"); };
	await h.send(h.msg("던지는 질문"));
	await h.text("설명하지 못했어요: 질문이 너무 길어요");
	assert.equal(h.api.of("sendMessageDraft").length, 0);
});

test("카드 알림은 사건 문구와 라벨만 담고 버튼 둘이 붙으며 같은 thread 는 한 번만 알린다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	const send = h.ports.subscribes[0].send;
	send(card(1));
	send({ kind: "record", recordId: "r", thread: card(1).thread });
	send({ kind: "hello", text: "안녕" });
	send({ kind: "warn", text: "경고" });
	send(card(1, { text: "다른 본문" }));
	await until(() => h.cards().length === 1, "카드 알림");
	await sleep(60);
	assert.equal(h.cards().length, 1);
	assert.equal(h.api.of("sendMessage").length, 1);
	const call = h.cards()[0];
	assert.equal(call.params.text, "AI가 물어봐요\n카드 1");
	assert.ok(!call.params.text.includes("전문"));
	assert.equal(call.params.parse_mode, "HTML");
	assert.deepEqual(buttonsOf(call).map((b) => b.text), ["쉽게 설명해줘", "원문 보기"]);
	assert.match(dataOf(call, "쉽게"), /^e:\d+$/);
	assert.match(dataOf(call, "원문"), /^o:\d+$/);
});

test("e 버튼은 요청문과 EASY 와 카드 focus 로 open 하고 o 버튼은 전문을 보낸다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	h.ports.subscribes[0].send(card(1));
	const call = await until(() => h.cards()[0], "카드");
	await h.send(h.cb(dataOf(call, "쉽게"), call.result));
	assert.equal(h.api.of("answerCallbackQuery").length, 1);
	await until(() => h.ports.opens.length === 1, "open");
	const input = h.ports.opens[0];
	assert.equal(input.question, EVENT_REQUEST.question);
	assert.equal(input.difficulty, "EASY");
	assert.deepEqual(input.focus, card(1).focus);
	assert.equal(input.id, S1.id);
	await h.send(h.cb(dataOf(call, "원문"), call.result));
	const source = await h.text("카드 1 전문");
	assert.ok(source.includes("<blockquote"));
	assert.equal(h.api.of("answerCallbackQuery").length, 2);
});

test("r 버튼은 evidence 를 불러 원문을 보내고 a 버튼은 EXPLAIN_ACTIONS 로 묻는다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	h.ports.openImpl = async () => ({ answer: answerOf({ thread: "abcdef0123456789", citations: [{ id: `s_${"a".repeat(40)}` }] }) });
	await h.send(h.msg("근거가 있는 질문"));
	const final = await until(() => h.api.of("sendMessage").find((c) => c.params.parse_mode === "HTML"), "최종 메시지");
	assert.deepEqual(buttonsOf(final).map((b) => b.text), [...EXPLAIN_ACTIONS.map((a) => a.name[0]), "원문"]);
	await h.send(h.cb(dataOf(final, "원문"), final.result));
	await h.text("원문 본문");
	assert.deepEqual(h.ports.evidences[0], [S1.id, `s_${"a".repeat(40)}`, "default"]);
	// 질문에 focus 가 없어도 thread 가 있는 답은 history 가 없으면 오래된 카드로 안내한다
	await h.send(h.cb(dataOf(final, "10초"), final.result));
	await h.text("오래된 카드라 이어 묻지 못해요");
	h.ports.rows = [{ thread: "abcdef0123456789", focus: { label: "라벨", text: "본문" } }];
	await h.send(h.cb(dataOf(final, "맥락"), final.result));
	await until(() => h.ports.opens.length === 2, "맥락 open");
	const context = EXPLAIN_ACTIONS.find((a) => a.name[0] === "맥락");
	assert.equal(h.ports.opens[1].question, context.prompt);
	assert.deepEqual(h.ports.opens[1].focus, { label: "라벨", text: "본문" });
});

test("오래된 버튼 번호는 안내 문구로만 답한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.cb("e:9999"));
	const answered = h.api.of("answerCallbackQuery");
	assert.equal(answered.length, 1);
	assert.ok(answered[0].params.text.includes("오래된 버튼이에요"));
	assert.equal(h.ports.opens.length, 0);
});

test("카드 알림에 답장하면 그 카드의 focus 로 이어 묻는다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	h.ports.subscribes[0].send(card(2));
	const call = await until(() => h.cards()[0], "카드");
	await h.send(h.msg("더 알려줘", { reply_to_message: { message_id: call.result } }));
	await until(() => h.ports.opens.length === 1, "open");
	assert.deepEqual(h.ports.opens[0].focus, card(2).focus);
	assert.equal(h.ports.opens[0].question, "더 알려줘");
	assert.equal(h.ports.opens[0].id, S1.id);
});

test("focus 가 표에 없으면 기록에서 찾고, 기록에도 없으면 오래된 카드라고 안내한다", async (t) => {
	const thread = "0123456789abcdef";
	const lost = "fedcba9876543210";
	const state = { offset: 0, following: null, lastCardAt: {}, messages: [[500, { sessionId: S1.id, thread }], [501, { sessionId: S1.id, thread: lost }]], focuses: {}, buttons: {}, next: 1 };
	const h = await setup(t, { state });
	h.ports.rows = [{ thread, focus: { label: "기록 라벨", text: "기록 본문" } }];
	await h.startBot();
	await h.send(h.msg("이어서", { reply_to_message: { message_id: 500 } }));
	await until(() => h.ports.opens.length === 1, "open");
	assert.deepEqual(h.ports.opens[0].focus, { label: "기록 라벨", text: "기록 본문" });
	await h.send(h.msg("또 이어서", { reply_to_message: { message_id: 501 } }));
	await h.text("오래된 카드라 이어 묻지 못해요");
	assert.equal(h.ports.opens.length, 1);
});

test("진행 중에 온 질문은 대기열에 들어가 순서대로 보내지고 다섯을 넘으면 거절된다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.msg("첫째"));
	await until(() => h.ports.opens.length === 1, "첫째 open");
	await h.send(h.msg("둘째"));
	await h.send(h.msg("셋째"));
	await h.text("대기 질문으로 받았어요 (1번째)");
	await h.text("대기 질문으로 받았어요 (2번째)");
	assert.equal(h.ports.opens.length, 1);
	h.ports.jobs[0].emit({ type: "answer", answer: answerOf() });
	await until(() => h.ports.opens.length === 2, "둘째 open");
	assert.equal(h.ports.opens[1].question, "둘째");
	h.ports.jobs[1].emit({ type: "answer", answer: answerOf() });
	await until(() => h.ports.opens.length === 3, "셋째 open");
	assert.equal(h.ports.opens[2].question, "셋째");
	for (const n of [4, 5, 6, 7, 8]) await h.send(h.msg(`질문${n}`));
	await h.text("(5번째)");
	await h.send(h.msg("넘치는 질문"));
	await h.text("대기 질문이 많아요");
});

test("설명 중 도착한 stopped_message_generation 은 draft_id 가 맞을 때만 cancel 하고 멈췄어요를 보낸다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.msg("오래 걸리는 질문"));
	await until(() => h.ports.opens.length === 1, "open");
	const draft = await until(() => h.api.of("sendMessageDraft")[0], "초안");
	await h.send(h.stopped(draft.params.draft_id + 99));
	assert.equal(h.ports.cancels.length, 0);
	await h.send(h.stopped(draft.params.draft_id));
	assert.equal(h.ports.cancels.length, 1);
	assert.equal(h.ports.cancels[0].requestId, h.ports.opens[0].requestId);
	await h.text("멈췄어요.");
});

test("/stop 과 한글 별칭 /중단 은 진행 중인 설명을 멈추고 없으면 안내한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.msg("/중단"));
	await h.text("지금 진행 중인 설명이 없어요.");
	await h.send(h.msg("질문"));
	await until(() => h.ports.opens.length === 1, "open");
	await h.send(h.msg("/stop"));
	await until(() => h.ports.cancels.length === 1, "cancel");
	await h.text("멈췄어요.");
});

test("/steer 는 진행 중이면 steer 를 부르고 없으면 안내한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.msg("/steer 더 짧게"));
	await h.text("지금 진행 중인 설명이 없어요.");
	assert.equal(h.ports.steers.length, 0);
	await h.send(h.msg("질문"));
	await until(() => h.ports.opens.length === 1, "open");
	await h.send(h.msg("/바로잡기 더 짧게"));
	assert.deepEqual(h.ports.steers, [{ profileId: "default", requestId: h.ports.opens[0].requestId, message: "더 짧게" }]);
});

test("미리 설명이 없는 카드는 open 을 부르지 않고, ask 가 붙은 카드는 같은 requestId 로 붙어 카드에 답장한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	const send = h.ports.subscribes[0].send;
	send(card(1));
	await until(() => h.cards().length === 1, "첫 카드");
	await sleep(40);
	assert.equal(h.ports.opens.length, 0);
	send(card(2, { ask: { requestId: "prefetch-2", question: EVENT_REQUEST.question, difficulty: "EASY", display: "쉽게 설명해줘" } }));
	await until(() => h.cards().length === 2, "둘째 카드");
	await until(() => h.ports.opens.length === 1, "붙는 open");
	assert.deepEqual(h.ports.opens[0], { id: S1.id, profileId: "default", question: EVENT_REQUEST.question, focus: card(2).focus, auto: true, difficulty: "EASY", requestId: "prefetch-2" });
	h.ports.jobs[0].emit({ type: "delta", text: "초안 글" });
	h.ports.jobs[0].emit({ type: "answer", answer: answerOf() });
	const reply = await until(() => h.api.of("sendMessage").find((c) => c.params.parse_mode === "HTML" && c.params.reply_parameters), "답장");
	assert.equal(reply.params.reply_parameters.message_id, h.cards()[1].result);
	assert.equal(h.api.of("sendMessageDraft").length, 0);
});

test("past 카드: 기준 시각 뒤의 ts 만 알리고 at 은 보지 않으며 ts 없는 카드는 알리지 않는다", async (t) => {
	const h = await setup(t);
	h.ports.subscribeImpl = ({ send }) => {
		send({ ...card(1), past: true, ts: new Date(T0 - 5000).toISOString(), at: new Date(T0 + 9000).toISOString() });
		send({ ...card(2), past: true, at: new Date(T0 + 9000).toISOString() });
		send({ ...card(3), past: true, ts: new Date(T0 + 1000).toISOString() });
	};
	await h.startBot();
	await until(() => h.cards().length === 1, "새 past 카드");
	await sleep(60);
	assert.equal(h.cards().length, 1);
	assert.equal(h.cards()[0].params.text, "AI가 물어봐요\n카드 3");
});

test("past 카드: 자동 이동 직전 60초 안에 새 세션이 낸 카드는 이동 뒤 알린다", async (t) => {
	const h = await setup(t);
	h.ports.subscribeImpl = ({ sessionId, send }) => {
		if (sessionId !== S2.id) return;
		send({ ...card(1), past: true, ts: new Date(T0 - 5000).toISOString() });
		send({ ...card(2), past: true, ts: new Date(T0 + 10_000).toISOString() });
	};
	await h.startBot();
	h.clock.t = T0 + 30_000;
	h.ports.sessions = [S2, S1];
	await h.subscribed(2);
	await until(() => h.cards().length === 1, "이동 뒤 알림");
	await sleep(60);
	assert.equal(h.cards().length, 1);
	assert.equal(h.cards()[0].params.text, "AI가 물어봐요\n카드 2");
});

test("past 카드가 5개 몰리면 알림 3개와 더 있어요 한 줄만 보낸다", async (t) => {
	const h = await setup(t);
	h.ports.subscribeImpl = ({ send }) => {
		for (const n of [1, 2, 3, 4, 5]) send({ ...card(n), past: true, ts: new Date(T0 + n * 1000).toISOString() });
	};
	await h.startBot();
	await h.text("카드가 2개 더 있어요");
	assert.equal(h.cards().length, 3);
	assert.equal(h.api.texts().filter((x) => x.includes("더 있어요")).length, 1);
	assert.ok(h.api.texts().find((x) => x.includes("더 있어요")).includes("/cards"));
});

test("재시작 때 explicit 세션을 다시 구독하고 lastCardAt 이 없으면 봇 시작 시각이 기준이다", async (t) => {
	const state = { offset: 5, following: { sessionId: S1.id, explicit: true }, lastCardAt: {}, messages: [], focuses: {}, buttons: {}, next: 1 };
	const h = await setup(t, { state });
	h.ports.sessions = [S2, S1];
	h.ports.subscribeImpl = ({ send }) => {
		send({ ...card(1), past: true, ts: new Date(T0 - 1000).toISOString() });
		send({ ...card(2), past: true, ts: new Date(T0 + 1000).toISOString() });
	};
	await h.startBot();
	assert.deepEqual(h.ports.subscribes.map((s) => s.sessionId), [S1.id]);
	await until(() => h.cards().length === 1, "알림");
	assert.equal(h.cards()[0].params.text, "AI가 물어봐요\n카드 2");
	assert.equal(h.api.of("getUpdates")[0].params.offset, 5);
	await sleep(120);
	assert.equal(h.ports.subscribes.length, 1);
});

test("lastCardAt 이 있으면 그 시각 뒤 카드만 알린다", async (t) => {
	const state = { offset: 0, following: { sessionId: S1.id, explicit: true }, lastCardAt: { [S1.id]: new Date(T0 - 10_000).toISOString() }, messages: [], focuses: {}, buttons: {}, next: 1 };
	const h = await setup(t, { state });
	h.ports.subscribeImpl = ({ send }) => {
		send({ ...card(1), past: true, ts: new Date(T0 - 20_000).toISOString() });
		send({ ...card(2), past: true, ts: new Date(T0 - 5000).toISOString() });
	};
	await h.startBot();
	await until(() => h.cards().length === 1, "알림");
	assert.equal(h.cards()[0].params.text, "AI가 물어봐요\n카드 2");
});

test("저장된 explicit 세션이 목록에 없으면 안내하고 자동 모드로 간다", async (t) => {
	const state = { offset: 0, following: { sessionId: "claude:gone", explicit: true }, lastCardAt: {}, messages: [], focuses: {}, buttons: {}, next: 1 };
	const h = await setup(t, { state });
	await h.startBot();
	await h.text("이 세션을 찾지 못했어요");
	assert.deepEqual(h.ports.subscribes.map((s) => s.sessionId), [S1.id]);
});

test("429 는 retry_after 만큼 기다린 뒤 같은 sendMessage 를 한 번 다시 보낸다", async (t) => {
	const h = await setup(t);
	h.api.handlers.sendMessage = (params, count) => {
		if (count === 1) throw new TelegramError("제한", { status: 429, method: "sendMessage", retryAfter: 2 });
	};
	await h.startBot();
	h.api.push([h.msg("/help")]);
	const sends = await until(() => (h.api.of("sendMessage").length >= 2 ? h.api.of("sendMessage") : null), "재시도");
	assert.deepEqual(sends[0].params, sends[1].params);
	assert.ok(sends[1].at - sends[0].at >= 10);
	await until(() => h.api.of("getUpdates").some((c) => c.at > sends[1].at), "루프 계속");
	assert.equal(h.api.of("sendMessage").length, 2);
});

test("스트리밍 중 sendMessage 와 초안이 거부돼도 놓친 거부가 없고 로그에 토큰이 없다", async (t) => {
	const seen = [];
	const watch = (reason) => seen.push(reason);
	process.on("unhandledRejection", watch);
	t.after(() => process.off("unhandledRejection", watch));
	const h = await setup(t);
	h.api.handlers.sendMessage = () => { throw new Error(`sendMessage 실패 ${TOKEN}`); };
	h.api.handlers.sendMessageDraft = () => { throw new Error(`draft 실패 ${TOKEN}`); };
	await h.startBot();
	await h.send(h.msg("질문"));
	await until(() => h.ports.opens.length === 1, "open");
	h.ports.jobs[0].emit({ type: "delta", text: "글" });
	await sleep(40);
	h.ports.jobs[0].emit({ type: "answer", answer: answerOf() });
	await until(() => h.logs.some((line) => line.includes("sendMessage 실패")), "로그");
	await sleep(80);
	assert.deepEqual(seen, []);
	assert.ok(h.logs.every((line) => !line.includes(TOKEN)));
	assert.ok(h.logs.some((line) => line.includes("<token>")));
});

test("getUpdates 가 토큰 든 메시지로 실패해도 로그와 상태에 토큰이 없고 다시 받는다", async (t) => {
	const h = await setup(t);
	h.api.push(new Error(`fetch failed http://x/bot${TOKEN}/getUpdates`));
	await h.startBot();
	await until(() => h.logs.length > 0, "로그");
	await until(() => h.api.of("getUpdates").length >= 3, "재시도");
	assert.ok(h.logs.every((line) => !line.includes(TOKEN)));
	assert.ok(h.logs.some((line) => line.includes("<token>")));
	assert.ok(!JSON.stringify(h.bot.status()).includes(TOKEN));
	assert.equal(h.bot.status().lastError, null);
});

test("409 는 로그 한 줄을 남기고 conflictMs 만큼 쉰 뒤 다시 받는다", async (t) => {
	const h = await setup(t);
	h.api.push(new TelegramError("충돌", { status: 409, method: "getUpdates" }));
	await h.startBot();
	await until(() => h.api.of("getUpdates").length >= 2, "재시도");
	const [first, second] = h.api.of("getUpdates");
	assert.ok(second.at - first.at >= 40);
	assert.ok(h.logs.some((line) => line.includes("409")));
});

test("토큰이 틀리면(401) lastError 만 설정하고 서버 쪽으로 예외를 내보내지 않는다", async (t) => {
	const h = await setup(t);
	h.api.handlers.getMe = () => { throw new TelegramError("권한 없음", { status: 401, method: "getMe" }); };
	await h.bot.start();
	assert.match(h.bot.status().lastError, /토큰이 올바르지 않아요/);
	assert.equal(h.api.of("getUpdates").length, 0);
	await h.bot.stop();
});

test("stop() 은 429 대기 중이어도 1초 안에 끝난다", async (t) => {
	const h = await setup(t, { timing: { retryUnitMs: 1000 } });
	h.api.push(new TelegramError("제한", { status: 429, method: "getUpdates", retryAfter: 30 }));
	await h.startBot();
	await until(() => h.api.of("getUpdates").length >= 1, "429 발생");
	await sleep(30);
	const t0 = Date.now();
	await h.bot.stop();
	assert.ok(Date.now() - t0 < 1000);
});

test("stop() 은 보내기 429 재시도 대기 중이어도 1초 안에 끝난다", async (t) => {
	const h = await setup(t, { timing: { retryUnitMs: 1000 } });
	h.api.handlers.sendMessage = () => { throw new TelegramError("제한", { status: 429, method: "sendMessage", retryAfter: 30 }); };
	await h.startBot();
	h.api.push([h.msg("/help")]);
	await until(() => h.api.of("sendMessage").length >= 1, "429 발생");
	await sleep(30);
	const t0 = Date.now();
	await h.bot.stop();
	assert.ok(Date.now() - t0 < 1000);
});

test("상태 파일: offset 이 재시작 뒤 이어지고 모양이 계획과 같다", async (t) => {
	const a = await setup(t);
	await a.startBot();
	a.ports.subscribes[0].send(card(1));
	await until(() => a.cards().length === 1, "카드");
	await a.send(a.msg("질문"));
	await a.bot.stop();
	const saved = JSON.parse(await readFile(a.statePath, "utf8"));
	assert.deepEqual(Object.keys(saved).sort(), ["buttons", "focuses", "following", "lastCardAt", "messages", "next", "offset"]);
	assert.equal(saved.offset, a.lastId + 1);
	assert.deepEqual(saved.following, { sessionId: S1.id, explicit: false });
	assert.equal(typeof saved.lastCardAt[S1.id], "string");
	assert.deepEqual(saved.focuses[card(1).thread], card(1).focus);
	assert.ok(saved.messages.some(([, ref]) => ref.sessionId === S1.id && ref.thread === card(1).thread));
	assert.ok(Object.values(saved.buttons).some((b) => b.kind === "e" && b.sub === "question" && b.thread === card(1).thread));
	assert.ok(saved.next > 2);
	const b = await setup(t, { dir: a.dir });
	await b.startBot();
	assert.equal(b.api.of("getUpdates")[0].params.offset, a.lastId + 1);
});

test("상태 파일이 망가져 있으면 빈 상태로 시작하고 로그 한 줄을 남긴다", async (t) => {
	const h = await setup(t, { state: "{not json" });
	await h.startBot();
	assert.ok(h.logs.some((line) => line.includes("망가져")));
	assert.equal(h.api.of("getUpdates")[0].params.offset, 0);
	assert.equal(h.bot.status().following, true);
});

test("한글 별칭과 글이 아닌 메시지, /status, /cards 가 동작한다", async (t) => {
	const h = await setup(t);
	await h.startBot();
	await h.send(h.msg("/도움말"));
	await h.text("/session");
	await h.send(h.msg("", { photo: [{}], text: undefined }));
	await h.text("글로 물어봐 주세요.");
	await h.send(h.msg("/상태"));
	const status = await h.text("따라가는 세션: 첫 세션");
	assert.ok(status.includes("미리 설명 켜짐") && status.includes("진행 중 0개"));
	const send = h.ports.subscribes[0].send;
	send(card(1));
	send(card(2));
	await until(() => h.cards().length === 2, "카드 둘");
	await h.send(h.msg("/카드"));
	const list = await until(() => h.api.of("sendMessage").find((c) => c.params.text.includes("받은 카드예요")), "카드 목록");
	assert.deepEqual(buttonsOf(list).map((b) => b.text), ["카드 2", "카드 1"]);
	await h.send(h.cb(dataOf(list, "카드 1"), list.result));
	await until(() => h.cards().length === 3, "카드 다시 보기");
	assert.equal(h.cards()[2].params.text, "AI가 물어봐요\n카드 1");
});

test("봇이 보내는 문구에 가운뎃점과 엠 대시가 없다", async (t) => {
	const h = await setup(t);
	h.ports.sessions = [S2, S1, S3];
	await h.startBot();
	for (const text of ["/start", "/session", "/stop", "/steer", "/status", "/cards"]) await h.send(h.msg(text));
	await h.send(h.cb("e:9999"));
	const all = [...h.api.texts(), ...h.api.of("answerCallbackQuery").map((c) => c.params.text ?? ""), ...h.api.of("sendMessage").flatMap((c) => buttonsOf(c).map((b) => b.text))];
	assert.ok(all.length > 5);
	assert.ok(all.every((x) => !x.includes("·") && !x.includes("—")));
});
