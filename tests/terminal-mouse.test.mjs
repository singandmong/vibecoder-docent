import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInput } from "../app/terminal-input.mjs";
import { highlightRow, indexAtColumn, rowRange, selectedText, wordRange } from "../app/terminal-mouse.mjs";

const events = (...chunks) => {
	const seen = [];
	const input = new TerminalInput((event) => seen.push(event));
	for (const chunk of chunks) input.feed(chunk);
	input.close();
	return seen;
};

test("SGR mouse reports become zero-based press, drag, release and wheel events, even when split across reads", () => {
	const seen = events("\u001b[<0;5;3M", "\u001b[<32;6;3M\u001b[<0;6;3m", "\u001b[<6", "4;1;1M\u001b[<65;1;1M", "\u001b[<2;1;1M\u001b[<35;9;9M\u001b[<66;1;1M");
	assert.deepEqual(seen.map(({ action, button, x, y, delta }) => [action, button, x, y, delta]), [
		["press", "left", 4, 2, 0],
		["drag", "left", 5, 2, 0],
		["release", "left", 5, 2, 0],
		["wheel", null, 0, 0, -1],
		["wheel", null, 0, 0, 1],
		["press", "right", 0, 0, 0],
	], "plain motion without a button and horizontal wheels are dropped");
});

test("a mouse report never leaks into typed text or swallows the keys around it", () => {
	const seen = events("가\u001b[<0;1;1M나\r");
	assert.deepEqual(seen.map((event) => event.type === "text" ? event.text : event.type === "mouse" ? "mouse" : event.key), ["가", "mouse", "나", "enter"]);
});

test("selected text keeps double-width syllables whole at the edges and joins rows without trailing spaces", () => {
	const rows = ["가나다라   ", "abc def  ", "마바사"];
	assert.equal(selectedText(rows, { anchor: { row: 0, col: 1 }, focus: { row: 0, col: 3 } }), "가나", "cells 1..3 touch the first two syllables");
	assert.equal(selectedText(rows, { anchor: { row: 0, col: 4 }, focus: { row: 2, col: 1 } }), "다라\nabc def\n마", "middle rows are whole, the last row ends at the focus cell");
	assert.equal(selectedText(rows, { anchor: { row: 2, col: 3 }, focus: { row: 0, col: 2 } }), "나다라\nabc def\n마바", "a backwards drag selects the same cells");
	assert.deepEqual(rowRange({ anchor: { row: 1, col: 3 }, focus: { row: 3, col: 5 } }, 2, 80), { start: 0, end: 80 });
	assert.equal(rowRange({ anchor: { row: 1, col: 3 }, focus: { row: 3, col: 5 } }, 4, 80), null);
});

test("a double click takes the whole word, including path and kebab characters, or just the one cell it hit", () => {
	assert.deepEqual(wordRange(" see src/app-ui.mjs now", 8), { start: 5, end: 18 });
	assert.deepEqual(wordRange("한글 단어", 1), { start: 0, end: 3 }, "a Hangul word spans its double-width cells");
	assert.deepEqual(wordRange("a  b", 1), { start: 1, end: 1 }, "a space selects just itself");
	assert.equal(wordRange("abc", 9), null, "outside the text");
});

test("highlighting reverses only the selected cells and leaves the rest alone", () => {
	assert.equal(highlightRow("가나다", { start: 2, end: 4 }), "가\u001b[7m나\u001b[27m다");
	assert.equal(highlightRow("가나다", { start: 3, end: 4 }), "가\u001b[7m나\u001b[27m다", "a range that hits half a syllable takes it whole");
	assert.equal(highlightRow("abc", { start: 5, end: 9 }), "abc", "a range past the text changes nothing");
});

test("a column maps to the glyph under it, and past the end to just after the last glyph", () => {
	assert.equal(indexAtColumn(["가", "나", "다"], 0), 0);
	assert.equal(indexAtColumn(["가", "나", "다"], 3), 1);
	assert.equal(indexAtColumn(["가", "나", "다"], 4), 2);
	assert.equal(indexAtColumn(["가", "나", "다"], 40), 3);
	assert.equal(indexAtColumn(["a", "    ", "b"], 3), 1, "a tab shown as four spaces is one glyph");
});
