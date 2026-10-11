import assert from "node:assert/strict";
import test from "node:test";
import { TerminalClient } from "../app/terminal-client.mjs";
import { TerminalInput, terminalSafeText } from "../app/terminal-input.mjs";
import { PassThrough, Writable } from "node:stream";
import { agoLabel, runTerminal } from "../app/terminal-ui.mjs";
import { fixture, until } from "./omp-fixture.mjs";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { createTerminalTheme } from "../app/terminal-theme.mjs";

async function terminal(t, baseUrl) {
	const stdin = new PassThrough();
	stdin.isTTY = true;
	stdin.setRawMode = (value) => { stdin.isRaw = value; };
	let screen = "", frames = 0, closed = false;
	const stdout = new Writable({ write(chunk, _encoding, done) {
		if (String(chunk).includes("\n")) { screen = stripVTControlCharacters(String(chunk)); frames++; }
		done();
	} });
	Object.assign(stdout, { isTTY: true, columns: 84, rows: 31 });
	const finished = runTerminal({ baseUrl, stdin, stdout, env: {} });
	finished.catch(() => {});
	const ui = {
		get screen() { return screen; },
		send: (keys) => stdin.write(keys),
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
	await until(() => screen.includes("세션 선택"));
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

function splitResponse(text, sizes, headers = {}) {
	const bytes = new TextEncoder().encode(text);
	let offset = 0, sizeIndex = 0;
	return new Response(new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) { controller.close(); return; }
			const size = sizes[sizeIndex++ % sizes.length];
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	}), { status: 200, headers });
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

test("SSE and NDJSON readers handle split UTF-8 stream chunks", async () => {
	const eventPayload = `: keepalive\r\n\r\ndata: {"kind":"question","sub":"question","text":"한국어 질문"}\r\n\r\n`;
	const askPayload = [
		{ type: "stage", stage: "explaining" },
		{ type: "delta", text: "안녕하세요" },
		{ type: "answer", answer: { headline: "완료" } },
	].map((event) => JSON.stringify(event)).join("\n") + "\n";
	const client = new TerminalClient("http://127.0.0.1:4747", async (url, options) => {
		if (new URL(url).pathname === "/api/live") return splitResponse(eventPayload, [1, 2, 3], { "content-type": "text/event-stream" });
		assert.equal(new URL(url).pathname, "/api/ask");
		assert.equal(options.headers.accept, "application/x-ndjson");
		return splitResponse(askPayload, [1, 2, 4], { "content-type": "application/x-ndjson" });
	});
	const events = [];
	await client.events("session:one", "default", new AbortController().signal, (event) => events.push(event));
	assert.deepEqual(events, [{ kind: "question", sub: "question", text: "한국어 질문" }]);
	const streamed = [];
	const outcome = await client.ask({ id: "session:one", profileId: "default", question: "질문", requestId: "one" }, new AbortController().signal, (event) => streamed.push(event));
	assert.equal(streamed[1].text, "안녕하세요");
	assert.equal(outcome.answer.headline, "완료");
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

test("a disconnected explanation rejoins the same request instead of submitting a duplicate", async (t) => {
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
		assert.equal(requests.length, 1);
		ui.send("\u0015\u0012\u0012");
		await until(() => ui.screen.includes("설명 깊이와 출력을 줄이지 않은 답변입니다."));
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[1], requests[0]);
		assert.equal((await f.calls()).filter((call) => call.pid).length, 1);
		await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
		assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.map((row) => row.question), ["연결이 끊겨도 한 번만 설명해요"]);
	} finally {
		await ui.close();
		proxy.closeAllConnections();
		await new Promise((resolve) => proxy.close(resolve));
	}
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

test("the composer keeps the editing caret visible through soft wraps and resize", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("한".repeat(500));
	assert.ok(ui.screen.includes("▏"), "soft-wrapped text must scroll with its caret");
	await ui.resize(40, 16);
	assert.ok(ui.screen.includes("▏"), "the editing point must remain visible after narrowing the terminal");
	await ui.key("\u0001");
	assert.ok(ui.screen.includes("▏"), "moving to the start must reveal that caret position");
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
	await until(() => ui.screen.includes("# 대화") && ui.screen.includes("카드 대화"));
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

test("an unmatched trigger is not sent until Esc turns it into literal question text", async (t) => {
	const f = await fixture(t);
	const ui = await terminal(t, f.address);
	await ui.key("#1 오류가 뭐야");
	assert.ok(ui.screen.includes("일치하는 항목이 없어요"), ui.screen);
	await ui.key("\r");
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body, []);
	await ui.key("\u001b");
	ui.send("\r");
	await until(async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body.length === 1);
	assert.equal((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body[0].question, "#1 오류가 뭐야");
});
