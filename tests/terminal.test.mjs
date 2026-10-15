import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInput, terminalSafeText } from "../app/terminal-input.mjs";
import { PassThrough, Writable } from "node:stream";
import { agoLabel, runTerminal } from "../app/terminal-ui.mjs";
import { fixture, secondModel, until } from "./omp-fixture.mjs";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { createTerminalTheme } from "../app/terminal-theme.mjs";
import { answerFocus } from "../app/conversations.mjs";

/** stage: "thread"(기본) 세션과 대화를 고르고 대화 화면까지, "conversations" 세션만 고르고 대화 선택창에서 멈춤, "sessions" 세션 선택창에서 멈춤. */
async function terminal(t, baseUrl, { stage = "thread" } = {}) {
	const stdin = new PassThrough();
	stdin.isTTY = true;
	stdin.setRawMode = (value) => { stdin.isRaw = value; };
	let screen = "", frames = 0, closed = false, grid = [], patchedRows = null, cursor = null, other = "";
	const copied = [];
	// 화면 전체를 그리는 프레임과 바뀐 줄만 고치는 프레임을 모두 반영한 가상 화면. 진짜 커서 위치(1부터)와 보임도 따라간다.
	const stdout = new Writable({ write(chunk, _encoding, done) {
		const text = String(chunk);
		if (text.includes("\u001b[?2026h")) {
			const place = [...text.matchAll(/\u001b\[(\d+);(\d+)H\u001b\[\?25([lh])\u001b\[\?2026l$/g)].at(-1);
			if (place) cursor = { row: Number(place[1]), col: Number(place[2]), visible: place[3] === "h" };
			const body = text.replace(/\u001b\[\?(?:2026|25)[hl]/g, "").replace(/\u001b\[\d+;\d+H$/, "");
			if (body.startsWith("\u001b[2J\u001b[H")) { grid = body.slice(7).split("\r\n"); patchedRows = null; }
			else {
				const parts = body.split(/\u001b\[(\d+);1H\u001b\[0m\u001b\[2K/);
				for (let i = 1; i < parts.length; i += 2) grid[Number(parts[i]) - 1] = parts[i + 1];
				patchedRows = (parts.length - 1) / 2;
			}
			screen = stripVTControlCharacters(grid.join("\r\n"));
			frames++;
		}
		else other += text;
		done();
	} });
	Object.assign(stdout, { isTTY: true, columns: 84, rows: 31 });
	const finished = runTerminal({ baseUrl, stdin, stdout, env: {}, copy: (text) => copied.push(text) });
	finished.catch(() => {});
	const ui = {
		get screen() { return screen; },
		/** 진짜 터미널 커서의 마지막 위치({row, col, visible}, 1부터). */
		get cursor() { return cursor; },
		/** 마지막 프레임이 고친 줄 수. 전체를 다시 그렸으면 null. */
		get patchedRows() { return patchedRows; },
		/** 프레임이 아닌 출력(마우스 보고 켜기·끄기, 제목 같은 것). */
		get other() { return other; },
		/** 마우스로 고르거나 두 번 눌러 복사한 글 목록. */
		copied,
		send: (keys) => stdin.write(keys),
		/** SGR 마우스 입력. 좌표는 화면의 0부터. action: press, release, drag, wheel-up, wheel-down. */
		mouse(action, x, y, { shift = false } = {}) {
			const code = { press: 0, release: 0, drag: 32, "wheel-up": 64, "wheel-down": 65 }[action] | (shift ? 4 : 0);
			stdin.write(`\u001b[<${code};${x + 1};${y + 1}${action === "release" ? "m" : "M"}`);
		},
		finished,
		async key(keys) { const before = frames; stdin.write(keys); await until(() => frames > before); },
		async resize(columns, rows) { const before = frames; Object.assign(stdout, { columns, rows }); stdout.emit("resize"); await until(() => frames > before); },
		async close() {
			if (closed) return;
			closed = true;
			stdin.write("\u0004"); await finished;
			assert.equal(stdin.isRaw, false);
			stdin.destroy(); stdout.destroy();
		},
	};
	t.after(() => ui.close());
	// 세션을 고르면 대화 선택창이 이어서 열린다. 대화는 기본 항목(카드가 없으면 세션 전체 대화)으로 연다.
	await until(() => screen.includes("세션 선택"));
	if (stage === "sessions") return ui;
	await ui.key("\r");
	await until(() => screen.includes("대화 선택"));
	if (stage === "conversations") return ui;
	await ui.key("\r");
	return ui;
}

async function choose(ui, shortcut, label) {
	await ui.key(shortcut);
	for (let i = 0; i < 20; i++) {
		const selected = ui.screen.split(/\r?\n/).find((line) => line.includes("→"));
		if (selected?.includes(label)) { await ui.key("\r"); return; }
		await ui.key("\u001b[B");
	}
	assert.fail(`선택 목록에서 ${label} 항목을 찾지 못했어요.\n${ui.screen}`);
}

test("terminal output strips cursor controls and bidi overrides", () => {
	const text = terminalSafeText("한국어\u001b[2J\u001b]52;clipboard\u0007\u202e화면");
	assert.equal(text, "한국어[2J]52;clipboard화면");
	assert.doesNotMatch(text, /[\u001b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
});

test("bracketed paste preserves Korean multiline text across split delimiters and strips controls", () => {
	const events = [];
	const input = new TerminalInput((event) => events.push(event));
	input.feed("\u001b[200~첫 줄\r\n둘째 줄\u001b[31m\u001b[20");
	input.feed("1~");
	assert.deepEqual(events, [{ type: "paste", text: "첫 줄\n둘째 줄[31m", tooLarge: false }]);
	input.close();
});

test("raw UTF-8 key input keeps committed Korean text separate from Enter", () => {
	const events = [];
	const input = new TerminalInput((event) => events.push(event));
	input.feed("한글 질문\r");
	assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "한글 질문");
	assert.deepEqual(events.at(-1), { type: "key", key: "enter" });
	input.close();
});

test("application cursor mode arrows are keys, not typed text, even when split", () => {
	const events = [];
	const input = new TerminalInput((event) => events.push(event));
	input.feed("\u001bOB\u001b");
	input.feed("OA");
	assert.deepEqual(events, [{ type: "key", key: "down" }, { type: "key", key: "up" }]);
	input.close();
});

test("session card time switches unit at the hour, day and week boundaries", () => {
	const now = Date.parse("2026-10-11T12:00:00Z");
	const ago = (ms) => agoLabel(new Date(now - ms).toISOString(), now);
	const minute = 60_000, hour = 60 * minute, day = 24 * hour;
	assert.deepEqual(
		[ago(59_999), ago(minute), ago(hour - 1), ago(hour), ago(day - 1), ago(day), ago(7 * day - 1)],
		["방금", "1분 전", "59분 전", "1시간 전", "23시간 전", "1일 전", "6일 전"],
	);
	assert.match(ago(7 * day), /^\d+월 \d+일$/);
	assert.equal(agoLabel("not a date", now), "시각 정보 없음");
});

test("terminal cancellation restores the question and a resent answer remains visible", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 1000 });
	const ui = await terminal(t, f.address);
	ui.send("멈춘 질문을 다시 보내요\r");
	await until(async () => (await f.api(`/api/jobs?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	ui.send("\u0003");
	await until(() => ui.screen.includes("멈춘 질문을 다시 보내요") && ui.screen.includes("중단했어요"));
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body, []);
	await f.control({});
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	await until(() => ui.screen.includes("설명 깊이와 출력을 줄이지 않은 답변입니다."));
	const rows = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body;
	assert.deepEqual(rows.map((row) => row.question), ["멈춘 질문을 다시 보내요"]);
	await ui.close();
});

test("Enter during an explanation becomes a queued question that is sent after the answer", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 200 });
	const ui = await terminal(t, f.address);
	ui.send("첫 질문\r");
	await until(async () => (await f.calls()).some((call) => call.pid));
	await ui.key("이어서 물을 질문\r");
	await until(() => ui.screen.includes("대기 질문 1"));
	assert.equal((await f.api(`/api/jobs?id=${encodeURIComponent(f.sessionId)}`)).body.length, 1, "the queued question waits for the running explanation");
	await f.control({});
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 2, 15000);
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.map((row) => row.question), ["첫 질문", "이어서 물을 질문"]);
	await until(() => ui.screen.includes("설명이 끝났어요") && !ui.screen.includes("대기 질문 1"));
});

test("a disconnected explanation rejoins the same request, and a question typed meanwhile waits its turn", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 100 });
	const requests = [];
	const proxy = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		const upstream = request(new URL(req.url, f.address), { method: req.method, headers: req.headers }, (response) => {
			res.writeHead(response.statusCode, response.headers);
			if (req.url === "/api/ask") {
				requests.push(JSON.parse(body));
				if (requests.length === 1) {
					response.once("data", (chunk) => { res.end(chunk); response.destroy(); });
					return;
				}
			}
			response.pipe(res);
			res.on("close", () => response.destroy());
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	const ui = await terminal(t, `http://127.0.0.1:${proxy.address().port}`);
	try {
		ui.send("연결이 끊겨도 한 번만 설명해요\r");
		await until(() => ui.screen.includes("연결이 끊겼어요"));
		await ui.key("중복 요청을 보내면 안 돼요\r");
		assert.equal(requests.length, 1, "a question typed while disconnected is not sent before the rejoined answer");
		assert.ok(ui.screen.includes("대기 질문 1"), ui.screen);
		ui.send("\u0012\u0012");
		await until(() => ui.screen.includes("설명 깊이와 출력을 줄이지 않은 답변입니다."));
		assert.deepEqual(requests[1], requests[0]);
		await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 2, 15000);
		assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.map((row) => row.question), ["연결이 끊겨도 한 번만 설명해요", "중복 요청을 보내면 안 돼요"]);
		assert.deepEqual(requests.map((entry) => entry.question), ["연결이 끊겨도 한 번만 설명해요", "연결이 끊겨도 한 번만 설명해요", "중복 요청을 보내면 안 돼요"]);
		assert.equal((await f.calls()).filter((call) => call.pid).length, 2, "the rejoined request is explained once");
	} finally {
		await ui.close();
		proxy.closeAllConnections();
		await new Promise((resolve) => proxy.close(resolve));
	}
});

test("typing a letter rewrites only the changed rows, and the real cursor follows the caret", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	const lineAt = () => ui.screen.split(/\r?\n/)[ui.cursor.row - 1];
	await ui.key("가");
	assert.ok(ui.patchedRows !== null && ui.patchedRows <= 2, `expected a partial update, got ${ui.patchedRows} rows`);
	assert.ok(ui.cursor.visible, "the cursor must stay visible so the IME can attach its composition to it");
	assert.match(lineAt(), /^ 가/);
	assert.equal(ui.cursor.col, 4, "caret after a one-space pad and a double-width Hangul syllable");
	await ui.key("\u007f");
	assert.ok(ui.patchedRows !== null && ui.patchedRows <= 2);
	assert.equal(ui.cursor.col, 2);
	assert.match(lineAt(), /궁금한 내용을 입력하세요/);
});

test("composer letters remain literal and picker cancellation preserves the draft and caret", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("qi! 가나\u001b[D");
	for (const shortcut of ["\u0010", "\u0014", "\u000f", "\u0007"]) {
		await ui.key(shortcut);
		await ui.key("\u001b");
	}
	await ui.resize(40, 16);
	assert.ok(ui.screen.split(/\r?\n/).length <= 16, "composer and status must fit inside the terminal");
	await ui.resize(84, 31);
	await ui.key("\u0003");
	ui.send("X\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.map((row) => row.question), ["qi! 가X나"]);
});

test("conversation drafts stay separate and selecting a saved answer neither calls the model nor changes its thread", async (t) => {
	const f = await fixture(t);
	const a = { label: "대화 A", text: "A 질문 대상" }, b = { label: "대화 B", text: "B 질문 대상" };
	await f.ask("a-one", "default", { question: "A 첫 질문", focus: a });
	await f.ask("a-two", "default", { question: "A 두 번째 질문", focus: a });
	await f.ask("b-one", "default", { question: "B 첫 질문", focus: b });
	const original = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body;
	const threadA = original.find((row) => row.question === "A 첫 질문").thread;
	const threadB = original.find((row) => row.question === "B 첫 질문").thread;
	const ui = await terminal(t, f.address);
	await ui.key("전체 초안");
	await choose(ui, "\u0014", "대화 A");
	await ui.key("A 초안");
	await choose(ui, "\u0014", "대화 B");
	await ui.key("B 초안");
	await choose(ui, "\u0014", "대화 A");
	await ui.key("\u0001앞-");
	await choose(ui, "\u000f", "A 첫 질문");
	assert.equal((await f.calls()).filter((call) => call.pid).length, 3, "navigation must not call the explanation model");
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 4);
	await choose(ui, "\u0014", "대화 B");
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 5);
	await choose(ui, "\u0014", "세션 전체");
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 6);
	const rows = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body;
	assert.deepEqual(rows.slice(3).map((row) => [row.question, row.thread]), [["앞-A 초안", threadA], ["B 초안", threadB], ["전체 초안", ""]]);
});

test("steering restores the next-question draft and keeps the correction in the original record", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 1000 });
	const ui = await terminal(t, f.address);
	ui.send("원래 질문\r");
	await until(async () => (await f.calls()).some((call) => call.pid));
	await ui.key("다음 질문 초안");
	await ui.key("\u0013");
	await f.control({});
	ui.send("보정을 반영해줘\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	await until(() => ui.screen.includes("다음 질문 초안") && ui.screen.includes("보정을 반영했어요."));
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 2);
	const rows = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body;
	assert.deepEqual(rows.map((row) => row.question), ["원래 질문", "다음 질문 초안"]);
	assert.deepEqual(rows[0].steers, ["보정을 반영해줘"]);
});

