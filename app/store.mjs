// 문답·요청 기록 module (ADR 0052). 프로필마다 문답(질문 하나와 답 하나)과 설명 요청의 상태를 learning.json 에 원자적으로 저장한다.
// 모든 입구가 프로필을 확인하고, 요청 키와 문답 식별자는 여기서만 만든다. 기존 questions.jsonl 은 기본 프로필의 역사로 보존한다.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { httpError } from "./errors.mjs";
import { threadKey, threadText, withThreads } from "./thread.mjs";

export const DOCENT_HOME = process.env.DOCENT_HOME ?? join(homedir(), ".docent");
const LEGACY_FILE = join(DOCENT_HOME, "questions.jsonl");
const STATE_FILE = join(DOCENT_HOME, "learning.json");
const RUN_ID = randomUUID();
let writes = Promise.resolve();

/**
 * 임시 파일로 원본을 바꾼다. Windows 는 대상 파일을 백신, 인덱서나 방금 읽은 핸들이 잠시 잡고 있으면 rename 이 EPERM, EACCES, EBUSY 로 실패한다.
 * 잠금은 곧 풀리므로 짧게 다시 시도한다. 다른 오류와 POSIX 에서는 첫 실패를 그대로 던진다 (ADR 0062).
 */
async function replaceFile(temp, target) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await rename(temp, target);
		} catch (error) {
			if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 20) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 10));
		}
	}
}

const emptyState = () => ({
	version: 1,
	profiles: [{ id: "default", name: "기본", defaultDifficulty: "NORMAL", domainDifficulties: {}, model: null, autoExplain: false }],
	items: [],
	records: [],
	requests: {},
});

/** 이전 v1의 동일한 복사본만 접는다. 참조 원본이 없거나 내용이 다르면 보존한다. */
function compactAnswerCopies(state) {
	const records = new Map(state.records.map((record) => [`${record.profileId}:${record.recordId ?? record.id}`, record]));
	for (const [key, request] of Object.entries(state.requests)) {
		const profileId = request.profileId ?? key.slice(0, key.indexOf(":"));
		const recordId = request.recordId ?? request.answer?.recordId;
		const record = records.get(`${profileId}:${recordId}`);
		if (record?.answer && request.answer && isDeepStrictEqual(request.answer, record.answer)) {
			request.recordId = recordId;
			delete request.answer;
		}
	}
	for (const item of state.items) {
		for (const explanation of item.explanations) {
			const record = records.get(`${item.profileId}:${explanation.recordId}`);
			if (!record?.answer) continue;
			const shared = { sessionId: record.sessionId, ts: record.ts, question: record.question, explanation: record.answer.raw, difficulty: record.answer.difficulty, evidence: record.answer.citations, auto: record.auto, sourceFingerprint: record.sourceFingerprint };
			for (const [field, value] of Object.entries(shared)) {
				if (Object.hasOwn(explanation, field) && isDeepStrictEqual(explanation[field], value)) delete explanation[field];
			}
		}
		const latest = records.get(`${item.profileId}:${item.explanations.at(-1)?.recordId}`);
		if (latest?.answer && Object.hasOwn(item, "evidence") && isDeepStrictEqual(item.evidence, latest.answer.citations)) delete item.evidence;
	}
	return state;
}

export async function readState() {
	let text;
	try {
		text = await readFile(STATE_FILE, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return emptyState();
		throw error;
	}
	const state = JSON.parse(text);
	if (state.version !== 1 || !Array.isArray(state.profiles) || !state.profiles.some((p) => p.id === "default") || !Array.isArray(state.items) || !Array.isArray(state.records) || !state.requests || typeof state.requests !== "object" || Array.isArray(state.requests)) {
		throw new Error("학습 저장 파일 형식이 올바르지 않아요. 기존 파일을 보존하고 읽기를 중단했어요.");
	}
	// autoExplain 이 없는 프로필은 0.24 전에 만든 것이다. 그때 기본값이 켜짐이었으니 켜진 채로 둔다 (ADR 0063).
	for (const profile of state.profiles) {
		profile.model ??= null;
		profile.autoExplain ??= true;
	}
	return compactAnswerCopies(state);
}

/** 모든 변경(기록+학습+요청 완료 포함)을 같은 파일에 커밋한다. 실패한 변경은 원본을 건드리지 않는다. */
export function updateState(change) {
	const next = writes.then(async () => {
		const state = await readState();
		const result = await change(state);
		await mkdir(DOCENT_HOME, { recursive: true });
		const temp = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(`${JSON.stringify(state)}\n`);
				await file.sync();
			} finally {
				await file.close();
			}
			await replaceFile(temp, STATE_FILE);
		} finally {
			await rm(temp, { force: true });
		}
		return result;
	});
	writes = next.catch(() => {});
	return next;
}

