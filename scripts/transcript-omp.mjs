#!/usr/bin/env node
// omp 세션 adapter. 세션 파일(~/.omp/agent/sessions/<폴더>/<id>.jsonl) → 목록 메타 / 전사 markdown / 사건 카드 후보.
// pi 도 엔트리 모양이 같아 ompShapedAdapter 를 쓴다(transcript-pi.mjs).
// CLI:    scripts/transcript-omp.mjs <session.jsonl> [out.md]   (out 생략 시 stdout)
// module: import { ompAdapter } from "./transcript-omp.mjs"
import { askQuestionLines, errorSummary } from "./event-text.mjs";
import { jsonLines, transcriptCli, transcriptHeader } from "./transcript-jsonl.mjs";
import { sourceWriter } from "./transcript-source.mjs";

const ERROR_LINES = 8;
const USER_MAX = 4000;
const SYSTEM_MAX = 1500;

const text = (content) =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n…(잘림)` : s);

const summarizeArgs = (args) => {
	if (!args) return "";
	const { i, ...rest } = args;
	if (i) return i;
	const first = Object.values(rest).find((v) => typeof v === "string");
	return first ? clip(first.replace(/\s+/g, " "), 100) : "";
};

/** 엔트리 목록을 전사 markdown 으로. `source` 는 헤더에 적을 원본 표시. */
function transcriptOf(entries, source) {
	const header = entries.find((e) => e.type === "session");
	const mark = sourceWriter(`omp:${header?.id ?? header?.sessionId ?? ""}`, header?.agentId ?? null);
	const results = new Map();
	for (const e of entries) {
		if (e.type === "message" && e.message?.role === "toolResult") results.set(e.message.toolCallId, e);
	}

	const toolLines = (entry, call, part) => {
		const questions = call.name === "ask" ? askQuestionLines(call.arguments?.questions) : [];
		const line = [`→ ${call.name}(${summarizeArgs(call.arguments)})`, ...questions].join("\n");
		const out = [mark(entry, line, { role: "assistant", part })];
		const result = results.get(call.id);
		if (!result) return [...out, "  (결과 없음)"];
		const r = result.message;
		const body = text(r.content);
		const n = body ? body.split("\n").length : 0;
		let summary;
		if (r.isError) summary = `⇒ ${call.name} 에러\n  ${body.split("\n").slice(0, ERROR_LINES).join("\n  ")}`;
		else if (call.name === "ask") summary = `⇒ ${call.name} 사용자 답:\n  ${clip(body, USER_MAX).split("\n").join("\n  ")}`;
		else summary = `⇒ ${call.name} ok, ${n}줄`;
		out.push(mark(result, summary, { role: "tool", part: call.id ?? "result" }));
		return out;
	};

	const title = entries.find((e) => e.type === "title")?.title ?? header?.title ?? "(제목 없음)";
	const out = transcriptHeader({ title, source, cwd: header?.cwd, started: header?.timestamp });
	let lastRole = null;
	const section = (role) => {
		if (role !== lastRole) out.push("", `## ${role}`, "");
		lastRole = role;
	};

	for (const e of entries) {
		if (e.type === "message") {
			const m = e.message;
			if (m.role === "user") {
				section("user");
				out.push(mark(e, clip(text(m.content), USER_MAX), { role: "user" }));
			} else if (m.role === "assistant") {
				section("assistant");
				for (const [index, b] of (m.content ?? []).entries()) {
					if (b.type === "text" && b.text.trim()) out.push(mark(e, b.text.trim(), { role: "assistant", part: `text:${index}` }));
					else if (b.type === "toolCall") out.push(...toolLines(e, b, `tool:${b.id ?? index}`));
				}
			}
		} else if (e.type === "custom_message" && e.display !== false) {
			const body = String(e.content ?? "");
			if (e.customType === "skill-prompt") {
				section("user");
				const userIdx = body.indexOf("\nUser: ");
				out.push(mark(e, clip(userIdx >= 0 ? body.slice(userIdx + 7) : body, USER_MAX), { role: "user" }));
			} else {
				section(`system (${e.customType})`);
				out.push(mark(e, clip(body, SYSTEM_MAX), { role: "system" }));
			}
		} else if (e.type === "compaction") {
			section("system");
			out.push(mark(e, "(여기서 이전 대화가 요약되고 압축됨)", { role: "system" }));
		} else if (e.type === "model_change") {
			section("system");
			out.push(mark(e, `(모델: ${e.model})`, { role: "system" }));
		}
	}

	return `${out.join("\n")}\n`;
}

