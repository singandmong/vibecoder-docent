// 터미널 선택창 (ADR 0068). OMP 의 /resume, 모델 선택창처럼 위에 검색창, 가운데 목록, 아래에 도움말을 둔다.
// 상태 없는 함수만 둔다: 거르기, 스크롤 시작점, 한 화면 그리기. 항목의 뜻과 실행은 terminal-ui.mjs 가 안다.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { graphemes, terminalSafeText } from "./terminal-input.mjs";

/**
 * @typedef {object} SelectItem
 * @property {string} label 이름. 검색에서 가장 먼저 본다
 * @property {string} [search] 검색에만 쓰는 글(폴더, 브랜치 같은 것)
 * @property {string} [description] 이름 옆 흐린 설명. 검색에도 쓴다
 * @property {string} [tag] 이름 앞 흐린 분류
 * @property {boolean} [current] 지금 쓰는 항목이면 체크 표시
 * @property {(selected: boolean, ctx: {width: number, column: number}) => string[]} [rows] 직접 그리는 항목(여러 줄)
 * @property {boolean} [pinned] 검색해도 늘 맨 위에 남는 항목(저장 같은 동작)
 * @property {number} [previewHeight] 미리 보기에 쓸 줄 수. 없으면 목록 영역의 절반. 고르는 항목이 바뀌어도 목록이 들썩이지 않게 항목 종류마다 같게 둔다
 * @property {(width: number, lines: number) => string[]} [preview] 고른 항목의 미리 보기 줄
 */

/**
 * 공백으로 나눈 낱말이 모두 들어간 항목만 남긴다. 이름에 든 낱말, 이름 앞에서 시작하는 낱말이 있는 항목을 먼저 두고
 * 같은 점수는 받은 순서를 지킨다. 한글 글자는 그대로 비교한다.
 */
export function filterItems(items, query) {
	const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return items;
	const ranked = [];
	items.forEach((item, order) => {
		if (item.pinned) { ranked.push({ item, score: -1e9, order }); return; }
		const label = String(item.label ?? "").toLowerCase();
		const haystack = `${label} ${item.search ?? ""} ${item.description ?? ""} ${item.tag ?? ""}`.toLowerCase();
		let score = 0;
		for (const term of terms) {
			const inLabel = label.indexOf(term);
			if (inLabel >= 0) score += inLabel === 0 ? 0 : 1;
			else if (haystack.includes(term)) score += 3;
			else return;
		}
		ranked.push({ item, score, order });
	});
	return ranked.sort((a, b) => a.score - b.score || a.order - b.order).map((entry) => entry.item);
}

/**
 * 항목마다 줄 수가 다른 목록에서 고른 항목이 보이는 첫 항목 순번을 정한다. 이미 보이면 그대로 두어 스크롤이 튀지 않는다.
 * @param {(i: number) => number} heightOf 항목별 줄 수(고른 항목 근처만 부른다)
 * @param {number} count 항목 수
 * @param {number} index 고른 항목
 * @param {number} start 지금 첫 항목
 * @param {number} lines 목록에 쓸 수 있는 줄 수
 */
export function scrollStart(heightOf, count, index, start, lines) {
	if (!count) return 0;
	const target = Math.max(0, Math.min(index, count - 1));
	let first = Math.max(0, Math.min(start, target));
	let used = 0;
	for (let i = first; i <= target; i++) used += heightOf(i);
	while (first < target && used > lines) { used -= heightOf(first); first++; }
	let tail = 0; // 끝을 지나 빈칸이 남으면 앞 항목으로 채운다
	for (let i = first; i < count && tail <= lines; i++) tail += heightOf(i);
	while (first > 0 && tail + heightOf(first - 1) <= lines) { first--; tail += heightOf(first); }
	return first;
}

/** 입력 글에 커서 칸을 그린다. 색을 쓸 수 있으면 반전 칸, 아니면 막대 글자. `parts` 는 글자 배열이고 이미 안전한 글이어야 한다. */
export function withCaret(theme, parts, index) {
	const before = parts.slice(0, index).join("");
	const at = parts[index];
	const after = parts.slice(index + 1).join("");
	if (!theme.enabled) return `${before}▏${at ?? ""}${after}`;
	return `${before}\u001b[7m${at ?? " "}\u001b[27m${after}`;
}

/** 이름 · 설명 한 줄짜리 기본 항목 모양. Pi SelectList 처럼 `→` 가 고른 항목이고 설명은 맞춘 칸에서 시작한다. */
export function defaultRows(theme, item, selected, { width, column }) {
	const mark = item.current ? theme.span("success", " ✓") : "  ";
	const tag = item.tag ? theme.span("dim", `${item.tag} `) : "";
	const tagWidth = item.tag ? visibleWidth(item.tag) + 1 : 0;
	const label = truncateToWidth(terminalSafeText(item.label ?? "").replace(/\s+/g, " "), Math.max(4, Math.min(column, width - 8)), "…");
	const pad = " ".repeat(Math.max(0, column - visibleWidth(label) - tagWidth));
	const room = width - 3 - tagWidth - column - 3;
	const description = item.description && room > 8 ? theme.span("muted", truncateToWidth(terminalSafeText(item.description).replace(/\s+/g, " "), room, "…")) : "";
	return [`${selected ? theme.span("title", " → ") : "   "}${tag}${theme.span(selected ? "title" : "text", label)}${pad}${mark} ${description}`];
}

