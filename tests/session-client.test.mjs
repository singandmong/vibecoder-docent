// 세션 클라이언트 (ADR 0055). 실제 HttpTransport 에 가짜 fetch 를 끼워 서버의 NDJSON·SSE 줄을 그대로 흘려 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { createSessionClient } from "../app/session-client.mjs";
import { HttpTransport } from "../app/transport.mjs";
import { until } from "./omp-fixture.mjs";

const encoder = new TextEncoder();

/** 줄을 조금씩 밀어 넣는 응답 본문. 요청이 끊기면(abort) 읽기도 끊긴다. */
function pushBody(signal) {
	let controller;
	const body = new ReadableStream({ start(c) { controller = c; } });
	// 끊긴 뒤에 오는 줄은 버린다(실제 서버도 닫힌 연결에는 쓰지 못한다).
	const write = (text) => { try { controller.enqueue(encoder.encode(text)); } catch {} };
	signal?.addEventListener("abort", () => { try { controller.error(new DOMException("aborted", "AbortError")); } catch {} }, { once: true });
	return {
		body,
		raw: write,
		send(...lines) { for (const line of lines) write(`${JSON.stringify(line)}\n`); },
		/** 마지막 줄은 줄바꿈 없이 보내고 닫는다. */
		finish(line) { write(JSON.stringify(line)); try { controller.close(); } catch {} },
		drop() { try { controller.error(new TypeError("network connection lost")); } catch {} },
	};
}

