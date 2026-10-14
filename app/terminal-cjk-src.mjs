import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { cjk } from "@streamdown/cjk";

// 터미널 강조 보정의 원본. `npm run build`가 app/assets/terminal-cjk.js로 묶는다 (ADR 0065).
// 웹과 같은 파서(remark-parse + Streamdown 기본 remark-gfm + @streamdown/cjk, 순서도 app/markdown-remark.mjs와 같다)로
// 강조 노드를 찾고, pi-tui의 marked가 거절할 구분 기호 묶음에만 U+FEFF(공백으로 취급, 렌더 뒤 삭제)를 끼운다.
const FLANK_MARK = "\ufeff";
const WHITESPACE = /^[\s\u00a0]$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;
const EMPHASIS_TYPES = new Set(["strong", "emphasis", "delete"]);

const processor = unified().use(remarkParse);
for (const plugin of [...cjk.remarkPluginsBefore, [remarkGfm, {}], ...cjk.remarkPluginsAfter]) processor.use(...(Array.isArray(plugin) ? plugin : [plugin]));

function codePointBefore(text, index) {
	if (index <= 0) return " ";
	const low = text.charCodeAt(index - 1);
	if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return String.fromCodePoint(text.codePointAt(index - 2));
	return text[index - 1];
}

function codePointAt(text, index) {
	return index >= text.length ? " " : String.fromCodePoint(text.codePointAt(index));
}

// 같은 종류(여는 쪽끼리, 닫는 쪽끼리)로 이어 붙은 범위를 한 묶음으로 합친다. `***`는 노드 둘의 범위가 이어진 것이다.
function mergeRanges(ranges) {
	const sorted = ranges.sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && last[1] === range[0]) last[1] = range[1];
		else merged.push([range[0], range[1]]);
	}
	return merged;
}

/** 파서가 강조로 읽은 구분 기호 묶음 중 CommonMark 기본 규칙이 거절할 것의 바깥쪽에 U+FEFF를 끼운 원문. */
export function cjkFriendlyEmphasis(source) {
	const text = String(source ?? "");
	if (!/[*_~]/.test(text)) return text;
	const openers = [];
	const closers = [];
	const visit = (node) => {
		const children = node.children;
		if (!children) return;
		if (EMPHASIS_TYPES.has(node.type) && children.length) {
			const start = node.position?.start?.offset;
			const end = node.position?.end?.offset;
			const first = children[0].position?.start?.offset;
			const last = children[children.length - 1].position?.end?.offset;
			if (Number.isInteger(start) && Number.isInteger(first) && first > start) openers.push([start, first]);
			if (Number.isInteger(end) && Number.isInteger(last) && end > last) closers.push([last, end]);
		}
		for (const child of children) visit(child);
	};
	visit(processor.parse(text));
	const inserts = [];
	const needsMark = (inner, outer) => PUNCTUATION.test(inner) && !WHITESPACE.test(outer) && !PUNCTUATION.test(outer);
	for (const [start, end] of mergeRanges(openers)) {
		if (needsMark(codePointAt(text, end), codePointBefore(text, start))) inserts.push(start);
	}
	for (const [start, end] of mergeRanges(closers)) {
		if (needsMark(codePointBefore(text, start), codePointAt(text, end))) inserts.push(end);
	}
	if (!inserts.length) return text;
	inserts.sort((a, b) => b - a);
	let out = text;
	for (const at of inserts) out = out.slice(0, at) + FLANK_MARK + out.slice(at);
	return out;
}
