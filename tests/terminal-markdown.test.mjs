import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { docentRemarkPlugins } from "../app/markdown-remark.mjs";
import { createTerminalMarkdown, cjkFriendlyEmphasis } from "../app/terminal-markdown.mjs";
import { createTerminalTheme } from "../app/terminal-theme.mjs";
import { terminalSafeText } from "../app/terminal-input.mjs";

const COLOR_ENV = { COLORTERM: "truecolor", TERM: "xterm-256color" };
const RICH_TEXT = [
	"# 제목",
	"",
	"**굵게**와 `코드` 그리고 [링크](https://example.com)가 섞인 문단입니다.",
	"",
	"- 외부 항목",
	"  - 내부 항목",
	"1. 첫 번째",
	"",
	"> 인용문입니다.",
	"",
	"```js",
	"const answer = 42;",
	"```",
	"",
	"| 이름 | 값 |",
	"| --- | --- |",
	"| 가 | 1 |",
].join("\n");

function plain(rows) {
	return rows.map((row) => stripVTControlCharacters(row));
}

test("terminal markdown renders real Pi structure, colors, and padding", () => {
	const theme = createTerminalTheme(COLOR_ENV);
	assert.equal(theme.enabled, true);
	const markdown = createTerminalMarkdown(theme);
	const rows = markdown.render(RICH_TEXT, 60);
	assert.ok(rows.length > 10);
	for (const row of rows) {
		assert.ok(visibleWidth(row) <= 60, `row wider than 60: ${JSON.stringify(row)}`);
	}
	const stripped = plain(rows).join("\n");
	// paddingX=1: every content row starts with the single margin space.
	for (const row of plain(rows)) {
		if (row.trim()) assert.match(row, /^ /u);
	}
	// Headings: electric blue bold (h1 also underlined), no raw '#' prefix for h1/h2.
	const headingRow = rows.find((row) => row.includes("제목"));
	assert.ok(headingRow.includes("\u001b[38;2;0;180;255m"));
	assert.ok(headingRow.includes("\u001b[1m"));
	assert.ok(headingRow.includes("\u001b[4m"));
	// Bold and inline code lose their markdown punctuation.
	assert.ok(!stripped.includes("**"));
	assert.ok(!stripped.includes("`코드`"));
	assert.ok(stripped.includes("굵게"));
	assert.ok(rows.some((row) => row.includes("\u001b[38;2;0;255;136m")), "inline code should be green");
	// Links: styled text with the URL in parentheses (no OSC 8 in any mode we emit).
	assert.ok(stripped.includes("(https://example.com)"));
	// Nested list keeps structure with indentation.
	assert.ok(stripped.includes("- 외부 항목"));
	assert.ok(stripped.includes("    - 내부 항목"));
	assert.ok(stripped.includes("1. 첫 번째"));
	// Quote border and italic quote text.
	const quoteRow = rows.find((row) => row.includes("인용문"));
	assert.ok(quoteRow.includes("\u001b[3m"));
	assert.ok(stripped.includes("│ 인용문입니다."));
	// Code fence borders and muted code block lines with indent.
	assert.ok(stripped.includes("```js"));
	const codeRow = rows.find((row) => row.includes("const answer"));
	assert.ok(codeRow.includes("\u001b[38;2;156;163;176m"));
	assert.ok(plain(rows).some((row) => row.startsWith("   const answer")));
	// Table drawn with box borders, bold header.
	assert.ok(stripped.includes("┌") && stripped.includes("┬") && stripped.includes("│"));
	assert.ok(stripped.includes("이름") && stripped.includes("가"));
	assert.ok(rows.some((row) => row.includes("\u001b[1m") && row.includes("이름")));
	// Body rows are padded to the full width for full-row backgrounds.
	assert.equal(visibleWidth(rows.find((row) => row.includes("굵게"))), 60);
});

