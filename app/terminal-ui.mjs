import { createHash, randomUUID } from "node:crypto";
import { TerminalClient } from "./terminal-client.mjs";
import { TerminalInput, graphemes, terminalSafeText, wrapTerminalText } from "./terminal-input.mjs";
import { createTerminalTheme } from "./terminal-theme.mjs";
import { createTerminalMarkdown } from "./terminal-markdown.mjs";
import { renderStatusRow, statusMetrics, statusSegments, statusSymbols } from "./terminal-status.mjs";
import { createHerdrReporter } from "./terminal-herdr.mjs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ESC = "\u001b[";
const TITLE = "바이브코더 도슨트";
const CATEGORY = { question: "질문", result: "작업 결과", plan: "계획" };
const profileName = (profile) => profile?.name || profile?.id || "기본 프로필";
const selectedProfileId = (profile) => profile?.id || "default";
const normalizedThreadText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const threadKey = (text) => {
	const normalized = normalizedThreadText(text);
	return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 16) : "";
};
/** 작업 폴더 이름. 워크트리처럼 저장소 이름과 다르면 "저장소/폴더" 로 보여 준다. */
const placeOf = (session) => (session.repo && session.project && session.repo !== session.project ? `${session.repo}/${session.project}` : session.project || session.repo || "");
/** 세션 카드 아이콘. DOCENT_SYMBOLS=ascii 또는 TERM=dumb 에서는 ASCII (ADR 0045). */
const SESSION_ICONS = Object.freeze({
	unicode: Object.freeze({ repo: "📦", folder: "📁", branch: "🌿", worktree: "🌳", recent: "🕘", current: "✓" }),
	ascii: Object.freeze({ repo: "[R]", folder: "[D]", branch: "br:", worktree: "wt:", recent: ">", current: "*" }),
});

/** 목록에서 고르기 쉬운 상대 시각. 일주일이 넘으면 날짜. */
export function agoLabel(value, now = Date.now()) {
	const time = Date.parse(value ?? "");
	if (!Number.isFinite(time)) return "시각 정보 없음";
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return "방금";
	if (minutes < 60) return `${minutes}분 전`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
	if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}일 전`;
	const date = new Date(time);
	return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function focusForEvent(event) {
	const options = Array.isArray(event.options) ? event.options.map((option) => `${option.label ?? ""}${option.description ? ` — ${option.description}` : ""}`).join("\n") : "";
	const source = String(event.text ?? "").trim();
	let text = `${source}${options ? `\n\n선택지:\n${options}` : ""}`;
	if (text.length > 7800) {
		const marker = "\n\n[중간 생략 — 전체 내용은 세션 전사에서 확인]\n\n";
		const half = Math.floor((7800 - 48) / 2);
		text = `${text.slice(0, half)}${marker}${text.slice(-half)}`;
	}
	const lines = String(event.text ?? "").split("\n").map((line) => line.replace(/^\s*(?:[#>*+-]+\s*|\d+[.)]\s+)*/, "").replace(/[*_`]/g, "").replace(/^\s*[✅⏳⛔]\s*/u, "").trim()).filter(Boolean);
	const heading = lines.find((line) => line.length > 8) || lines[0] || "";
	const derived = heading.length > 100 ? `${heading.slice(0, 100)}…` : heading;
	const label = typeof event.focus?.label === "string" && event.focus.label.trim() ? event.focus.label : derived || CATEGORY[event.sub];
	const focusText = typeof event.focus?.text === "string" && event.focus.text.trim() ? event.focus.text : text;
	return { label: label.slice(0, 200), text: focusText };
}

function dateLabel(value) {
	const time = Date.parse(value ?? "");
	return Number.isFinite(time) ? new Date(time).toLocaleString("ko-KR", { hour12: false }) : "시각 정보 없음";
}

function clipLine(text, max) {
	const safe = terminalSafeText(text).replace(/\s+/g, " ");
	const lines = wrapTerminalText(safe, Math.max(1, max));
	if (lines.length <= 1) return lines[0] ?? "";
	return `${wrapTerminalText(safe, Math.max(1, max - 1))[0]}…`;
}

function moveVertical(draft, cursor, delta, preferredColumn) {
	const parts = graphemes(draft);
	let line = 0, column = 0;
	for (let i = 0; i < cursor; i++) {
		if (parts[i] === "\n") { line++; column = 0; }
		else column++;
	}
	const targetLine = line + delta;
	const lines = draft.split("\n");
	if (targetLine < 0 || targetLine >= lines.length) return { cursor, preferredColumn: null };
	const targetColumn = preferredColumn ?? column;
	let offset = 0;
	for (let i = 0; i < targetLine; i++) offset += graphemes(lines[i]).length + 1;
	return { cursor: offset + Math.min(targetColumn, graphemes(lines[targetLine]).length), preferredColumn: targetColumn };
}

function focusThread(focus) {
	return focus?.text ? threadKey(focus.text) : "";
}

function requestStatus(event) {
	if (event.type === "queued") return "다른 설명이 끝나기를 기다리는 중이에요";
	if (event.type === "stage") return event.stage === "planning" ? "질문을 살펴보는 중이에요" : event.stage === "explaining" ? "설명을 쓰는 중이에요" : "설명을 준비하는 중이에요";
	return "설명을 쓰는 중이에요";
}