/** 도슨트 서버 흉내. /api/ask 마다 손으로 흘릴 수 있는 스트림을 연다. */
function fakeServer({ jobs = [] } = {}) {
	const server = { jobs, asks: [], cancels: [], steers: [], refuse: null, cancelResult: { cancelled: true }, lives: [] };
	server.fetch = async (url, init = {}) => {
		const { pathname } = new URL(url);
		const body = init.body ? JSON.parse(init.body) : null;
		if (pathname === "/api/jobs") return Response.json(server.jobs);
		if (pathname === "/api/ask") {
			if (server.refuse) return Response.json({ error: server.refuse.error }, { status: server.refuse.status });
			const stream = pushBody(init.signal);
			server.asks.push({ ...stream, body });
			return new Response(stream.body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
		}
		if (pathname === "/api/ask/cancel") { server.cancels.push(body); return Response.json(server.cancelResult); }
		if (pathname === "/api/ask/steer") { server.steers.push(body); return Response.json({ steered: true }); }
		if (pathname === "/api/live") {
			const stream = pushBody(init.signal);
			server.lives.push(stream);
			return new Response(stream.body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	};
	return server;
}

function setup(options) {
	const server = fakeServer(options);
	const drafts = new Map();
	const changes = [];
	let id = 0;
	const client = createSessionClient({
		transport: new HttpTransport("http://docent.test", server.fetch),
		drafts: {
			read: (place) => drafts.get(`${place.profileId}|${place.sessionId}|${place.thread}`) ?? "",
			write: (place, text) => drafts.set(`${place.profileId}|${place.sessionId}|${place.thread}`, text),
		},
		cards: () => [{ thread: "0123456789abcdef", label: "카드" }],
		newRequestId: () => `request-${++id}`,
		onChange: (change) => changes.push(change),
	});
	const ended = () => changes.filter((change) => change.type === "end");
	return { server, client, drafts, changes, ended };
}

const ANSWER = { type: "answer", answer: { headline: "완료" } };

/** 정해진 크기로 잘라 보내는 응답. 한글 한 글자(3바이트)가 두 조각에 걸치게 된다. */
function splitResponse(text, sizes, headers = {}) {
	const bytes = encoder.encode(text);
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

test("SSE and NDJSON readers handle split UTF-8 stream chunks and a final line without a newline", async () => {
	const eventPayload = `: keepalive\r\n\r\ndata: {"kind":"question","sub":"question","text":"한국어 질문"}\r\n\r\n`;
	const askPayload = [
		{ type: "stage", stage: "explaining" },
		{ type: "delta", text: "안녕하세요" },
		{ type: "answer", answer: { headline: "완료" } },
	].map((event) => JSON.stringify(event)).join("\n");
	const transport = new HttpTransport("http://127.0.0.1:4747", async (url, options) => {
		if (new URL(url).pathname === "/api/live") return splitResponse(eventPayload, [1, 2, 3], { "content-type": "text/event-stream" });
		assert.equal(new URL(url).pathname, "/api/ask");
		assert.equal(options.headers.accept, "application/x-ndjson");
		return splitResponse(askPayload, [1, 2, 4], { "content-type": "application/x-ndjson" });
	});
	const events = [];
	await transport.events("session:one", "default", new AbortController().signal, (event) => events.push(event));
	assert.deepEqual(events, [{ kind: "question", sub: "question", text: "한국어 질문" }]);
	const streamed = [];
	const outcome = await transport.ask({ id: "session:one", profileId: "default", question: "질문", requestId: "one" }, new AbortController().signal, (event) => streamed.push(event));
	assert.equal(streamed[1].text, "안녕하세요");
	assert.equal(outcome.answer.headline, "완료");
});

test("rejoin after reload shows the replayed text once", async () => {
	const { server, client, ended } = setup({ jobs: [{
		requestId: "running", question: "왜 이렇게 했어?", display: "왜?", focus: null, thread: "", auto: false, difficulty: null, stage: "explaining", text: "앞부분",
	}] });
	client.open({ profileId: "default", sessionId: "s1" });
	await client.rejoin();
	await until(() => server.asks.length === 1);
	assert.deepEqual(server.asks[0].body, { id: "s1", profileId: "default", question: "왜 이렇게 했어?", requestId: "running" });
	// 서버(jobs.subscribe)는 쌓인 글을 delta 하나로 다시 보낸다.
	server.asks[0].send({ type: "stage", stage: "explaining" }, { type: "delta", text: "앞부분" }, { type: "delta", text: " 뒷부분" });
	await until(() => client.active?.text.endsWith("뒷부분"));
	assert.equal(client.active.text, "앞부분 뒷부분");
	assert.equal(client.active.display, "왜?");
	server.asks[0].finish(ANSWER);
	await until(() => ended().length === 1);
	assert.deepEqual(ended()[0].outcome, ANSWER);
	assert.equal(client.active, null);
});

test("a server error message reaches the outcome", async () => {
	const { server, client, ended } = setup();
	server.refuse = { status: 409, error: "같은 requestId 를 다른 질문에 사용할 수 없어요." };
	client.open({ profileId: "default", sessionId: "s1" });
	client.ask({ question: "질문" });
	await until(() => ended().length === 1);
	assert.deepEqual(ended()[0].outcome, { type: "error", error: "같은 requestId 를 다른 질문에 사용할 수 없어요.", status: 409 });
	assert.equal(client.active, null);
});

test("Enter during an explanation queues; the queue drains in order and skips stale contexts", async () => {
	const { server, client, drafts, ended } = setup();
	client.open({ profileId: "default", sessionId: "s1" });
	client.ask({ question: "첫 질문" });
	const second = client.ask({ question: "둘째 질문" });
	client.ask({ question: "셋째 질문" });
	await until(() => server.asks.length === 1);
	assert.deepEqual(client.queue.map((job) => job.question), ["둘째 질문", "셋째 질문"]);
	assert.equal(server.asks[0].body.cards.length, 1, "a new question carries the current cards");
	server.asks[0].finish(ANSWER);
	await until(() => server.asks.length === 2);
	assert.equal(client.active, second);
	server.asks[1].finish(ANSWER);
	await until(() => server.asks.length === 3);
	server.asks[2].finish(ANSWER);
	await until(() => ended().length === 3);
	assert.deepEqual(server.asks.map((entry) => entry.body.question), ["첫 질문", "둘째 질문", "셋째 질문"]);

	// 다른 세션으로 가면 그 세션의 대기 질문은 보내지 않고, 비어 있는 원래 입력창으로 돌려보낸다.
	client.ask({ question: "넷째 질문", thread: "0123456789abcdef" });
	client.ask({ question: "다른 세션으로 가기 전 대기 질문", thread: "0123456789abcdef" });
	await until(() => server.asks.length === 4);
	client.open({ profileId: "default", sessionId: "s2" });
	assert.deepEqual(client.queue, []);
	assert.equal(drafts.get("default|s1|0123456789abcdef"), "다른 세션으로 가기 전 대기 질문");
	server.asks[3].finish(ANSWER);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(server.asks.length, 4, "a stale queued question is never sent");
	assert.equal(ended().length, 3, "the old session's stream no longer reports to this session");
});

test("cancel restores the question only into an empty draft", async () => {
	const { server, client, drafts, ended } = setup();
	client.open({ profileId: "default", sessionId: "s1" });
	client.ask({ question: "멈출 질문" });
	await until(() => server.asks.length === 1);
	assert.deepEqual(await client.stop(), { cancelled: true });
	assert.deepEqual(server.cancels, [{ profileId: "default", requestId: "request-1" }]);
	assert.deepEqual(ended()[0].outcome, { type: "cancelled", restored: true });
	assert.equal(drafts.get("default|s1|"), "멈출 질문");

	drafts.set("default|s1|", "");
	client.ask({ question: "또 멈출 질문" });
	await until(() => server.asks.length === 2);
	drafts.set("default|s1|", "이미 쓰던 다음 질문");
	await client.stop();
	assert.deepEqual(ended()[1].outcome, { type: "cancelled", restored: false });
	assert.equal(drafts.get("default|s1|"), "이미 쓰던 다음 질문");
});

test("cancel restores into the thread the server reported", async () => {
	const thread = "fedcba9876543210";
	const { server, client, drafts, ended } = setup({ jobs: [{
		requestId: "card-ask", question: "카드 질문", focus: { label: "카드", text: "카드 원문" }, thread, auto: false, difficulty: "EASY", stage: "planning", text: "",
	}] });
	client.open({ profileId: "default", sessionId: "s1" });
	await client.rejoin();
	await until(() => server.asks.length === 1);
	assert.deepEqual(server.asks[0].body, { id: "s1", profileId: "default", question: "카드 질문", requestId: "card-ask", focus: { label: "카드", text: "카드 원문" }, difficulty: "EASY" });
	await client.stop();
	assert.equal(ended()[0].job.thread, thread);
	assert.equal(ended()[0].outcome.restored, true);
	assert.equal(drafts.get(`default|s1|${thread}`), "카드 질문");
	assert.equal(drafts.get("default|s1|"), undefined);
});

test("a dropped connection keeps the explanation; resuming replays it once and then sends the queued question", async () => {
	const { server, client, changes, ended } = setup();
	client.open({ profileId: "default", sessionId: "s1" });
	const first = client.ask({ question: "끊길 질문" });
	await until(() => server.asks.length === 1);
	server.asks[0].send({ type: "delta", text: "설명 앞" });
	await until(() => first.text === "설명 앞");
	server.asks[0].drop();
	await until(() => first.disconnected);
	assert.equal(client.active, first);
	assert.ok(changes.some((change) => change.type === "job" && change.error), "the disconnect is reported");
	client.ask({ question: "다음 질문" });
	assert.equal(server.asks.length, 1, "a question during a disconnected explanation waits its turn");
	assert.equal(client.resume(first), true);
	assert.equal(client.resume(first), false, "an attached request is not opened twice");
	await until(() => server.asks.length === 2);
	assert.deepEqual(server.asks[1].body, server.asks[0].body);
	server.asks[1].send({ type: "delta", text: "설명 앞" }, { type: "delta", text: " 이어서" });
	await until(() => first.text.endsWith("이어서"));
	assert.equal(first.text, "설명 앞 이어서");
	server.asks[1].finish(ANSWER);
	await until(() => server.asks.length === 3);
	assert.equal(server.asks[2].body.question, "다음 질문");
	assert.equal(ended()[0].job, first);
});

test("live events follow the session and reconnect after the stream closes", async () => {
	const { server, client, changes } = setup();
	client.open({ profileId: "default", sessionId: "s1" });
	const following = client.follow();
	await until(() => server.lives.length === 1);
	server.lives[0].raw(`data: {"kind":"question","sub":"question","te`);
	server.lives[0].raw(`xt":"카드"}\n\n`);
	await until(() => changes.some((change) => change.type === "live"));
	assert.deepEqual(changes.find((change) => change.type === "live").event, { kind: "question", sub: "question", text: "카드" });
	server.lives[0].finish({});
	await until(() => server.lives.length === 2, 3000);
	assert.ok(changes.some((change) => change.type === "live-status" && change.status === "closed"));
	client.close();
	await following;
});