test("terminal markdown wraps wide Korean text inside narrow widths", () => {
	const theme = createTerminalTheme(COLOR_ENV);
	const markdown = createTerminalMarkdown(theme);
	const rows = markdown.render("안녕하세요 도슨트 설명입니다", 10);
	assert.ok(rows.length > 1);
	const joined = plain(rows).map((row) => row.replace(/ /g, "")).join("");
	assert.ok(joined.includes("안녕하세요"));
	assert.ok(joined.includes("도슨트"));
	for (const row of rows) {
		assert.ok(visibleWidth(row) <= 10, `row wider than 10: ${JSON.stringify(row)}`);
	}
});

test("terminal markdown respects NO_COLOR and dumb terminals with identical layout", () => {
	const coloredTheme = createTerminalTheme(COLOR_ENV);
	const colored = plain(createTerminalMarkdown(coloredTheme).render(RICH_TEXT, 60));
	for (const env of [{ NO_COLOR: "", TERM: "xterm-256color" }, { TERM: "dumb" }]) {
		const theme = createTerminalTheme(env);
		assert.equal(theme.enabled, false);
		const rows = createTerminalMarkdown(theme).render(RICH_TEXT, 60);
		assert.ok(rows.every((row) => !row.includes("\u001b")), "plain output must not contain escape codes");
		assert.deepEqual(rows, colored);
		// MarkdownTheme functions are identity when disabled.
		assert.equal(theme.markdown.heading("제목"), "제목");
		assert.equal(theme.markdown.bold("굵게"), "굵게");
	}
});

test("terminal markdown neutralizes hostile control strings from content", () => {
	const theme = createTerminalTheme(COLOR_ENV);
	const markdown = createTerminalMarkdown(theme);
	const hostile = "문장\u001b]52;c;clipboard\u0007\u001b[2J다음\u001b[31m빨강\u001b]8;;https://evil.example\u0007링크\u001b]8;;\u0007끝";
	const rows = markdown.render(hostile, 40);
	const stripped = plain(rows).join("\n");
	assert.ok(!/\u001b\]/u.test(rows.join("")), "no OSC sequences may survive");
	assert.ok(!rows.join("").includes("\u001b[2J"));
	assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(rows.join("").replace(/\u001b\[[0-9;]*m/g, "")));
	assert.ok(stripped.includes("문장") && stripped.includes("다음") && stripped.includes("끝"));
	// The stripped escape becomes visible literal text; content text survives.
	assert.ok(stripped.includes("[31m빨강"));
	assert.ok(stripped.includes("https://evil.example"), "link URL falls back to visible text");
	assert.equal(markdown.render("", 40).length, 0);
	assert.equal(markdown.render("   \n  ", 40).length, 0);
});

test("terminal markdown caches stable content without changing results", () => {
	const theme = createTerminalTheme(COLOR_ENV);
	const markdown = createTerminalMarkdown(theme, { cacheSize: 2 });
	const first = markdown.render(RICH_TEXT, 60);
	assert.deepEqual(markdown.render(RICH_TEXT, 60), first);
	// Exceed the cache bound; every text still renders correctly.
	for (let index = 0; index < 5; index += 1) {
		const rows = markdown.render(`고유한 단락 ${index} 내용`, 40);
		assert.ok(plain(rows).join("").includes(`고유한 단락 ${index}`));
	}
	assert.ok(markdown.render(RICH_TEXT, 30).length >= first.length);
});