test("terminal theme respects plain output and prevents content from issuing terminal controls", () => {
	const content = "문장\u001b]52;c;clipboard\u0007\u001b[2J끝";
	for (const env of [{ NO_COLOR: "", TERM: "xterm-256color" }, { TERM: "dumb" }]) {
		const theme = createTerminalTheme(env);
		assert.equal(theme.enabled, false);
		assert.equal(theme.paint("selected", content), terminalSafeText(content));
	}
	for (const env of [{ COLORTERM: "truecolor" }, { TERM: "xterm-256color" }, { TERM: "vt100" }]) {
		const painted = createTerminalTheme(env).paint("selected", content);
		assert.equal(stripVTControlCharacters(painted), terminalSafeText(content));
		assert.doesNotMatch(painted, /\u001b(?:\]52|\[2J)/u);
	}
});

test("switching profiles restores each composer's draft without sending it under the other profile", async (t) => {
	const f = await fixture(t);
	const other = (await f.api("/api/profiles", "POST", { name: "다른 프로필" })).body;
	const ui = await terminal(t, f.address);
	await ui.key("기본 프로필의 초안");
	await choose(ui, "\u0007", "다른 프로필");
	await ui.key("다른 프로필의 초안");
	await choose(ui, "\u0007", "기본 (기본)");
	ui.send("\r");
	await until(async () => (await f.api("/api/history?profileId=default")).body.length === 1);
	assert.equal((await f.api("/api/history?profileId=default")).body[0].question, "기본 프로필의 초안");
	assert.deepEqual((await f.api(`/api/history?profileId=${other.id}`)).body, []);
	await choose(ui, "\u0007", "다른 프로필");
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?profileId=${other.id}`)).body.length === 1);
	assert.equal((await f.api(`/api/history?profileId=${other.id}`)).body[0].question, "다른 프로필의 초안");
});

test("the real cursor stays on the editing point through soft wraps and resize", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	const lineAt = () => ui.screen.split(/\r?\n/)[ui.cursor.row - 1];
	await ui.key("한".repeat(500));
	assert.match(lineAt(), /^ 한+▏?\s*$/, "soft-wrapped text must scroll with its caret");
	assert.equal(ui.cursor.col, 2 + 2 * (500 % 41), "82 columns hold 41 syllables per row");
	await ui.resize(40, 16);
	assert.ok(ui.cursor.row <= 16, "the cursor must stay inside the narrowed terminal");
	assert.match(lineAt(), /^ 한+▏?\s*$/);
	assert.equal(ui.cursor.col, 2 + 2 * (500 % 19), "38 columns hold 19 syllables per row");
	await ui.key("\u0001");
	assert.match(lineAt(), /^ ▏?한+/);
	assert.equal(ui.cursor.col, 2, "moving to the start puts the cursor on the first syllable");
});

test("the whole-session conversation's answer picker excludes answers from card threads", async (t) => {
	const f = await fixture(t);
	await f.ask("whole", "default", { question: "전체 대상 질문" });
	await f.ask("card", "default", { question: "카드 대상 질문", focus: { label: "카드 대화", text: "다른 질문 대상" } });
	const ui = await terminal(t, f.address);
	await ui.key("\u000f");
	assert.ok(ui.screen.includes("전체 대상 질문"));
	assert.equal(ui.screen.includes("카드 대상 질문"), false);
	await ui.key("\r");
	ui.send("선택한 전체 대화에 이어 묻기\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 3);
	const row = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.find((entry) => entry.question === "선택한 전체 대화에 이어 묻기");
	assert.equal(row.thread, "");
});

test("the whole-session conversation shows its re-explained answer and lists no separate saved conversation for it", async (t) => {
	const f = await fixture(t);
	await f.ask("whole", "default", { question: "전체 대상 질문" });
	const [first] = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body;
	await f.ask("again", "default", { question: "다른 방식으로 다시 설명해줘", focus: answerFocus(first.answer) });
	const ui = await terminal(t, f.address);
	await ui.key("\u000f");
	assert.ok(ui.screen.includes("전체 대상 질문"), ui.screen);
	assert.ok(ui.screen.includes("다른 방식으로 다시 설명해줘"), ui.screen);
	await ui.key("\u001b");
	await ui.key("\u0014");
	assert.ok(ui.screen.includes("대화 선택"), ui.screen);
	assert.ok(ui.screen.includes("저장 0"), ui.screen);
	assert.equal(ui.screen.includes("저장 대화"), false, ui.screen);
});

test("cancelling does not overwrite a newer unsent composer draft", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 1000 });
	const ui = await terminal(t, f.address);
	ui.send("중단할 질문\r");
	await until(async () => (await f.calls()).some((call) => call.pid));
	await ui.key("이미 작성한 다음 질문");
	ui.send("\u0003");
	await until(() => ui.screen.includes("중단했어요") && ui.screen.includes("이미 작성한 다음 질문"));
	await f.control({});
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.map((row) => row.question), ["이미 작성한 다음 질문"]);
});

test("trigger menus switch conversation and settings in place, and never send the trigger as a question", async (t) => {
	const f = await fixture(t);
	await f.ask("card", "default", { question: "카드 첫 질문", focus: { label: "카드 대화", text: "카드 질문 대상" } });
	const cardThread = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body[0].thread;
	const ui = await terminal(t, f.address);
	await ui.key("/대");
	assert.ok(ui.screen.includes("/대화"), ui.screen);
	await ui.key("\r");
	await until(() => ui.screen.includes("대화 선택") && ui.screen.includes("카드 대화"));
	await ui.key("카드");
	await ui.key("\r");
	ui.send("카드에 이어 묻기\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 2);
	const rows = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body;
	assert.deepEqual(rows.map((row) => [row.question, row.thread]), [["카드 첫 질문", cardThread], ["카드에 이어 묻기", cardThread]]);
	await ui.key("$hard");
	await ui.key("\r");
	await until(async () => (await f.api("/api/profiles")).body.find((profile) => profile.id === "default").defaultDifficulty === "HARD");
	assert.equal((await f.calls()).filter((call) => call.pid).length, 2, "menus must not call the explanation model");
});

test("commands show Korean and English names and either name runs the command", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("/s");
	const listed = ui.screen.split(/\r?\n/).filter((line) => /\/\S+ \(\w+\)/.test(line)).map((line) => line.match(/\/(\S+) \((\w+)\)/).slice(1).join(" "));
	assert.deepEqual(listed.slice(0, 2), ["세션 session", "설정 settings"], ui.screen);
	await ui.key("\u0015");
	await ui.key("/exit");
	assert.match(ui.screen.split(/\r?\n/).find((line) => line.includes("→")) ?? "", /\/종료 \(exit\)/);
	ui.send("\r");
	await ui.finished;
});

test("review command opens the searchable glossary selector without calling the model", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("/review");
	assert.match(ui.screen, /\/복습 \(review\)/, ui.screen);
	await ui.key("\r");
	await until(() => ui.screen.includes("배운 내용 다시보기"));
	assert.match(ui.screen, /용어 사전|아직 모인 용어가 없어요/, ui.screen);
	assert.equal((await f.calls()).filter((call) => call.pid).length, 0);
});

test("a leading @ # $ opens its selector instead of entering the draft, and a leading space keeps it literal", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("#1 오류가 뭐야");
	assert.ok(ui.screen.includes("대화 선택") && ui.screen.includes("맞는 대화가 없어요"), ui.screen);
	assert.equal(ui.cursor.row, 7, "while a selector is open the cursor sits in its search field, below the 4-row boxed header");
	await ui.key("\r");
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body, []);
	await ui.key("\u001b");
	assert.ok(ui.screen.includes("대화 선택"), "the first Esc only clears the search");
	await ui.key("\u001b");
	assert.equal(ui.screen.includes("대화 선택"), false, "the second Esc closes the selector");
	await ui.key(" #1 오류가 뭐야");
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	assert.equal((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body[0].question, "#1 오류가 뭐야");
});

test("the @ session picker shows the Herdr workspace name on the session card", async (t) => {
	const f = await fixture(t);
	// 서버가 붙인 herdr 필드를 대신해 목록 응답에 넣는 얇은 중계. 나머지 요청은 그대로 넘긴다.
	const proxy = createServer((req, res) => {
		const upstream = request(new URL(req.url, f.address), { method: req.method, headers: req.headers }, (response) => {
			if (req.url !== "/api/sessions") { res.writeHead(response.statusCode, response.headers); response.pipe(res); return; }
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				const list = JSON.parse(body).map((session) => ({ ...session, herdr: { workspace: "w3", label: "워드프레스 리팩터링", number: 3, pane: "w3:p2" } }));
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(list));
			});
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	t.after(() => proxy.close());
	const ui = await terminal(t, `http://127.0.0.1:${proxy.address().port}`);
	await ui.key("@");
	assert.match(ui.screen, /워드프레스 리팩터링/, ui.screen);
	await ui.key("\u001b");
	await ui.key("@워드");
	assert.match(ui.screen, /워드프레스 리팩터링/, "the workspace name is searchable");
});

