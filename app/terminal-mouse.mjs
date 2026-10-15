// 터미널 마우스 글자 선택 (ADR 0070). 마우스 보고를 켜면 터미널이 글자 선택을 못 하므로 OMP 전체 화면 모드와 Herdr처럼
// 앱이 끌어서 고르기(복사), 두 번 눌러 낱말 고르기를 맡는다. 화면 칸 기준이라 상태 없는 함수로만 둔다.
import { visibleWidth } from "@earendil-works/pi-tui";
import { graphemes } from "./terminal-input.mjs";

/** 한 줄(평문)을 글자와 칸 범위 목록으로. 칸은 0부터이고 끝은 포함하지 않는다. */
export function cellsOf(plain) {
	let column = 0;
	return graphemes(plain).map((text) => {
		const width = Math.max(0, visibleWidth(text));
		const cell = { text, start: column, end: column + width };
		column += width;
		return cell;
	});
}

/** 앞선 쪽이 먼저 오게 anchor 와 focus 를 정렬한다. */
export function orderedSelection(selection) {
	const { anchor, focus } = selection;
	return anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col) ? [anchor, focus] : [focus, anchor];
}

/** 그 줄에서 고른 칸 범위 {start, end(미포함)}. 고르지 않은 줄은 null. 가운데 줄은 줄 전체, 끝 칸은 포함한다. */
export function rowRange(selection, row, columns) {
	const [first, last] = orderedSelection(selection);
	if (row < first.row || row > last.row) return null;
	return { start: row === first.row ? first.col : 0, end: row === last.row ? last.col + 1 : columns };
}

/** 고른 칸의 글을 줄바꿈으로 이은 글. 줄 끝 공백은 뺀다. 칸 끝에 걸친 넓은 글자는 통째로 넣는다. */
export function selectedText(plainRows, selection) {
	const [first, last] = orderedSelection(selection);
	const lines = [];
	for (let row = first.row; row <= last.row; row++) {
		const plain = plainRows[row] ?? "";
		const range = rowRange(selection, row, Math.max(visibleWidth(plain), 1));
		lines.push(cellsOf(plain).filter((cell) => cell.end > range.start && cell.start < range.end).map((cell) => cell.text).join("").trimEnd());
	}
	return lines.join("\n").replace(/\s+$/u, "");
}

/** 평문 줄에서 고른 범위를 반전해 돌려준다. 글자는 넓은 글자가 걸치면 통째로 반전한다. */
export function highlightRow(plain, range) {
	let before = "", middle = "", after = "";
	for (const cell of cellsOf(plain)) {
		if (cell.end <= range.start) before += cell.text;
		else if (cell.start >= range.end) after += cell.text;
		else middle += cell.text;
	}
	return middle ? `${before}\u001b[7m${middle}\u001b[27m${after}` : plain;
}

const WORD = /[\p{L}\p{N}_/.\-~@]/u;

/** 누른 칸의 낱말 칸 범위 {start, end(포함)}. 글자, 숫자와 경로에 쓰는 `_ / . - ~ @` 가 이어진 만큼. 낱말이 아니면 그 칸 하나. */
export function wordRange(plain, column) {
	const cells = cellsOf(plain);
	const at = cells.findIndex((cell) => column >= cell.start && column < cell.end);
	if (at < 0) return null;
	const isWord = (cell) => WORD.test(cell.text);
	if (!isWord(cells[at])) return { start: cells[at].start, end: cells[at].end - 1 };
	let from = at, to = at;
	while (from > 0 && isWord(cells[from - 1])) from--;
	while (to < cells.length - 1 && isWord(cells[to + 1])) to++;
	return { start: cells[from].start, end: cells[to].end - 1 };
}

/** 칸 위치를 글자 목록(줄 안의 글자 배열)의 글자 순번으로. 줄 끝을 넘으면 마지막 글자 뒤. */
export function indexAtColumn(parts, column) {
	let used = 0;
	for (let i = 0; i < parts.length; i++) {
		const width = Math.max(0, visibleWidth(parts[i]));
		if (column < used + width) return i;
		used += width;
	}
	return parts.length;
}
