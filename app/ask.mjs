// 설명 요청 (ADR 0028·0029·0031·0032·0050). 질문 하나는 설명 작업 하나다.
// 작업은 차례(사용자 질문이 미리 설명보다 먼저, 같은 스레드는 들어온 순서) → 분야 판정 → 설명 → 근거·저장 → (뒤에서) 학습 분류로 흐른다.
// 모델 실행은 runner 로만 한다. 운영에서는 omp 프로세스, 테스트에서는 각본대로 답하는 runner 를 넣는다.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { capacity } from "./capacity.mjs";
import { conversationPool } from "./conversation.mjs";
import { checkOverride, depthDecider } from "./depth.mjs";
import { displayOf, parseCards, parseFocus, questionContext, recentDialogue, steerMessage } from "./dialogue.mjs";
import { threadRows } from "./conversations.mjs";
import { extractCitations, prepareEvidence } from "./evidence.mjs";
import { jobRegistry } from "./jobs.mjs";
import { httpError } from "./errors.mjs";
import { applyClassification, explanationHints, parsePlan, planningContext, planningInput, profile, sourceScope } from "./learning.mjs";
import { selectedModel } from "./models.mjs";
import { sessionModel } from "./session-model.mjs";
import { extractTerms, filterTerms } from "./review.mjs";
import { CancelledError } from "./runner.mjs";
import { parseAnswer } from "./slots.mjs";
import { beginRequest, completeAnswer, history, requestKey, requestSignature, settleRequest, storedRequest } from "./store.mjs";
import { threadOf } from "./thread.mjs";

const MANUAL_GRACE_MS = 1500;
const SOURCE_CACHE = 8;
// 동시에 돌리는 설명 작업 수 상한 (ADR 0075). 몰려든 요청은 전사 읽기와 분야 판정 전에 순서를 기다린다.
const MAX_JOBS = 8;

/** 기다리는 동안 중단되면 CancelledError. */
function untilOrAbort(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new CancelledError());
	return new Promise((res, rej) => {
		const onAbort = () => rej(new CancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			res(value);
		}, rej);
	});
}