const askEvent = (id, question, timestamp) => ({
	type: "assistant", uuid: id, timestamp,
	message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${id}`, name: "AskUserQuestion", input: { questions: [{ question, options: [{ label: "Supabase Realtime", description: "이미 보유" }] }] } }] },
});

test("picking a session opens the conversation selector on the newest card, previews its AI output, and Enter reads it", async (t) => {
	const f = await fixture(t);
	await f.appendSession(askEvent("a1", "첫 번째로 물어본 질문", "2026-01-01T00:02:00Z"));
	await f.appendSession(askEvent("a2", "두 번째로 물어본 질문", "2026-01-01T00:03:00Z"));
	const ui = await terminal(t, f.address, { stage: "conversations" });
	await until(() => ui.screen.includes("두 번째로 물어본 질문") && ui.screen.includes("첫 번째로 물어본 질문"));
	const lines = ui.screen.split(/\r?\n/);
	const at = (text) => lines.findIndex((line) => line.includes(text));
	assert.ok(at("세션 전체 대화") < at("두 번째로 물어본 질문") && at("두 번째로 물어본 질문") < at("첫 번째로 물어본 질문"), "the whole conversation first, then cards newest first");
	assert.ok(lines[at("두 번째로 물어본 질문")].includes("→"), "the newest card is preselected, not the whole-session conversation");
	assert.ok(ui.screen.includes("Supabase Realtime"), "the highlighted card's AI output is previewed below the list");
	await ui.key("\u001b[B");
	assert.ok(ui.screen.split(/\r?\n/).find((line) => line.includes("→"))?.includes("첫 번째로 물어본 질문"));
	await ui.key("\r");
	assert.equal(ui.screen.includes("대화 선택"), false);
	assert.ok(ui.screen.includes("AI 출력") && ui.screen.includes("Supabase Realtime"), "the opened card shows its AI output as the first message");
	assert.ok(ui.screen.includes("Esc 대화 목록"));
	await ui.key("\u001b");
	assert.ok(ui.screen.includes("대화 선택"), "Esc in a conversation returns to the list");
	assert.ok(ui.screen.split(/\r?\n/).find((line) => line.includes("→"))?.includes("첫 번째로 물어본 질문"), "the open conversation stays selected");
});

test("a selector searches Hangul, pages by screen, and keeps the real cursor in its search field", async (t) => {
	const f = await fixture(t);
	const proxy = createServer((req, res) => {
		const upstream = request(new URL(req.url, f.address), { method: req.method, headers: req.headers }, (response) => {
			if (req.url !== "/api/sessions") { res.writeHead(response.statusCode, response.headers); response.pipe(res); return; }
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				const [first] = JSON.parse(body);
				const list = Array.from({ length: 30 }, (_, i) => ({ ...first, id: i ? `${first.id}#${i}` : first.id, title: i === 12 ? "한글 검색 대상 세션" : `세션 ${String(i + 1).padStart(2, "0")}` }));
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(list));
			});
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	t.after(() => proxy.close());
	const ui = await terminal(t, `http://127.0.0.1:${proxy.address().port}`, { stage: "sessions" });
	const counter = () => ui.screen.match(/(\d+)\/(\d+)(?: \(전체 \d+\))?\s*$/m);
	assert.deepEqual(counter().slice(1, 3), ["1", "31"]);
	await ui.key("\u001b[6~");
	const paged = Number(counter()[1]);
	assert.ok(paged > 2 && paged < 30, `PageDown moves by a screen, got ${paged}`);
	await ui.key("\u001b[5~");
	assert.equal(counter()[1], "1", "PageUp comes back");
	await ui.key("\u001b[A");
	assert.equal(counter()[1], "31", "Up from the first item wraps to the last");
	await ui.key("대상");
	assert.match(ui.screen, /1\/1 \(전체 31\)/);
	assert.ok(ui.screen.includes("한글 검색 대상 세션"));
	assert.equal(ui.screen.includes("세션 05"), false);
	assert.equal(ui.cursor.row, 6, "3-row boxed header while no session is open");
	assert.equal(ui.cursor.col, 1 + 6 + 4, "after the 6-column ` 검색 ` label and two double-width syllables (1-based)");
	await ui.key("\u007f\u007f");
	assert.equal(ui.cursor.col, 7, "Backspace removes whole syllables");
	await ui.key("\u001b[B");
	await ui.key("\r");
	await until(() => ui.screen.includes("대화 선택"));
});

