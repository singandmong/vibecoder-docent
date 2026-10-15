import { cardDisplay, conversationList, excerpt, summarySentences, threadRows } from "./conversations.mjs";
import { createSessionClient } from "./session-client.mjs";
import { HttpTransport } from "./transport.mjs";
import { TerminalInput, editLine, graphemes, layoutDraft, terminalSafeText, wrapTerminalText } from "./terminal-input.mjs";
import { createTerminalTheme } from "./terminal-theme.mjs";
import { createTerminalMarkdown } from "./terminal-markdown.mjs";
import { renderStatusRow, statusMetrics, statusSegments, statusSymbols } from "./terminal-status.mjs";
import { createHerdrReporter } from "./terminal-herdr.mjs";
import { filterItems, renderSelector, withCaret } from "./terminal-select.mjs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ESC = "\u001b[";
const TITLE = "바이브코더 도슨트";
const CATEGORY = { question: "질문", result: "작업 결과", plan: "계획" };
const profileName = (profile) => profile?.name || profile?.id || "기본 프로필";
const selectedProfileId = (profile) => profile?.id || "default";
/** 작업 폴더 이름. 워크트리처럼 저장소 이름과 다르면 "저장소/폴더" 로 보여 준다. */
const placeOf = (session) => (session.repo && session.project && session.repo !== session.project ? `${session.repo}/${session.project}` : session.project || session.repo || "");
/** 세션 카드 아이콘. DOCENT_SYMBOLS=ascii 또는 TERM=dumb 에서는 ASCII (ADR 0045). */
const SESSION_ICONS = Object.freeze({
	unicode: Object.freeze({ repo: "📦", folder: "📁", branch: "🌿", worktree: "🌳", recent: "🕘", current: "✓", workspace: "🔖" }),
	ascii: Object.freeze({ repo: "[R]", folder: "[D]", branch: "br:", worktree: "wt:", recent: ">", current: "*", workspace: "ws:" }),
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

/** 설명 작업의 단계(session-client)를 진행 줄 문구로. */
function stageText(job) {
	if (job.stage === "queued") return "다른 설명이 끝나기를 기다리는 중이에요";
	if (job.stage === "planning") return "질문을 살펴보는 중이에요";
	if (job.stage === "explaining") return "설명을 쓰는 중이에요";
	return job.stage ? "설명을 준비하는 중이에요" : "요청을 보내는 중이에요";
}

/** 서버 오류는 HTTP 상태를 붙여 보여 준다. 연결 실패에는 상태가 없다. */
const reason = (error) => `${error?.message || String(error)}${error?.status ? ` (HTTP ${error.status})` : ""}`;

/** Runs a full-screen, dependency-free TTY client. Server lifetime remains independent of this process. */
export async function runTerminal({ baseUrl, stdin = process.stdin, stdout = process.stdout, env = process.env, initialSession = null } = {}) {
	if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
		throw new Error("대화형 터미널에서 실행해야 해요. 일반 터미널에서 docent-tui 를 실행하세요.");
	}
	const theme = createTerminalTheme();
	const markdown = createTerminalMarkdown(theme);
	const symbols = statusSymbols();
	const api = new HttpTransport(baseUrl);
	const herdr = createHerdrReporter({ env, baseUrl });
	let profiles, sessions;
	try {
		[profiles, sessions] = await Promise.all([api.profiles(), api.sessions()]);
	} catch (error) {
		const detail = terminalSafeText(reason(error));
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
		picker: null, // {kind, query:{text,cursor}, index, start, page, touched, auto} 선택창이 열려 있을 때
		selectedAnswer: null, settling: null,
		bodyScroll: 0, followSelection: true, followBottom: false,
		notice: "", noticeError: false, noticeKind: "info", liveNotice: "",
		completion: { key: "", index: 0, dismissed: null }, models: null, favorites: null,
		sessionModel: null, // 이 세션의 모델 {raw, model}. 모델을 고르지 않았을 때(기본) 설명에 쓰인다 (ADR 0069)
		scopeDraft: new Set(), // 모델 범위 선택창에서 고르는 중인 모델
	};
	let renderTimer = null;
	const FRAME_MS = 16;
	let lastRenderAt = 0;
	let painted = { size: "", rows: [], cursor: "" }; // 마지막으로 화면에 쓴 줄과 커서. 바뀐 것만 다시 쓰는 기준
	// OMP 의 showHardwareCursor 처럼 진짜 터미널 커서를 입력 위치에 두고 보인다. 한글 조합 글자와 후보 창이 그 자리에 붙는다 (ADR 0068).
	const hardwareCursor = !["0", "false", "off"].includes(String(env?.DOCENT_HARDWARE_CURSOR ?? "").toLowerCase());
	let historyGeneration = 0;
	let sessionGeneration = 0;
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
	// 같은 글을 같은 너비로 다시 그리는 일이 많다(입력할 때마다, 설명 중 스피너마다). 결과를 너비별로 기억한다.
	const markdownCache = new Map();
	const MARKDOWN_CACHE_MAX = 400;
	const markdownLines = (text, columns = width()) => {
		const key = `${columns}\u0000${text}`;
		let lines = markdownCache.get(key);
		if (lines) markdownCache.delete(key);
		else lines = markdown.render(text, columns);
		markdownCache.set(key, lines);
		if (markdownCache.size > MARKDOWN_CACHE_MAX) markdownCache.delete(markdownCache.keys().next().value);
		return lines;
	};
	const addMarkdown = (items, text, role = "text") => {
		for (const line of markdownLines(text)) items.push({ text: line, role, rich: true });
	};

	function displayedHistory() {
		return threadRows(state.history, state.thread);
	}

	function isAnswerSelected(row) {
		return Boolean(state.selectedAnswer && row.ts === state.selectedAnswer.ts && (row.question ?? "") === state.selectedAnswer.question);
	}

	// --- Drafts: keyed per profile/session/thread/purpose so context switches never leak text. ---
	const placeKey = (place, purpose) => `${place.profileId}|${place.sessionId}|${place.thread}|${purpose}`;
	function draftKey(purpose = state.purpose) {
		return placeKey({ profileId: selectedProfileId(state.profile), sessionId: state.session?.id ?? "", thread: state.thread }, purpose);
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

	// --- Session client: ask jobs, 대기 질문, stop/steer, rejoin and live events (session-client.mjs, ADR 0055). ---
	// 중단한 질문과 보내지 못한 대기 질문은 그 질문의 스레드 입력창이 비어 있을 때만 돌아간다.
	const client = createSessionClient({
		transport: api,
		drafts: {
			read: (place) => state.drafts.get(placeKey(place, "ask"))?.text ?? "",
			write: (place, text) => state.drafts.set(placeKey(place, "ask"), { text, cursor: graphemes(text).length, preferredColumn: null }),
		},
		cards: () => state.cards.map((card) => ({ thread: card.thread, label: cardTitleOf(card) })),
		onChange: (change) => { if (state.running) applyChange(change); },
	});

	// --- 대화 고르기: 세션 전체 대화, 사건 카드(웹처럼 새것이 위), 카드가 목록에 없는 저장 대화 (conversations.mjs). ---
	function answerOf(thread) { return threadRows(state.history, thread).at(-1)?.answer ?? null; }
	/** 카드 제목은 웹처럼 답이 있으면 답에서, 없으면 질문 대상 제목이다. */
	function cardTitleOf(card) { return cardDisplay(answerOf(card.thread), card.focus.label).title; }
	function conversationOptions() {
		const list = conversationList(state.history, state.cards);
		return [...list.filter((o) => o.kind === "all"), ...list.filter((o) => o.kind === "card").reverse(), ...list.filter((o) => o.kind === "saved")];
	}
	const answerText = (answer) => (answer && typeof answer === "object" ? [answer.headline, answer.explain, ...(answer.details ?? [])].filter(Boolean).join("\n\n") : "");

	/** 세션 카드: 어디(저장소, 브랜치, 워크트리)와 언제, 제목, 최근 작업 한 줄 (ADR 0045). */
	const sessionCard = (session, selected, current) => {
		const icons = SESSION_ICONS[symbols] ?? SESSION_ICONS.unicode;
		const columns = width();
		const place = [
			session.repo
				? theme.span("title", `${icons.repo} ${clipLine(session.repo, 28)}`)
				: theme.span("path", `${icons.folder} ${clipLine(session.project || "작업 폴더 없음", 28)}`),
			session.herdr && theme.span("label", `${icons.workspace} ${clipLine(session.herdr.label || `작업 공간 ${session.herdr.number}`, 24)}`),
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

	// --- 선택창 항목 (ADR 0068): 세션, 대화, 저장된 답변, 프로필, 설정이 같은 모양(검색창 + 목록 + 미리 보기)이다. ---
	/** 왼쪽 글을 줄임표로 자르고 흐린 정보를 오른쪽 끝에 붙여 한 줄로 만든다. */
	function withMeta(head, meta) {
		const columns = width();
		if (!meta) return truncateToWidth(head, columns, "…");
		const metaWidth = visibleWidth(meta);
		const left = truncateToWidth(head, Math.max(10, columns - metaWidth - 3), "…");
		const gap = columns - visibleWidth(left) - metaWidth - 1;
		return gap >= 1 ? `${left}${" ".repeat(gap)}${meta}` : left;
	}
	/** 줄이 많으면 앞쪽만 남기고 마지막 줄에 이어 읽는 방법을 적는다. */
	function clipLines(lines, max, more) {
		if (lines.length <= max) return lines;
		return [...lines.slice(0, Math.max(0, max - 1)), theme.span("dim", ` … ${more}`)];
	}
	const MARKS = symbols === "ascii"
		? { busy: "*", wait: "~", done: "+", star: "*" }
		: { busy: "●", wait: "◌", done: "✓", star: "★" };

	function sessionPreview(session, columns, max) {
		const lines = [];
		const field = (name, value) => { if (value) lines.push(`${theme.span("dim", ` ${name}  `)}${theme.span("muted", clipLine(value, columns - 16))}`); };
		field("폴더", session.cwd);
		field("기록", `${dateLabel(session.started)} 시작 • ${dateLabel(session.updated)} 마지막`);
		field("SSH", session.ssh);
		field("처음 요청", session.first);
		field("최근 작업", session.recent);
		return lines.slice(0, max);
	}

	function sessionItems() {
		return state.sessions.map((session) => {
			const current = session.id === state.session?.id;
			return {
				label: session.title || "제목 없음",
				search: [session.repo, session.project, session.worktree, session.branch, session.provider, session.host, session.herdr?.label, session.recent, session.cwd, session.first].filter(Boolean).join(" "),
				current,
				session,
				rows: (selected) => [...sessionCard(session, selected, current), ""],
				previewHeight: 5,
				preview: (columns, max) => sessionPreview(session, columns, max),
				run: () => void switchSession(session),
			};
		});
	}

	function conversationPreview(option, display, badge, columns, max) {
		const rows = threadRows(state.history, option.thread);
		const head = [`${theme.span("label", ` ${badge}`)} ${theme.span("title", clipLine(display.title, columns - 10))}`];
		const foot = [];
		if (rows.length) {
			const last = rows.at(-1);
			foot.push(theme.span("muted", ` 저장된 문답 ${rows.length}개 • 마지막 질문  ${clipLine(last.display || last.question || "", Math.max(10, columns - 30))}`));
			const headline = last.answer && typeof last.answer === "object" ? last.answer.headline : "";
			if (headline) foot.push(theme.span("muted", ` ${clipLine(headline, columns - 4)}`));
		} else foot.push(theme.span("dim", " 이 대화에는 아직 저장된 문답이 없어요. Enter 로 열어서 질문하세요."));
		let body;
		if (option.focus?.text) body = markdownLines(option.focus.text, columns);
		else if (option.kind === "all") body = rows.slice(-4).map((row) => theme.span("text", ` • ${clipLine(row.display || row.question || "", columns - 5)}`));
		else body = [];
		const room = Math.max(1, max - head.length - foot.length);
		return [...head, ...clipLines(body, room, "Enter 로 전체 읽기"), ...foot];
	}

	function conversationItems() {
		const newest = [...state.cards].reverse().find((card) => !card.past)?.thread;
		const favorites = new Set((state.favorites ?? []).map((entry) => entry.thread));
		const sep = theme.span("dim", " • ");
		return conversationOptions().map((option) => {
			const card = option.card;
			const display = card ? cardDisplay(option.answer, option.label) : { title: option.label, summary: "" };
			const badge = option.kind === "all" ? "전체" : card ? CATEGORY[card.sub] || "작업 내용" : "저장";
			const auto = card?.ask ? client.autoJob(card.ask.requestId) : null;
			const status = client.active?.thread === option.thread ? { role: "warning", text: `${MARKS.busy} 설명 중` }
				: auto && !auto.outcome ? { role: "warning", text: `${MARKS.wait} ${auto.stage === "queued" ? "설명 대기" : "미리 설명 중"}` }
					: option.count ? { role: "success", text: `${MARKS.done} 문답 ${option.count}` }
						: card?.autoState === "limited" ? { role: "warning", text: "자동 설명 한도" } : null;
			const when = card ? card.ts || card.at : option.lastTs;
			const meta = [
				favorites.has(option.thread) && theme.span("label", MARKS.star),
				card && card.thread === newest && theme.span("success", "NEW"),
				status && theme.span(status.role, status.text),
				when && theme.span("dim", agoLabel(when)),
			].filter(Boolean).join(sep);
			// 답이 없는 카드는 AI 가 한 말의 앞부분(제목 줄은 빼고)이나 선택지로 고르는 데 도움을 준다.
			const choices = Array.isArray(card?.options) ? card.options.map((entry) => entry?.label).filter(Boolean) : [];
			const preface = card ? summarySentences(String(option.focus.text).split("\n").slice(1).join("\n"), 2) : "";
			const summary = option.kind === "all" ? "카드에 묶이지 않은 질문과 세션 전체에 대한 설명을 이어 가요"
				: card ? display.summary || (choices.length ? `선택지: ${choices.join(" / ")}` : preface) || "Enter 로 열어서 원문을 읽어요"
					: `저장된 문답 ${option.count}개`;
			const current = option.thread === state.thread;
			return {
				label: display.title,
				search: `${badge} ${summary}`,
				current,
				option,
				rows: (selected) => [
					withMeta(`${selected ? theme.span("title", " → ") : current ? theme.span("success", ` ${MARKS.done} `) : "   "}${theme.span("label", `[${badge}]`)} ${theme.span(selected ? "title" : "text", clipLine(display.title, 200))}`, meta),
					`     ${theme.span("muted", clipLine(summary, width() - 6))}`,
					"",
				],
				preview: (columns, max) => conversationPreview(option, display, badge, columns, max),
				run: () => switchThread(option),
			};
		});
	}

	function answerItems() {
		return displayedHistory().map((row) => {
			const answer = row.answer && typeof row.answer === "object" ? row.answer : null;
			return {
				label: row.display || row.question || "질문 내용을 찾을 수 없어요.",
				description: `${dateLabel(row.ts)}${row.auto ? " • 미리 설명" : ""} • ${answer ? answer.headline || "답변 본문 없음" : "저장된 답변 없음"}`,
				search: answerText(answer),
				current: isAnswerSelected(row),
				row,
				preview: (columns, max) => {
					const body = answerText(answer) ? markdownLines(answerText(answer), columns) : [theme.span("muted", " 저장된 답변이 없어요.")];
					return clipLines(body, max, "Enter 로 이 답변 위치로 가기");
				},
				run: () => openSelectedAnswer(row),
			};
		});
	}

	function profileItems() {
		return state.profiles.map((profile) => ({
			label: `${profileName(profile)}${profile.id === "default" ? " (기본)" : ""}`,
			description: `${profile.defaultDifficulty || "NORMAL"} • ${profile.model || "기본 모델"}`,
			current: profile.id === state.profile.id,
			run: () => void chooseProfile(profile),
		}));
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
		const text = answerText(row.answer);
		if (text) addMarkdown(items, text);
		else add(items, " 아직 저장된 답변이 없어요.", { role: "muted" });
	}

	function addAskBlock(items, ask) {
		divider(items);
		addUserMessage(items, ask.display || ask.question, ask.steers);
		divider(items);
		if (ask.text) addMarkdown(items, ask.text);
	}

	/** 대기 질문: 지금 설명이 끝나면 순서대로 보낸다. /대기 로 마지막 질문을 입력창에 되돌린다. */
	function addQueue(items) {
		const queue = client.queue;
		if (!queue.length) return;
		divider(items);
		queue.forEach((job, index) => items.push({ text: theme.span("muted", ` 대기 질문 ${index + 1}  ${clipLine(job.question, width() - 14)}`), role: "text", rich: true }));
		items.push({ text: theme.span("dim", " 지금 설명이 끝나면 차례대로 보내요. /대기 로 마지막 질문을 입력창에 돌려놔요."), role: "text", rich: true });
	}

	/** 열려 있는 대화의 제목 줄: 어느 대화인지, 즐겨찾기인지, 목록으로 돌아가는 키. */
	function threadHeading() {
		const option = conversationOptions().find((entry) => entry.thread === state.thread);
		const card = option?.card;
		const badge = !state.thread ? "전체" : card ? CATEGORY[card.sub] || "작업 내용" : "저장";
		const title = !state.thread ? "세션 전체 대화" : card ? cardDisplay(option.answer, option.label).title : state.focus?.label || option?.label || "선택한 대화";
		const star = (state.favorites ?? []).some((entry) => entry.thread === state.thread) ? ` ${theme.span("label", MARKS.star)}` : "";
		const hint = width() >= 70 ? "  Esc 대화 목록 • Ctrl+F 즐겨찾기" : "  Esc 목록";
		return `${theme.span("label", ` [${badge}]`)} ${theme.span("title", clipLine(title, Math.max(10, width() - 40)))}${star}${theme.span("dim", hint)}`;
	}

	function conversationBody() {
		const items = [];
		if (!state.session) {
			divider(items);
			add(items, " 먼저 세션을 고르세요.", { role: "title" });
			add(items, " Enter 를 누르거나 @ 를 입력하면 세션 목록이 열려요.", { role: "muted" });
			return items;
		}
		const rows = displayedHistory();
		items.push({ text: threadHeading(), role: "text", rich: true });
		if (state.focus?.text) {
			items.push({ text: "", role: "custom" });
			items.push({ text: theme.span("label", " AI 출력"), role: "custom", rich: true });
			addMarkdown(items, state.focus.text, "custom");
			items.push({ text: "", role: "custom" });
			divider(items);
		}
		const asks = [state.settling, client.active].filter(Boolean);
		if (!rows.length && !asks.length) {
			add(items, " 이 작업에서 무엇이 궁금한가요?", { role: "title" });
			add(items, " 아래에 질문을 쓰세요. Esc 로 다른 대화를 고르고, / 를 입력하면 모든 명령을 볼 수 있어요.", { role: "muted" });
		}
		for (const row of rows) addRecord(items, row, isAnswerSelected(row));
		for (const ask of asks) addAskBlock(items, ask);
		addQueue(items);
		return items;
	}

	// --- Composer: Pi editor shape. Full-width rules, padded prompt rows, no frame, corners, or labels. ---
	// 커서 칸은 반전 칸으로 그리고, 진짜 터미널 커서도 같은 자리에 둔다(render). rows 안의 caret 은 입력 줄 기준 위치.
	function composerFrame() {
		const isSteer = state.purpose === "steer";
		const draft = currentDraft();
		const contentWidth = Math.max(1, width() - 2);
		const placeholder = isSteer ? "바로잡을 내용을 입력하세요"
			: width() >= 70 ? "궁금한 내용을 입력하세요.  / 명령   @ 세션   # 대화   $ 설정" : "궁금한 내용을 입력하세요";
		const { lines, caret } = layoutDraft(draft.text, draft.cursor, contentWidth);
		const maxLines = Math.max(1, Math.min(8, height() - 8));
		const start = Math.max(0, Math.min(caret.line - maxLines + 1, lines.length - maxLines));
		const borderRole = isSteer ? "warning" : "borderAccent";
		const hidden = start > 0 ? ` ↑ ${start}줄 더 ` : "";
		const top = hidden
			? `${"─".repeat(Math.max(0, Math.floor((width() - visibleWidth(hidden)) / 2)))}${hidden}${"─".repeat(Math.max(0, width() - Math.floor((width() - visibleWidth(hidden)) / 2) - visibleWidth(hidden)))}`
			: "─".repeat(width());
		const rows = [{ text: top, role: borderRole }];
		if (!draft.text) rows.push({ text: ` ${withCaret(theme, [], 0)}${theme.span("dim", terminalSafeText(placeholder))}`, role: "composer", rich: true });
		else {
			for (let i = start; i < Math.min(lines.length, start + maxLines); i++) {
				const parts = lines[i].map((part) => terminalSafeText(part));
				rows.push({ text: ` ${i === caret.line ? withCaret(theme, parts, caret.index) : parts.join("")}`, role: "composer", rich: true });
			}
		}
		rows.push({ text: "─".repeat(width()), role: borderRole });
		return { rows, caret: draft.text ? { row: 1 + caret.line - start, col: 1 + caret.col } : { row: 1, col: 1 } };
	}

	const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let spinnerFrame = 0, spinnerTimer = null;
	function syncSpinner() {
		const ask = client.active;
		const active = Boolean(ask && !ask.disconnected && !ask.cancelling);
		if (active && !spinnerTimer) spinnerTimer = setInterval(() => { spinnerFrame = (spinnerFrame + 1) % SPINNER.length; scheduleRender(); }, 100);
		else if (!active && spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
	}

	/** Pi shows working state and messages just above the editor; nothing is shown when idle. */
	function activityLine() {
		const ask = client.active;
		if (ask?.disconnected) return theme.span("warning", " 연결이 끊겼어요. Ctrl+R로 같은 요청에 다시 연결해요.");
		if (ask?.cancelling) return theme.span("warning", " 설명을 멈추는 중이에요");
		if (ask) return `${theme.span("title", ` ${SPINNER[spinnerFrame]} `)}${theme.span("muted", stageText(ask))}${theme.span("dim", " (/중단 stop, /바로잡기 steer)")}`;
		if (state.notice) return theme.span(state.noticeKind === "error" ? "error" : state.noticeKind === "success" ? "success" : "muted", ` ${state.notice}`);
		if (state.liveNotice) return theme.span("warning", ` ${state.liveNotice}`);
		return "";
	}

	function headerLines() {
		const keys = width() >= 100
			? [["/", "명령"], ["@", "세션"], ["#", "대화"], ["$", "설정"], ["Esc", "대화 목록"], ["Enter", "보내기"], ["Ctrl+J", "줄바꿈"], ["Ctrl+C", "중단"]]
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
			ask: client.active,
			spinnerFrame,
			session: state.session ? { ...state.session, title: clipLine(state.session.title || state.session.id, third), project: clipLine(placeOf(state.session) || state.session.provider || "", Math.floor(third * 0.75)) } : null,
			conversation: clipLine(state.thread ? state.focus?.label || "선택한 대화" : "세션 전체 대화", third),
			scroll,
			modelName: clipLine(selector ? model?.name || selector : state.sessionModel?.model?.name ?? (state.session && state.sessionModel ? "omp 기본 모델" : "세션 모델"), 28),
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
		const picker = state.picker;
		const composer = picker ? null : composerFrame();
		const activity = activityLine();
		const completion = picker ? [] : completionRows(activeCompletion());
		const header = rows >= 14 ? headerLines() : headerLines().slice(0, 1);
		const showFooter = !(completion.length && rows < 20);
		const composerRows = composer?.rows ?? [];
		const bodyHeight = Math.max(1, rows - header.length - (activity ? 1 : 0) - composerRows.length - completion.length - (showFooter ? 2 : 0));
		const fill = (text) => {
			const fitted = truncateToWidth(text, columns);
			return fitted + " ".repeat(Math.max(0, columns - visibleWidth(fitted)));
		};
		const paintRow = (item) => item.rich
			? theme.line(item.role, fill(item.text))
			: theme.paint(item.role, fill(terminalSafeText(item.text)));
		let visible, scroll = "", caret;
		if (picker) {
			// 선택창은 입력창 자리까지 쓰고, 진짜 커서는 검색창 안에 둔다.
			const view = selectorView(bodyHeight);
			visible = view.rows;
			caret = { row: header.length + view.caret.row, col: view.caret.col };
		} else {
			const body = conversationBody();
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
			visible = body.slice(state.bodyScroll, state.bodyScroll + bodyHeight);
			scroll = body.length > bodyHeight ? `${Math.round(((state.bodyScroll + bodyHeight) / body.length) * 100)}%` : "";
			caret = { row: header.length + bodyHeight + (activity ? 1 : 0) + composer.caret.row, col: composer.caret.col };
		}
		while (visible.length < bodyHeight) visible.push({ text: "", role: "text" });
		const output = [
			...header.map((line) => theme.line("text", truncateToWidth(line, columns))),
			...visible.map(paintRow),
			...(activity ? [theme.line("text", truncateToWidth(activity, columns))] : []),
			...composerRows.map(paintRow),
			...completion.map(paintRow),
			...(showFooter ? footerLines(scroll).map((line) => theme.line("text", truncateToWidth(line, columns))) : []),
		];
		// 진짜 커서는 프레임을 쓰는 동안 숨기고 마지막에 입력 위치로 옮겨 보인다. 그래야 한글 조합 글자가 그 자리에 붙고 깜빡이지 않는다.
		const cursor = `${ESC}${Math.min(caret.row, rows - 1) + 1};${Math.min(caret.col, columns - 1) + 1}H${ESC}?25${hardwareCursor ? "h" : "l"}`;
		// 바뀐 줄만 다시 쓴다. 화면 크기나 줄 수가 바뀌면 전체를 다시 그린다.
		const size = `${columns}x${rows}`;
		if (painted.size !== size || painted.rows.length !== output.length) {
			stdout.write(`${ESC}?2026h${ESC}?25l${ESC}2J${ESC}H${output.join("\r\n")}${cursor}${ESC}?2026l`);
		} else {
			let patch = "";
			for (let i = 0; i < output.length; i++) {
				if (output[i] !== painted.rows[i]) patch += `${ESC}${i + 1};1H${ESC}0m${ESC}2K${output[i]}`;
			}
			if (patch || cursor !== painted.cursor) stdout.write(`${ESC}?2026h${ESC}?25l${patch}${cursor}${ESC}?2026l`);
		}
		painted = { size, rows: output, cursor };
	}

	/** 입력 직후 바로 그리고, 설명 스트림이나 스피너처럼 잦은 갱신은 한 프레임(16ms)에 한 번으로 묶는다. */
	function scheduleRender() {
		if (renderTimer || !state.running) return;
		const wait = Math.max(0, lastRenderAt + FRAME_MS - performance.now());
		renderTimer = setTimeout(() => { renderTimer = null; lastRenderAt = performance.now(); render(); }, wait);
	}

	// --- 선택창 (ADR 0068): 열기, 거르기, 고르기, 닫기. 고르거나 닫아도 입력창 초안은 건드리지 않는다. ---
	const PICKERS = {
		sessions: { title: "세션 선택", placeholder: "제목, 저장소, 브랜치, 폴더로 찾기", empty: "맞는 세션이 없어요. 글자를 지우거나 Ctrl+R 로 목록을 새로 불러오세요.", keys: "Enter 열기  Ctrl+R 새로고침" },
		conversations: { title: "대화 선택", placeholder: "제목, 요약으로 찾기", empty: "맞는 대화가 없어요. 글자를 지워 보세요.", keys: "Enter 열기  Ctrl+F 즐겨찾기" },
		answers: { title: "저장된 답변", placeholder: "질문, 답으로 찾기", empty: "이 대화에는 맞는 저장된 답변이 없어요.", keys: "Enter 이 답변으로" },
		profiles: { title: "프로필 선택", placeholder: "프로필 이름으로 찾기", empty: "맞는 프로필이 없어요.", keys: "Enter 선택" },
		settings: { title: "설정", placeholder: "깊이, 모델, 미리 설명, 프로필로 찾기", empty: "맞는 설정이 없어요. 글자를 지워 보세요.", keys: "Enter 바꾸기" },
		modelScope: { title: "모델 범위", placeholder: "제공자, 모델 이름으로 찾기", empty: "맞는 모델이 없어요. 글자를 지워 보세요.", keys: "Enter 담기·빼기, 맨 위 항목으로 저장" },
	};

	function pickerItems(kind) {
		if (kind === "sessions") return sessionItems();
		if (kind === "conversations") return conversationItems();
		if (kind === "answers") return answerItems();
		if (kind === "profiles") return profileItems();
		if (kind === "modelScope") return modelScopeItems();
		return settingsItems();
	}

	function pickerDetail(kind) {
		if (kind === "sessions") return `도슨트가 함께 읽을 작업 기록 • ${state.sessions.length}개`;
		if (kind === "conversations") return `카드 ${state.cards.length} • 저장 ${conversationOptions().filter((option) => option.kind === "saved").length}`;
		if (kind === "answers") return "모델을 다시 부르지 않아요";
		if (kind === "profiles") return "프로필마다 학습 기록과 설명 깊이가 나뉘어요";
		if (kind === "modelScope") return `고른 ${state.scopeDraft.size}개 • Esc 로 저장하지 않고 닫기`;
		if (state.models?.loading) return "모델 목록을 불러오는 중이에요";
		return state.models?.error ? `모델 목록을 불러오지 못했어요: ${state.models.error}` : `프로필 ${profileName(state.profile)}`;
	}

	const visibleItems = () => filterItems(pickerItems(state.picker.kind), state.picker.query.text);

	/** 열 때와 새 카드가 올 때 고를 항목. 현재 세션, 지금 폴더의 세션, 설명 중이거나 가장 새 카드, 지금 쓰는 값 순이다. */
	function defaultIndex(picker, items) {
		const found = (test) => Math.max(0, items.findIndex(test));
		if (picker.kind === "sessions") {
			const current = items.findIndex((item) => item.current);
			if (current >= 0) return current;
			const here = process.cwd().replaceAll("\\", "/");
			return found((item) => {
				const folder = String(item.session.cwd ?? "").replaceAll("\\", "/");
				return folder && (here === folder || here.startsWith(`${folder}/`));
			});
		}
		if (picker.kind === "conversations") {
			if (!picker.auto) return found((item) => item.current);
			if (client.active) {
				const busy = items.findIndex((item) => item.option.thread === client.active.thread);
				if (busy >= 0) return busy;
			}
			return found((item) => item.option.kind === "card");
		}
		if (picker.kind === "answers") {
			const current = items.findIndex((item) => item.current);
			return current >= 0 ? current : Math.max(0, items.length - 1);
		}
		if (picker.kind === "modelScope") return 0;
		return found((item) => item.current);
	}

	function selectorView(lines) {
		const picker = state.picker, spec = PICKERS[picker.kind];
		const all = pickerItems(picker.kind);
		const items = filterItems(all, picker.query.text);
		if (!picker.touched) picker.index = defaultIndex(picker, items);
		picker.index = Math.max(0, Math.min(picker.index, items.length - 1));
		const narrow = width() < 72;
		const view = renderSelector({
			theme, width: width(), lines, title: spec.title, detail: pickerDetail(picker.kind), query: picker.query, placeholder: spec.placeholder,
			items, total: all.length, index: picker.index, start: picker.start,
			hint: narrow ? "↑↓ 이동  Enter 선택  Esc 닫기" : `↑↓ 이동  PgUp/PgDn 쪽  ${spec.keys}  Esc 닫기`,
			empty: spec.empty,
		});
		picker.start = view.start;
		picker.page = view.visible;
		return view;
	}

	function openPicker(kind, { auto = false } = {}) {
		if ((kind === "conversations" || kind === "answers") && !state.session) {
			inform("먼저 세션을 고르세요.");
			kind = "sessions";
		}
		if (kind === "settings" || kind === "modelScope") loadModels();
		if (kind === "modelScope") state.scopeDraft = new Set(state.profile.modelScope ?? []);
		state.picker = { kind, query: { text: "", cursor: 0 }, index: 0, start: 0, page: 5, touched: false, auto };
		scheduleRender();
	}

	function togglePicker(kind) {
		if (state.picker?.kind === kind) closePicker();
		else openPicker(kind);
	}

	function closePicker() {
		state.picker = null;
		state.bodyScroll = 0;
		scheduleRender();
	}

	function movePicker(delta) {
		const picker = state.picker, count = visibleItems().length;
		if (!count) return;
		picker.touched = true;
		const next = picker.index + delta;
		picker.index = Math.abs(delta) === 1 ? (next + count) % count : Math.max(0, Math.min(next, count - 1)); // 한 칸씩은 끝에서 반대편으로, 쪽 단위는 끝에서 멈춘다
		scheduleRender();
	}

	function choosePicker() {
		const items = visibleItems();
		const item = items[Math.min(state.picker.index, items.length - 1)];
		if (!item) { failNotice("선택할 항목이 없어요."); return; }
		if (!item.keepOpen) state.picker = null;
		item.run();
		scheduleRender();
	}

	/** 선택창이 열려 있을 때의 키. 처리했으면 true. 글자와 붙여넣기는 검색창으로, 나머지는 이동과 선택이다. */
	function pickerKey(event) {
		const picker = state.picker;
		if (event.type === "key") {
			switch (event.key) {
				case "up": movePicker(-1); return true;
				case "down": movePicker(1); return true;
				case "pageup": movePicker(-Math.max(1, picker.page - 1)); return true;
				case "pagedown": movePicker(Math.max(1, picker.page - 1)); return true;
				case "enter": case "tab": choosePicker(); return true;
				case "escape":
					if (picker.query.text) { picker.query = { text: "", cursor: 0 }; picker.touched = false; picker.start = 0; scheduleRender(); }
					else closePicker();
					return true;
				case "ctrl-f": {
					const item = visibleItems()[picker.index];
					if (item?.option) void toggleFavorite(item.option.thread, item.option.focus);
					return true;
				}
			}
		}
		const before = picker.query.text;
		if (!editLine(picker.query, event)) return false;
		if (picker.query.text !== before) { picker.index = 0; picker.start = 0; picker.touched = Boolean(picker.query.text); }
		scheduleRender();
		return true;
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
	function openSelectedAnswer(row) {
		if (!row) { inform("선택할 저장된 답변이 없어요."); return; }
		state.selectedAnswer = { ts: row.ts, question: row.question ?? "" };
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = true;
		state.followBottom = false;
		scheduleRender();
	}

	/** 즐겨찾기 켜고 끄기(웹과 같은 /api/favorites). 먼저 화면에 반영하고 저장이 실패하면 되돌린다. */
	async function toggleFavorite(thread, focus) {
		if (!state.session) { inform("먼저 세션을 고르세요."); return; }
		const sessionId = state.session.id, profileId = selectedProfileId(state.profile);
		const before = state.favorites;
		if (!Array.isArray(before)) { failNotice("즐겨찾기 목록을 아직 불러오지 못했어요."); return; }
		const on = !before.some((entry) => entry.thread === thread);
		state.favorites = on ? [...before, { thread }] : before.filter((entry) => entry.thread !== thread);
		scheduleRender();
		try {
			await api.setFavorite(sessionId, profileId, on, focus ? { label: String(focus.label ?? "").slice(0, 200), text: excerpt(focus.text) } : null);
			if (state.running && state.session?.id === sessionId) await loadFavorites(sessionId, profileId, historyGeneration);
			succeed(on ? "즐겨찾기에 넣었어요." : "즐겨찾기에서 뺐어요.");
		} catch (error) {
			if (state.session?.id === sessionId) state.favorites = before;
			failNotice(`즐겨찾기를 저장하지 못했어요: ${reason(error)}`);
		}
	}

	// --- 명령 목록 (OMP 처럼 입력창 바로 아래): 입력창 전체가 "/" 와 거르기 글자일 때만 열린다. Esc 는 글자를 그대로 둔다. ---
	// @ # $ 를 입력창 첫 글자로 치면 글자는 질문에 넣지 않고 세션, 대화, 설정 선택창이 열린다 (ADR 0068).
	const DEPTHS = [["EASY", "짧고 쉬운 핵심과 예시"], ["NORMAL", "원리와 흐름까지"], ["HARD", "실제 코드, 경계 조건, 대안까지"]];
	const TRIGGER_PICKERS = { "@": "sessions", "#": "conversations", "$": "settings" };

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
		openPicker("sessions");
		return false;
	}

	/** 명령은 한글과 영문 이름을 함께 보여 주고 둘 다로 고를 수 있다. 예: "/종료 (exit)", "/exit". */
	const command = (ko, en, aliases, description, run) => ({ label: `/${ko} (${en})`, names: [ko, en], aliases, description, run });
	function commandItems() {
		const items = [
			command("세션", "session", "", "함께 읽을 작업 세션 고르기", () => openPicker("sessions")),
			command("대화", "thread", "conversation card", "세션 전체 대화나 사건 카드 고르기", () => { if (needSession()) openPicker("conversations"); }),
			command("답변", "answers", "history", "이 대화에서 저장된 답변 다시 보기", () => { if (needSession()) openPicker("answers"); }),
			command("즐겨찾기", "favorite", "star bookmark", "지금 보는 대화를 즐겨찾기에 넣거나 빼기", () => { if (needSession()) void toggleFavorite(state.thread, state.focus); }),
			command("설정", "settings", "config model depth profile", "설명 깊이, 모델, 미리 설명, 프로필", () => openPicker("settings")),
			command("새로고침", "refresh", "reload", "목록과 대화를 다시 불러오고 끊긴 설명에 다시 연결", rejoinOrRefresh),
		];
		if (client.active) items.push(
			command("바로잡기", "steer", "", "진행 중인 설명의 방향 고치기", toggleSteer),
			command("중단", "stop", "cancel", "진행 중인 설명 멈추기", () => void cancelActiveAsk()),
		);
		if (client.queue.length) items.push(command("대기", "queue", "edit unqueue", "마지막 대기 질문을 입력창에 돌려놓고 고치거나 지우기", unqueueLast));
		items.push(command("종료", "exit", "quit", "터미널만 닫기. 서버와 보낸 설명 요청은 유지", exit));
		return items;
	}

	/** 모델을 고르지 않았을 때 설명에 쓰이는 이 세션의 모델 한 줄. */
	function sessionModelText() {
		if (!state.session) return "세션을 고르면 그 세션의 모델로 설명해요";
		if (!state.sessionModel) return "이 세션의 모델을 확인하는 중이에요";
		const { raw, model } = state.sessionModel;
		if (model) return `이 세션은 ${model.name} (${model.selector})`;
		return raw ? `${raw} 는 omp 카탈로그에 없어 omp 기본 모델로 설명해요` : "기록에 모델이 없어 omp 기본 모델로 설명해요";
	}

	async function loadSessionModel(sessionId, generation) {
		try {
			const info = await api.sessionModel(sessionId);
			if (state.running && generation === sessionGeneration) { state.sessionModel = info; scheduleRender(); }
		} catch { /* 표시만 못 한다. 설명 모델은 서버가 같은 규칙으로 정한다. */ }
	}

	function loadModels() {
		if (state.models) return;
		state.models = { loading: true, list: [] };
		api.models().then((catalog) => {
			state.models = { loading: false, list: Array.isArray(catalog?.models) ? catalog.models : [] };
		}).catch((error) => {
			state.models = { loading: false, list: [], error: terminalSafeText(reason(error)) };
		}).finally(scheduleRender);
	}

	async function patchProfile(patch, message) {
		const id = selectedProfileId(state.profile);
		try {
			const updated = await api.updateProfile(id, patch);
			state.profiles = state.profiles.map((entry) => entry.id === updated.id ? updated : entry);
			if (selectedProfileId(state.profile) === updated.id) state.profile = updated;
			succeed(message);
		} catch (error) { failNotice(`설정을 바꾸지 못했어요: ${reason(error)}`); }
	}

	/** 설정 선택창 항목. 깊이, 미리 설명, 모델은 고른 뒤에도 창이 남아 이어서 바꿀 수 있다. */
	function settingsItems() {
		loadModels();
		const profile = state.profile;
		const items = DEPTHS.map(([depth, description]) => ({
			tag: "깊이", label: depth, search: "depth difficulty 난이도 설명 깊이", description,
			current: (profile.defaultDifficulty || "NORMAL") === depth, keepOpen: true,
			run: () => void patchProfile({ defaultDifficulty: depth }, `기본 설명 깊이를 ${depth}로 바꿨어요.`),
		}));
		const auto = profile.autoExplain !== false;
		items.push({
			tag: "미리 설명", label: auto ? "끄기" : "켜기", search: "auto prefetch 자동",
			description: auto ? "지금 켜져 있어요. 새 사건 카드를 미리 설명하지 않아요" : "지금 꺼져 있어요. 새 사건 카드를 쉬운 말로 미리 설명해요",
			keepOpen: true,
			run: () => void patchProfile({ autoExplain: !auto }, auto ? "미리 설명을 껐어요." : "미리 설명을 켰어요."),
		});
		items.push({ tag: "모델", label: "세션 모델 (기본)", search: "model 모델 기본 default session", description: sessionModelText(), current: !profile.model, keepOpen: true, run: () => void patchProfile({ model: null }, "세션의 모델로 설명해요.") });
		const scope = profile.modelScope?.length ? new Set(profile.modelScope) : null;
		for (const model of state.models.list) {
			if (scope && !scope.has(model.selector) && profile.model !== model.selector) continue; // 범위 밖 모델은 숨기되 지금 고른 모델은 둔다
			items.push({
				tag: "모델", label: model.name || model.selector, search: `model 모델 ${model.provider ?? ""}`, description: model.selector,
				current: profile.model === model.selector, keepOpen: true,
				run: () => void patchProfile({ model: model.selector }, `${model.name || model.selector} 모델로 설명해요.`),
			});
		}
		items.push({
			tag: "모델 범위", label: scope ? `범위 고치기 (${scope.size}개)` : "범위 정하기", search: "model scope 모델 범위 후보",
			description: scope ? "목록에 둘 모델을 다시 고릅니다" : "지금은 모든 모델이 보여요. 쓸 모델만 골라 목록을 줄입니다",
			run: () => openPicker("modelScope"),
		});
		if (scope) items.push({ tag: "모델 범위", label: "범위 해제", search: "model scope 모델 범위 전체", description: "모든 모델이 목록에 보여요", keepOpen: true, run: () => void patchProfile({ modelScope: null }, "모델 범위를 해제했어요.") });
		for (const entry of state.profiles) {
			items.push({
				tag: "프로필", label: profileName(entry), search: "profile 프로필",
				description: entry.id === "default" ? "기본 프로필" : "학습 기록을 따로 보관해요",
				current: entry.id === state.profile.id,
				run: () => void chooseProfile(entry),
			});
		}
		return items;
	}

	/** 모델 범위 선택창 항목: 맨 위 저장 항목(검색해도 남음)과 모델별 체크. Enter 로 담고 뺀다. */
	function modelScopeItems() {
		loadModels();
		const draft = state.scopeDraft;
		const items = [{
			tag: "저장", label: `범위 저장 (${draft.size}개)`, pinned: true, search: "save 저장",
			description: draft.size ? "모델 선택 목록에 고른 모델만 보여요" : "고른 모델이 없으면 범위가 풀려 모든 모델이 보여요",
			run: () => void patchProfile({ modelScope: [...draft] }, draft.size ? `모델 범위를 ${draft.size}개로 정했어요.` : "모델 범위를 해제했어요."),
		}];
		for (const model of state.models.list) {
			items.push({
				tag: model.provider, label: model.name || model.selector, search: model.selector, description: model.selector,
				current: draft.has(model.selector), keepOpen: true,
				run: () => { if (draft.has(model.selector)) draft.delete(model.selector); else draft.add(model.selector); },
			});
		}
		return items;
	}

	function activeCompletion() {
		if (state.picker || state.purpose === "steer") return null;
		const draft = currentDraft();
		const match = /^\/([^\n]*)$/.exec(draft.text);
		if (!match || state.completion.dismissed === draft.text) return null;
		const terms = match[1].toLowerCase().split(/\s+/).filter(Boolean);
		let items = commandItems().filter((item) => {
			const haystack = `${item.label} ${item.aliases ?? ""} ${item.description ?? ""}`.toLowerCase();
			return terms.every((term) => haystack.includes(term));
		});
		// 이름이 입력한 글자로 시작하는 명령을 먼저 둔다. "/s" 는 설명에 s 가 든 명령보다 session, settings, stop 이 앞선다.
		if (terms.length) {
			const starts = (item) => item.names.some((name) => name.toLowerCase().startsWith(terms[0]));
			items = [...items.filter(starts), ...items.filter((item) => !starts(item))];
		}
		if (state.completion.key !== draft.text) {
			state.completion.key = draft.text;
			state.completion.index = 0;
		}
		state.completion.index = Math.max(0, Math.min(state.completion.index, items.length - 1));
		return { items, empty: "일치하는 명령이 없어요. Esc를 누르면 입력한 글자를 그대로 보낼 수 있어요." };
	}

	function moveCompletion(completion, delta) {
		const count = completion.items.length;
		if (!count) return;
		state.completion.index = (state.completion.index + delta + count) % count;
		scheduleRender();
	}

	function acceptCompletion(completion) {
		const item = completion.items[state.completion.index];
		if (!item) { failNotice(completion.empty); return; }
		clearDraft();
		state.completion = { key: "", index: 0, dismissed: null };
		inform("");
		item.run();
		scheduleRender();
	}

	/** Pi SelectList rows under the editor: "→" marks the keyboard choice, descriptions stay muted. */
	function completionRows(completion) {
		if (!completion) return [];
		const rows = [];
		const total = completion.items.length;
		const max = Math.max(2, Math.min(8, height() - 14));
		const index = state.completion.index;
		const start = Math.max(0, Math.min(index - Math.floor(max / 2), total - max));
		const visible = completion.items.slice(start, start + max);
		const labelWidth = Math.min(Math.floor(width() * 0.45), Math.max(8, ...visible.map((item) => visibleWidth(item.label))));
		rows.push(`${theme.span("title", " / 명령")}${theme.span("dim", "  ↑↓ 이동  Enter 실행  Esc 글자 그대로 입력")}`);
		if (!total) rows.push(theme.span("dim", `   ${completion.empty}`));
		visible.forEach((item, offset) => {
			const selected = start + offset === index;
			const label = clipLine(item.label, labelWidth);
			const padded = label + " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
			const room = width() - labelWidth - 8;
			rows.push(`${selected ? theme.span("title", " → ") : "   "}${theme.span(selected ? "title" : "text", padded)}   ${room > 6 && item.description ? theme.span("muted", clipLine(item.description, room)) : ""}`);
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
			if (state.picker?.kind === "answers") state.picker.start = 0;
			scheduleRender();
		} catch (error) {
			if (generation === historyGeneration) failNotice(`이전 대화를 불러오지 못했어요: ${reason(error)}`);
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

	/** 서버가 질문 대상과 스레드를 붙인 사건 카드만 받는다. 클라이언트는 스레드를 계산하지 않는다. */
	function addCard(event) {
		if (!event || !["question", "assistant"].includes(event.kind) || !CATEGORY[event.sub] || typeof event.text !== "string" || !event.text.trim()) return null;
		if (typeof event.thread !== "string" || !event.thread || typeof event.focus?.text !== "string" || !event.focus.text.trim()) return null;
		const thread = event.thread, key = thread;
		if (state.cardKeys.has(key)) return null;
		state.cardKeys.add(key);
		const card = { ...event, focus: { label: event.focus.label || CATEGORY[event.sub], text: event.focus.text }, thread, key };
		state.cards.push(card);
		if (state.cards.length > 200) {
			const removed = state.cards.shift();
			state.cardKeys.delete(removed.key);
		}
		return card;
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
		const card = addCard(event);
		if (!card) return;
		// 서버가 미리 설명을 붙인 새 카드는 같은 requestId 로 작업에 붙어 진행 상태와 끝을 안다(웹과 같다).
		if (card.ask && !state.history.some((row) => row.thread === card.thread)) {
			client.attachAuto({ requestId: card.ask.requestId, question: card.ask.question, display: card.ask.display ?? null, difficulty: card.ask.difficulty ?? "EASY", focus: card.focus, thread: card.thread });
		}
		scheduleRender();
	}

	/** session-client 의 변화를 화면에 옮긴다. 미리 설명과 다른 화면이 보낸 질문은 그리지 않는다(답은 record 사건으로 다시 불러온다). */
	function applyChange(change) {
		if (change.type === "live") { handleEvent(change.event); return; }
		if (change.type === "live-status") {
			state.liveNotice = change.status === "closed" ? "실시간 연결이 닫혔어요. 다시 연결하는 중이에요." : `실시간 연결에 실패했어요: ${terminalSafeText(change.error)}`;
			scheduleRender();
			return;
		}
		if (change.type === "end") { void finishAsk(change.job, change.outcome); return; }
		if (change.type === "queue" && change.dropped?.length) {
			// 세션·프로필을 바꾸면 대기 질문은 보내지 않고 원래 대화의 빈 입력창으로만 돌아간다. 돌려놓지 못한 질문은 알린다.
			const lost = change.dropped.filter((job) => !change.restored.includes(job));
			const back = change.restored.length ? `대기 질문 ${change.restored.length}개는 원래 대화의 입력창에 돌려놨어요. ` : "";
			if (lost.length) failNotice(`${back}보내지 못한 대기 질문 ${lost.length}개는 입력창에 이미 글이 있어 돌려놓지 못했어요: ${lost.map((job) => clipLine(job.question, 40)).join(", ")}`);
			else inform(back.trim());
			return;
		}
		if (change.job?.auto) { if (state.picker?.kind === "conversations") scheduleRender(); return; }
		if (change.job?.detached) return;
		if (change.error) failNotice(`설명 요청에 실패했어요: ${change.error} 서버의 요청은 계속될 수 있어요. Ctrl+R 키로 같은 요청에 다시 연결하세요.`);
		if (change.type === "job" && !change.event) {
			state.followSelection = false;
			state.followBottom = true;
		}
		scheduleRender();
	}

	async function finishAsk(job, outcome) {
		if (job.auto) {
			if (outcome.type === "answer") await reloadHistory();
			scheduleRender();
			return;
		}
		if (!job.detached) {
			if (outcome.type === "answer") {
				// 저장된 대화를 다시 불러올 때까지 받은 설명을 그대로 보여 준다. 그 사이 다음 대기 질문이 시작될 수 있다.
				state.settling = job;
				inform("설명이 끝났어요. 저장된 대화를 불러오는 중이에요.");
				await reloadHistory();
				if (state.settling === job) state.settling = null;
				succeed("설명이 끝났어요.");
			} else if (outcome.type === "cancelled") restoreCancelledQuestion(job, outcome.restored);
			else failNotice(`설명을 만들지 못했어요: ${outcome.error || "서버 오류"}`);
		}
		if (!client.active && state.purpose === "steer") state.purpose = "ask";
		scheduleRender();
	}

	/** 서버에 남은 진행 중인 설명에 같은 requestId 로 다시 붙고, 그 설명의 스레드(서버가 준 값)로 간다. */
	async function rejoin(generation) {
		const before = client.active;
		try {
			await client.rejoin();
		} catch (error) {
			if (generation === sessionGeneration) failNotice(`진행 중인 요청을 확인하지 못했어요: ${reason(error)}`);
			return;
		}
		const job = client.active;
		if (!state.running || generation !== sessionGeneration || !job || job === before) return;
		state.thread = job.thread;
		state.focus = job.focus;
		state.selectedAnswer = null;
		inform("진행 중인 설명에 다시 연결했어요.");
	}

	async function refreshSessions() {
		try {
			const list = await api.sessions();
			if (!state.running || !Array.isArray(list)) return;
			state.sessions = list;
			inform(`세션 목록을 새로 불러왔어요. ${list.length}개`);
		} catch (error) { failNotice(`세션 목록을 불러오지 못했어요: ${reason(error)}`); }
	}

	/** 세션을 연다. 고른 직후에는 대화 선택창이 이어서 열린다(`pick`). 프로필만 바꿀 때는 같은 세션 전체 대화에 머문다. */
	async function switchSession(session, { pick = true } = {}) {
		if (!session) { inform("선택할 세션이 없어요."); return; }
		state.session = session;
		state.cards = [];
		state.cardKeys.clear();
		state.history = [];
		state.favorites = null;
		state.focus = null;
		state.thread = "";
		state.selectedAnswer = null;
		state.settling = null;
		state.purpose = "ask";
		state.liveNotice = "";
		state.notice = "이전 대화를 불러오는 중이에요.";
		state.noticeError = false;
		state.noticeKind = "info";
		historyGeneration++;
		const generation = ++sessionGeneration;
		// 이전 세션의 설명 스트림은 놓는다(서버 작업은 계속). 돌아오면 rejoin 으로 다시 붙는다.
		client.open({ profileId: selectedProfileId(state.profile), sessionId: session.id });
		state.sessionModel = null;
		void loadSessionModel(session.id, generation);
		if (pick) openPicker("conversations", { auto: true });
		else state.picker = null;
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
			if (state.notice === "이전 대화를 불러오는 중이에요.") state.notice = "";
			scheduleRender();
		} catch (error) {
			if (generation === sessionGeneration) failNotice(`이전 대화를 불러오지 못했어요: ${reason(error)}`);
		}
		if (state.running && generation === sessionGeneration) void client.follow();
		if (state.running && generation === sessionGeneration) void rejoin(generation);
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
		if (state.session) await switchSession(state.session, { pick: false });
		else {
			client.close();
			openPicker("sessions");
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
		if (!client.active) { inform("바로잡을 진행 중인 설명이 없어요. 설명이 진행되면 Ctrl+S 로 전환하세요."); return; }
		state.purpose = "steer";
		scheduleRender();
	}

	async function submitComposer() {
		const draft = currentDraft();
		const text = draft.text.trim();
		if (!text) { failNotice("보낼 내용을 입력하세요."); return; }
		if (state.purpose === "steer") {
			if (!client.active) { failNotice("바로잡을 진행 중인 설명이 없어요."); return; }
			const message = text;
			const key = draftKey();
			clearDraft(key);
			state.purpose = "ask";
			inform("");
			try {
				if (!await client.steer(message)) throw new Error("바로잡을 진행 중인 설명이 없어요.");
				inform("바로잡기를 보냈어요.");
			} catch (error) {
				state.drafts.set(key, { text: message, cursor: graphemes(message).length, preferredColumn: null });
				failNotice(`바로잡기를 보내지 못했어요: ${reason(error)}`);
			}
			return;
		}
		if (!state.session) { inform("먼저 세션을 고르세요. @ 를 입력하면 세션 목록이 나와요."); return; }
		// 설명이 진행 중이면(연결이 끊겼어도) 대기 질문이 되어 지금 설명이 끝난 뒤 차례대로 나간다 (ADR 0029 §4).
		const job = client.ask({ question: text, focus: state.focus, thread: state.thread });
		clearDraft();
		state.picker = null;
		state.bodyScroll = 0;
		state.followSelection = false;
		state.followBottom = true;
		if (job && client.queue.includes(job)) inform("대기 질문으로 보냈어요. 지금 설명이 끝나면 이어서 보내요.");
		else inform("");
	}

	/** 중단한 질문은 서버가 알려 준 그 질문의 스레드로 돌아간다. 입력창 복원은 session-client 가 빈 입력창에만 한다. */
	function restoreCancelledQuestion(job, restored) {
		if (state.purpose === "steer") state.purpose = "ask";
		state.focus = job.focus;
		state.thread = job.thread;
		state.picker = null;
		state.selectedAnswer = null;
		state.bodyScroll = 0;
		state.followSelection = false;
		state.followBottom = true;
		if (restored) inform("설명을 중단했어요. 보낸 질문을 입력창에 돌려놨어요.");
		else inform(`설명을 중단했어요. 새로 쓴 질문은 그대로 두었어요. 보낸 질문: ${clipLine(job.question, Math.max(16, width() - 40))}`);
	}

	/** /대기: 마지막 대기 질문을 그 스레드의 입력창으로 돌려놓는다. 고쳐서 다시 보내거나 지운다. */
	function unqueueLast() {
		const job = client.queue.at(-1);
		if (!job || !client.unqueue(job)) { inform("대기 질문이 없어요."); return; }
		state.focus = job.focus;
		state.thread = job.thread;
		state.selectedAnswer = null;
		const draft = currentDraft();
		const text = draft.text.trim() ? `${draft.text}\n${job.question}` : job.question;
		setDraftText(text);
		inform("대기 질문을 입력창에 돌려놨어요. 고쳐서 Enter 로 다시 보내거나 지우세요.");
	}

	async function cancelActiveAsk() {
		const ask = client.active;
		if (!ask) { inform("진행 중인 설명이 없어요."); return; }
		if (ask.cancelling) return;
		inform("설명을 멈추는 중이에요.");
		try {
			const result = await client.stop();
			if (result && !result.cancelled) failNotice("서버에서 진행 중인 요청을 찾지 못했어요. Ctrl+R 키로 결과를 확인하세요.");
		} catch (error) {
			failNotice(`중단 요청을 보내지 못했어요: ${reason(error)}`);
		}
	}

	function rejoinOrRefresh() {
		const ask = client.active;
		if (ask) {
			if (!ask.disconnected) { inform("설명에 연결되어 있어요. 새 요청을 만들지 않았어요."); return; }
			client.resume(ask);
			inform("");
			return;
		}
		if (state.picker?.kind === "sessions" || !state.session) { void refreshSessions(); return; }
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
		const ask = client.active;
		if (!ask) herdr.update("idle");
		else if (ask.disconnected) herdr.update("blocked", "설명 연결이 끊겼어요. Ctrl+R로 다시 연결하세요.");
		else herdr.update("working", ask.cancelling ? "설명을 멈추는 중이에요" : stageText(ask));
	}

	function exit() {
		if (!state.running) return;
		state.running = false;
		clearTimeout(renderTimer);
		clearInterval(spinnerTimer);
		client.close();
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
		// 선택창이 열려 있으면 글자와 붙여넣기는 검색창으로 간다.
		if (state.picker && (event.type === "text" || event.type === "paste")) { pickerKey(event); return; }
		if (event.type === "paste") {
			if (event.tooLarge) { failNotice(`붙여넣은 내용이 너무 커요. ${draftLimit()}자 이내로 나눠서 붙여넣으세요.`); return; }
			insertText(event.text, true);
			return;
		}
		if (event.type === "text") {
			// @ # $ 를 입력창 첫 글자로 치면 세션, 대화, 설정 선택창이 열린다. 질문이 이 기호로 시작하면 앞에 공백을 하나 두세요.
			const kind = TRIGGER_PICKERS[event.text];
			if (kind && state.purpose !== "steer" && !currentDraft().text) { openPicker(kind); return; }
			insertText(event.text);
			return;
		}

		switch (event.key) {
			case "ctrl-p": togglePicker("sessions"); return;
			case "ctrl-t": togglePicker("conversations"); return;
			case "ctrl-o": togglePicker("answers"); return;
			case "ctrl-g": togglePicker("profiles"); return;
			case "ctrl-r": rejoinOrRefresh(); return;
			case "ctrl-s": toggleSteer(); return;
			case "interrupt": void cancelActiveAsk(); return;
			case "eof": exit(); return;
			case "ctrl-f":
				if (state.picker) pickerKey(event);
				else if (state.session) void toggleFavorite(state.thread, state.focus);
				else inform("먼저 세션을 고르세요.");
				return;
			case "escape": {
				if (state.picker) { pickerKey(event); return; }
				const completion = activeCompletion();
				if (completion) { state.completion.dismissed = currentDraft().text; scheduleRender(); }
				else if (state.purpose === "steer") { state.purpose = "ask"; scheduleRender(); }
				else { state.notice = ""; openPicker(state.session ? "conversations" : "sessions"); } // 대화 안에서 Esc 는 대화 목록으로 돌아간다
				return;
			}
		}

		if (state.picker) { pickerKey(event); return; }
		{
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
		} else openPicker("sessions");
		render();
		await finished;
	} finally {
		input.close();
		restoreTerminal();
		await herdr.release();
	}
}