const FIRST_MAX = 140;

/** 세션 파일 머리(title/session 엔트리 + 첫 사용자 발화)만 읽어 목록용 메타를 뽑는다. 셋이 다 차면 더 읽지 않는다. */
function sessionMeta(entries) {
	let title = null;
	let header = null;
	let first = null;
	for (const e of entries) {
		if (e.type === "title") title = e.title;
		else if (e.type === "session") header = e;
		else if (e.type === "message" && e.message?.role === "user" && !first) {
			const t = text(e.message.content).replace(/\s+/g, " ").trim();
			if (t) first = t.length > FIRST_MAX ? `${t.slice(0, FIRST_MAX)}…` : t;
		}
		if (title && header && first) break;
	}
	return { title: title || header?.title || "(제목 없음)", cwd: header?.cwd ?? null, started: header?.timestamp ?? null, first };
}

const EVENT_HEAD = 600;

/** 엔트리에서 사건 카드 후보를 뽑는다. {kind, text, question?, options?} */
function eventsOf(entries) {
	const out = [];
	for (const e of entries) {
		const ts = e.timestamp ?? e.ts ?? null;
		if (e.type === "message") {
			const m = e.message;
			if (m.role === "user") {
				const t = text(m.content).trim();
				if (t) out.push({ kind: "user", text: t.slice(0, EVENT_HEAD) });
			} else if (m.role === "assistant") {
				for (const b of m.content ?? []) {
					if (b.type === "text" && b.text.trim()) out.push({ kind: "assistant", text: b.text.trim(), ts });
					else if (b.type === "toolCall" && b.name === "ask") {
						for (const q of b.arguments?.questions ?? [])
							out.push({ kind: "question", text: q.question, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })), ts });
					}
				}
			} else if (m.role === "toolResult" && m.isError) {
				out.push({ kind: "error", tool: m.toolName, text: errorSummary(text(m.content), EVENT_HEAD) });
			}
		} else if (e.type === "custom_message" && e.customType === "skill-prompt" && e.display !== false) {
			const body = String(e.content ?? "");
			const i = body.indexOf("\nUser: ");
			out.push({ kind: "user", text: (i >= 0 ? body.slice(i + 7) : body).trim().slice(0, EVENT_HEAD) });
		} else if (e.type === "custom" && e.customType === "session_exit") {
			out.push({ kind: "done", text: "세션이 끝났어요" });
		}
	}
	return out;
}

/**
 * omp 모양 엔트리를 쓰는 호스트의 adapter. `adapt` 는 줄 하나를 omp 엔트리 모양으로 바꾸고,
 * `requireUser` 면 사용자 발화가 없는 세션을 목록에서 숨긴다.
 */
export function ompShapedAdapter({ id, dir, adapt, requireUser = false }) {
	return {
		id,
		dir,
		headBytes: 256 * 1024, // session_init 의 시스템 프롬프트 뒤에 첫 사용자 발화가 온다
		/** 목록 메타 {title, cwd, started, first}. 숨길 세션이면 null. */
		meta(head) {
			const m = sessionMeta(jsonLines(head, adapt));
			return requireUser && !m.first ? null : m;
		},
		/** 전사 markdown. `path` 는 헤더의 원본 표시. */
		transcript(text, path = "") {
			return transcriptOf([...jsonLines(text, adapt)], path);
		},
		/** 새로 끝난 줄들에서 사건 카드 후보. */
		events(chunk) {
			return eventsOf(jsonLines(chunk, adapt));
		},
	};
}

export const ompAdapter = ompShapedAdapter({ id: "omp", dir: ".omp/agent/sessions" });

await transcriptCli(import.meta.url, ompAdapter);