/** Runs a full-screen, dependency-free TTY client. Server lifetime remains independent of this process. */
export async function runTerminal({ baseUrl, stdin = process.stdin, stdout = process.stdout, env = process.env, initialSession = null } = {}) {
	if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
		throw new Error("대화형 터미널에서 실행해야 해요. 일반 터미널에서 docent-tui 를 실행하세요.");
	}
	const theme = createTerminalTheme();
	const markdown = createTerminalMarkdown(theme);
	const symbols = statusSymbols();
	const api = new TerminalClient(baseUrl);
	const herdr = createHerdrReporter({ env, baseUrl });
	let profiles, sessions;
	try {
		[profiles, sessions] = await Promise.all([api.profiles(), api.sessions()]);
	} catch (error) {
		const detail = terminalSafeText(error?.message || String(error));
		throw new Error(`도슨트 서버에 연결하지 못했어요.\n주소: ${baseUrl}\n${detail}\n별도 터미널에서 docent --no-open 으로 서버를 시작하거나 --url 로 서버 주소를 지정하세요.`);
	}
	if (!Array.isArray(profiles) || !profiles.length) throw new Error("서버에서 프로필 목록을 받지 못했어요.");
	if (!Array.isArray(sessions)) throw new Error("서버에서 세션 목록을 받지 못했어요.");

	const initialProfile = profiles.find((entry) => entry.id === "default") ?? profiles[0];
	const state = {
		running: true,
		profiles, sessions, profile: initialProfile, session: null,
		profileIndex: Math.max(0, profiles.indexOf(initialProfile)),
		cards: [], cardKeys: new Set(), history: [],
		focus: null, thread: "",
		purpose: "ask", drafts: new Map(),
		picker: "sessions", pickerIndex: { sessions: 0, profiles: 0, conversations: 0, answers: 0 },
		ask: null, selectedAnswer: null,
		bodyScroll: 0, followSelection: true, followBottom: false,
		notice: "", noticeError: false, noticeKind: "info", liveNotice: "",
		completion: { key: "", index: 0, dismissed: null }, models: null, favorites: null,
	};
	let renderTimer = null;
	let streamController = null;
	let historyGeneration = 0;
	let sessionGeneration = 0;
	let askController = null;
	let resolveFinished;
	const finished = new Promise((resolve) => { resolveFinished = resolve; });

	const width = () => Math.max(20, Number(stdout.columns) || 80);
	const height = () => Math.max(8, Number(stdout.rows) || 24);
	const setNotice = (message, kind) => {
		state.notice = terminalSafeText(message);
		state.noticeError = kind === "error";
		state.noticeKind = kind;
		scheduleRender();
	};
	const failNotice = (message) => setNotice(message, "error");
	const inform = (message) => setNotice(message, "info");
	const succeed = (message) => setNotice(message, "success");
	const wrap = (text, columns = width()) => wrapTerminalText(text, columns);
	const add = (items, text, options = {}) => {
		const source = String(text ?? "");
		const pad = `${options.indent ?? ""}${/^ */.exec(source)[0]}`;
		const lines = wrap(source.trimStart(), Math.max(1, width() - pad.length)).map((line) => pad + line);
		for (let i = 0; i < lines.length; i++) {
			items.push({ text: lines[i], role: options.role || "text", selected: Boolean(options.selected && i === 0) });
		}
	};
	const divider = (items) => items.push({ text: "", role: "text" });
	const addMarkdown = (items, text, role = "text") => {
		for (const line of markdown.render(text, width())) items.push({ text: line, role, rich: true });
	};

	function displayedHistory() {
		return state.history.filter((row) => (row.thread || "") === state.thread);
	}

	function sameAskContext() {
		return Boolean(state.ask && state.ask.sessionId === state.session?.id && state.ask.profileId === selectedProfileId(state.profile));
	}

	function isAnswerSelected(row) {
		return Boolean(state.selectedAnswer && row.ts === state.selectedAnswer.ts && (row.question ?? "") === state.selectedAnswer.question);
	}

	// --- Drafts: keyed per profile/session/thread/purpose so context switches never leak text. ---
	function draftKey(purpose = state.purpose) {
		return `${selectedProfileId(state.profile)}|${state.session?.id ?? ""}|${state.thread}|${purpose}`;
	}
	function currentDraft() {
		const key = draftKey();
		let draft = state.drafts.get(key);
		if (!draft) {
			draft = { text: "", cursor: 0, preferredColumn: null };
			state.drafts.set(key, draft);
		}
		return draft;
	}
	function clearDraft(key = draftKey()) {
		state.drafts.set(key, { text: "", cursor: 0, preferredColumn: null });
	}
	function draftLimit() {
		return state.purpose === "steer" ? 2000 : 8000;
	}

	// --- Conversation choices: session whole + live cards + saved-only threads, deterministic. ---
	function conversationOptions() {
		const options = [{
			kind: "all", thread: "", focus: null, card: null,
			label: "세션 전체 대화",
			meta: `세션 전체 대화의 문답 ${state.history.filter((row) => !row.thread).length}개`,
		}];
		const seen = new Set([""]);
		for (const card of state.cards) {
			const thread = card.thread || focusThread(card.focus);
			if (!thread || seen.has(thread)) continue;
			seen.add(thread);
			const saved = state.history.filter((row) => row.thread === thread).length;
			options.push({
				kind: "card", thread, focus: { label: card.focus.label, text: card.focus.text }, card,
				label: card.focus.label,
				meta: `${card.past ? "이전 기록" : "새 기록"} | ${dateLabel(card.ts || card.at)}${saved ? ` | 저장된 문답 ${saved}개` : " | 저장된 문답 없음"}`,
			});
		}
		const byThread = new Map();
		for (const row of state.history) {
			if (!row.thread || seen.has(row.thread)) continue;
			let entry = byThread.get(row.thread);
			if (!entry) { entry = { thread: row.thread, rows: [] }; byThread.set(row.thread, entry); }
			entry.rows.push(row);
		}
		const saved = [...byThread.values()].sort((a, b) => {
			const at = String(a.rows.at(-1)?.ts ?? ""), bt = String(b.rows.at(-1)?.ts ?? "");
			return bt.localeCompare(at) || a.thread.localeCompare(b.thread);
		});
		for (const entry of saved) {
			const last = entry.rows.at(-1);
			options.push({
				kind: "saved", thread: entry.thread,
				focus: last?.focus?.text ? { label: last.focus.label || "질문 대상", text: last.focus.text } : null,
				card: null,
				label: last?.focus?.label || "주제 없는 저장 대화",
				meta: `마지막 활동 ${dateLabel(last?.ts)} | 저장된 문답 ${entry.rows.length}개`,
			});
		}
		return options;
	}

	// --- Body renderers. ---
	const pick = (items, selected, label, description = "") => {
		const prefix = selected ? theme.span("title", " → ") : "   ";
		const columns = width();
		const main = clipLine(label, Math.max(8, columns - 4));
		const head = `${prefix}${theme.span(selected ? "title" : "text", main)}`;
		const extra = description && columns > 40 && visibleWidth(main) + visibleWidth(description) + 7 <= columns
			? theme.span("muted", `  ${description}`) : "";
		items.push({ text: head + extra, role: "text", rich: true, selected });
		if (description && !extra) items.push({ text: theme.span("muted", `     ${clipLine(description, columns - 6)}`), role: "text", rich: true });
	};
	const pickerHeader = (items, title, detail) => {
		items.push({ text: "─".repeat(width()), role: "borderAccent" });
		items.push({ text: `${theme.span("title", ` ${title}`)}${detail ? theme.span("muted", `  ${detail}`) : ""}`, role: "text", rich: true });
		divider(items);
	};
	const pickerFooter = (items, total) => {
		divider(items);
		items.push({ text: theme.span("dim", ` ↑↓ 이동  Enter 선택  Esc 입력창으로${total > 8 ? `  (${total}개)` : ""}`), role: "text", rich: true });
		items.push({ text: "─".repeat(width()), role: "borderAccent" });
	};

	/** 세션 카드: 어디(저장소, 브랜치, 워크트리)와 언제, 제목, 최근 작업 한 줄 (ADR 0045). */
	const sessionCard = (session, selected, current) => {
		const icons = SESSION_ICONS[symbols] ?? SESSION_ICONS.unicode;
		const columns = width();
		const place = [
			session.repo
				? theme.span("title", `${icons.repo} ${clipLine(session.repo, 28)}`)
				: theme.span("path", `${icons.folder} ${clipLine(session.project || "작업 폴더 없음", 28)}`),
			session.branch && theme.span("success", `${icons.branch} ${clipLine(session.branch, 32)}${session.detached ? " (브랜치 아님)" : ""}`),
			session.worktree && theme.span("label", `${icons.worktree} ${clipLine(session.worktree, 24)}`),
			current && theme.span("success", icons.current),
		].filter(Boolean).join("  ");
		const head = `${selected ? theme.span("title", " → ") : "   "}${place}`;
		const meta = theme.span("dim", [session.provider || "제공자 미상", session.host, agoLabel(session.updated)].filter(Boolean).join(" • "));
		const lines = [
			visibleWidth(head) + visibleWidth(meta) + 2 <= columns ? `${head}  ${meta}` : truncateToWidth(head, columns),
			`     ${theme.span(selected ? "title" : "text", clipLine(session.title || "제목 없음", columns - 6))}`,
		];
		if (session.recent) lines.push(`     ${theme.span("muted", `${icons.recent} ${clipLine(session.recent, columns - 9)}`)}`);
		return lines;
	};

	function sessionsBody() {
		const items = [];
		pickerHeader(items, "세션 선택", "도슨트가 함께 읽을 작업 기록");
		if (!state.sessions.length) add(items, " 세션이 없어요. 에이전트에서 대화를 시작한 뒤 Ctrl+R 로 새로고침하세요.", { role: "muted" });
		for (let i = 0; i < state.sessions.length; i++) {
			const session = state.sessions[i];
			const selected = i === state.pickerIndex.sessions;
			for (const text of sessionCard(session, selected, session.id === state.session?.id)) items.push({ text, role: "text", rich: true, selected });
			if (i < state.sessions.length - 1) divider(items);
		}
		pickerFooter(items, state.sessions.length);
		return items;
	}

	function profilesBody() {
		const items = [];
		pickerHeader(items, "프로필 선택", "프로필마다 학습 기록과 설명 깊이가 나뉘어요");
		state.profiles.forEach((profile, i) => {
			pick(items, i === state.pickerIndex.profiles, `${profileName(profile)}${profile.id === "default" ? " (기본)" : ""}`, `${profile.defaultDifficulty || "NORMAL"} • ${profile.model || "기본 모델"}`);
		});
		pickerFooter(items, state.profiles.length);
		return items;
	}

	function conversationsBody() {
		const items = [];
		const options = conversationOptions();
		const savedCount = options.filter((option) => option.kind === "saved").length;
		pickerHeader(items, "대화 선택", `카드 ${state.cards.length} • 저장 ${savedCount}`);
		options.forEach((option, index) => {
			const badge = option.kind === "all" ? "전체" : option.kind === "card" ? CATEGORY[option.card.sub] || "작업 내용" : "저장 대화";
			pick(items, index === state.pickerIndex.conversations, `[${badge}] ${option.label}`, option.meta.replaceAll(" | ", " • "));
		});
		pickerFooter(items, options.length);
		return items;
	}

	function answersBody() {
		const items = [];
		const rows = displayedHistory();
		pickerHeader(items, "저장된 답변", `${rows.length}개 • 모델을 다시 부르지 않아요`);
		if (!rows.length) add(items, " 아직 저장된 답변이 없어요.", { role: "muted" });
		rows.forEach((row, index) => {
			const answer = row.answer;
			const summary = answer && typeof answer === "object" ? answer.headline || "답변 본문 없음" : "저장된 답변 없음";
			pick(items, index === state.pickerIndex.answers, row.display || row.question || "질문 내용을 찾을 수 없어요.", `${dateLabel(row.ts)}${row.auto ? " • 미리 설명" : ""} • ${summary}`);
		});
		pickerFooter(items, rows.length);
		return items;
	}

	function addUserMessage(items, text, steers, selected = false, meta = "") {
		if (meta) items.push({ text: theme.span(selected ? "title" : "dim", ` ${selected ? "→ " : ""}${meta}`), role: "text", rich: true, selected });
		items.push({ text: "", role: "user", selected: selected && !meta });
		addMarkdown(items, text, "user");
		for (const message of steers ?? []) addMarkdown(items, `*바로잡기:* ${message}`, "user");
		items.push({ text: "", role: "user" });
	}

	function addRecord(items, row, selected) {
		const meta = selected || row.auto ? `${dateLabel(row.ts)}${row.auto ? " • 미리 설명" : ""}${selected ? " • 선택한 답변" : ""}` : "";
		divider(items);
		addUserMessage(items, row.display || row.question || "질문 내용을 찾을 수 없어요.", row.steers, selected, meta);
		divider(items);
		const answer = row.answer;
		const text = answer && typeof answer === "object" ? [answer.headline, answer.explain, ...(answer.details ?? [])].filter(Boolean).join("\n\n") : "";
		if (text) addMarkdown(items, text);
		else add(items, " 아직 저장된 답변이 없어요.", { role: "muted" });
	}

	function addAskBlock(items) {
		const ask = state.ask;
		divider(items);
		addUserMessage(items, ask.question, ask.steers);
		divider(items);
		if (ask.text) addMarkdown(items, ask.text);
	}

	function conversationBody() {
		const items = [];
		const rows = displayedHistory();
		divider(items);
		if (state.focus?.text) {
			items.push({ text: "", role: "custom" });
			items.push({ text: theme.span("label", " AI 출력"), role: "custom", rich: true });
			addMarkdown(items, state.focus.text, "custom");
			items.push({ text: "", role: "custom" });
			divider(items);
		}
		if (!rows.length && !sameAskContext()) {
			add(items, " 이 작업에서 무엇이 궁금한가요?", { role: "title" });
			add(items, " 아래에 질문을 쓰세요. # 를 입력하면 설명할 대화를, / 를 입력하면 모든 명령을 고를 수 있어요.", { role: "muted" });
		}
		for (const row of rows) addRecord(items, row, isAnswerSelected(row));
		if (sameAskContext()) addAskBlock(items);
		return items;
	}

	function pickerBody() {
		if (state.picker === "sessions") return sessionsBody();
		if (state.picker === "profiles") return profilesBody();
		if (state.picker === "conversations") return conversationsBody();
		return answersBody();
	}

	// --- Composer: Pi editor shape. Full-width rules, padded prompt rows, no frame, corners, or labels. ---
	function composerFrame() {
		const isSteer = state.purpose === "steer";
		const draft = currentDraft();
		const parts = graphemes(draft.text);
		const contentWidth = Math.max(1, width() - 2);
		const withCaret = `${parts.slice(0, draft.cursor).join("")}▏${parts.slice(draft.cursor).join("")}`;
		const placeholder = state.picker ? "선택하면 이 입력창으로 돌아와요."
			: isSteer ? "바로잡을 내용을 입력하세요"
				: width() >= 70 ? "궁금한 내용을 입력하세요.  / 명령   @ 세션   # 대화   $ 설정" : "궁금한 내용을 입력하세요";
		const wrapped = draft.text ? wrap(withCaret, contentWidth) : [`▏${placeholder}`];
		const maxLines = Math.max(1, Math.min(8, height() - 8));
		const caretLine = wrap(`${parts.slice(0, draft.cursor).join("")}▏`, contentWidth).length - 1;
		const start = Math.max(0, Math.min(caretLine - maxLines + 1, wrapped.length - maxLines));
		const borderRole = state.picker ? "border" : isSteer ? "warning" : "borderAccent";
		const hidden = start > 0 ? ` ↑ ${start}줄 더 ` : "";
		const top = hidden
			? `${"─".repeat(Math.max(0, Math.floor((width() - visibleWidth(hidden)) / 2)))}${hidden}${"─".repeat(Math.max(0, width() - Math.floor((width() - visibleWidth(hidden)) / 2) - visibleWidth(hidden)))}`
			: "─".repeat(width());
		const lines = [{ text: top, role: borderRole }];
		for (const row of wrapped.slice(start, start + maxLines)) lines.push({ text: ` ${row}`, role: draft.text ? "composer" : "dim" });
		lines.push({ text: "─".repeat(width()), role: borderRole });
		return lines;
	}

	const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let spinnerFrame = 0, spinnerTimer = null;
	function syncSpinner() {
		const active = Boolean(state.ask && !state.ask.disconnected && !state.ask.cancelling);
		if (active && !spinnerTimer) spinnerTimer = setInterval(() => { spinnerFrame = (spinnerFrame + 1) % SPINNER.length; scheduleRender(); }, 100);
		else if (!active && spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
	}

	/** Pi shows working state and messages just above the editor; nothing is shown when idle. */
	function activityLine() {
		const ask = state.ask;
		if (ask?.disconnected) return theme.span("warning", " 연결이 끊겼어요. Ctrl+R로 같은 요청에 다시 연결해요.");
		if (ask?.cancelling) return theme.span("warning", " 설명을 멈추는 중이에요");
		if (ask) return `${theme.span("title", ` ${SPINNER[spinnerFrame]} `)}${theme.span("muted", `${ask.stage || "설명을 준비하는 중이에요"}`)}${theme.span("dim", " (/중단, /바로잡기)")}`;
		if (state.notice) return theme.span(state.noticeKind === "error" ? "error" : state.noticeKind === "success" ? "success" : "muted", ` ${state.notice}`);
		if (state.liveNotice) return theme.span("warning", ` ${state.liveNotice}`);
		return "";
	}

	function headerLines() {
		const keys = width() >= 100
			? [["/", "명령"], ["@", "세션"], ["#", "대화"], ["$", "설정"], ["Enter", "보내기"], ["Ctrl+J", "줄바꿈"], ["Ctrl+C", "중단"]]
			: [["/", "명령"], ["@", "세션"], ["#", "대화"], ["$", "설정"]];
		return [
			`${theme.span("title", ` ${TITLE}`)}${theme.span("dim", "  설명 전용, 코드는 바꾸지 않아요")}`,
			` ${keys.map(([key, label]) => `${theme.span("title", key)} ${theme.span("muted", label)}`).join(theme.span("dim", " • "))}`,
		];
	}

	/** Status line: two rows built from STATUS_RULES (docs/terminal-status-line.md, ADR 0040). */
	function footerLines(scroll) {
		const third = Math.max(8, Math.floor(width() / 3));
		const selector = state.profile.model;
		const model = selector ? state.models?.list?.find((entry) => entry.selector === selector) : null;
		const segments = statusSegments({
			ask: state.ask,
			spinnerFrame,
			session: state.session ? { ...state.session, title: clipLine(state.session.title || state.session.id, third), project: clipLine(placeOf(state.session) || state.session.provider || "", Math.floor(third * 0.75)) } : null,
			conversation: clipLine(state.thread ? state.focus?.label || "선택한 대화" : "세션 전체 대화", third),
			scroll,
			modelName: clipLine(selector ? model?.name || selector : "기본 모델", 28),
			depth: state.profile.defaultDifficulty || "NORMAL",
			profileName: clipLine(profileName(state.profile), 14),
			metrics: statusMetrics(state.history, state.thread, state.favorites),
		}, symbols);
		return [1, 2].map((row) => renderStatusRow(segments.filter((segment) => segment.row === row), width(), theme));
	}

	function render() {
		if (!state.running) return;
		syncSpinner();
		syncHerdr();
		const columns = width(), rows = height();
		const body = state.picker ? pickerBody() : conversationBody();
		const composer = composerFrame();
		const activity = activityLine();
		const completion = completionRows(activeCompletion());
		const header = rows >= 14 ? headerLines() : headerLines().slice(0, 1);
		const showFooter = !(completion.length && rows < 20);
		const bodyHeight = Math.max(1, rows - header.length - (activity ? 1 : 0) - composer.length - completion.length - (showFooter ? 2 : 0));
		const selectedLine = body.findIndex((item) => item.selected);
		let selectedEnd = selectedLine; // 여러 줄 카드는 마지막 줄까지 보이게 한다
		while (selectedEnd >= 0 && body[selectedEnd + 1]?.selected) selectedEnd++;
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (state.followBottom) state.bodyScroll = maxScroll;
		else if (state.followSelection && selectedLine >= 0) {
			if (selectedLine < state.bodyScroll) state.bodyScroll = selectedLine;
			else if (selectedEnd >= state.bodyScroll + bodyHeight) state.bodyScroll = Math.min(selectedLine, selectedEnd - bodyHeight + 1);
		}
		state.bodyScroll = Math.max(0, Math.min(state.bodyScroll, maxScroll));
		const visible = body.slice(state.bodyScroll, state.bodyScroll + bodyHeight);
		while (visible.length < bodyHeight) visible.push({ text: "", role: "text" });
		const fill = (text) => {
			const fitted = truncateToWidth(text, columns);
			return fitted + " ".repeat(Math.max(0, columns - visibleWidth(fitted)));
		};
		const paintRow = (item) => item.rich
			? theme.line(item.role, fill(item.text))
			: theme.paint(item.role, fill(terminalSafeText(item.text)));
		const scroll = body.length > bodyHeight ? `${Math.round(((state.bodyScroll + bodyHeight) / body.length) * 100)}%` : "";
		const output = [
			...header.map((line) => theme.line("text", truncateToWidth(line, columns))),
			...visible.map(paintRow),
			...(activity ? [theme.line("text", truncateToWidth(activity, columns))] : []),
			...composer.map(paintRow),
			...completion.map(paintRow),
			...(showFooter ? footerLines(scroll).map((line) => theme.line("text", truncateToWidth(line, columns))) : []),
		];
		stdout.write(`${ESC}?2026h${ESC}2J${ESC}H${output.join("\r\n")}${ESC}?2026l`);
	}

	function scheduleRender() {
		if (renderTimer || !state.running) return;
		renderTimer = setTimeout(() => { renderTimer = null; render(); }, 35);
	}

	// --- Pickers: open/close/choose. Esc and picking never touch the keyed drafts. ---
	function togglePicker(kind) {
		if (state.picker === kind) { closePicker(); return; }
		if ((kind === "conversations" || kind === "answers") && !state.session) {
			inform("먼저 세션을 고르세요. @ 를 입력하면 세션 목록이 나와요.");
			return;
		}
		state.picker = kind;
		if (kind === "sessions") {
			const current = state.sessions.findIndex((entry) => entry.id === state.session?.id);
			state.pickerIndex.sessions = current >= 0 ? current : 0;
		} else if (kind === "profiles") {
			const current = state.profiles.findIndex((entry) => entry.id === state.profile.id);
			state.pickerIndex.profiles = Math.max(0, current);
		} else if (kind === "conversations") {
			const current = conversationOptions().findIndex((option) => option.thread === state.thread);
			state.pickerIndex.conversations = Math.max(0, current);
		} else if (kind === "answers") {
			const rows = displayedHistory();
			const current = rows.findIndex((row) => isAnswerSelected(row));
			state.pickerIndex.answers = current >= 0 ? current : Math.max(0, rows.length - 1);
		}
		state.bodyScroll = 0;
		state.followSelection = true;
		state.followBottom = false;
		scheduleRender();
	}

	function closePicker() {
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = true;
		state.followBottom = false;
		scheduleRender();
	}

	function pickerCount() {
		if (state.picker === "sessions") return state.sessions.length;
		if (state.picker === "profiles") return state.profiles.length;
		if (state.picker === "conversations") return conversationOptions().length;
		if (state.picker === "answers") return displayedHistory().length;
		return 0;
	}

	function focusPicker(index) {
		const count = pickerCount();
		if (!count) return;
		state.pickerIndex[state.picker] = Math.max(0, Math.min(index, count - 1));
		state.bodyScroll = 0;
		state.followSelection = true;
		state.followBottom = false;
		scheduleRender();
	}

	function movePicker(delta) {
		const count = pickerCount();
		if (!count) return;
		focusPicker((state.pickerIndex[state.picker] + delta + count) % count);
	}

	function choosePicker() {
		if (state.picker === "sessions") { void switchSession(state.sessions[state.pickerIndex.sessions]); return; }
		if (state.picker === "profiles") { void chooseProfile(state.profiles[state.pickerIndex.profiles]); return; }
		if (state.picker === "conversations") { switchThread(conversationOptions()[state.pickerIndex.conversations]); return; }
		if (state.picker === "answers") openSelectedAnswer();
	}

	function switchThread(option) {
		if (!option) { inform("선택할 대화가 없어요."); return; }
		state.focus = option.focus ? { label: option.focus.label, text: option.focus.text } : null;
		state.thread = option.thread || "";
		state.selectedAnswer = null;
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = false;
		state.followBottom = true;
		scheduleRender();
	}

	/** Saved answers are a read view: select the original record inside its thread. No request is sent. */
	function openSelectedAnswer() {
		const rows = displayedHistory();
		const row = rows[state.pickerIndex.answers];
		if (!row) { inform("선택할 저장된 답변이 없어요."); return; }
		state.selectedAnswer = { ts: row.ts, question: row.question ?? "" };
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = true;
		state.followBottom = false;
		scheduleRender();
	}

	// --- Inline completion (OMP style): "/" commands, "@" sessions, "#" conversations, "$" settings. ---
	// Active only while the whole question draft is one trigger plus a filter; Esc keeps the text literal.
	const DEPTHS = [["EASY", "짧고 쉬운 핵심과 예시"], ["NORMAL", "원리와 흐름까지"], ["HARD", "실제 코드, 경계 조건, 대안까지"]];

	function setDraftText(text) {
		const draft = currentDraft();
		draft.text = text;
		draft.cursor = graphemes(text).length;
		draft.preferredColumn = null;
		state.completion.dismissed = null;
		scheduleRender();
	}

	function needSession() {
		if (state.session) return true;
		inform("먼저 세션을 고르세요.");
		setDraftText("@");
		return false;
	}

	function commandItems() {
		const items = [
			{ label: "/세션", aliases: "session", description: "함께 읽을 작업 세션 고르기", run: () => setDraftText("@") },
			{ label: "/대화", aliases: "thread conversation card", description: "세션 전체 대화나 사건 카드 고르기", run: () => { if (needSession()) setDraftText("#"); } },
			{ label: "/답변", aliases: "answer history", description: "이 대화에서 저장된 답변 다시 보기", run: () => { if (needSession()) togglePicker("answers"); } },
			{ label: "/설정", aliases: "settings config model depth profile", description: "설명 깊이, 모델, 미리 설명, 프로필", run: () => setDraftText("$") },
			{ label: "/새로고침", aliases: "refresh reload", description: "목록과 대화를 다시 불러오고 끊긴 설명에 다시 연결", run: rejoinOrRefresh },
		];
		if (state.ask) items.push(
			{ label: "/바로잡기", aliases: "steer", description: "진행 중인 설명의 방향 고치기", run: toggleSteer },
			{ label: "/중단", aliases: "stop cancel", description: "진행 중인 설명 멈추기", run: () => void cancelActiveAsk() },
		);
		items.push({ label: "/종료", aliases: "quit exit", description: "터미널만 닫기. 서버와 보낸 설명 요청은 유지", run: exit });
		return items;
	}

	function sessionItems() {
		return state.sessions.map((session) => ({
			label: session.title || "제목 없음",
			aliases: `${session.repo ?? ""} ${session.project ?? ""} ${session.worktree ?? ""} ${session.branch ?? ""} ${session.provider ?? ""} ${session.host ?? ""}`,
			description: session.recent ?? "",
			card: (selected) => sessionCard(session, selected, session.id === state.session?.id),
			current: session.id === state.session?.id,
			run: () => void switchSession(session),
		}));
	}

	function conversationItems() {
		if (!state.session) return [];
		return conversationOptions().map((option) => ({
			label: `${option.kind === "all" ? "[전체]" : option.kind === "card" ? `[${CATEGORY[option.card.sub] || "작업 내용"}]` : "[저장 대화]"} ${option.label}`,
			description: option.meta.replaceAll(" | ", " • "),
			current: option.thread === state.thread,
			run: () => switchThread(option),
		}));
	}

	function loadModels() {
		if (state.models) return;
		state.models = { loading: true, list: [] };
		api.models().then((catalog) => {
			state.models = { loading: false, list: Array.isArray(catalog?.models) ? catalog.models : [] };
		}).catch((error) => {
			state.models = { loading: false, list: [], error: terminalSafeText(error.message) };
		}).finally(scheduleRender);
	}

	async function patchProfile(patch, message) {
		const id = selectedProfileId(state.profile);
		try {
			const updated = await api.updateProfile(id, patch);
			state.profiles = state.profiles.map((entry) => entry.id === updated.id ? updated : entry);
			if (selectedProfileId(state.profile) === updated.id) state.profile = updated;
			succeed(message);
		} catch (error) { failNotice(`설정을 바꾸지 못했어요: ${error.message}`); }
	}

	function settingsItems() {
		loadModels();
		const profile = state.profile;
		const items = DEPTHS.map(([depth, description]) => ({
			label: `설명 깊이 ${depth}`, aliases: "depth difficulty 난이도", description,
			current: (profile.defaultDifficulty || "NORMAL") === depth,
			run: () => void patchProfile({ defaultDifficulty: depth }, `기본 설명 깊이를 ${depth}로 바꿨어요.`),
		}));
		const auto = profile.autoExplain !== false;
		items.push({
			label: auto ? "미리 설명 끄기" : "미리 설명 켜기", aliases: "auto prefetch 자동",
			description: auto ? "지금 켜져 있어요. 새 사건 카드를 미리 설명하지 않아요" : "지금 꺼져 있어요. 새 사건 카드를 쉬운 말로 미리 설명해요",
			run: () => void patchProfile({ autoExplain: !auto }, auto ? "미리 설명을 껐어요." : "미리 설명을 켰어요."),
		});
		items.push({ label: "모델: 기본 모델", aliases: "model 모델", description: "omp 기본 모델로 설명", current: !profile.model, run: () => void patchProfile({ model: null }, "기본 모델로 설명해요.") });
		for (const model of state.models.list) {
			items.push({
				label: `모델: ${model.name || model.selector}`, aliases: `model 모델 ${model.provider ?? ""}`, description: model.selector,
				current: profile.model === model.selector,
				run: () => void patchProfile({ model: model.selector }, `${model.name || model.selector} 모델로 설명해요.`),
			});
		}
		for (const entry of state.profiles) {
			items.push({
				label: `프로필: ${profileName(entry)}`, aliases: "profile 프로필",
				description: entry.id === "default" ? "기본 프로필" : "학습 기록을 따로 보관해요",
				current: entry.id === state.profile.id,
				run: () => void chooseProfile(entry),
			});
		}
		return items;
	}

	function activeCompletion() {
		if (state.picker || state.purpose === "steer") return null;
		const draft = currentDraft();
		const match = /^([/@#$])([^\n]*)$/.exec(draft.text);
		if (!match || state.completion.dismissed === draft.text) return null;
		const [, trigger, raw] = match;
		const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
		const all = trigger === "/" ? commandItems() : trigger === "@" ? sessionItems() : trigger === "#" ? conversationItems() : settingsItems();
		const items = all.filter((item) => {
			const haystack = `${item.label} ${item.aliases ?? ""} ${item.description ?? ""}`.toLowerCase();
			return terms.every((term) => haystack.includes(term));
		});
		if (state.completion.key !== draft.text) {
			state.completion.key = draft.text;
			state.completion.index = terms.length ? 0 : Math.max(0, items.findIndex((item) => item.current));
		}
		state.completion.index = Math.max(0, Math.min(state.completion.index, items.length - 1));
		const empty = trigger === "#" && !state.session ? "먼저 세션을 고르세요. @ 를 입력하면 세션 목록이 나와요."
			: trigger === "$" && state.models?.loading && !terms.length ? "" : "일치하는 항목이 없어요. Esc를 누르면 입력한 글자를 그대로 보낼 수 있어요.";
		const title = { "/": "명령", "@": "세션", "#": "대화", "$": "설정" }[trigger];
		return { trigger, title, items, empty, loading: trigger === "$" && Boolean(state.models?.loading), modelError: trigger === "$" ? state.models?.error : "" };
	}

	function moveCompletion(completion, delta) {
		const count = completion.items.length;
		if (!count) return;
		state.completion.index = (state.completion.index + delta + count) % count;
		scheduleRender();
	}

	function acceptCompletion(completion) {
		const item = completion.items[state.completion.index];
		if (!item) { failNotice(completion.empty || "일치하는 항목이 없어요."); return; }
		clearDraft();
		state.completion = { key: "", index: 0, dismissed: null };
		inform("");
		item.run();
		scheduleRender();
	}

	/** Pi SelectList rows under the editor: "→" marks the keyboard choice, descriptions stay muted. Session items draw as cards. */
	function completionRows(completion) {
		if (!completion) return [];
		const rows = [];
		const total = completion.items.length;
		const linesPerItem = completion.items.some((item) => item.card) ? 3 : 1;
		const max = Math.max(2, Math.min(8, Math.floor((height() - 14) / linesPerItem)));
		const index = state.completion.index;
		const start = Math.max(0, Math.min(index - Math.floor(max / 2), total - max));
		const visible = completion.items.slice(start, start + max);
		const labelWidth = Math.min(Math.floor(width() * 0.45), Math.max(8, ...visible.map((item) => visibleWidth(item.label))));
		rows.push(`${theme.span("title", ` ${completion.trigger} ${completion.title}`)}${theme.span("dim", "  ↑↓ 이동  Enter 선택  Esc 글자 그대로 입력")}`);
		if (completion.loading) rows.push(theme.span("dim", "   모델 목록을 불러오는 중이에요"));
		if (completion.modelError) rows.push(theme.span("warning", `   모델 목록을 불러오지 못했어요: ${completion.modelError}`));
		if (!total && completion.empty) rows.push(theme.span("dim", `   ${completion.empty}`));
		visible.forEach((item, offset) => {
			const selected = start + offset === index;
			if (item.card) {
				const lines = item.card(selected);
				rows.push(...lines, ...Array(Math.max(0, linesPerItem - lines.length)).fill("")); // 고를 때 입력창이 들썩이지 않게 높이를 맞춘다
				return;
			}
			const label = clipLine(item.label, labelWidth);
			const padded = label + " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
			const mark = item.current ? theme.span("success", " ✓") : "  ";
			const room = width() - labelWidth - 8;
			rows.push(`${selected ? theme.span("title", " → ") : "   "}${theme.span(selected ? "title" : "text", padded)}${mark} ${room > 6 && item.description ? theme.span("muted", clipLine(item.description, room)) : ""}`);
		});
		if (total > max) rows.push(theme.span("dim", `   (${index + 1}/${total})`));
		return rows.map((text) => ({ text, role: "text", rich: true }));
	}

	// --- Server data flow (transport contracts unchanged). ---
	async function reloadHistory() {
		if (!state.session) return;
		const generation = ++historyGeneration;
		try {
			const [rows] = await Promise.all([
				api.history(state.session.id, selectedProfileId(state.profile)),
				loadFavorites(state.session.id, selectedProfileId(state.profile), generation),
			]);
			if (!state.running || generation !== historyGeneration) return;
			state.history = Array.isArray(rows) ? rows : [];
			if (state.selectedAnswer && !state.history.some((row) => isAnswerSelected(row))) state.selectedAnswer = null;
			state.pickerIndex.answers = Math.min(state.pickerIndex.answers, Math.max(0, displayedHistory().length - 1));
			scheduleRender();
		} catch (error) {
			if (generation === historyGeneration) failNotice(`이전 대화를 불러오지 못했어요: ${error.message}`);
		}
	}

	/** Favorites only feed the status line count; a failure hides the count instead of showing a false 0. */
	async function loadFavorites(sessionId, profileId, generation) {
		try {
			const list = await api.favorites(sessionId, profileId);
			if (generation === historyGeneration) state.favorites = Array.isArray(list) ? list : null;
		} catch {
			if (generation === historyGeneration) state.favorites = null;
		}
	}

	function addCard(event) {
		if (!event || !["question", "assistant"].includes(event.kind) || !CATEGORY[event.sub] || typeof event.text !== "string" || !event.text.trim()) return;
		const focus = focusForEvent(event);
		const thread = typeof event.thread === "string" && event.thread ? event.thread : focusThread(focus);
		const key = thread || `${event.sub}\n${normalizedThreadText(event.text)}`;
		if (state.cardKeys.has(key)) return;
		state.cardKeys.add(key);
		state.cards.push({ ...event, focus, thread, key });
		if (state.cards.length > 200) {
			const removed = state.cards.shift();
			state.cardKeys.delete(removed.key);
		}
	}

	function handleEvent(event) {
		if (!state.running || !event || typeof event !== "object") return;
		if (event.kind === "warn") {
			state.liveNotice = terminalSafeText(event.text || "실시간 기록을 확인하지 못했어요.");
			scheduleRender();
			return;
		}
		if (event.kind === "record") {
			void reloadHistory();
			return;
		}
		const before = state.cards.length;
		addCard(event);
		if (state.cards.length !== before) scheduleRender();
	}

	async function keepLive(session, profile, signal, generation) {
		let backoff = 500;
		while (state.running && !signal.aborted && generation === sessionGeneration) {
			try {
				await api.events(session.id, selectedProfileId(profile), signal, (event) => {
					if (generation !== sessionGeneration || signal.aborted || state.session?.id !== session.id || selectedProfileId(state.profile) !== selectedProfileId(profile)) return;
					handleEvent(event);
				});
				if (!signal.aborted) {
					state.liveNotice = "실시간 연결이 닫혔어요. 다시 연결하는 중이에요.";
					scheduleRender();
				}
				backoff = 500;
			} catch (error) {
				if (signal.aborted || !state.running) return;
				state.liveNotice = `실시간 연결에 실패했어요: ${terminalSafeText(error.message)}`;
				scheduleRender();
			}
			await new Promise((resolve) => {
				const done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, backoff);
				signal.addEventListener("abort", done, { once: true });
				if (signal.aborted) done();
			});
			backoff = Math.min(backoff * 2, 8000);
		}
	}

	async function restoreJob(session, profile, generation) {
		try {
			const jobs = await api.jobs(session.id, selectedProfileId(profile));
			if (!state.running || generation !== sessionGeneration || state.ask || !Array.isArray(jobs)) return;
			const job = jobs.find((entry) => !entry.auto);
			if (!job?.requestId || typeof job.question !== "string") return;
			const focus = job.focus?.text ? { label: String(job.focus.label || "질문 대상").slice(0, 200), text: job.focus.text } : null;
			const ask = {
				requestId: job.requestId, sessionId: session.id, profileId: selectedProfileId(profile), question: job.question,
				focus, text: "", stage: requestStatus({ type: "stage", stage: job.stage }), steers: [], cancelling: false, startedAt: Date.parse(job.startedAt ?? "") || Date.now(),
			};
			const body = { id: session.id, profileId: ask.profileId, question: ask.question, requestId: ask.requestId };
			if (focus) body.focus = focus;
			if (job.difficulty) body.difficulty = job.difficulty;
			state.ask = ask;
			inform("진행 중인 설명에 다시 연결했어요.");
			void consumeAsk(ask, body);
		} catch (error) {
			if (generation === sessionGeneration) failNotice(`진행 중인 요청을 확인하지 못했어요: ${error.message}`);
		}
	}

	async function refreshSessions() {
		try {
			const list = await api.sessions();
			if (!state.running || !Array.isArray(list)) return;
			state.sessions = list;
			const current = list.findIndex((entry) => entry.id === state.session?.id);
			state.pickerIndex.sessions = current >= 0 ? current : Math.min(state.pickerIndex.sessions, Math.max(0, list.length - 1));
			inform(`세션 목록을 새로 불러왔어요. ${list.length}개`);
		} catch (error) { failNotice(`세션 목록을 불러오지 못했어요: ${error.message}`); }
	}

	async function switchSession(session) {
		if (!session) { inform("선택할 세션이 없어요."); return; }
		state.session = session;
		state.cards = [];
		state.cardKeys.clear();
		state.history = [];
		state.favorites = null;
		state.focus = null;
		state.thread = "";
		state.selectedAnswer = null;
		if (state.purpose === "steer" && !(state.ask && state.ask.sessionId === session.id && state.ask.profileId === selectedProfileId(state.profile))) state.purpose = "ask";
		state.liveNotice = "";
		state.notice = "이전 대화를 불러오는 중이에요.";
		state.noticeError = false;
		state.noticeKind = "info";
		historyGeneration++;
		const generation = ++sessionGeneration;
		streamController?.abort();
		streamController = new AbortController();
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = false;
		state.followBottom = true;
		try {
			const [rows] = await Promise.all([
				api.history(session.id, selectedProfileId(state.profile)),
				loadFavorites(session.id, selectedProfileId(state.profile), historyGeneration),
			]);
			if (!state.running || generation !== sessionGeneration) return;
			state.history = Array.isArray(rows) ? rows : [];
			state.notice = "";
			scheduleRender();
		} catch (error) {
			if (generation === sessionGeneration) failNotice(`이전 대화를 불러오지 못했어요: ${error.message}`);
		}
		if (state.running && generation === sessionGeneration) void keepLive(session, state.profile, streamController.signal, generation);
		if (state.running && generation === sessionGeneration) void restoreJob(session, state.profile, generation);
	}

	async function chooseProfile(profile) {
		if (!profile) return;
		state.profile = profile;
		state.profileIndex = Math.max(0, state.profiles.findIndex((entry) => entry.id === profile.id));
		state.focus = null;
		state.thread = "";
		state.history = [];
		state.favorites = null;
		state.cards = [];
		state.cardKeys.clear();
		state.selectedAnswer = null;
		inform(`프로필을 ${profileName(profile)} 으로 바꿨어요.`);
		if (state.session) await switchSession(state.session);
		else {
			state.picker = "sessions";
			state.pickerIndex.sessions = 0;
			state.bodyScroll = 0;
			state.followSelection = true;
			state.followBottom = false;
			scheduleRender();
		}
	}

	// --- Composer editing. ---
	function insertText(text, isPaste = false) {
		if (!text) return;
		const draft = currentDraft();
		if (draft.text.length + text.length > draftLimit()) {
			failNotice(`${state.purpose === "steer" ? "바로잡기 문장은 2000자" : "질문은 8000자"} 이내로 입력하세요. 입력은 더하지 않았어요.`);
			return;
		}
		const parts = graphemes(draft.text);
		const before = parts.slice(0, draft.cursor).join("");
		const after = parts.slice(draft.cursor).join("");
		draft.text = before + text + after;
		draft.cursor = graphemes(before + text).length;
		draft.preferredColumn = null;
		if (isPaste) inform("붙여넣은 내용은 텍스트로만 입력했어요.");
		else inform("");
	}

	function eraseWord() {
		const draft = currentDraft();
		const parts = graphemes(draft.text);
		let start = draft.cursor;
		while (start > 0 && /^\s+$/u.test(parts[start - 1])) start--;
		while (start > 0 && !/^\s+$/u.test(parts[start - 1])) start--;
		parts.splice(start, draft.cursor - start);
		draft.text = parts.join("");
		draft.cursor = start;
		draft.preferredColumn = null;
		scheduleRender();
	}

	function moveToLineEdge(edge) {
		const draft = currentDraft();
		const parts = graphemes(draft.text);
		let start = draft.cursor, end = draft.cursor;
		while (start > 0 && parts[start - 1] !== "\n") start--;
		while (end < parts.length && parts[end] !== "\n") end++;
		draft.cursor = edge === "home" ? start : end;
		draft.preferredColumn = null;
		scheduleRender();
	}

	function toggleSteer() {
		if (state.purpose === "steer") {
			state.purpose = "ask";
			scheduleRender();
			return;
		}
		if (!state.ask) { inform("바로잡을 진행 중인 설명이 없어요. 설명이 진행되면 Ctrl+S 로 전환하세요."); return; }
		state.purpose = "steer";
		scheduleRender();
	}

	async function submitComposer() {
		const draft = currentDraft();
		const text = draft.text.trim();
		if (!text) { failNotice("보낼 내용을 입력하세요."); return; }
		if (state.purpose === "steer") {
			const target = state.ask;
			if (!target) { failNotice("바로잡을 진행 중인 설명이 없어요."); return; }
			const message = text;
			const key = draftKey();
			clearDraft(key);
			state.purpose = "ask";
			inform("");
			try {
				await api.steer(target.profileId, target.requestId, message);
				if (!target.steers.includes(message)) target.steers.push(message);
				inform("바로잡기를 보냈어요.");
			} catch (error) {
				state.drafts.set(key, { text: message, cursor: graphemes(message).length, preferredColumn: null });
				failNotice(`바로잡기를 보내지 못했어요: ${error.message}`);
			}
			return;
		}
		if (!state.session) { inform("먼저 세션을 고르세요. @ 를 입력하면 세션 목록이 나와요."); return; }
		if (state.ask) {
			inform(`${state.ask.sessionId === state.session.id ? "설명이" : "다른 세션의 설명이"} 진행 중이에요. ${state.ask.disconnected ? "Ctrl+R 키로 같은 요청에 다시 연결하세요." : "Ctrl+S 로 바로잡거나 Ctrl+C 로 중단하세요."}`);
			return;
		}
		const session = state.session;
		const profile = state.profile;
		const focus = state.focus ? { label: state.focus.label, text: state.focus.text } : null;
		const requestId = randomUUID();
		const ask = {
			requestId, sessionId: session.id, profileId: selectedProfileId(profile), question: text,
			focus, text: "", stage: "요청을 보내는 중이에요", steers: [], cancelling: false, startedAt: Date.now(),
		};
		state.ask = ask;
		inform("");
		clearDraft();
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = false;
		state.followBottom = true;
		const body = { id: session.id, profileId: ask.profileId, question: text, requestId };
		if (focus) body.focus = focus;
		body.cards = state.cards.slice(-40).filter((card) => /^[a-f0-9]{16}$/.test(card.thread)).map((card) => ({ thread: card.thread, label: String(card.displayTitle || card.focus.label).slice(0, 200) }));
		void consumeAsk(ask, body);
	}

	function restoreCancelledQuestion(ask) {
		if (state.ask !== ask) return;
		state.ask = null;
		if (state.purpose === "steer") state.purpose = "ask";
		if (state.session?.id === ask.sessionId && selectedProfileId(state.profile) === ask.profileId) {
			state.focus = ask.focus;
			state.thread = focusThread(ask.focus);
			state.picker = null;
			state.selectedAnswer = null;
			state.bodyScroll = 0;
			state.followSelection = false;
			state.followBottom = true;
			// The cancelled question returns to the composer only when its context draft is
			// empty; a newer draft typed while the ask ran stays untouched.
			const key = draftKey();
			const existing = state.drafts.get(key);
			if (existing?.text?.trim()) {
				inform(`설명을 중단했어요. 새로 쓴 질문은 그대로 두었어요. 보낸 질문: ${clipLine(ask.question, Math.max(16, width() - 40))}`);
			} else {
				state.drafts.set(key, { text: ask.question, cursor: graphemes(ask.question).length, preferredColumn: null });
				inform("설명을 중단했어요. 보낸 질문을 입력창에 돌려놨어요.");
			}
		} else inform("다른 세션의 설명을 중단했어요.");
	}

	async function consumeAsk(ask, body) {
		if (ask.disconnected) ask.text = "";
		ask.disconnected = false;
		ask.body = body;
		state.followSelection = false;
		state.followBottom = true;
		state.bodyScroll = Number.MAX_SAFE_INTEGER;
		const controller = new AbortController();
		askController = controller;
		scheduleRender();
		try {
			const outcome = await api.ask(body, controller.signal, (event) => {
				if (state.ask !== ask) return;
				if (event.type === "queued" || event.type === "stage") ask.stage = requestStatus(event);
				else if (event.type === "delta") ask.text += String(event.text ?? "");
				else if (event.type === "reset") ask.text = "";
				else if (event.type === "steer" && typeof event.message === "string" && !ask.steers.includes(event.message)) ask.steers.push(event.message);
				else if (event.type === "error") ask.error = terminalSafeText(event.error || "설명 요청에 실패했어요.");
				scheduleRender();
			});
			if (outcome.type === "answer") {
				inform("설명이 끝났어요. 저장된 대화를 불러오는 중이에요.");
				if (state.session?.id === ask.sessionId && selectedProfileId(state.profile) === ask.profileId) await reloadHistory();
				succeed("설명이 끝났어요.");
			} else if (outcome.type === "cancelled") restoreCancelledQuestion(ask);
			else failNotice(`설명을 만들지 못했어요: ${outcome.error || "서버 오류"}`);
		} catch (error) {
			if (!controller.signal.aborted) {
				ask.disconnected = !error.status;
				if (ask.disconnected) ask.stage = "연결 끊김";
				failNotice(`설명 요청에 실패했어요: ${error.message}${ask.disconnected ? " 서버의 요청은 계속될 수 있어요. Ctrl+R 키로 같은 요청에 다시 연결하세요." : ""}`);
			}
		} finally {
			if (state.ask === ask && !ask.disconnected) state.ask = null;
			if (askController === controller) askController = null;
			if (!state.ask && state.purpose === "steer") state.purpose = "ask";
			scheduleRender();
		}
	}

	async function cancelActiveAsk() {
		const ask = state.ask;
		if (!ask || ask.cancelling) {
			if (!ask) inform("진행 중인 설명이 없어요.");
			return;
		}
		ask.cancelling = true;
		inform("설명을 멈추는 중이에요.");
		try {
			const result = await api.cancel(ask.profileId, ask.requestId);
			if (!result?.cancelled) {
				ask.cancelling = false;
				failNotice("서버에서 진행 중인 요청을 찾지 못했어요. Ctrl+R 키로 결과를 확인하세요.");
			} else if (ask.disconnected) restoreCancelledQuestion(ask);
		} catch (error) {
			ask.cancelling = false;
			failNotice(`중단 요청을 보내지 못했어요: ${error.message}`);
		}
	}

	function rejoinOrRefresh() {
		if (state.ask) {
			if (!state.ask.body) { failNotice("다시 연결할 요청 정보가 없어요."); return; }
			if (!state.ask.disconnected) { inform("설명에 연결되어 있어요. 새 요청을 만들지 않았어요."); return; }
			void consumeAsk(state.ask, state.ask.body);
			return;
		}
		if (state.picker === "sessions" || !state.session) { void refreshSessions(); return; }
		void reloadHistory();
		inform("대화 기록을 새로 불러오는 중이에요.");
	}

	function scroll(delta, followBottom = false) {
		state.followSelection = false;
		state.followBottom = followBottom;
		state.bodyScroll += delta;
		scheduleRender();
	}

	const term = String(process.env.TERM ?? "");
	const titleSupported = Boolean(term) && term !== "dumb";
	let terminalRestored = false;
	function restoreTerminal() {
		if (terminalRestored) return;
		terminalRestored = true;
		try { stdin.setRawMode(originalRaw); } catch {}
		try { stdin.pause(); } catch {}
		try {
			stdout.write(`${ESC}0m${ESC}?2004l${ESC}?25h${ESC}?1049l${titleSupported ? `${ESC}23;0t` : ""}`);
		} catch {}
	}

	/** Herdr agents 창: 직접 물은 설명만 작업 중으로 알린다. 미리 설명은 서버 쪽 일이라 알리지 않는다 (ADR 0043). */
	function syncHerdr() {
		const ask = state.ask;
		if (!ask) herdr.update("idle");
		else if (ask.disconnected) herdr.update("blocked", "설명 연결이 끊겼어요. Ctrl+R로 다시 연결하세요.");
		else herdr.update("working", ask.cancelling ? "설명을 멈추는 중이에요" : ask.stage || "설명을 준비하는 중이에요");
	}

	function exit() {
		if (!state.running) return;
		state.running = false;
		clearTimeout(renderTimer);
		clearInterval(spinnerTimer);
		streamController?.abort();
		askController?.abort();
		input.close();
		stdin.off("data", onData);
		stdin.off("end", onEnd);
		stdout.off("resize", resizeHandler);
		process.off("SIGWINCH", resizeHandler);
		process.off("SIGTERM", onSignal);
		process.off("SIGHUP", onSignal);
		restoreTerminal();
		resolveFinished();
	}

	function key(event) {
		if (!state.running) return;
		if (event.type === "paste") {
			if (event.tooLarge) { failNotice(`붙여넣은 내용이 너무 커요. ${draftLimit()}자 이내로 나눠서 붙여넣으세요.`); return; }
			insertText(event.text, true);
			return;
		}
		if (event.type === "text") { insertText(event.text); return; }

		switch (event.key) {
			case "ctrl-p": togglePicker("sessions"); return;
			case "ctrl-t": togglePicker("conversations"); return;
			case "ctrl-o": togglePicker("answers"); return;
			case "ctrl-g": togglePicker("profiles"); return;
			case "ctrl-r": rejoinOrRefresh(); return;
			case "ctrl-s": toggleSteer(); return;
			case "interrupt": void cancelActiveAsk(); return;
			case "eof": exit(); return;
			case "escape": {
				const completion = activeCompletion();
				if (completion) { state.completion.dismissed = currentDraft().text; scheduleRender(); }
				else if (state.picker) closePicker();
				else { state.notice = ""; scheduleRender(); }
				return;
			}
		}

		if (state.picker) {
			if (event.key === "up") { movePicker(-1); return; }
			if (event.key === "down") { movePicker(1); return; }
			if (event.key === "home") { focusPicker(0); return; }
			if (event.key === "end") { focusPicker(pickerCount() - 1); return; }
			if (event.key === "enter" || event.key === "tab") { choosePicker(); return; }
			if (event.key === "left") { scroll(-1); return; }
			if (event.key === "right") { scroll(1); return; }
		} else {
			const draft = currentDraft();
			const completion = activeCompletion();
			if (completion) {
				if (event.key === "up") { moveCompletion(completion, -1); return; }
				if (event.key === "down") { moveCompletion(completion, 1); return; }
				if (event.key === "enter" || event.key === "tab") { acceptCompletion(completion); return; }
			}
			if (event.key === "enter") { void submitComposer(); return; }
			if (event.key === "newline") { insertText("\n"); return; }
			if (event.key === "tab") { insertText("\t"); return; }
			if (event.key === "left") { draft.cursor = Math.max(0, draft.cursor - 1); draft.preferredColumn = null; scheduleRender(); return; }
			if (event.key === "right") { draft.cursor = Math.min(graphemes(draft.text).length, draft.cursor + 1); draft.preferredColumn = null; scheduleRender(); return; }
			if (event.key === "home" || event.key === "end") { moveToLineEdge(event.key); return; }
			if (event.key === "up" || event.key === "down") {
				const moved = moveVertical(draft.text, draft.cursor, event.key === "up" ? -1 : 1, draft.preferredColumn);
				draft.cursor = moved.cursor;
				draft.preferredColumn = moved.preferredColumn;
				scheduleRender();
				return;
			}
			if (event.key === "backspace") {
				const parts = graphemes(draft.text);
				if (draft.cursor > 0) {
					parts.splice(draft.cursor - 1, 1);
					draft.cursor--;
					draft.text = parts.join("");
					draft.preferredColumn = null;
					scheduleRender();
				}
				return;
			}
			if (event.key === "delete") {
				const parts = graphemes(draft.text);
				if (draft.cursor < parts.length) {
					parts.splice(draft.cursor, 1);
					draft.text = parts.join("");
					draft.preferredColumn = null;
					scheduleRender();
				}
				return;
			}
			if (event.key === "clear") { draft.text = ""; draft.cursor = 0; draft.preferredColumn = null; scheduleRender(); return; }
			if (event.key === "delete-word") { eraseWord(); return; }
		}

		if (event.key === "pageup") { scroll(-Math.max(1, height() - 8)); return; }
		if (event.key === "pagedown") { scroll(Math.max(1, height() - 8), true); return; }
	}

	const input = new TerminalInput(key);
	const originalRaw = Boolean(stdin.isRaw);
	const onSignal = () => exit();
	const onEnd = () => exit();
	const onData = (data) => input.feed(data);
	const resizeHandler = () => scheduleRender();
	try {
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdout.on("resize", resizeHandler);
		process.on("SIGWINCH", resizeHandler);
		process.once("SIGTERM", onSignal);
		process.once("SIGHUP", onSignal);
		stdout.write(`${titleSupported ? `\u001b[22;0t\u001b]2;${TITLE}\u0007` : ""}${ESC}?1049h${ESC}?25l${ESC}?2004h`);
		loadModels();
		if (initialSession) {
			// docent herdr / OMP /docent: 지정한 세션을 바로 연다. 최근 200개 밖이어도 id 로 열 수 있다.
			const listed = state.sessions.find((entry) => entry.id === initialSession);
			void switchSession(listed ?? { id: initialSession, provider: initialSession.split(":")[0], title: "지정한 세션" });
		}
		render();
		await finished;
	} finally {
		input.close();
		restoreTerminal();
		await herdr.release();
	}
}
