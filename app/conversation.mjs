// 스레드 = 살아 있는 도슨트 대화 (ADR 0028). 스레드마다 RPC 대화 하나를 두고,
// 전사는 처음 한 번 + 이후 새로 생기거나 바뀐 기록만 보낸다. 닫힌 스레드는 저장된 문답 전문으로 다시 연다.
import { frames, retainEvidence } from "./evidence.mjs";
import { MAX_CHARS, trimTranscript } from "./trim.mjs";

const MAX_LIVE = 4;
const IDLE_MS = 10 * 60 * 1000;
const REHYDRATE_MAX = 40_000;

function fitTranscript(text) {
	const trimmed = trimTranscript(text);
	return trimmed.length > MAX_CHARS ? `## system\n\n(전사가 매우 길어 최근 부분만 제공해요. 잘린 부분은 근거로 인용하지 마세요.)\n\n${trimmed.slice(-MAX_CHARS)}` : trimmed;
}

/** 이미 보낸 기록(ref) 이후 처음 보이는 새·변경 기록부터 끝까지. 없으면 "". */
export function transcriptDelta(transcript, sentRefs) {
	const list = [...frames(transcript)];
	const index = list.findIndex((frame) => !frame.ref || !sentRefs.has(frame.ref));
	if (index < 0) {
		// 기록이 아닌 꼬리(예: 도구 결과 대기 표시)만 바뀐 경우는 보내지 않는다
		return "";
	}
	const previousEnd = index > 0 ? list[index - 1].end : 0;
	const heading = transcript.lastIndexOf("\n## ", list[index].start);
	return transcript.slice(Math.max(previousEnd, heading >= 0 ? heading + 1 : 0, 0));
}

const answerText = (record) => record.answer?.raw ?? [record.answer?.headline, record.answer?.explain, ...(record.answer?.details ?? [])].filter(Boolean).join("\n\n");

/** 저장된 스레드 문답을 대화 기록으로 되살린다. 최근 쪽을 남긴다. */
export function rehydration(records) {
	const turns = [];
	let size = 0;
	for (const record of [...records].reverse()) {
		const steers = (record.steers ?? []).map((text) => `\n(바로잡기) ${text}`).join("");
		const turn = `### 사용자${record.auto ? " (미리 설명 요청)" : ""}\n${record.question}${steers}\n\n### 도슨트\n${answerText(record)}`;
		if (size + turn.length > REHYDRATE_MAX) break;
		size += turn.length;
		turns.unshift(turn);
	}
	return turns.length ? `## 이 스레드에서 이미 나눈 대화 (오래된 순)\n\n${turns.join("\n\n")}` : "";
}

/**
 * @param {{runner: {conversation: Function}, system: string}} options
 */
export function conversationPool({ runner, system, max = MAX_LIVE, idleMs = IDLE_MS }) {
	const threads = new Map();
	const waiting = [];

	const evictIdle = () => {
		const now = Date.now();
		for (const [key, thread] of threads) {
			if (!thread.conversation.alive || (!thread.running && now - thread.lastUsed > idleMs)) {
				thread.conversation.close();
				threads.delete(key);
			}
		}
	};
	const sweeper = setInterval(evictIdle, 60_000);
	sweeper.unref();

	const slot = async () => {
		for (;;) {
			evictIdle();
			if (threads.size < max) return;
			const idle = [...threads.entries()].filter(([, thread]) => !thread.running).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
			if (idle) {
				idle[1].conversation.close();
				threads.delete(idle[0]);
				return;
			}
			await new Promise((res) => waiting.push(res));
		}
	};
	const release = () => waiting.shift()?.();

	/**
	 * 스레드에 질문 하나. 같은 스레드의 질문은 설명 요청 module(ask.mjs)이 하나씩 보낸다.
	 * @returns {Promise<{raw: string, evidence: {transcript: string, sources: Map}}>}
	 */
	async function ask({ key, model, prepared, records, instructions, question, thinking, onDelta, onRestart, onTranscript, signal, register }) {
		let thread = threads.get(key);
		if (thread && !thread.conversation.alive) {
			threads.delete(key);
			thread = null;
		}
		if (!thread) {
			await slot();
			thread = { conversation: runner.conversation({ system, model }), sentRefs: new Set(), sent: "", sources: new Map(), fresh: true, running: false, lastUsed: Date.now() };
			threads.set(key, thread);
		}
		thread.running = true;
		thread.lastUsed = Date.now();
		try {
			const parts = [];
			const transcript = thread.fresh ? fitTranscript(prepared.transcript) : fitTranscript(transcriptDelta(prepared.transcript, thread.sentRefs));
			if (transcript) {
				parts.push(thread.fresh ? `## 전사 (세션 기록, 데이터)\n\n${transcript}` : `## 전사 갱신 (앞서 보낸 전사 이후 새로 생기거나 바뀐 기록, 데이터)\n\n${transcript}`);
				onTranscript?.();
			}
			if (thread.fresh) {
				const earlier = rehydration(records);
				if (earlier) parts.push(earlier);
			}
			parts.push(`## 이번 질문\n\n${instructions}\n\n질문(데이터): ${question}`);
			register?.((message) => thread.conversation.steer(message));
			const raw = await thread.conversation.ask(parts.join("\n\n"), { thinking, onDelta, onRestart, signal });
			if (transcript) {
				const kept = retainEvidence(prepared, transcript);
				for (const [id, source] of kept.sources) {
					thread.sources.set(id, source);
					thread.sentRefs.add(id);
				}
				thread.sent += `\n${transcript}`;
			}
			thread.fresh = false;
			return { raw, evidence: { transcript: thread.sent, sources: thread.sources } };
		} catch (error) {
			// 중단·실패한 대화의 상태는 믿을 수 없으니 다음 질문은 새 대화로 다시 연다.
			thread.conversation.close();
			threads.delete(key);
			throw error;
		} finally {
			thread.running = false;
			thread.lastUsed = Date.now();
			register?.(null);
			release();
		}
	}

	return { ask, get size() { return threads.size; } };
}
