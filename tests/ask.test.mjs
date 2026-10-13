import assert from "node:assert/strict";
import test from "node:test";
import { fixture, until } from "./omp-fixture.mjs";

const explanations = async (f) => (await f.calls()).filter((call) => !call.planning);

test("a thread is one live conversation: later questions reuse it and send only the new part of the transcript", async (t) => {
	const f = await fixture(t);
	const first = await f.stream({ question: "지금 뭐 했어?", requestId: "one" });
	assert.equal(first.at(-1).type, "answer");
	assert.ok(first.some((line) => line.type === "delta"));
	await f.appendSession({ type: "user", uuid: "u2", cwd: "/project", timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: "리얼타임은 어디에 둘까?" } });
	const second = await f.stream({ question: "그럼 장기적으로는?", requestId: "two" });
	assert.equal(second.at(-1).type, "answer");
	const [a, b] = await explanations(f);
	assert.equal(a.pid, b.pid);
	assert.match(a.message, /## 전사 \(세션 기록/);
	assert.match(b.message, /## 전사 갱신/);
	assert.match(b.message, /리얼타임은 어디에 둘까\?/);
	assert.doesNotMatch(b.message, /검색 상태를 설명해줘/);
});

test("stopping ends the job without a record, and the same request replays as stopped without calling the model", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 40 });
	let cancelled = false;
	const lines = await f.stream({ question: "잘못 보낸 질문", requestId: "stop" }, async (line) => {
		if (line.type === "delta" && !cancelled) {
			cancelled = true;
			assert.deepEqual((await f.api("/api/ask/cancel", "POST", { profileId: "default", requestId: "stop" })).body, { cancelled: true });
		}
	});
	assert.equal(lines.at(-1).type, "cancelled");
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}&profileId=default`)).body, []);
	const before = (await explanations(f)).length;
	const replay = await f.ask("stop", "default", { question: "잘못 보낸 질문" });
	assert.equal(replay.status, 409);
	assert.equal(replay.body.cancelled, true);
	assert.equal((await explanations(f)).length, before);
});

test("a correction restarts the answer in the same conversation, joiners share one model call, and the record keeps the correction", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 40 });
	let steered = false;
	let joined;
	const lines = await f.stream({ question: "이 선택지 뭐야?", requestId: "steer" }, async (line) => {
		if (line.type === "delta" && !steered) {
			steered = true;
			joined = f.stream({ question: "이 선택지 뭐야?", requestId: "steer" });
			assert.deepEqual((await f.api("/api/ask/steer", "POST", { profileId: "default", requestId: "steer", message: "리얼타임 질문 말이야" })).body, { steered: true });
		}
	});
	const types = lines.map((line) => line.type);
	assert.ok(types.indexOf("steer") < types.indexOf("reset"));
	const answer = lines.at(-1).answer;
	assert.match(answer.raw, /보정을 반영했어요/);
	assert.deepEqual((await joined).at(-1).answer, answer);
	const calls = await explanations(f);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].pid, calls[1].pid);
	assert.match(calls[1].message, /바로잡기[^\n]*리얼타임 질문 말이야/);
	const [row] = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}&profileId=default`)).body;
	assert.deepEqual(row.steers, ["리얼타임 질문 말이야"]);
	assert.equal((await f.api("/api/ask/steer", "POST", { profileId: "default", requestId: "steer", message: "늦은 보정" })).status, 409);
	await until(async () => (await f.api(`/api/jobs?id=${encodeURIComponent(f.sessionId)}&profileId=default`)).body.length === 0);
});

test("a user question on a thread whose pre-explanation is still running waits its turn, and both explanations finish", async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 40 });
	const focus = { label: "리얼타임 위치", text: "보유 계정 기준으로 어디에 리얼타임을 둘까?" };
	let user;
	const auto = await f.stream({ question: "쉽게 설명해줘", focus, auto: true, difficulty: "EASY", requestId: "auto-running" }, (line) => {
		if (line.type === "delta" && !user) user = f.stream({ question: "그럼 비용은?", focus, requestId: "user-next" });
	});
	assert.equal(auto.at(-1).type, "answer");
	const asked = await user;
	assert.equal(asked.at(-1).type, "answer", JSON.stringify(asked.at(-1)));
	const calls = await explanations(f);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].pid, calls[1].pid);
	assert.match(calls[1].message, /그럼 비용은\?/);
	const rows = (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}&profileId=default`)).body;
	assert.deepEqual(rows.map((row) => row.requestId ?? row.answer.requestId), ["auto-running", "user-next"]);
});

test("the server pre-explains a new AI question for a profile that opened the session, even after the tab closes", async (t) => {
	const f = await fixture(t);
	// 픽스처의 기본 프로필은 autoExplain 이 없는 0.24 전 파일이라 켜진 채로 남는다. 새로 만든 프로필은 꺼진 채 시작한다 (ADR 0063).
	assert.equal((await f.api("/api/profiles")).body.find((p) => p.id === "default").autoExplain, true);
	assert.equal((await f.api("/api/profiles", "POST", { name: "새 프로필" })).body.autoExplain, false);
	const controller = new AbortController();
	const response = await fetch(`${f.address}/api/live?id=${encodeURIComponent(f.sessionId)}&profileId=default`, { signal: controller.signal });
	const reader = response.body.getReader();
	const events = [];
	let buffer = "";
	const next = async (test) => {
		for (;;) {
			const found = events.find(test);
			if (found) return found;
			const { value } = await reader.read();
			buffer += Buffer.from(value).toString("utf8");
			for (const frame of buffer.split("\n\n").slice(0, -1)) {
				const data = frame.split("\n").find((part) => part.startsWith("data: "));
				if (data) events.push(JSON.parse(data.slice(6)));
			}
			buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
		}
	};
	await next((ev) => ev.kind === "hello");
	await f.appendSession({ type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "AskUserQuestion", input: { questions: [{ question: "보유 계정 기준으로 어디에 리얼타임을 둘까?", options: [{ label: "Supabase Realtime", description: "이미 보유" }] }] } }] } });
	const card = await next((ev) => ev.kind === "question");
	controller.abort();
	assert.equal(card.autoState, "queued");
	assert.match(card.focus.text, /Supabase Realtime — 이미 보유/);
	assert.equal(card.ask.display, "쉽게 설명해줘");
	const rows = async () => (await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}&profileId=default`)).body;
	await until(async () => (await rows())[0]?.answer.learning.classification === "unknown", 10_000);
	const [row] = await rows();
	assert.equal(row.auto, true);
	assert.equal(row.thread, card.thread);
	assert.equal(row.answer.requestId, card.ask.requestId);
	// 화면이 같은 요청으로 붙으면 모델을 다시 부르지 않고 저장된 설명을 받는다.
	const before = (await f.calls()).length;
	const attached = await f.stream({ question: card.ask.question, focus: card.focus, auto: true, difficulty: "EASY", requestId: card.ask.requestId });
	assert.equal(attached.at(-1).answer.recordId, row.answer.recordId);
	assert.equal((await f.calls()).length, before);
});