/** 저장 상태 안의 프로필. 없으면 404, 비었으면 400. */
export function profileFrom(state, id) {
	if (typeof id !== "string" || !id) throw httpError(400, "profileId 가 필요해요.");
	const profile = state.profiles.find((p) => p.id === id);
	if (!profile) throw httpError(404, "프로필을 찾을 수 없어요.");
	return profile;
}

export function fingerprint(text) {
	return createHash("sha256").update(text).digest("hex");
}

/** 저장 위치와 무관한 문답 식별자. 옛 questions.jsonl 줄은 시각과 세션으로 식별한다. */
export const rowKey = (row) => row.recordId ?? row.id ?? `legacy:${row.ts}\n${row.sessionId}`;

/** 프로필의 문답. `sessionId` 가 없으면 모든 세션. 시간순이고 각 문답에 스레드 식별자(`thread`)가 붙는다. */
export async function history(sessionId, profileId = "default") {
	const state = await readState();
	profileFrom(state, profileId);
	const rows = state.records.filter((row) => row.profileId === profileId && (!sessionId || row.sessionId === sessionId));
	if (profileId === "default") {
		let text;
		try {
			text = await readFile(LEGACY_FILE, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			text = "";
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const row = JSON.parse(line);
				if (row && (!row.profileId || row.profileId === "default") && (!sessionId || row.sessionId === sessionId)) {
					const keywords = row.keywords ?? state.legacyKeywords?.[rowKey(row)];
					rows.push({ ...row, profileId: "default", ...(keywords ? { keywords } : {}) });
				}
			} catch {
				// 과거 append 중 잘린 줄만 건너뛴다. 학습 상태 파일 오류는 숨기지 않는다.
			}
		}
	}
	return withThreads(rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts))));
}

/** 용어 추출 결과를 저장한다. 새 문답은 레코드에, 옛 questions.jsonl 줄은 원본을 고치지 않고 따로 보관한다. */
export function saveKeywords(profileId, byId) {
	return updateState((state) => {
		profileFrom(state, profileId);
		for (const [id, keywords] of Object.entries(byId)) {
			const record = state.records.find((row) => row.profileId === profileId && rowKey(row) === id);
			if (record) record.keywords = keywords;
			else if (profileId === "default") (state.legacyKeywords ??= {})[id] = keywords;
		}
		return Object.keys(byId).length;
	});
}

/** 같은 프로필의 같은 requestId 는 같은 요청이다. 진행 중 작업과 저장된 요청이 같은 키를 쓴다. */
export function requestKey(profileId, requestId) {
	if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200) throw httpError(400, "requestId 는 비어 있지 않은 200자 이내의 문자열이어야 해요.");
	return `${profileId}:${requestId}`;
}

export const requestSignature = (payload) => fingerprint(JSON.stringify(payload));

/** 저장된 요청 결과. 완료는 {answer}, 실패·중단·이전 실행의 미완료는 {error}. */
function settled(state, profileId, stored, signature) {
	if (stored.signature !== signature) throw httpError(409, "같은 requestId 를 다른 질문에 사용할 수 없어요.");
	if (stored.state === "complete") {
		const record = state.records.find((entry) => entry.profileId === profileId && (entry.recordId ?? entry.id) === stored.recordId);
		const answer = stored.answer ?? record?.answer;
		if (!answer) throw httpError(500, "완료된 요청의 원본 답변을 찾을 수 없어요. 중복 실행을 막기 위해 다시 생성하지 않아요.");
		return { answer };
	}
	if (stored.state === "failed") return { error: httpError(stored.status, stored.error) };
	if (stored.state === "cancelled") return { error: Object.assign(httpError(409, "이 요청은 중단됐어요. 다시 물으려면 새로 질문해 주세요."), { cancelled: true }) };
	return { error: httpError(409, "이 요청은 이전 실행에서 중단되었거나 아직 처리 중이에요. 같은 요청을 자동 재실행하지 않아요. 다시 묻으려면 새 requestId 를 사용하세요.") };
}