/**
 * 한 화면의 선택창 줄을 만든다. 정확히 `lines` 줄을 돌려준다.
 * 위에서부터 가로선, 제목, 검색창, (빈 줄), 목록, (미리 보기), 도움말, 가로선.
 * @param {object} view
 * @param {object} view.theme
 * @param {number} view.width
 * @param {number} view.lines 쓸 수 있는 줄 수
 * @param {string} view.title
 * @param {string} [view.detail] 제목 옆 흐린 글
 * @param {{text: string, cursor: number}} view.query 검색창
 * @param {string} view.placeholder 검색창이 비었을 때 안내
 * @param {SelectItem[]} view.items 이미 거른 항목
 * @param {number} view.total 거르기 전 항목 수
 * @param {number} view.index 고른 항목
 * @param {number} view.start 목록의 첫 항목(직전 값)
 * @param {string} view.hint 도움말 한 줄
 * @param {string} view.empty 항목이 없을 때 안내
 * @returns {{rows: {text: string, role: string, rich: boolean}[], start: number, visible: number, hits: {index: number, top: number, height: number}[], caret: {row: number, col: number}}} visible 은 목록에 통째로 보인 항목 수, hits 는 보이는 항목마다 rows 기준 시작 줄과 높이(마우스 누름 판정), caret 은 검색창 안 커서 위치(줄은 rows 기준, 칸은 0부터)
 */
export function renderSelector(view) {
	const { theme, width, lines, title, detail, query, placeholder, items, total, index, hint, empty } = view;
	const rule = { text: "─".repeat(width), role: "borderAccent", rich: false };
	const rich = (text, role = "text") => ({ text, role, rich: true });
	const gap = lines >= 10;
	const fixed = 5 + (gap ? 1 : 0); // 가로선, 제목, 검색창, 도움말, 가로선, (빈 줄)
	const available = Math.max(1, lines - fixed);
	const parts = graphemes(query.text);

	const searchLabel = " 검색 ";
	const searchText = query.text
		? withCaret(theme, parts.map((part) => terminalSafeText(part)), query.cursor)
		: `${withCaret(theme, [], 0)}${theme.span("dim", terminalSafeText(placeholder))}`;
	const caretCol = visibleWidth(searchLabel) + visibleWidth(terminalSafeText(parts.slice(0, query.cursor).join("")));

	const selectedItem = items[index];
	const wantPreview = Boolean(selectedItem?.preview) && available >= 12;
	const column = Math.min(Math.floor(width * 0.42), Math.max(8, ...items.slice(0, 200).map((item) => visibleWidth(terminalSafeText(item.label ?? "")) + (item.tag ? visibleWidth(item.tag) + 1 : 0))));
	const ctx = { width, column };
	const memo = new Map();
	const rowsOf = (i) => {
		if (!memo.has(i)) memo.set(i, items[i].rows ? items[i].rows(i === index, ctx) : defaultRows(theme, items[i], i === index, ctx));
		return memo.get(i);
	};
	let listLines = available, previewLines = 0;
	if (wantPreview && selectedItem.previewHeight) {
		previewLines = Math.min(selectedItem.previewHeight, available - 5);
		listLines = available - previewLines - 1;
	} else if (wantPreview) {
		// 항목이 적으면 목록은 필요한 만큼만 쓰고 남는 줄은 미리 보기에 준다. 많으면 목록이 대부분을 쓴다.
		const maxList = available - 7;
		let need = 0;
		for (let i = 0; i < items.length && need < maxList; i++) need += rowsOf(i).length;
		listLines = Math.max(4, Math.min(maxList, need));
		previewLines = available - listLines - 1;
	}
	const start = scrollStart((i) => rowsOf(i).length, items.length, index, view.start ?? 0, listLines);

	const rows = [rule, rich(`${theme.span("title", ` ${terminalSafeText(title)}`)}${detail ? theme.span("muted", `  ${terminalSafeText(detail)}`) : ""}`)];
	const searchRow = rows.length;
	rows.push(rich(`${theme.span("dim", searchLabel)}${searchText}`));
	if (gap) rows.push(rich(""));

	const list = [];
	const hits = [];
	let visible = 0;
	if (!items.length) list.push(rich(theme.span("muted", ` ${terminalSafeText(empty)}`)));
	for (let i = start; i < items.length && list.length < listLines; i++) {
		const built = rowsOf(i);
		const before = list.length;
		for (const text of built) if (list.length < listLines) list.push(rich(text));
		hits.push({ index: i, top: rows.length + before, height: list.length - before });
		if (list.length <= listLines && built.length) visible++;
	}
	while (list.length < listLines) list.push(rich(""));
	rows.push(...list);

	if (wantPreview) {
		rows.push({ text: "─".repeat(width), role: "border", rich: false });
		const shown = selectedItem.preview(width, previewLines).slice(0, previewLines);
		for (const text of shown) rows.push(rich(text));
	}
	while (rows.length < lines - 2) rows.push(rich("")); // 도움말과 아래 가로선은 늘 맨 아래에 둔다

	const count = items.length ? `${index + 1}/${items.length}${items.length !== total ? ` (전체 ${total})` : ""}` : `0/${total}`;
	const left = ` ${hint}`;
	const gapWidth = width - visibleWidth(left) - visibleWidth(count) - 1;
	rows.push(rich(gapWidth >= 2
		? `${theme.span("dim", left)}${" ".repeat(gapWidth)}${theme.span("muted", count)}`
		: theme.span("dim", truncateToWidth(`${left}  ${count}`, width, "…"))));
	rows.push(rule);
	return { rows: rows.slice(0, lines), start, visible: Math.max(1, visible), hits, caret: { row: searchRow, col: caretCol } };
}