/** 사용자 질문이 미리 설명보다 먼저다. 미리 설명은 프로필마다 하나씩, 사용자 질문이 끝나고 잠깐 뒤에 시작한다. */
function priorityGate() {
	const profiles = new Map();
	const of = (id) => {
		if (!profiles.has(id)) profiles.set(id, { manual: 0, lastManual: 0, autoBusy: false, waiters: [] });
		return profiles.get(id);
	};
	const pump = (id) => {
		const entry = of(id);
		if (entry.autoBusy || entry.manual || !entry.waiters.length) return;
		const wait = entry.lastManual + MANUAL_GRACE_MS - Date.now();
		if (wait > 0) {
			setTimeout(() => pump(id), wait).unref();
			return;
		}
		entry.autoBusy = true;
		entry.waiters.shift()();
	};
	return {
		/** 사용자 질문. 바로 시작하고, 돌려받은 함수로 끝을 알린다. */
		manual(id) {
			of(id).manual++;
			return () => {
				const entry = of(id);
				entry.manual = Math.max(0, entry.manual - 1);
				entry.lastManual = Date.now();
				pump(id);
			};
		},
		/** 미리 설명 차례를 기다린다. 돌려받은 함수로 차례를 넘긴다. */
		auto(id, signal) {
			const entry = of(id);
			return new Promise((res, rej) => {
				const grant = () => {
					signal.removeEventListener("abort", onAbort);
					res(() => {
						entry.autoBusy = false;
						pump(id);
					});
				};
				const onAbort = () => {
					const index = entry.waiters.indexOf(grant);
					if (index >= 0) entry.waiters.splice(index, 1);
					rej(new CancelledError());
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.waiters.push(grant);
				pump(id);
			});
		},
		waiting: (id) => of(id).waiters.length,
	};
}

/** 같은 스레드의 질문은 들어온 순서대로 하나씩 (ADR 0029 §4). 한 스레드는 살아 있는 대화 하나라 동시에 두 질문을 받을 수 없다. */
function threadTurns() {
	const tails = new Map();
	return {
		/** 앞선 질문이 끝날 때까지 기다린다. 돌려받은 함수로 차례를 넘긴다. 기다리다 중단되면 뒤 순서는 그대로 이어진다. */
		async take(key, signal) {
			const previous = tails.get(key) ?? Promise.resolve();
			let release;
			const mine = new Promise((res) => { release = res; });
			const tail = previous.then(() => mine);
			tails.set(key, tail);
			const done = () => {
				release();
				if (tails.get(key) === tail) tails.delete(key);
			};
			try {
				await untilOrAbort(previous, signal);
			} catch (error) {
				done();
				throw error;
			}
			return done;
		},
	};
}

/**
 * @param {{
 *   runner: {once: Function, conversation: Function},
 *   providerOf: (sessionId: string) => {id: string, host?: string, transcript: (sessionId: string) => Promise<string>},
 *   prompts: {docent: string, planner: string, domains: string},
 *   notify: (sessionId: string, profileId: string, payload: object) => void,
 * }} deps
 */
export function createAsk({ runner, providerOf, prompts, notify }) {
	const threads = conversationPool({ runner, system: prompts.docent });
	const jobs = jobRegistry();
	const gate = priorityGate();
	const turns = threadTurns();
	const slots = capacity(MAX_JOBS);
	const sources = new Map();
	const decideDepth = depthDecider({ runner, prompt: prompts.domains });

	/** 정규화 전사와 근거 표식. 같은 전사면 표식 계산을 다시 하지 않는다. */
	async function sessionSource(id, provider) {
		const original = await provider.transcript(id);
		const cached = sources.get(id);
		if (cached?.original === original) return cached;
		const entry = { original, prepared: prepareEvidence(original, id) };
		sources.delete(id);
		sources.set(id, entry);
		while (sources.size > SOURCE_CACHE) sources.delete(sources.keys().next().value);
		return entry;
	}

	/** 답이 나온 뒤 학습 분류를 채우고, 보고 있는 화면에 카드 제목·핵심 단어·카드 제안을 알린다. 실패해도 답은 그대로다. */
	function classifyLater({ context, response, startedAt, model, sessionId, thread, cards }) {
		const profileId = context.profile.id;
		return (async () => {
			let plan;
			try {
				plan = parsePlan(await runner.once({ system: prompts.planner, task: planningInput(context, response), model }), context);
			} catch {
				// 선택한 모델이 실패해도 다른 모델로 바꾸지 않는다. 분류를 추측하지 않고 알 수 없음으로 남긴다.
				plan = { ...parsePlan("", context), warning: "학습 분류를 실행하지 못했어요. 개념, 분야를 추측하지 않았어요." };
			}
			const suggested = plan.card && plan.card !== thread ? cards.find((card) => card.thread === plan.card) : null;
			const answer = await applyClassification(context, response.recordId, plan, startedAt, suggested ? { suggest: suggested } : {});
			notify(sessionId, profileId, { kind: "record", recordId: response.recordId, requestId: response.requestId, thread, answer });
		})().catch((error) => console.error(`docent: 학습 분류를 저장하지 못했어요 (${error.message})`));
	}

	/** 설명 → 근거 검증 → 저장 → (뒤에서) 학습 분류. 설명은 스레드 대화에서 스트림으로 나온다. */
	async function explain(job, { profileId, current, id, q, focus, difficulty, cards, thread, requestId }) {
		const begun = await beginRequest(profileId, requestId, job.signature);
		if (begun.answer) return begun.answer;
		if (begun.error) throw begun.error;
		const t0 = Date.now();
		try {
			if (job.signal.aborted) throw new CancelledError();
			const chosen = await selectedModel(current.model);
			const provider = providerOf(id);
			const [source, records] = await Promise.all([sessionSource(id, provider), history(id, profileId)]);
			// 프로필에서 고른 모델이 없으면 설명 대상 세션의 모델을 쓴다. 카탈로그에서 못 찾으면 omp 기본 모델로 가고 답에 그렇게 남긴다 (ADR 0069).
			const fromSession = chosen ? null : (await sessionModel(source.original, provider.id)).model;
			const model = chosen ?? fromSession;
			const modelSource = chosen ? "profile" : fromSession ? "session" : "default";
			const scope = sourceScope(id, provider.host, source.original);
			const own = threadRows(records, thread);
			const context = { ...(await planningContext(profileId, scope, q, job.meta.auto, focus)), dialogue: recentDialogue(own), cards };
			const { thinking, ...depth } = await decideDepth({ profile: context.profile, override: difficulty, question: q, focus, model, signal: job.signal, onJudging: () => job.emit({ type: "stage", stage: "planning" }) });
			job.emit({ type: "stage", stage: "explaining" });
			// 분야 판정 중에 들어온 바로잡기는 질문에 합쳐서 설명을 시작한다.
			const early = job.steers.map((message) => `\n(바로잡기) ${message}`).join("");
			const generated = await threads.ask({
				key: `${profileId}\n${id}\n${thread}\n${model?.selector ?? ""}`,
				model,
				prepared: source.prepared,
				records: own,
				instructions: `${explanationHints(context, depth)}\n${questionContext(focus)}`,
				question: `${q}${early}`,
				thinking,
				signal: job.signal,
				onDelta: (text) => job.emit({ type: "delta", text }),
				onRestart: () => job.emit({ type: "reset" }),
				register: (steer) => { job.steerHandler = steer ? (message) => steer(steerMessage(message)) : null; },
			});
			const { raw, citations } = extractCitations(generated.raw, generated.evidence);
			const ruleTerms = extractTerms(raw);
			const jevTerms = await filterTerms(raw, ruleTerms);
			const terms = jevTerms ?? ruleTerms;
			const termsBy = jevTerms ? "jev" : "rule";
			const answer = { raw, ...parseAnswer(raw), ms: Date.now() - t0, ...depth, terms, citations, requestId, model: model?.selector ?? null, modelSource, thread };
			const { response, startedAt } = await completeAnswer(begun.request, context, answer, { provider: provider.id, project: scope.cwd ? basename(scope.cwd) : null, terms, termsBy, ...(job.steers.length ? { steers: [...job.steers] } : {}) });
			classifyLater({ context, response, startedAt, model, sessionId: id, thread, cards });
			return response;
		} catch (error) {
			await settleRequest(begun.request, job.signal.aborted ? { cancelled: true } : error);
			throw error;
		}
	}

	/** 차례를 받은 뒤 설명한다. 미리 설명은 사용자 질문이 없을 때, 같은 스레드는 앞 질문이 끝난 뒤, 전체 작업은 상한 안에서. */
	async function run(job, input) {
		const { profileId, id, thread } = input;
		const endGate = job.meta.auto ? await gate.auto(profileId, job.signal) : gate.manual(profileId);
		try {
			const endTurn = await turns.take(`${profileId}\n${id}\n${thread}`, job.signal);
			try {
				const free = await slots.acquire(job.signal);
				try {
					return await explain(job, input);
				} finally {
					free();
				}
			} finally {
				endTurn();
			}
		} finally {
			endGate();
		}
	}

	const jobOf = (profileId, requestId) => jobs.get(requestKey(profileId, requestId));

	return {
		/**
		 * 요청 확인 후 진행 중인 작업에 붙거나 새 작업을 연다.
		 * 작업({subscribe, done, ...}) 또는 저장된 결과 {answer} | {error} 를 돌려준다.
		 */
		async open(input) {
			const { id, question, difficulty } = input;
			const profileId = input.profileId ?? "default";
			const requestId = input.requestId ?? randomUUID();
			if (typeof id !== "string" || !id || id.length > 2048 || typeof question !== "string" || !question.trim() || question.length > 8000) throw httpError(400, "유효한 세션 id 와 8000자 이내의 질문이 필요해요.");
			if (input.auto !== undefined && typeof input.auto !== "boolean") throw httpError(400, "auto 는 참/거짓이어야 해요.");
			const focus = parseFocus(input.focus);
			const cards = parseCards(input.cards);
			const current = await profile(profileId);
			checkOverride(difficulty);
			const q = question.trim();
			const auto = Boolean(input.auto);
			const key = requestKey(profileId, requestId);
			const signature = requestSignature({ id, question: q, ...(focus ? { focus } : {}), auto, difficulty: difficulty ?? null });
			const join = () => {
				const running = jobs.get(key);
				if (running && running.signature !== signature) throw httpError(409, "같은 requestId 를 다른 질문에 사용할 수 없어요.");
				return running;
			};
			const running = join();
			if (running) return running;
			// 완료된 요청은 이후 모델 설정·카탈로그와 무관하게 저장된 답을 돌려준다.
			const stored = await storedRequest(profileId, requestId, signature);
			if (stored) return stored;
			// 스레드는 저장된 문답에서 정한다. 다시 설명한 답은 원래 답의 스레드에 남는다 (ADR 0053).
			const thread = focus ? threadOf(id, focus, await history(id, profileId)) : "";
			const again = join();
			if (again) return again;
			return jobs.start({
				key,
				signature,
				meta: { profileId, sessionId: id, requestId, question: q, focus, thread, auto, difficulty: difficulty ?? null },
				run: (job) => run(job, { profileId, current, id, q, focus, difficulty, cards, thread, requestId }),
			});
		},
		/** 같은 프로필의 같은 요청이 진행 중인지. */
		has: (profileId, requestId) => Boolean(jobOf(profileId, requestId)),
		/** 중단. 진행 중이던 작업이 있었으면 참. */
		async cancel(input) {
			const profileId = input.profileId ?? "default";
			await profile(profileId);
			return Boolean(jobOf(profileId, input.requestId)?.cancel());
		},
		/** 바로잡기. 진행 중인 설명이 없으면 409. */
		async steer(input) {
			const profileId = input.profileId ?? "default";
			const { message } = input;
			await profile(profileId);
			if (typeof message !== "string" || !message.trim() || message.length > 2000) throw httpError(400, "바로잡기 문장은 2000자 이내로 입력하세요.");
			if (!jobOf(profileId, input.requestId)?.steer(message.trim())) throw httpError(409, "지금 진행 중인 설명이 없어 바로잡을 수 없어요.");
		},
		/** 세션의 진행 중 작업 (새로고침 뒤 다시 붙기용). */
		async list(profileId, sessionId) {
			await profile(profileId);
			return jobs.list((meta) => meta.profileId === profileId && meta.sessionId === sessionId).map((job) => ({
				requestId: job.meta.requestId, question: job.meta.question, ...(displayOf(job.meta.question) ? { display: displayOf(job.meta.question) } : {}),
				focus: job.meta.focus, thread: job.meta.thread, auto: job.meta.auto, difficulty: job.meta.difficulty, stage: job.stage, text: job.text,
			}));
		},
		/** 차례를 기다리는 미리 설명 수. */
		waiting: (profileId) => gate.waiting(profileId),
		/** 진행 중인 작업을 모두 중단하고 끝날 때까지 기다린다. */
		async close() {
			const active = jobs.list(() => true);
			for (const job of active) job.cancel();
			await Promise.allSettled(active.map((job) => job.done));
		},
	};
}
