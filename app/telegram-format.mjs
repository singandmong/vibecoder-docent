// 답과 카드를 텔레그램 HTML 메시지로 바꾸는 순수 변환 (ADR 0076). 입출력과 node: 모듈을 쓰지 않는다.
// 텔레그램 HTML 은 이스케이프가 & < > 세 글자뿐이고, 한 메시지는 4096자 이하다.
import { parseAnswer } from "./slots.mjs";

const STATUS_EMOJI = { done: "✅", running: "⏳", blocked: "⛔" };
const KIND = { question: "AI가 물어봐요", result: "작업 결과가 나왔어요", plan: "AI가 계획을 세웠어요" };
const DETAIL_TITLE = "더 자세히";
const MAX_DEFAULT = 3800;
const LABEL_MAX = 101;

export const escapeHtml = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- 글줄 안쪽 변환 ----

const INLINE = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__/g;

function linkHtml(label, url) {
	if (!/^https:\/\/\S/i.test(url)) return escapeHtml(label);
	return `<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(label)}</a>`;
}

function plainInline(text, bold) {
	let out = "", last = 0;
	for (const m of text.matchAll(INLINE)) {
		out += escapeHtml(text.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[1] !== undefined) out += linkHtml(m[1], m[2]);
		else {
			const inner = plainInline(m[3] ?? m[4], false);
			out += bold ? `<b>${inner}</b>` : inner;
		}
	}
	return out + escapeHtml(text.slice(last));
}

