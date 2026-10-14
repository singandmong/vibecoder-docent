import { Markdown } from "@earendil-works/pi-tui";
import { terminalSafeText } from "./terminal-input.mjs";
import { cjkFriendlyEmphasis } from "./assets/terminal-cjk.js";

export { cjkFriendlyEmphasis };

const DEFAULT_CACHE_SIZE = 8;
const PADDING_X = 1;
const PADDING_Y = 0;

// 강조 보정(U+FEFF 끼우기)은 웹과 같은 파서로 만든 번들이 한다 (ADR 0065). 렌더 뒤 sanitizeRenderedLine이 U+FEFF를 지운다.

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