/** 읽기 전용 확인. 저장된 결과가 없으면 null. */
export async function storedRequest(profileId, requestId, signature) {
	const state = await readState();
	profileFrom(state, profileId);
	const stored = state.requests[requestKey(profileId, requestId)];
	return stored ? settled(state, profileId, stored, signature) : null;
}

/**
 * 모델을 부르기 직전에 시작 상태를 저장한다. 프로세스가 중단돼도 같은 ID로 모델을 다시 부르지 않는다.
 * 그사이 결과가 생겼으면 그것을 돌려준다. 새로 시작했으면 {request}.
 */
export function beginRequest(profileId, requestId, signature) {
	const key = requestKey(profileId, requestId);
	return updateState((state) => {
		profileFrom(state, profileId);
		const stored = state.requests[key];
		if (stored) return settled(state, profileId, stored, signature);
		state.requests[key] = { signature, profileId, state: "pending", runId: RUN_ID, startedAt: new Date().toISOString() };
		return { request: { key, signature, profileId } };
	});
}

/** 시작한 요청의 실패·중단을 기록한다. */
export function settleRequest(request, error) {
	return updateState((state) => {
		if (state.requests[request.key]?.state !== "pending") return;
		state.requests[request.key] = error.cancelled
			? { ...state.requests[request.key], state: "cancelled", cancelledAt: new Date().toISOString() }
			: { ...state.requests[request.key], state: "failed", error: String(error.message ?? error), status: error.status ?? 500 };
	});
}

/** 답을 문답으로 저장하고 요청을 완료한다. 학습 분류는 뒤에서 채운다(`learning.applyClassification`). */
export function completeAnswer(request, context, answer, entry) {
	return updateState((state) => {
		profileFrom(state, request.profileId);
		const stored = state.requests[request.key];
		if (!stored || stored.signature !== request.signature || stored.state !== "pending") throw httpError(409, "요청 저장 상태가 바뀌었어요.");
		const ts = new Date().toISOString();
		const recordId = randomUUID();
		const response = { ...answer, recordId, learning: { concepts: [], domains: [], keywords: [], repeated: false, classification: "pending" } };
		state.records.push({ ...entry, id: recordId, recordId, ts, profileId: request.profileId, sessionId: context.source.sessionId, question: context.question, ...(context.focus ? { focus: context.focus } : {}), auto: context.auto, sourceFingerprint: context.source.fingerprint, answer: response });
		state.requests[request.key] = { ...stored, state: "complete", completedAt: ts, recordId };
		return { response, startedAt: stored.startedAt };
	});
}

/** 프로필의 즐겨찾기 스레드. `sessionId` 가 없으면 모든 세션. */
export async function favorites(profileId, sessionId) {
	const state = await readState();
	profileFrom(state, profileId);
	return (state.favorites ?? []).filter((entry) => entry.profileId === profileId && (!sessionId || entry.sessionId === sessionId)).map(({ sessionId: id, label, text, ts }) => ({ sessionId: id, label, text, ts, thread: threadKey(text) }));
}

/** 즐겨찾기 켜기/끄기. 같은 스레드는 한 번만 저장한다. */
export function setFavorite(profileId, sessionId, focus, on) {
	return updateState((state) => {
		profileFrom(state, profileId);
		const list = (state.favorites ??= []);
		const text = threadText(focus?.text);
		const index = list.findIndex((entry) => entry.profileId === profileId && entry.sessionId === sessionId && threadText(entry.text) === text);
		if (on && index < 0) list.push({ profileId, sessionId, label: focus?.label ?? "세션 전체 대화", text: focus?.text ?? "", ts: new Date().toISOString() });
		if (!on && index >= 0) list.splice(index, 1);
		return { favorite: on };
	});
}

/** ~/.docent/config.json — {host, peers:{이름: URL}}. 없으면 {}. 비밀값은 여기 두지 않는다. */
export async function config() {
	const text = await readFile(join(DOCENT_HOME, "config.json"), "utf8").catch(() => "");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch (e) {
		console.error(`docent: config.json 을 읽지 못했어요 (${e.message}). 무시하고 계속해요.`);
		return {};
	}
}

/** config.json 의 일부 항목만 고친다. 나머지 항목과 옛 모양은 그대로 둔다. */
export async function saveConfig(patch) {
	const path = join(DOCENT_HOME, "config.json");
	const next = { ...(await config()), ...patch };
	await mkdir(DOCENT_HOME, { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const file = await open(temp, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await replaceFile(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
	return next;
}
