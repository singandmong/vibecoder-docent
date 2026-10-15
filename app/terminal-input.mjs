const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const CSI_KEYS = new Map([
	["\u001b[A", "up"], ["\u001b[B", "down"], ["\u001b[C", "right"], ["\u001b[D", "left"],
	["\u001b[H", "home"], ["\u001b[F", "end"], ["\u001b[1~", "home"], ["\u001b[4~", "end"],
	["\u001b[7~", "home"], ["\u001b[8~", "end"], ["\u001b[3~", "delete"],
	["\u001b[5~", "pageup"], ["\u001b[6~", "pagedown"], ["\u001b[Z", "shift-tab"],
	// Application cursor mode (SS3), sent by Herdr, tmux and some terminals.
	["\u001bOA", "up"], ["\u001bOB", "down"], ["\u001bOC", "right"], ["\u001bOD", "left"],
	["\u001bOH", "home"], ["\u001bOF", "end"],
]);
const ESC_PREFIXES = [...CSI_KEYS.keys(), PASTE_START];
const MAX_PASTE_CHARS = 32_000;

/** Terminal output is plain text only. Strip controls that can move the cursor, change modes, or spoof text. */
export function terminalSafeText(value) {
	return String(value ?? "")
		.replace(/[\u2028\u2029]/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function graphemes(value) {
	const text = String(value ?? "");
	if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
	return Array.from(text);
}

function graphemeWidth(value) {
	const chars = Array.from(value, (char) => char.codePointAt(0));
	if (chars.every((point) => /\p{Mark}/u.test(String.fromCodePoint(point)) || point === 0x200d || (point >= 0xfe00 && point <= 0xfe0f))) return 0;
	return chars.some((point) => (
		(point >= 0x1100 && point <= 0x11ff) || (point >= 0x2e80 && point <= 0xa4cf) ||
		(point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
		(point >= 0xfe10 && point <= 0xfe6f) || (point >= 0xff00 && point <= 0xff60) ||
		(point >= 0xffe0 && point <= 0xffe6) || (point >= 0x1f000 && point <= 0x1faff) ||
		(point >= 0x20000 && point <= 0x3ffff)
	)) ? 2 : 1;
}

export function wrapTerminalText(value, width) {
	const columns = Math.max(1, Math.floor(width));
	const lines = [];
	for (const source of terminalSafeText(value).replace(/\t/g, "    ").split("\n")) {
		let line = "", used = 0;
		for (const part of graphemes(source)) {
			const size = graphemeWidth(part);
			if (used && used + size > columns) {
				lines.push(line);
				line = "";
				used = 0;
			}
			line += part;
			used += size;
		}
		lines.push(line);
	}
	return lines.length ? lines : [""];
}

/**
 * 입력창 글을 `columns` 칸으로 접고(글자는 쪼개지 않음), 커서(글자 단위 위치)가 놓인 줄·글자 순번·칸을 돌려준다.
 * 커서는 글자 위이거나 글 끝의 빈 칸이다. 줄 끝에 놓인 커서 칸은 `columns` 칸 바로 다음(여유 한 칸)까지 갈 수 있다.
 * 탭은 네 칸 공백으로 보인다. 줄바꿈 글자는 줄 사이로만 쓰이고 줄 안에는 남지 않는다.
 * @returns {{lines: string[][], caret: {line: number, index: number, col: number}}} lines 는 줄마다 글자 배열
 */
export function layoutDraft(text, cursor, columns) {
	const limit = Math.max(1, Math.floor(columns));
	const parts = graphemes(text);
	const at = Math.max(0, Math.min(Math.floor(cursor) || 0, parts.length));
	const lines = [[]];
	let used = 0, caret = null;
	for (let i = 0; i <= parts.length; i++) {
		const part = parts[i];
		if (part === "\n") {
			if (i === at) caret = { line: lines.length - 1, index: lines.at(-1).length, col: used };
			lines.push([]);
			used = 0;
			continue;
		}
		const size = part === undefined ? 0 : part === "\t" ? 4 : graphemeWidth(part);
		if (part !== undefined && used && used + size > limit) { lines.push([]); used = 0; }
		if (i === at) caret = { line: lines.length - 1, index: lines.at(-1).length, col: used };
		if (part === undefined) break;
		lines.at(-1).push(part === "\t" ? "    " : part);
		used += size;
	}
	return { lines, caret };
}

/**
 * 한 줄 입력(선택 목록의 검색창)을 키 입력으로 고친다. line = {text, cursor(글자 단위)} 를 직접 바꾸고, 처리했으면 true.
 * 붙여넣은 줄바꿈은 공백이 되고 `limit` 글자를 넘는 입력은 버린다.
 */
export function editLine(line, event, limit = 200) {
	const parts = graphemes(line.text);
	const at = Math.max(0, Math.min(line.cursor, parts.length));
	const set = (next, cursor) => { line.text = next.join(""); line.cursor = cursor; };
	if (event.type === "text" || event.type === "paste") {
		const added = graphemes(event.type === "paste" ? String(event.text ?? "").replace(/\s*\n\s*/g, " ") : event.text);
		if (!added.length || parts.length + added.length > limit) return true;
		set([...parts.slice(0, at), ...added, ...parts.slice(at)], at + added.length);
		return true;
	}
	if (event.type !== "key") return false;
	switch (event.key) {
		case "left": line.cursor = Math.max(0, at - 1); return true;
		case "right": line.cursor = Math.min(parts.length, at + 1); return true;
		case "home": line.cursor = 0; return true;
		case "end": line.cursor = parts.length; return true;
		case "backspace": if (at > 0) set([...parts.slice(0, at - 1), ...parts.slice(at)], at - 1); return true;
		case "delete": if (at < parts.length) set([...parts.slice(0, at), ...parts.slice(at + 1)], at); return true;
		case "clear": set([], 0); return true;
		case "delete-word": {
			let start = at;
			while (start > 0 && /^\s+$/u.test(parts[start - 1])) start--;
			while (start > 0 && !/^\s+$/u.test(parts[start - 1])) start--;
			set([...parts.slice(0, start), ...parts.slice(at)], start);
			return true;
		}
		default: return false;
	}
}

function cleanPaste(value) {
	return terminalSafeText(String(value).replace(/\r\n?/g, "\n"));
}

/** Decodes raw TTY bytes (after Node's UTF-8 StringDecoder) into safe key and bracketed-paste events. */
export class TerminalInput {
	constructor(onKey) {
		this.onKey = onKey;
		this.buffer = "";
		this.pasting = false;
		this.paste = "";
		this.pasteTooLarge = false;
		this.timer = null;
	}

	feed(chunk) {
		this.buffer += String(chunk);
		this.drain();
	}

	close() {
		clearTimeout(this.timer);
		this.timer = null;
	}

	waitForSequence() {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (this.buffer === "\u001b") {
				this.buffer = "";
				this.onKey({ type: "key", key: "escape" });
			} else if (this.buffer.startsWith("\u001b")) {
				// An incomplete/unknown terminal control sequence is discarded, never inserted as text.
				this.buffer = "";
			}
			this.drain();
		}, 80);
	}

	drain() {
		for (;;) {
			if (this.pasting) {
				const end = this.buffer.indexOf(PASTE_END);
				if (end < 0) {
					let keep = Math.min(PASTE_END.length - 1, this.buffer.length);
					while (keep > 0 && !PASTE_END.startsWith(this.buffer.slice(-keep))) keep--;
					const piece = this.buffer.slice(0, this.buffer.length - keep);
					if (this.paste.length + piece.length <= MAX_PASTE_CHARS) this.paste += piece;
					else this.pasteTooLarge = true;
					this.buffer = this.buffer.slice(this.buffer.length - keep);
					return;
				}
				const piece = this.buffer.slice(0, end);
				if (this.paste.length + piece.length <= MAX_PASTE_CHARS) this.paste += piece;
				else this.pasteTooLarge = true;
				this.buffer = this.buffer.slice(end + PASTE_END.length);
				this.pasting = false;
				this.onKey({ type: "paste", text: this.pasteTooLarge ? "" : cleanPaste(this.paste), tooLarge: this.pasteTooLarge });
				this.paste = "";
				this.pasteTooLarge = false;
				continue;
			}

			if (!this.buffer) return;
			if (this.buffer.startsWith(PASTE_START)) {
				clearTimeout(this.timer);
				this.timer = null;
				this.buffer = this.buffer.slice(PASTE_START.length);
				this.pasting = true;
				this.paste = "";
				this.pasteTooLarge = false;
				continue;
			}

			if (this.buffer[0] === "\u001b") {
				const exact = [...CSI_KEYS].find(([sequence]) => this.buffer.startsWith(sequence));
				if (exact) {
					clearTimeout(this.timer);
					this.timer = null;
					this.buffer = this.buffer.slice(exact[0].length);
					this.onKey({ type: "key", key: exact[1] });
					continue;
				}
				if (ESC_PREFIXES.some((sequence) => sequence.startsWith(this.buffer))) {
					this.waitForSequence();
					return;
				}
				if (this.buffer.startsWith("\u001b]")) {
					const bel = this.buffer.indexOf("\u0007", 2);
					const st = this.buffer.indexOf("\u001b\\", 2);
					const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
					if (end < 0) { this.waitForSequence(); return; }
					this.buffer = this.buffer.slice(end + (end === bel ? 1 : 2));
					continue;
				}
				if (this.buffer.startsWith("\u001b[")) {
					const final = this.buffer.slice(2).search(/[\u0040-\u007e]/);
					if (final < 0) { this.waitForSequence(); return; }
					this.buffer = this.buffer.slice(final + 3);
					continue;
				}
				clearTimeout(this.timer);
				this.timer = null;
				this.buffer = this.buffer.slice(1);
				this.onKey({ type: "key", key: "escape" });
				continue;
			}

			const char = String.fromCodePoint(this.buffer.codePointAt(0));
			this.buffer = this.buffer.slice(char.length);
			const controls = {
				"\r": "enter", "\n": "newline", "\u0003": "interrupt", "\u0004": "eof",
				"\u0008": "backspace", "\u007f": "backspace", "\t": "tab", "\u0001": "home",
				"\u0005": "end", "\u000b": "newline", "\u0015": "clear", "\u0017": "delete-word",
				"\u0007": "ctrl-g", "\u000f": "ctrl-o", "\u0010": "ctrl-p",
				"\u0012": "ctrl-r", "\u0013": "ctrl-s", "\u0014": "ctrl-t", "\u0006": "ctrl-f",
			};
			if (controls[char]) this.onKey({ type: "key", key: controls[char] });
			else if (char.codePointAt(0) >= 0x20 && char.codePointAt(0) !== 0x7f && !(char.codePointAt(0) >= 0x80 && char.codePointAt(0) <= 0x9f)) {
				this.onKey({ type: "text", text: char });
			}
		}
	}
}
