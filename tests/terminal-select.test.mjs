import assert from "node:assert/strict";
import test from "node:test";
import { editLine, layoutDraft } from "../app/terminal-input.mjs";
import { filterItems, scrollStart } from "../app/terminal-select.mjs";

test("draft layout never splits a double-width syllable and puts the caret on the row that holds it", () => {
	const { lines, caret } = layoutDraft("한글한글한", 3, 4);
	assert.deepEqual(lines.map((line) => line.join("")), ["한글", "한글", "한"]);
	assert.deepEqual(caret, { line: 1, index: 1, col: 2 }, "the caret on the 4th syllable sits on the second row");
});

test("draft layout keeps a caret at the end of a full row on that row, in the spare column", () => {
	const { lines, caret } = layoutDraft("한글", 2, 4);
	assert.equal(lines.length, 1);
	assert.deepEqual(caret, { line: 0, index: 2, col: 4 });
});

test("draft layout carries the caret across newlines and expands tabs to four columns", () => {
	const { lines, caret } = layoutDraft("a\n\tb", 3, 20);
	assert.deepEqual(lines.map((line) => line.join("")), ["a", "    b"]);
	assert.deepEqual(caret, { line: 1, index: 1, col: 4 }, "the caret before b follows the four-column tab");
	assert.deepEqual(layoutDraft("a\n", 2, 20).caret, { line: 1, index: 0, col: 0 }, "the caret after a trailing newline opens a new empty row");
});

test("selector filtering needs every term, prefers name matches, and keeps the received order otherwise", () => {
	const items = [
		{ label: "알파 세션", search: "저장소 beta" },
		{ label: "베타 작업", search: "" },
		{ label: "감마", search: "beta 저장소" },
		{ label: "델타", description: "베타 설명" },
	];
	assert.deepEqual(filterItems(items, "베타").map((item) => item.label), ["베타 작업", "델타"]);
	assert.deepEqual(filterItems(items, "beta 저장소").map((item) => item.label), ["알파 세션", "감마"], "ties keep the list order");
	assert.deepEqual(filterItems(items, "  ").length, 4, "a blank query keeps everything");
	assert.deepEqual(filterItems(items, "없는말"), []);
});

test("list scrolling keeps the choice visible, stays put while it is visible, and fills the screen at the end", () => {
	const heights = [3, 3, 3, 3, 3, 3];
	const heightOf = (i) => heights[i];
	assert.equal(scrollStart(heightOf, 6, 1, 0, 9), 0, "already visible: no jump");
	assert.equal(scrollStart(heightOf, 6, 3, 0, 9), 1, "scrolls just far enough to show the choice");
	assert.equal(scrollStart(heightOf, 6, 5, 4, 9), 3, "at the end the window still ends on the last item");
	assert.equal(scrollStart(heightOf, 6, 2, 5, 9), 2, "moving above the window puts the choice at its top");
	assert.equal(scrollStart((i) => [1, 5, 1][i], 3, 2, 0, 5), 2, "uneven heights count by lines: the 5-line item no longer fits above the choice");
});

test("search editing handles Hangul syllables whole, joins pasted lines, and respects the limit", () => {
	const line = { text: "", cursor: 0 };
	editLine(line, { type: "text", text: "한" });
	editLine(line, { type: "text", text: "글" });
	assert.deepEqual(line, { text: "한글", cursor: 2 });
	editLine(line, { type: "key", key: "left" });
	editLine(line, { type: "text", text: "-" });
	assert.deepEqual(line, { text: "한-글", cursor: 2 });
	editLine(line, { type: "key", key: "backspace" });
	editLine(line, { type: "key", key: "backspace" });
	assert.deepEqual(line, { text: "글", cursor: 0 });
	editLine(line, { type: "paste", text: "첫 줄\n둘째 줄" });
	assert.equal(line.text, "첫 줄 둘째 줄글");
	editLine(line, { type: "key", key: "clear" });
	assert.deepEqual(line, { text: "", cursor: 0 });
	assert.equal(editLine(line, { type: "key", key: "enter" }), false, "keys it does not own are left to the caller");
	editLine(line, { type: "text", text: "가".repeat(5) }, 3);
	assert.equal(line.text, "", "input beyond the limit is dropped, not truncated");
});

test("a pinned item stays on top whatever the search says", () => {
	const items = [{ label: "범위 저장", pinned: true }, { label: "알파" }, { label: "베타" }];
	assert.deepEqual(filterItems(items, "베타").map((item) => item.label), ["범위 저장", "베타"]);
	assert.deepEqual(filterItems(items, "없는말").map((item) => item.label), ["범위 저장"]);
});
