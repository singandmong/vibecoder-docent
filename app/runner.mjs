// omp 실행 정책을 한곳에 모은다 (ADR 0028). 호출자는 시스템 프롬프트·입력·모델·중단 신호만 넘긴다.
// 사용자 전역 설정(기억 recall/retain, 확장·스킬·규칙 탐색, auto thinking)은 docent 호출에 적용하지 않는다.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { httpError } from "./errors.mjs";

const ISOLATION = "memory:\n  backend: off\nautolearn:\n  enabled: false\n";
const ISOLATION_FLAGS = ["--no-session", "--no-title", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp"];
const FAILED = "요청 내용과 비밀값 보호를 위해 원시 실행 로그는 저장하지 않아요.";

export class CancelledError extends Error {
	constructor() {
		super("요청을 중단했어요.");
		this.cancelled = true;
		this.status = 409;
	}
}

const modelFlags = (model) => (model ? ["--provider", model.provider, "--model", model.selector] : []);
const lastAssistantText = (messages) => {
	const message = (messages ?? []).findLast((entry) => entry?.role === "assistant");
	return (message?.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("").trim();
};

/**
 * @param {{bin: string, tmpRoot: string, timeoutMs: number}} options
 */
export async function createRunner({ bin, tmpRoot, timeoutMs }) {
	const isolation = join(tmpRoot, "omp-isolation.yml");
	await writeFile(isolation, ISOLATION);
	const base = ["--config", isolation, ...ISOLATION_FLAGS];
	const env = { ...process.env, TERM: "dumb" };
	const children = new Set();
	let closed = false;
	function launch(args) {
		if (closed) throw new CancelledError();
		const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"] });
		children.add(child);
		child.once("close", () => children.delete(child));
		return child;
	}
	async function close() {
		closed = true;
		await Promise.all([...children].map((child) => new Promise((resolve) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
			child.once("close", () => { clearTimeout(timer); resolve(); });
			child.kill("SIGTERM");
		})));
	}

	/**
	 * 한 번 묻고 끝나는 호출(학습 분류·용어 추출). 도구 없음.
	 * `input` 은 stdin 으로 사용자 메시지 앞에 붙고, `task` 가 그 뒤에 온다.
	 */
	function once({ system, task, input = "", model = null, thinking = "off", signal }) {
		return new Promise((res, rej) => {
			if (signal?.aborted) return rej(new CancelledError());
			const child = launch(["-p", ...base, "--no-tools", "--thinking", thinking, "--system-prompt", system, ...modelFlags(model), task]);
			let stdout = "";
			let settled = false;
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				error ? rej(error) : res(value);
			};
			const onAbort = () => {
				child.kill("SIGTERM");
				finish(new CancelledError());
			};
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				finish(httpError(502, `설명 생성기를 실행하지 못했어요 (시간 제한). ${FAILED}`));
			}, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			// 청크 경계에서 한글 등 여러 바이트 글자가 깨지지 않게 문자열 디코더를 쓴다.
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.on("error", (error) => finish(httpError(502, `설명 생성기를 실행하지 못했어요 (${error.code ?? "실행 오류"}). ${FAILED}`)));
			child.on("close", (code) => {
				if (code !== 0) return finish(httpError(502, `설명 생성기를 실행하지 못했어요 (${code ?? "실행 중단"}). ${FAILED}`));
				// print 모드가 앞에 붙이는 진행 표시줄 제거
				const lines = stdout.split("\n");
				while (lines.length && /^(Working\.\.\.|\s*)$/.test(lines[0])) lines.shift();
				const output = lines.join("\n").trim();
				if (!output) return finish(httpError(502, "설명 생성기가 빈 응답을 반환했어요."));
				finish(null, output);
			});
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		});
	}

	/**
	 * 살아 있는 RPC 대화 하나. 같은 대화의 질문은 이어지는 턴이 된다.
	 * 한 번에 한 질문만 처리한다. 호출자가 순서를 보장한다.
	 */
	function conversation({ system, model = null }) {
		const child = launch(["--mode", "rpc", ...base, "--tools", "read", "--system-prompt", system, ...modelFlags(model)]);
		let buffer = "";
		let ready;
		let exited = false;
		let turn = null; // { res, rej, onDelta, onRestart, text, restarting, sawStart, timer }
		const responses = new Map();
		let nextId = 0;
		const readyPromise = new Promise((res, rej) => { ready = { res, rej }; });
		readyPromise.catch(() => {});

		const fail = (error) => {
			ready.rej(error);
			for (const { rej } of responses.values()) rej(error);
			responses.clear();
			if (turn) endTurn(error);
		};
		const endTurn = (error, text) => {
			const current = turn;
			if (!current) return;
			turn = null;
			clearTimeout(current.timer);
			error ? current.rej(error) : current.res(text);
		};
		const send = (command) => {
			const id = `c${++nextId}`;
			return new Promise((res, rej) => {
				if (exited) return rej(httpError(502, `설명 생성기가 종료됐어요. ${FAILED}`));
				responses.set(id, { res, rej });
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			});
		};
		const onFrame = (frame) => {
			if (frame.type === "ready") return ready.res();
			if (frame.type === "response") {
				const pending = responses.get(frame.id);
				const rejected = httpError(502, `설명 생성기가 요청을 거절했어요. ${FAILED}`);
				if (pending) {
					responses.delete(frame.id);
					frame.success === false ? pending.rej(rejected) : pending.res(frame.data);
				} else if (frame.success === false && turn && ["prompt", "abort_and_prompt"].includes(frame.command)) endTurn(rejected);
				return;
			}
			if (!turn) return;
			if (frame.type === "agent_start") {
				if (turn.restarting) {
					turn.restarting = false;
					turn.text = "";
					turn.onRestart?.();
				} else if (turn.pendingSteer) {
					// 첫 턴이 시작되기 전에 온 바로잡기는 시작을 확인한 뒤 보낸다
					const message = turn.pendingSteer;
					turn.pendingSteer = null;
					turn.restarting = true;
					send({ type: "abort_and_prompt", message }).catch((error) => endTurn(error));
				}
				turn.sawStart = true;
				return;
			}
			if (frame.type === "message_update") {
				const event = frame.assistantMessageEvent;
				if (event?.type === "text_delta" && typeof event.delta === "string" && !turn.restarting) {
					turn.text += event.delta;
					turn.onDelta?.(event.delta);
				}
				return;
			}
			if (frame.type === "agent_end" && frame.isTerminal !== false) {
				// 바로잡기로 끊긴 턴의 종료는 건너뛰고, 다시 시작한 턴의 종료를 기다린다.
				if (turn.restarting) return;
				if (turn.aborting === "cancel") return endTurn(new CancelledError());
				const text = lastAssistantText(frame.messages) || turn.text.trim();
				if (!text) return endTurn(httpError(502, "설명 생성기가 빈 응답을 반환했어요."));
				endTurn(null, text);
			}
		};

		// 청크 경계에서 여러 바이트 글자가 깨지지 않게 문자열 디코더를 쓴다.
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				try {
					onFrame(JSON.parse(line));
				} catch {
					// 프로토콜 밖의 줄은 무시한다
				}
			}
		});
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			exited = true;
			fail(httpError(502, `설명 생성기를 실행하지 못했어요 (${error.code ?? "실행 오류"}). ${FAILED}`));
		});
		child.on("close", (code) => {
			exited = true;
			fail(httpError(502, `설명 생성기가 종료됐어요 (${code ?? "중단"}). ${FAILED}`));
		});

		return {
			get alive() { return !exited; },
			get busy() { return Boolean(turn); },
			/** 질문 하나. 답 전문을 돌려준다. `signal` 로 중단하면 CancelledError. */
			async ask(message, { thinking = "low", onDelta, onRestart, signal } = {}) {
				if (turn) throw new Error("conversation is busy");
				if (signal?.aborted) throw new CancelledError();
				await readyPromise;
				await send({ type: "set_thinking_level", level: thinking });
				if (signal?.aborted) throw new CancelledError();
				const result = new Promise((res, rej) => {
					turn = { res, rej, onDelta, onRestart, text: "", restarting: false, sawStart: false, pendingSteer: null, aborting: null };
					turn.timer = setTimeout(() => {
						send({ type: "abort" }).catch(() => {});
						endTurn(httpError(502, `설명 생성기를 실행하지 못했어요 (시간 제한). ${FAILED}`));
					}, timeoutMs);
				});
				result.catch(() => {});
				const onAbort = () => {
					if (!turn) return;
					turn.aborting = "cancel";
					send({ type: "abort" }).catch(() => {});
					// 중단 응답이 오지 않아도 호출자를 붙잡지 않는다
					setTimeout(() => endTurn(new CancelledError()), 3000);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					await send({ type: "prompt", message });
					return await result;
				} catch (error) {
					endTurn(error);
					throw error;
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			},
			/** 진행 중인 답을 끊고 같은 대화 맥락에 보정을 더해 다시 답하게 한다. */
			steer(message) {
				if (!turn || turn.aborting) return false;
				if (!turn.sawStart) {
					turn.pendingSteer = message;
					return true;
				}
				turn.restarting = true;
				send({ type: "abort_and_prompt", message }).catch((error) => endTurn(error));
				return true;
			},
			close() {
				if (exited) return;
				child.stdin.end();
				setTimeout(() => { if (!exited) child.kill("SIGTERM"); }, 2000).unref();
			},
		};
	}

	return { once, conversation, close };
}
