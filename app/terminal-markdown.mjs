import { Markdown } from "@earendil-works/pi-tui";
import { terminalSafeText } from "./terminal-input.mjs";

const DEFAULT_CACHE_SIZE = 8;
const PADDING_X = 1;
const PADDING_Y = 0;

// U+FEFF는 marked의 `\s`에 걸리지만 폭이 0이라 줄바꿈 계산에 영향이 없다. 아래 cjkFriendlyEmphasis가 넣고 렌더 뒤에 지운다.
const FLANK_MARK = "\ufeff";

/** Keep only renderer-produced SGR; drop OSC (links, images), other CSI, and residual controls. */
function sanitizeRenderedLine(line) {
	return String(line)
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (sequence) => (sequence.endsWith("m") ? sequence : ""))
		.replace(/\u001b[@-Z\\-_]/g, "")
		.replace(/[\u0000-\u001a\u001c-\u001f\u007f-\u009f]/g, "")
		.replace(/\u001b(?!\[[0-?]*m)/g, "")
		.replace(/\ufeff/g, "");
}

const WHITESPACE = /^[\s\u00a0]$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;
const CJK_LETTER = /^[\u1100-\u11ff\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\u{20000}-\u{3ffff}]$/u;

function codePointBefore(line, index) {
	if (index <= 0) return " ";
	const low = line.charCodeAt(index - 1);
	if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return String.fromCodePoint(line.codePointAt(index - 2));
	return line[index - 1];
}

function codePointAt(line, index) {
	return index >= line.length ? " " : String.fromCodePoint(line.codePointAt(index));
}

function closeOpener(stack, length) {
	const at = stack.lastIndexOf(length);
	if (at < 0) return false;
	stack.length = at;
	return true;
}

/** Rewrite one non-code line; `stack` holds the lengths of `*` runs still waiting for a closer. */
function cjkFriendlyLine(line, stack) {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\\") {
			out += line.slice(i, i + 2);
			i += 2;
		} else if (ch === "`") {
			let end = i;
			while (line[end] === "`") end++;
			const ticks = end - i;
			let close = -1;
			for (let k = end; k < line.length; ) {
				if (line[k] !== "`") { k++; continue; }
				let run = k;
				while (line[run] === "`") run++;
				if (run - k === ticks) { close = run; break; }
				k = run;
			}
			// 코드 범위는 글자 하나도 건드리지 않는다. 닫는 백틱이 없으면 일반 글자다.
			out += line.slice(i, close < 0 ? end : close);
			i = close < 0 ? end : close;
		} else if (ch === "*") {
			let end = i;
			while (line[end] === "*") end++;
			const length = end - i;
			const prev = codePointBefore(line, i);
			const next = codePointAt(line, end);
			const prevSpace = WHITESPACE.test(prev);
			const nextSpace = WHITESPACE.test(next);
			const prevPunct = PUNCTUATION.test(prev);
			const nextPunct = PUNCTUATION.test(next);
			const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
			const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
			const run = line.slice(i, end);
			if (prevPunct && CJK_LETTER.test(next)) {
				// 구두점 뒤, 한글 앞: CommonMark는 여는 표시로만 본다. 짝이 기다리고 있으면 닫는 표시로 바꿔 준다.
				if (closeOpener(stack, length)) out += run + FLANK_MARK;
				else { stack.push(length); out += run; }
			} else if (CJK_LETTER.test(prev) && nextPunct) {
				// 한글 뒤, 구두점 앞: CommonMark는 닫는 표시로만 본다. 짝이 없으면 여는 표시로 바꿔 준다.
				if (closeOpener(stack, length)) out += run;
				else { stack.push(length); out += FLANK_MARK + run; }
			} else {
				if (left && (!right || stack.lastIndexOf(length) < 0)) stack.push(length);
				else if (right) closeOpener(stack, length);
				out += run;
			}
			i = end;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/**
 * CommonMark의 강조 규칙은 닫는 `**` 앞이 구두점이고 뒤가 한글이면(`**`코드`**를`) 강조로 보지 않는다.
 * 한글 옆에서만 이런 `*` 묶음의 앞이나 뒤에 U+FEFF(공백으로 취급됨)를 끼워 pi-tui의 파서가 강조로 읽게 한다 (ADR 0061).
 * 코드 블록, 코드 범위, 이스케이프는 건드리지 않고, ASCII만 있는 글은 그대로다.
 */
export function cjkFriendlyEmphasis(source) {
	const text = String(source ?? "");
	if (!text.includes("*")) return text;
	const stack = [];
	let fence = null;
	return text
		.split("\n")
		.map((line) => {
			if (fence) {
				const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
				if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
				return line;
			}
			const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (opening) {
				fence = { char: opening[1][0], length: opening[1].length };
				stack.length = 0;
				return line;
			}
			if (!line.trim()) {
				stack.length = 0;
				return line;
			}
			return cjkFriendlyLine(line, stack);
		})
		.join("\n");
}

/**
 * Trusted-ANSI Markdown rows backed by the real Pi renderer (@earendil-works/pi-tui).
 *
 * createTerminalMarkdown(theme, options?) => { render(text, width): string[] }
 * - theme: createTerminalTheme() result; uses theme.markdown so NO_COLOR yields plain rows.
 * - options.defaultTextStyle: optional Pi DefaultTextStyle applied to body text
 *   (trusted renderer strings only — color callbacks must not strip ANSI).
 * - options.cacheSize: bounded instance cache, default 8; stable text/width never reparses.
 * - Rows are padded to `width` with paddingX=1, paddingY=0; empty input renders [].
 * - Source is sanitized before parsing; output keeps SGR only (no OSC links/images).
 * Consumer composes full rows with theme.line(role, renderedLine).
 */
export function createTerminalMarkdown(theme, options = {}) {
	const cacheSize = Math.max(1, Math.floor(options.cacheSize ?? DEFAULT_CACHE_SIZE));
	const markdownTheme = theme.markdown;
	const instances = new Map();

	return {
		render(text, width) {
			const columns = Math.max(1, Math.floor(Number(width) || 1));
			const source = terminalSafeText(text);
			if (!source.trim()) return [];
			let instance = instances.get(source);
			if (!instance) {
				if (instances.size >= cacheSize) {
					instances.delete(instances.keys().next().value);
				}
				instance = new Markdown(source, PADDING_X, PADDING_Y, markdownTheme, options.defaultTextStyle, { transform: cjkFriendlyEmphasis });
				instances.set(source, instance);
			}
			return instance.render(columns).map(sanitizeRenderedLine);
		},
	};
}