test("terminal theme paints full rows and spans inline segments per OMP roles", () => {
	const theme = createTerminalTheme(COLOR_ENV);
	const content = "안녕\u001b]52;c;x\u0007하세요";
	const safe = terminalSafeText(content);
	// user: white text on #243B53, full-row erase.
	const userPainted = theme.paint("user", content);
	assert.ok(userPainted.includes("\u001b[38;2;255;255;255m"));
	assert.ok(userPainted.includes("\u001b[48;2;36;59;83m"));
	assert.ok(userPainted.endsWith("\u001b[K\u001b[0m"));
	assert.equal(stripVTControlCharacters(userPainted), safe);
	// Body text and composer inherit the terminal: no codes at all.
	assert.equal(theme.paint("text", content), safe);
	assert.equal(theme.paint("composer", content), safe);
	// Semantic role colors.
	assert.ok(theme.paint("warning", "x").includes("\u001b[38;2;255;179;71m"));
	assert.ok(theme.paint("label", "x").includes("\u001b[38;2;212;192;144m"));
	assert.ok(theme.paint("dim", "x").includes("\u001b[38;2;107;114;128m"));
	assert.ok(theme.paint("path", "x").includes("\u001b[38;2;232;236;244m"));
	assert.ok(theme.paint("custom", "x").includes("\u001b[48;2;42;48;56m"));
	assert.ok(theme.paint("borderAccent", "x").includes("\u001b[38;2;0;180;255m"));
	// span: inline, no erase-to-EOL, resets only what it set.
	const modelSpan = theme.span("model", content);
	assert.ok(modelSpan.includes("\u001b[38;2;0;180;255m"));
	assert.ok(!modelSpan.includes("\u001b[K"));
	assert.ok(modelSpan.endsWith(`세요\u001b[39m`));
	assert.equal(theme.span("text", content), safe);
	assert.equal(theme.span("model", "a\u001b]52;c;x\u0007b"), "\u001b[38;2;0;180;255ma]52;c;xb\u001b[39m");
	// line: trusted content on a status row keeps segment colors over the status background.
	const statusRow = theme.line("status", theme.span("model", "gpt") + " · " + theme.span("path", "~/x"));
	assert.ok(statusRow.startsWith("\u001b[38;2;156;163;176m\u001b[48;2;15;18;22m"));
	assert.ok(statusRow.includes("\u001b[38;2;0;180;255mgpt\u001b[39m"));
	assert.ok(statusRow.endsWith("\u001b[K\u001b[0m"));
	assert.equal(stripVTControlCharacters(statusRow), "gpt · ~/x");
	// line over rendered markdown re-applies the user style after every renderer reset.
	const row = createTerminalMarkdown(theme).render("본문 `코드` 끝", 40)[0];
	const userRow = theme.line("user", row);
	assert.ok(userRow.split("\u001b[48;2;36;59;83m").length >= 3, "user background must survive renderer resets");
	assert.equal(stripVTControlCharacters(userRow), stripVTControlCharacters(row));
	// Without color, line passes trusted content through untouched.
	const plainTheme = createTerminalTheme({ NO_COLOR: "" });
	assert.equal(plainTheme.line("user", row), row);
	assert.equal(plainTheme.paint("user", content), safe);
	assert.equal(plainTheme.span("model", content), safe);
});