test("choosing a setting keeps the selector open and moves the check mark", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("$hard");
	await ui.key("\r");
	await until(() => ui.screen.split(/\r?\n/).some((line) => line.includes("HARD") && line.includes("✓")));
	assert.ok(ui.screen.includes("설정"), "the settings selector stays open for the next change");
	assert.equal((await f.api("/api/profiles")).body.find((profile) => profile.id === "default").defaultDifficulty, "HARD");
});

test("Esc in a conversation opens the list with the current conversation selected", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("\u001b");
	assert.ok(ui.screen.includes("대화 선택"));
	assert.ok(ui.screen.split(/\r?\n/).find((line) => line.includes("→"))?.includes("세션 전체 대화"));
	await ui.key("\u001b");
	assert.equal(ui.screen.includes("대화 선택"), false);
});

test("the settings selector defaults to the session's model, and a model scope narrows the model list", async (t) => {
	const f = await fixture(t);
	await f.appendSession({ type: "assistant", uuid: "m1", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", model: "other", content: [{ type: "text", text: "작업했어요." }] } });
	const ui = await terminal(t, f.address);
	await until(() => ui.screen.split(/\r?\n/).slice(-2).join("\n").includes("Other"));
	await ui.key("$");
	await until(() => ui.screen.includes("Cheap") && ui.screen.includes("Other"));
	const defaultRow = ui.screen.split(/\r?\n/).find((line) => line.includes("세션 모델 (기본)"));
	assert.ok(defaultRow?.includes("✓") || defaultRow?.includes("+"), "the session model is the checked default");
	await ui.key("범위");
	assert.ok(ui.screen.includes("범위 정하기"));
	await ui.key("\r");
	assert.ok(ui.screen.includes("모델 범위") && ui.screen.includes("범위 저장 (0개)"), ui.screen);
	await ui.key("\u001b[B");
	await ui.key("\u001b[B");
	await ui.key("\r");
	assert.ok(ui.screen.includes("범위 저장 (1개)"));
	await ui.key("\u001b[A");
	await ui.key("\u001b[A");
	await ui.key("\r");
	await until(async () => ((await f.api("/api/profiles")).body[0].modelScope ?? []).length === 1);
	assert.deepEqual((await f.api("/api/profiles")).body[0].modelScope, [secondModel]);
	await ui.key("$cheap");
	assert.ok(ui.screen.includes("맞는 설정이 없어요"), "a model outside the scope is hidden from the settings list");
});

test("sessions idle for over three days are kept out of the list, shown by the last row, and still found by search", async (t) => {
	const f = await fixture(t);
	const proxy = createServer((req, res) => {
		const upstream = request(new URL(req.url, f.address), { method: req.method, headers: req.headers }, (response) => {
			if (req.url !== "/api/sessions") { res.writeHead(response.statusCode, response.headers); response.pipe(res); return; }
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				const [first] = JSON.parse(body);
				const old = { ...first, id: `${first.id}#old`, title: "오래전에 끝난 작업", updated: new Date(Date.now() - 10 * 86_400_000).toISOString() };
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify([{ ...first, title: "방금 한 작업" }, old]));
			});
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	t.after(() => proxy.close());
	const ui = await terminal(t, `http://127.0.0.1:${proxy.address().port}`, { stage: "sessions" });
	assert.ok(ui.screen.includes("방금 한 작업"));
	assert.equal(ui.screen.includes("오래전에 끝난 작업"), false, "the old session is not in the active list");
	assert.match(ui.screen, /종료된 세션 보기 \(1개\)/);
	await ui.key("오래전");
	assert.ok(ui.screen.includes("오래전에 끝난 작업"), "search reaches ended sessions");
	await ui.key("\u0015");
	await ui.key("\u001b[A");
	await ui.key("\r");
	await until(() => ui.screen.includes("오래전에 끝난 작업") && ui.screen.includes("진행 중인 세션으로 돌아가기"));
	assert.equal(ui.screen.includes("방금 한 작업"), false, "the ended view lists only ended sessions");
});
/** 목록 응답을 30개 세션으로 부풀리는 중계. 첫 세션만 진짜다. */
async function manySessions(t, f) {
	const proxy = createServer((req, res) => {
		const upstream = request(new URL(req.url, f.address), { method: req.method, headers: req.headers }, (response) => {
			if (req.url !== "/api/sessions") { res.writeHead(response.statusCode, response.headers); response.pipe(res); return; }
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				const [first] = JSON.parse(body);
				const list = Array.from({ length: 30 }, (_, i) => ({ ...first, id: i ? `${first.id}#${i}` : first.id, title: `세션 ${String(i + 1).padStart(2, "0")}` }));
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(list));
			});
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	t.after(() => proxy.close());
	return `http://127.0.0.1:${proxy.address().port}`;
}

const rowOf = (ui, text) => ui.screen.split(/\r?\n/).findIndex((line) => line.includes(text));

test("mouse reporting is switched on at start, and /마우스 turns it off and on again", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	assert.ok(ui.other.includes("\u001b[?1000h\u001b[?1002h\u001b[?1006h"), "SGR mouse reporting is requested");
	await ui.key("/마우스");
	await ui.key("\r");
	await until(() => ui.other.includes("\u001b[?1006l\u001b[?1002l\u001b[?1000l"));
	await ui.key("/mouse");
	await ui.key("\r");
	await until(() => ui.other.lastIndexOf("?1000h") > ui.other.lastIndexOf("?1000l"));
});

test("in a selector the wheel moves the choice one item per notch without wrapping, and a click chooses the item under the pointer", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, await manySessions(t, f), { stage: "sessions" });
	const counter = () => ui.screen.match(/(\d+)\/31\s*$/m)?.[1];
	assert.equal(counter(), "1");
	ui.mouse("wheel-down", 10, 10);
	await until(() => counter() === "2");
	ui.mouse("wheel-up", 10, 10);
	ui.mouse("wheel-up", 10, 10);
	await until(() => counter() === "1");
	ui.mouse("wheel-up", 10, 10);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(counter(), "1", "the wheel stops at the first item");
	const y = rowOf(ui, "세션 03");
	assert.ok(y > 0, ui.screen);
	ui.mouse("press", 10, y);
	await until(() => ui.screen.split(/\r?\n/).find((line) => line.includes("→"))?.includes("세션 03") || ui.screen.split(/\r?\n/)[y - 1].includes("→"));
	assert.equal(counter(), "3", "pressing selects the item");
	assert.equal(ui.screen.includes("대화 선택"), false, "the item is chosen on release, not on press");
	ui.mouse("release", 10, y);
	await until(() => ui.screen.includes("대화 선택"));
});

test("clicking in the composer puts the caret on the clicked syllable", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("가나다라마");
	const y = rowOf(ui, "가나다라마");
	assert.ok(y > 0);
	assert.equal(ui.cursor.col, 12, "after five double-width syllables");
	ui.mouse("press", 5, y);
	ui.mouse("release", 5, y);
	await until(() => ui.cursor.col === 6);
	await ui.key("X");
	assert.match(ui.screen, /가나X▏?다라마/, "typing continues at the clicked position");
});

