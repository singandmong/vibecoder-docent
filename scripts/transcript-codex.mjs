#!/usr/bin/env node
// Codex CLI 세션 adapter (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) → 목록 메타 / 전사 markdown / 사건 카드 후보.
// 출력 모양은 transcript-omp.mjs 와 같다. 도슨트는 둘을 구분하지 않는다.
// CLI:    scripts/transcript-codex.mjs <session.jsonl> [out.md]
// module: import { codexAdapter } from "./transcript-codex.mjs"
import { askQuestionLines, errorSummary } from "./event-text.mjs";
import { jsonLines, transcriptCli, transcriptHeader } from "./transcript-jsonl.mjs";
import { sourceWriter } from "./transcript-source.mjs";

const ERROR_LINES = 8;
const USER_MAX = 4000;
const TITLE_MAX = 60;
const FIRST_MAX = 140;
const EVENT_HEAD = 600;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n…(잘림)` : s);

// 사용자 메시지 블록 중 Codex 가 주입한 컨텍스트. 진짜 발화만 남긴다.
const INJECTED = /^(<environment_context>|<recommended_plugins>|<user_instructions>|<skill>|# AGENTS\.md instructions|<image[\s>]|<\/image>)/;
// Codex 앱은 발화 앞에 `<external_codex_apps_open_page>…</external_codex_apps_open_page>` 같은 snake_case 감싼 블록을 붙인다. 발화가 아니라 앞에서 걷어 낸다.
const WRAPPER_PREFIX = /^(?:<([a-z]+(?:_[a-z]+)+)>[\s\S]*?<\/\1>\s*)+/;

/** 사용자 메시지 payload 에서 실제 발화 텍스트만 모은다. 없으면 null. */
const userText = (payload) => {
	const parts = [];
	for (const b of payload?.content ?? []) {
		if (b?.type !== "input_text" && b?.type !== "text") continue;
		let t = (b.text ?? "").trim().replace(WRAPPER_PREFIX, "");
		if (!t) continue;
		if (INJECTED.test(t)) continue;
		if (t.startsWith("# Files mentioned by the user:")) {
			const i = t.indexOf("## My request:");
			t = i >= 0 ? t.slice(i + "## My request:".length).trim() : "";
		}
		if (t) parts.push(t);
	}
	return parts.length ? parts.join("\n") : null;
};

const blockText = (content) =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter((b) => b && (b.type === "input_text" || b.type === "output_text" || b.type === "text"))
				.map((b) => b.text ?? "")
				.join("\n");

const parseArgs = (raw) => {
	if (!raw) return null;
	if (typeof raw === "object") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
};

/** exec 커스텀 호출의 input 은 JS 스니펫. 안의 cmd 문자열들을 꺼내 한 줄로. */
const execCmd = (input) => {
	const src = String(input ?? "");
	const cmds = [];
	for (const m of src.matchAll(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
		try {
			cmds.push(JSON.parse(`"${m[1]}"`));
		} catch {
			cmds.push(m[1]);
		}
	}
	if (cmds.length) return cmds.join("; ");
	// cmd 가 변수로 넘어가는 스니펫: 첫 셸다운 문자열 리터럴로 대충 요약
	for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
		let s = m[1];
		try {
			s = JSON.parse(`"${s}"`);
		} catch {
			// 그대로
		}
		if (s.length > 3 && /[\s|&;`$]/.test(s)) return s;
	}
	return null;
};

/** request_user_input_async 인자를 askQuestionLines 모양으로. options 는 문자열 배열. */
const askQuestions = (args) =>
	(args?.questions ?? []).map((q) => ({
		question: q?.title ?? q?.question ?? "",
		options: (q?.options ?? []).map((o) => (typeof o === "string" ? { label: o } : { label: o?.label ?? o?.title ?? "", description: o?.description ?? "" })),
	}));

const summarizeCall = (call) => {
	const args = parseArgs(call.arguments);
	if (call.name === "exec") {
		const cmd = execCmd(call.input ?? call.arguments);
		if (cmd) return clip(cmd.replace(/\s+/g, " "), 100);
	}
	if (args) {
		const preferred = args.cmd ?? args.command ?? args.task_name ?? args.target ?? args.title ?? args.description;
		if (typeof preferred === "string") return clip(preferred.replace(/\s+/g, " "), 100);
		const first = Object.values(args).find((v) => typeof v === "string" && v && !v.startsWith("gAAAAA"));
		if (first) return clip(first.replace(/\s+/g, " "), 100);
	}
	return "";
};