test("terminal theme adapts SGR color mode to the terminal", () => {
	for (const env of [{ TERM: "xterm-256color" }, { COLORTERM: "truecolor" }, { TERM: "vt100" }]) {
		const theme = createTerminalTheme(env);
		assert.equal(theme.enabled, true);
		const painted = theme.paint("user", "x");
		assert.doesNotMatch(painted, /\u001b(?:\]52|\[2J)/u);
		assert.equal(stripVTControlCharacters(painted), "x");
		if (env.TERM === "xterm-256color") {
			assert.match(painted, /\u001b\[38;5;\d+m/u);
			assert.match(painted, /\u001b\[48;5;\d+m/u);
		} else if (env.TERM === "vt100") {
			assert.match(painted, /\u001b\[\d+m/u);
		} else {
			assert.match(painted, /\u001b\[38;2;\d+;\d+;\d+m/u);
		}
	}
});

const BOLD_OPEN = "\u001b[1m";

function boldRuns(text, width = 80) {
	const rows = createTerminalMarkdown(createTerminalTheme(COLOR_ENV)).render(text, width);
	const joined = rows.join("\n");
	// Pi가 쓰는 굵게 SGR(1m)로 열고 22m으로 닫는 구간의 글자만 모은다.
	return { joined, plainText: stripVTControlCharacters(joined), runs: [...joined.matchAll(/\u001b\[1m([\s\S]*?)\u001b\[22m/gu)].map((match) => stripVTControlCharacters(match[1])) };
}

test("terminal markdown bolds ** next to Hangul when CommonMark flanking would not (ADR 0061)", () => {
	const cases = [
		["**`안녕하세요`**를 확인하세요", "안녕하세요", "안녕하세요를 확인하세요"],
		["**\"문장\"**을 읽습니다", "\"문장\"", "\"문장\"을 읽습니다"],
		["**(괄호)**는 따로 둡니다", "(괄호)", "(괄호)는 따로 둡니다"],
		["**안녕.**하세요", "안녕.", "안녕.하세요"],
		["한글**\"문장\"**을 읽습니다", "\"문장\"", "한글\"문장\"을 읽습니다"],
		["**「인용」**이라고 합니다", "「인용」", "「인용」이라고 합니다"],
	];
	for (const [source, bold, shown] of cases) {
		const { joined, plainText, runs } = boldRuns(source);
		assert.ok(joined.includes(BOLD_OPEN), `no bold SGR for ${source}`);
		assert.ok(runs.some((run) => run.includes(bold)), `bold run missing ${bold} for ${source}: ${JSON.stringify(runs)}`);
		assert.ok(!plainText.includes("**"), `literal ** left for ${source}: ${plainText}`);
		assert.ok(!joined.includes("\ufeff"), `marker leaked for ${source}`);
		assert.equal(plainText.trim(), shown);
	}
});

test("terminal markdown CJK emphasis fix keeps single * and wrapping widths intact", () => {
	const { runs, plainText } = boldRuns("*\"문장\"*을 읽습니다 그리고 **`코드`**를 봅니다", 14);
	assert.ok(!plainText.includes("*"));
	assert.ok(runs.some((run) => run.includes("코드")));
	const rows = createTerminalMarkdown(createTerminalTheme(COLOR_ENV)).render("**`안녕하세요`**를 아주 길게 이어지는 문장입니다", 14);
	for (const row of rows) assert.ok(visibleWidth(row) <= 14, JSON.stringify(row));
});

test("terminal markdown CJK emphasis fix leaves ASCII, code spans, and fences unchanged", () => {
	assert.equal(cjkFriendlyEmphasis("a**b**c and *d*"), "a**b**c and *d*");
	assert.equal(cjkFriendlyEmphasis("`**안녕.**하세요` 와 \\*\\*안녕.\\*\\*하세요"), "`**안녕.**하세요` 와 \\*\\*안녕.\\*\\*하세요");
	const fenced = "```md\n**\"문장\"**을\n**안녕.**하세요\n```\n";
	assert.equal(cjkFriendlyEmphasis(fenced), fenced);
	const tilde = "~~~\n**안녕.**하세요\n~~~";
	assert.equal(cjkFriendlyEmphasis(tilde), tilde);
	// 렌더 결과: ASCII 규칙은 그대로, 코드 범위와 코드 블록 안의 ** 는 글자 그대로 보인다.
	const ascii = boldRuns("a**b**c");
	assert.deepEqual(ascii.runs, ["b"]);
	assert.equal(ascii.plainText.trim(), "abc");
	const code = boldRuns("`**안녕.**하세요`");
	assert.equal(code.runs.length, 0);
	assert.equal(code.plainText.trim(), "**안녕.**하세요");
	const block = boldRuns(fenced);
	assert.equal(block.runs.length, 0);
	assert.ok(block.plainText.includes("**안녕.**하세요"));
	// 이미 규칙대로 강조되는 문장은 바꾸지 않는다.
	assert.equal(cjkFriendlyEmphasis("**굵게**와 `코드` 그리고 **둘째**를"), "**굵게**와 `코드` 그리고 **둘째**를");
});

// ADR 0065: 터미널은 웹과 같은 파서(remark + @streamdown/cjk)로 강조 구간을 정한다. 아래 문장들에서 두 렌더러가 같은 글자를 같은 모양으로 칠하는지 비교한다.
function webEmphasis(markdown) {
	const processor = unified().use(remarkParse);
	for (const plugin of docentRemarkPlugins()) processor.use(...(Array.isArray(plugin) ? plugin : [plugin]));
	const tree = processor.runSync(processor.parse(markdown));
	const style = { strong: "bold", emphasis: "italic", delete: "strike" };
	const text = (node) => (node.value ?? "") + (node.children ?? []).map(text).join("");
	const found = { bold: "", italic: "", strike: "" };
	const visit = (node, inside) => {
		const kind = style[node.type];
		if (kind && !inside.has(kind)) found[kind] += text(node);
		const next = kind ? new Set([...inside, kind]) : inside;
		for (const child of node.children ?? []) visit(child, next);
	};
	visit(tree, new Set());
	return found;
}

function terminalEmphasis(markdown) {
	const rows = createTerminalMarkdown(createTerminalTheme(COLOR_ENV)).render(markdown, 400);
	const codes = { 1: ["bold", true], 22: ["bold", false], 3: ["italic", true], 23: ["italic", false], 9: ["strike", true], 29: ["strike", false] };
	const state = { bold: false, italic: false, strike: false };
	const found = { bold: "", italic: "", strike: "" };
	for (const row of rows) {
		for (const part of row.split(/(\u001b\[[0-9;]*m)/u)) {
			const sgr = /^\u001b\[([0-9;]*)m$/u.exec(part);
			if (sgr) {
				for (const code of sgr[1].split(";")) if (codes[code]) state[codes[code][0]] = codes[code][1];
			} else {
				for (const kind of Object.keys(state)) if (state[kind]) found[kind] += part;
			}
		}
	}
	return found;
}

const squash = (found) => Object.fromEntries(Object.entries(found).map(([kind, value]) => [kind, value.replace(/\s+/gu, "")]));

const DIFFERENTIAL_CASES = [
	"**`안녕하세요`**를 확인하세요",
	"**\"문장\"**을 읽습니다",
	"한글**\"문장\"**을 읽습니다",
	"***\"굵게 기울임\"***을 봅니다",
	"**\"a\"** 및 *\"b\"*를 봅니다",
	"~~\"취소\"~~는 취소선입니다",
	"*\"기울임\"*을 읽고 **(괄호)**는 따로 둡니다",
	"앞 **`a`**와 뒤 **`b`**를 둘 다",
	"**「인용」**이라고 하고 *『제목』*이라고 한다",
	"***`코드`***를 보세요",
	"a**b**c 와 *d* 는 ASCII 입니다",
	"**굵게**와 `코드` 그리고 **둘째**를",
	"**안녕.**하세요 그리고 **끝!**입니다",
	"2 * 3 * 4 는 곱셈이고 **\"굵게\"**를 씁니다",
	"`**안녕.**하세요` 와 \\*\\*안녕.\\*\\*하세요",
	"**`a`**를 먼저 쓰고\n둘째 줄에 *\"b\"*를 씁니다",
	"여러 줄 코드 `a\nb **` 뒤에 **\"굵게\"**를 씁니다",
	"여러 줄 코드 `a **\nb` 와 **\"굵게\"**를 그리고 ~~\"끝\"~~은",
	"- **\"목록\"**을 읽고\n- *\"둘째\"*를 읽는다",
];

test("terminal emphasis matches the web remark pipeline node-for-node (ADR 0065)", () => {
	for (const source of DIFFERENTIAL_CASES) {
		assert.deepEqual(squash(terminalEmphasis(source)), squash(webEmphasis(source)), source);
	}
});

test("terminal emphasis pass handles *** mixes, multi-line code spans, and strikethrough", () => {
	const star3 = terminalEmphasis("***\"굵게 기울임\"***을 봅니다");
	assert.equal(star3.bold, "\"굵게 기울임\"");
	assert.equal(star3.italic, "\"굵게 기울임\"");
	const mix = terminalEmphasis("**\"a\"** 및 *\"b\"*를");
	assert.equal(mix.bold, "\"a\"");
	assert.equal(mix.italic, "\"b\"");
	assert.equal(terminalEmphasis("~~\"취소\"~~는").strike, "\"취소\"");
	const spanning = "코드 `a\nb **` 뒤 **\"굵게\"**를";
	assert.equal(terminalEmphasis(spanning).bold, "\"굵게\"");
	assert.equal(cjkFriendlyEmphasis("`a\nb **`"), "`a\nb **`");
	assert.equal(cjkFriendlyEmphasis("***\"x\"***을"), "***\"x\"***\ufeff을");
	assert.equal(cjkFriendlyEmphasis("a**b**c ASCII *d*"), "a**b**c ASCII *d*");
});