test("dragging selects screen text and copies it, and a double click selects and copies one word", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("복사할 문장입니다");
	let y = rowOf(ui, "복사할 문장입니다");
	ui.mouse("press", 1, y);
	ui.mouse("drag", 3, y);
	ui.mouse("drag", 6, y);
	ui.mouse("release", 6, y);
	await until(() => ui.copied.length === 1);
	assert.deepEqual(ui.copied, ["복사할"], "the selected cells are copied, wide characters whole");
	await ui.key("\u0015");
	await ui.key("alpha-beta/gamma delta");
	y = rowOf(ui, "alpha-beta/gamma delta");
	ui.mouse("press", 8, y);
	ui.mouse("release", 8, y);
	ui.mouse("press", 8, y);
	ui.mouse("release", 8, y);
	await until(() => ui.copied.length === 2);
	assert.equal(ui.copied[1], "alpha-beta/gamma", "path and kebab characters keep a word whole");
});

test("the wheel scrolls a long conversation three lines per notch and follows new text again at the bottom", async (t) => {
	const f = await fixture(t);
	for (let i = 1; i <= 25; i++) await f.ask(`wheel-${i}`, "default", { question: `질문 ${String(i).padStart(2, "0")}` });
	const ui = await terminal(t, f.address);
	await until(() => ui.screen.includes("질문 25"));
	assert.equal(ui.screen.includes("질문 01"), false);
	for (let i = 0; i < 80; i++) ui.mouse("wheel-up", 10, 10);
	await until(() => ui.screen.includes("질문 01"));
	assert.equal(ui.screen.includes("질문 25"), false, "scrolled to the top");
	for (let i = 0; i < 120; i++) ui.mouse("wheel-down", 10, 10);
	await until(() => ui.screen.includes("질문 25"));
});