test("the answer arrives before its classification, and the open page is told when the card title, keywords and suggestion are ready", async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const response = await fetch(`${f.address}/api/live?id=${encodeURIComponent(f.sessionId)}&profileId=default`, { signal: controller.signal });
	const reader = response.body.getReader();
	let buffer = "";
	const nextEvent = async (test) => {
		for (;;) {
			const frames = buffer.split("\n\n");
			buffer = frames.pop();
			for (const frame of frames) {
				const data = frame.split("\n").find((part) => part.startsWith("data: "));
				const value = data && JSON.parse(data.slice(6));
				if (value && test(value)) return value;
			}
			const { value } = await reader.read();
			buffer += Buffer.from(value).toString("utf8");
		}
	};
	await nextEvent((ev) => ev.kind === "hello");
	await f.control({ holdPlanning: true });
	const lines = await f.stream({ question: "지금 뭐 했어?", requestId: "late-classification" });
	const answer = lines.at(-1).answer;
	assert.equal(answer.learning.classification, "pending");
	await f.release();
	const update = await nextEvent((ev) => ev.kind === "record");
	assert.equal(update.recordId, answer.recordId);
	assert.equal(update.thread, "");
	assert.equal(update.answer.learning.classification, "unknown");
});

test("a Claude Code transcript picks up subagent progress even when the main session file is unchanged", async (t) => {
	const f = await fixture(t);
	const transcript = async () => (await fetch(`${f.address}/api/transcript?id=${encodeURIComponent(f.sessionId)}`)).text();
	await f.appendSubagent("a1", { type: "user", uuid: "s1", timestamp: "2026-01-01T00:00:10Z", message: { role: "user", content: "첫 지시" } });
	assert.match(await transcript(), /첫 지시/);
	await f.appendSubagent("a1", { type: "assistant", uuid: "s2", timestamp: "2026-01-01T00:00:20Z", message: { role: "assistant", content: [{ type: "text", text: "서브에이전트가 방금 끝낸 일" }] } });
	assert.match(await transcript(), /서브에이전트가 방금 끝낸 일/);
});

test("Korean text split across output chunks is decoded intact, not stored with replacement characters", async (t) => {
	const f = await fixture(t);
	await f.control({ splitUtf8: true });
	const answer = (await f.stream({ question: "지금 뭐 했어?", requestId: "utf8" })).at(-1).answer;
	assert.match(answer.raw, /설명 깊이와 출력을 줄이지 않은 답변입니다/);
	assert.equal(answer.raw.includes("\uFFFD"), false);
});

// Windows 의 process.kill 은 신호를 보내지 않고 프로세스를 바로 끝내서 서버의 SIGTERM 종료 처리가 돌지 않는다 (ADR 0057).
test("graceful server shutdown stops its running model and keeps the request cancelled after restart", { skip: process.platform === "win32" && "Windows 에는 정상 종료 신호가 없어요" }, async (t) => {
	const f = await fixture(t);
	await f.control({ slowExplanation: 10000 });
	const pending = f.stream({ question: "종료 중인 설명", requestId: "shutdown" }).catch(() => null);
	await until(async () => (await f.calls()).some((call) => call.pid));
	const pid = (await f.calls()).find((call) => call.pid).pid;
	t.after(() => { try { process.kill(pid, "SIGTERM"); } catch {} });
	await f.restart();
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	await pending;
	assert.equal((await f.stream({ question: "종료 중인 설명", requestId: "shutdown" })).at(-1).type, "cancelled");
	assert.deepEqual((await f.api(`/api/history?id=${encodeURIComponent(f.sessionId)}`)).body, []);
});