const outputText = (output) =>
	typeof output === "string"
		? output
		: (output ?? [])
				.filter((b) => b && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n");

/** 도구 출력이 실패인지. exec 래퍼는 "Script failed/error", 셸 결과는 0 아닌 exit_code. */
const isErrorOutput = (output) => {
	const t = outputText(output);
	if (/^Script (failed|error)\b/m.test(t)) return true;
	const m = /"exit_code"\s*:\s*(-?\d+)/.exec(t) ?? /exit(?:ed)? (?:with )?code\s+(-?\d+)/i.exec(t);
	return m ? Number(m[1]) !== 0 : false;
};

const isAsk = (call) => call.name === "request_user_input" || call.name === "request_user_input_async";

/** 엔트리 목록을 전사 markdown 으로. `source` 는 헤더에 적을 원본 표시. */
function transcriptOf(entries, source) {
	const meta = entries.find((e) => e.type === "session_meta")?.payload ?? {};
	const mark = sourceWriter(`codex:${meta.session_id ?? meta.id ?? ""}`);
	const results = new Map();
	for (const e of entries) {
		const p = e.payload;
		if (e.type === "response_item" && (p?.type === "custom_tool_call_output" || p?.type === "function_call_output") && p.call_id) results.set(p.call_id, e);
	}

	const toolLines = (entry, call, part) => {
		const questions = isAsk(call) ? askQuestionLines(askQuestions(parseArgs(call.arguments))) : [];
		const line = [`→ ${call.name}(${summarizeCall(call)})`, ...questions].join("\n");
		const out = [mark(entry, line, { role: "assistant", part })];
		const result = results.get(call.call_id ?? call.id);
		if (!result) return [...out, "  (결과 없음)"];
		const body = outputText(result.payload.output);
		const n = body ? body.split("\n").length : 0;
		let summary;
		if (isErrorOutput(result.payload.output)) summary = `⇒ ${call.name} 에러\n  ${body.split("\n").slice(0, ERROR_LINES).join("\n  ")}`;
		else if (isAsk(call)) summary = `⇒ ${call.name} 사용자 답:\n  ${clip(body, USER_MAX).split("\n").join("\n  ")}`;
		else summary = `⇒ ${call.name} ok, ${n}줄`;
		out.push(mark(result, summary, { role: "tool", part: `result:${call.call_id ?? call.id}` }));
		return out;
	};

	const first = firstUserText(entries);
	const title = first ? clip(first.split("\n")[0].replace(/\s+/g, " "), TITLE_MAX).replace("\n…(잘림)", "…") : "(제목 없음)";
	const out = transcriptHeader({ title, source, cwd: meta.cwd, started: meta.timestamp ?? entries[0]?.timestamp });
	let lastRole = null;
	const section = (role) => {
		if (role !== lastRole) out.push("", `## ${role}`, "");
		lastRole = role;
	};

	let lastModel = null;
	for (const e of entries) {
		const p = e.payload;
		if (e.type === "turn_context") {
			if (p?.model && p.model !== lastModel) {
				lastModel = p.model;
				section("system");
				out.push(mark(e, `(모델: ${p.model})`, { role: "system", part: `model:${e.ordinal ?? p.turn_id ?? ""}` }));
			}
		} else if (e.type === "response_item" && p?.type === "message") {
			if (p.role === "user") {
				const t = userText(p);
				if (!t) continue; // 주입 컨텍스트만 있는 사용자 메시지
				section("user");
				out.push(mark(e, clip(t, USER_MAX), { role: "user" }));
			} else if (p.role === "assistant") {
				const t = blockText(p.content).trim();
				if (!t) continue;
				section("assistant");
				out.push(mark(e, t, { role: "assistant" }));
			}
			// developer·system role 은 주입 지시문이라 건너뛴다
		} else if (e.type === "response_item" && (p?.type === "custom_tool_call" || p?.type === "function_call")) {
			section("assistant");
			out.push(...toolLines(e, p, `tool:${p.call_id ?? p.id}`));
		} else if (e.type === "compacted") {
			section("system");
			out.push(mark(e, "(여기서 이전 대화가 요약되고 압축됨)", { role: "system", part: `compacted:${e.ordinal ?? ""}` }));
		} else if (e.type === "event_msg" && p?.type === "turn_aborted") {
			section("system");
			out.push(mark(e, `(사용자가 실행을 중단함${p.reason ? `: ${p.reason}` : ""})`, { role: "system", part: `aborted:${p.turn_id ?? e.ordinal ?? ""}` }));
		}
		// reasoning·agent_message(암호화됨)·token_usage·world_state·item_completed(중복) 등은 건너뛴다
	}

	return `${out.join("\n")}\n`;
}

/** 첫 실제 사용자 발화(주입 컨텍스트 제외). 제목과 목록용. */
const firstUserText = (entries) => {
	for (const e of entries) {
		const p = e.payload;
		if (e.type !== "response_item" || p?.type !== "message" || p.role !== "user") continue;
		const t = userText(p);
		if (t) return t;
	}
	return null;
};

/** 세션 파일 머리(session_meta + 첫 사용자 발화)만 읽어 목록용 메타를 뽑는다. 사용자 발화 없는 세션은 숨김(null). */
function sessionMeta(entries) {
	const meta = entries.find((e) => e.type === "session_meta")?.payload ?? null;
	const first = firstUserText(entries);
	if (!first) return null;
	const flat = first.replace(/\s+/g, " ").trim();
	const title = clip(flat, TITLE_MAX).replace("\n…(잘림)", "…");
	return {
		title,
		cwd: meta?.cwd ?? null,
		started: meta?.timestamp ?? entries[0]?.timestamp ?? null,
		first: flat.length > FIRST_MAX ? `${flat.slice(0, FIRST_MAX)}…` : flat,
	};
}

/** 엔트리에서 사건 카드 후보를 뽑는다. {kind, text, options?} */
function eventsOf(entries) {
	const out = [];
	for (const e of entries) {
		const p = e.payload;
		if (e.type === "response_item" && p?.type === "message") {
			if (p.role === "user") {
				const t = userText(p);
				if (t) out.push({ kind: "user", text: t.slice(0, EVENT_HEAD) });
			} else if (p.role === "assistant") {
				const t = blockText(p.content).trim();
				if (t) out.push({ kind: "assistant", text: t, ts: e.timestamp ?? null });
			}
		} else if (e.type === "response_item" && (p?.type === "custom_tool_call" || p?.type === "function_call") && isAsk(p)) {
			for (const q of askQuestions(parseArgs(p.arguments)))
				out.push({ kind: "question", text: q.question, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })), ts: e.timestamp ?? null });
		} else if (e.type === "response_item" && (p?.type === "custom_tool_call_output" || p?.type === "function_call_output") && isErrorOutput(p.output)) {
			out.push({ kind: "error", text: errorSummary(outputText(p.output), EVENT_HEAD) });
		} else if (e.type === "event_msg" && p?.type === "task_complete") {
			out.push({ kind: "done", text: "작업이 끝났어요" });
		} else if (e.type === "event_msg" && p?.type === "turn_aborted") {
			out.push({ kind: "error", text: `사용자가 실행을 중단했어요${p.reason ? ` (${p.reason})` : ""}` });
		}
	}
	return out;
}

export const codexAdapter = {
	id: "codex",
	dir: ".codex/sessions",
	depth: 3, // YYYY/MM/DD/rollout-*.jsonl
	match: /^rollout-.*\.jsonl$/,
	headBytes: 512 * 1024, // session_meta 에 긴 기본 지시문이 붙는다
	/** 목록 메타 {title, cwd, started, first}. 숨길 세션이면 null. */
	meta(head) {
		return sessionMeta([...jsonLines(head)]);
	},
	/** 전사 markdown. `path` 는 헤더의 원본 표시. */
	transcript(text, path = "") {
		return transcriptOf([...jsonLines(text)], path);
	},
	/** 새로 끝난 줄들에서 사건 카드 후보. */
	events(chunk) {
		return eventsOf(jsonLines(chunk));
	},
};

await transcriptCli(import.meta.url, codexAdapter);