/** 인라인 코드, 링크, 굵게를 바꾸고 나머지는 이스케이프한다. bold=false 면 굵게 표시를 글자만 남긴다. */
function inline(text, bold = true) {
	return String(text).split(/(`+[^`\n]*?`+)/).map((part, index) => {
		if (index % 2 === 0) return plainInline(part, bold);
		const code = /^(`+)([^`\n]*?)\1$/.exec(part);
		return code ? `<code>${escapeHtml(code[2])}</code>` : escapeHtml(part);
	}).join("");
}

// ---- 줄 묶음(블록) 나누기 ----

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*$/;

/** 마크다운을 블록으로 나눈다. sep 는 앞 블록과의 사이 구분(빈 줄이 있었으면 문단 경계). */
function parseBlocks(text) {
	const blocks = [];
	let gap = "\n\n"; // 첫 블록 앞은 쓰이지 않는다.
	let current = null;
	const push = (block) => { blocks.push({ ...block, sep: gap }); gap = "\n"; current = null; };
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) { gap = "\n\n"; current = null; continue; }
		const open = FENCE_OPEN.exec(line);
		if (open) {
			const body = [];
			const [marker] = open[1];
			const size = open[1].length;
			i++;
			for (; i < lines.length; i++) {
				const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
				if (close && close[1][0] === marker && close[1].length >= size) break;
				body.push(lines[i]);
			}
			push({ type: "code", lang: open[2], lines: body });
			continue;
		}
		if (/^\s*\|/.test(line)) {
			if (current?.type === "table") current.lines.push(line);
			else { push({ type: "table", lines: [line] }); current = blocks.at(-1); }
			continue;
		}
		if (/^\s*>/.test(line)) {
			const stripped = line.replace(/^(?:\s*>[ \t]?)+/, "");
			if (current?.type === "quote") current.lines.push(stripped);
			else { push({ type: "quote", lines: [stripped] }); current = blocks.at(-1); }
			continue;
		}
		const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) { push({ type: "heading", lines: [heading[1]] }); continue; }
		if (current?.type === "para") current.lines.push(line);
		else { push({ type: "para", lines: [line] }); current = blocks.at(-1); }
	}
	return blocks;
}

/** 블록 하나를 HTML 로. 항상 여닫는 태그가 맞는다. plainQuote 는 접힌 인용 안이라 인용을 평문 "> " 로 둔다. */
function renderBlock(block, plainQuote) {
	const { type, lines } = block;
	switch (type) {
		case "code": {
			const body = escapeHtml(lines.join("\n"));
			return block.lang ? `<pre><code class="language-${block.lang}">${body}</code></pre>` : `<pre>${body}</pre>`;
		}
		case "table": return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
		case "heading": return lines.map((line) => `<b>${inline(line, false)}</b>`).join("\n");
		case "quote":
			if (plainQuote) return lines.map((line) => `&gt; ${inline(line)}`).join("\n");
			return `<blockquote>${lines.map((line) => inline(line)).join("\n")}</blockquote>`;
		case "head": {
			const title = lines.join(" ").trim();
			if (!title) return block.emoji;
			return `${block.emoji ? `${block.emoji} ` : ""}<b>${inline(title, false)}</b>`;
		}
		case "source": return `<blockquote expandable>${escapeHtml(lines.join("\n"))}</blockquote>`;
		default: return lines.map((line) => inline(line)).join("\n");
	}
}

/** 블록을 budget 이하 조각들로. 줄 수가 많으면 반으로, 한 줄이면 글자 수로 나눈다. 조각마다 태그가 닫힌다. */
function pieces(block, budget, plainQuote) {
	const html = renderBlock(block, plainQuote);
	if (html.length <= budget) return [html];
	if (block.lines.length > 1) {
		const mid = Math.ceil(block.lines.length / 2);
		return [
			...pieces({ ...block, lines: block.lines.slice(0, mid) }, budget, plainQuote),
			...pieces({ ...block, lines: block.lines.slice(mid) }, budget, plainQuote),
		];
	}
	const chars = [...(block.lines[0] ?? "")];
	if (chars.length < 2) return [html];
	const mid = Math.ceil(chars.length / 2);
	return [
		...pieces({ ...block, lines: [chars.slice(0, mid).join("")] }, budget, plainQuote),
		...pieces({ ...block, lines: [chars.slice(mid).join("")] }, budget, plainQuote),
	];
}

/** 블록들을 budget 이하 조각으로 펼친다. 이어진 조각은 같은 블록에서 나왔으면 줄바꿈 한 번으로 잇는다. */
function units(blocks, budget, plainQuote) {
	return blocks.flatMap((block) => pieces(block, budget, plainQuote).map((html, index) => ({ html, sep: index ? "\n" : block.sep })));
}

/** 단위들을 budget 이하 문자열로 묶는다. 단위가 이미 budget 이하이므로 문단 경계에서만 나뉜다. */
function pack(list, budget) {
	const out = [];
	let cur = "";
	for (const { html, sep } of list) {
		if (!cur) cur = html;
		else if (cur.length + sep.length + html.length <= budget) cur += sep + html;
		else { out.push(cur); cur = html; }
	}
	if (cur) out.push(cur);
	return out;
}

const wrapExpandable = (body, title) => `<blockquote expandable>${title ? `${title}\n` : ""}${body}</blockquote>`;

// ---- 내보내기 ----

/**
 * 모델 답 원문을 텔레그램 HTML 메시지 배열로 바꾼다.
 * 조각마다 <b>, <pre>, <blockquote> 가 닫혀 있고 길이는 max 이하다.
 */
export function answerMessages(raw, { max = MAX_DEFAULT } = {}) {
	const answer = parseAnswer(raw);
	const mainBlocks = [];
	if (answer.headline) mainBlocks.push({ type: "head", emoji: STATUS_EMOJI[answer.status] ?? "", lines: [answer.headline], sep: "\n\n" });
	else if (answer.status) mainBlocks.push({ type: "head", emoji: STATUS_EMOJI[answer.status], lines: [""], sep: "\n\n" });
	const explain = parseBlocks(answer.explain);
	if (explain.length) explain[0].sep = "\n\n";
	mainBlocks.push(...explain);
	const messages = pack(units(mainBlocks, max, false), max);

	const detailBlocks = answer.details.flatMap((section, index) => {
		const blocks = parseBlocks(section);
		if (blocks.length) blocks[0].sep = "\n\n";
		return index && blocks.length ? [{ ...blocks[0], sep: "\n\n" }, ...blocks.slice(1)] : blocks;
	});
	if (detailBlocks.length) {
		const overhead = wrapExpandable("", DETAIL_TITLE).length;
		const chunks = pack(units(detailBlocks, Math.max(max - overhead, 1), true), Math.max(max - overhead, 1))
			.map((body, index) => wrapExpandable(body, index ? "" : DETAIL_TITLE));
		const last = messages.at(-1);
		if (last && last.length + 2 + chunks[0].length <= max) messages[messages.length - 1] = `${last}\n\n${chunks.shift()}`;
		messages.push(...chunks);
	}
	return messages;
}

/** 카드 알림 본문. 사건 종류 문구와 focus.label 뿐이고 원문 전문과 선택지는 넣지 않는다. */
export function cardText(card) {
	const label = [...String(card?.focus?.label ?? "")].slice(0, LABEL_MAX).join("");
	return `${KIND[card?.sub] ?? "새 카드가 왔어요"}\n${escapeHtml(label)}`;
}

/** 원문 보기용. 원문을 접힌 인용에 그대로 담고 max 이하 조각으로 나눈다. */
export function sourceText(text, { max = MAX_DEFAULT } = {}) {
	const body = String(text ?? "");
	if (!body.trim()) return [];
	const overhead = wrapExpandable("", "").length;
	const budget = Math.max(max - overhead, 1) + overhead;
	return pieces({ type: "source", lines: body.split("\n") }, budget, false);
}
