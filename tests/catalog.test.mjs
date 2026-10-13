import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeAdapter } from "../scripts/transcript-claude.mjs";
import { codexAdapter } from "../scripts/transcript-codex.mjs";
import { geminiAdapter } from "../scripts/transcript-gemini.mjs";
import { peerProvider } from "../app/peers.mjs";

// 라이브 재생이 의미 분류 API 를 부르지 않도록 키 없이 불러온다.
const originalKey = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
const { localProviders, sessionCatalog } = await import("../app/catalog.mjs");
if (originalKey !== undefined) process.env.TYPESAFE_API_KEY = originalKey;

const jsonl = (entries) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
const claudeSession = (cwd, text) => jsonl([{ type: "user", uuid: "u1", cwd, timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: text } }]);
const codexSession = (cwd, text) => jsonl([
	{ type: "session_meta", timestamp: "2026-10-01T00:00:00Z", payload: { session_id: "c1", timestamp: "2026-10-01T00:00:00Z", cwd, originator: "codex-tui" } },
	{ type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text }] } },
]);
const geminiSession = (text) => jsonl([
	{ sessionId: "g1", projectHash: "h", startTime: "2026-10-01T00:00:00.000Z", lastUpdated: "2026-10-01T00:00:00.000Z", kind: "main" },
	{ id: "u-1", timestamp: "2026-10-01T00:00:10.000Z", type: "user", content: [{ text }] },
]);

/** 임시 HOME 에 세션 파일과 git 저장소를 만든다. `files` 는 HOME 기준 경로 → [내용, 수정 시각 ISO]. */
async function home(t, files) {
	const dir = await mkdtemp(join(tmpdir(), "docent-catalog-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const [rel, [content, updated]] of Object.entries(files)) {
		const path = join(dir, rel);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
		if (updated) await utimes(path, new Date(updated), new Date(updated));
	}
	return dir;
}

/** 원격 docent 의 HTTP 대신 쓰는 메모리 안의 가짜. 경로별 응답과 받은 요청 주소를 남긴다. */
function fakePeer(routes) {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		const { pathname } = new URL(url);
		const route = routes[pathname];
		if (!route) return new Response("not found", { status: 404 });
		return typeof route === "function" ? route(url) : new Response(JSON.stringify(route));
	};
	return { fetch, calls };
}

const adapters = [claudeAdapter, codexAdapter, geminiAdapter];

test("the list merges local and peer sessions by last activity and keeps the 200 most recent", async (t) => {
	const dir = await home(t, {
		".claude/projects/a/new.jsonl": [claudeSession("/w/a", "가장 최근"), "2026-10-03T00:00:00Z"],
		".codex/sessions/2026/10/01/rollout-old.jsonl": [codexSession("/w/b", "오래됨"), "2026-01-01T00:00:00Z"],
	});
	// 원격은 2026-10-02 하루 안의 세션 250개를 보낸다. 로컬 최근 세션은 그보다 늦고 오래된 세션은 200개 밖이다.
	const remote = Array.from({ length: 250 }, (_, i) => ({ id: `claude:p/${i}.jsonl`, provider: "claude", title: `원격 ${i}`, updated: new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString(), host: null }));
	const peer = fakePeer({ "/api/sessions": remote });
	const catalog = sessionCatalog([...localProviders(adapters, { home: dir }), peerProvider("book", "http://book.test:4747", { fetch: peer.fetch })]);
	const list = await catalog.list();
	assert.equal(list.length, 200);
	assert.equal(list[0].id, "claude:a/new.jsonl");
	assert.deepEqual(list.slice(1, 3).map((s) => s.id), ["@book/claude:p/249.jsonl", "@book/claude:p/248.jsonl"]);
	assert.equal(list[1].host, "book");
	assert.ok(list.every((s, i) => i === 0 || s.updated <= list[i - 1].updated), "newest first");
	assert.ok(!list.some((s) => s.id.startsWith("codex:")), "the oldest session is past the cap");
});

test("local sessions get repo, branch and worktree from this computer; peer sessions keep what their server sent", async (t) => {
	const dir = await home(t, {
		"repo/.git/HEAD": ["ref: refs/heads/feat/list\n"],
		"repo/.git/worktrees/side/HEAD": ["ref: refs/heads/side-branch\n"],
		".claude/projects/a/s.jsonl": [""],
	});
	const cwd = join(dir, "repo");
	const worktree = join(dir, "side");
	await mkdir(worktree);
	await writeFile(join(worktree, ".git"), `gitdir: ${join(cwd, ".git/worktrees/side")}\n`);
	await writeFile(join(dir, ".claude/projects/a/s.jsonl"), claudeSession(cwd, "이 저장소 고쳐줘"));
	await writeFile(join(dir, ".claude/projects/a/w.jsonl"), claudeSession(worktree, "워크트리 작업"));
	// 원격 세션의 작업 폴더가 우연히 이 컴퓨터의 저장소 경로와 같아도 여기서 브랜치를 찾지 않는다.
	const peer = fakePeer({ "/api/sessions": [{ id: "claude:p/r.jsonl", provider: "claude", title: "원격", cwd, updated: "2026-10-01T00:00:00Z", host: null, recent: "원격 최근 작업" }] });
	const catalog = sessionCatalog([...localProviders(adapters, { home: dir }), peerProvider("book", "http://book.test", { fetch: peer.fetch })]);
	const byId = Object.fromEntries((await catalog.list()).map((s) => [s.id, s]));
	assert.deepEqual([byId["claude:a/s.jsonl"].repo, byId["claude:a/s.jsonl"].branch, byId["claude:a/s.jsonl"].recent], ["repo", "feat/list", "이 저장소 고쳐줘"]);
	assert.deepEqual([byId["claude:a/w.jsonl"].repo, byId["claude:a/w.jsonl"].worktree, byId["claude:a/w.jsonl"].branch], ["repo", "side", "side-branch"]);
	assert.deepEqual(byId["@book/claude:p/r.jsonl"], { id: "@book/claude:p/r.jsonl", provider: "claude", title: "원격", cwd, updated: "2026-10-01T00:00:00Z", host: "book", recent: "원격 최근 작업" });
});

test("a file path resolves only when the list would show that file", async (t) => {
	const session = geminiSession("고쳐줘");
	const dir = await home(t, {
		".gemini/tmp/demo/chats/session-1.jsonl": [session],
		".gemini/tmp/demo/chats/parent/session-child.jsonl": [session],
		".gemini/tmp/demo/chats/notes.jsonl": [session],
		".codex/sessions/2026/10/01/rollout-1.jsonl": [codexSession("/w", "작업")],
		".codex/sessions/2026/10/01/history.jsonl": [codexSession("/w", "작업")],
		".codex/sessions/2026/10/rollout-shallow.jsonl": [codexSession("/w", "작업")],
		".claude/projects/a/empty.jsonl": [""],
		"elsewhere/session.jsonl": [session],
	});
	const catalog = sessionCatalog(localProviders(adapters, { home: dir }));
	const listed = (await catalog.list()).map((s) => s.id).sort();
	assert.deepEqual(listed, ["codex:2026/10/01/rollout-1.jsonl", "gemini:demo/chats/session-1.jsonl"]);
	assert.equal(await catalog.resolve(join(dir, ".gemini/tmp/demo/chats/session-1.jsonl")), "gemini:demo/chats/session-1.jsonl");
	assert.equal(await catalog.resolve(join(dir, ".codex/sessions/2026/10/01/../01/rollout-1.jsonl")), "codex:2026/10/01/rollout-1.jsonl");
	for (const rel of [
		".gemini/tmp/demo/chats/parent/session-child.jsonl", // 서브에이전트 파일은 한 단계 더 안쪽
		".gemini/tmp/demo/chats/notes.jsonl", // 이름이 session-* 가 아님
		".codex/sessions/2026/10/01/history.jsonl", // 이름이 rollout-* 가 아님
		".codex/sessions/2026/10/rollout-shallow.jsonl", // 날짜 폴더 한 단계가 모자람
		".claude/projects/a/empty.jsonl", // 아직 첫 메시지 전
		".claude/projects/a/missing.jsonl",
		"elsewhere/session.jsonl",
	]) {
		await assert.rejects(catalog.resolve(join(dir, rel)), (error) => error.status === 404, rel);
	}
});

test("a session id outside the walk rules is a bad id, and an unknown provider is 400", async (t) => {
	const dir = await home(t, {
		".gemini/tmp/demo/chats/parent/session-child.jsonl": [geminiSession("x")],
		".codex/sessions/2026/10/01/history.jsonl": [codexSession("/w", "작업")],
	});
	const catalog = sessionCatalog(localProviders(adapters, { home: dir }));
	for (const id of ["gemini:demo/chats/parent/session-child.jsonl", "codex:2026/10/01/history.jsonl", "claude:../../.codex/sessions/2026/10/01/history.jsonl"]) {
		await assert.rejects(catalog.transcript(id), (error) => error.status === 400 && error.message === "bad session id", id);
		// 라이브 스트림을 열기 전에 확인할 수 있도록 찾기 단계에서 바로 던진다.
		assert.throws(() => catalog.providerOf(id), (error) => error.status === 400, id);
	}
	for (const id of ["nope:a/b.jsonl", "@book/claude:a/b.jsonl", ""]) {
		await assert.rejects(catalog.transcript(id), (error) => error.status === 400 && error.message === "unknown provider", id);
		assert.throws(() => catalog.watch(id, () => {}), (error) => error.status === 400, id);
	}
});

test("live watch goes to the session file here and to the peer's live stream there", async (t) => {
	const dir = await home(t, { ".claude/projects/a/s.jsonl": [claudeSession("/w", "지켜봐줘")] });
	const frames = [{ kind: "hello", text: "원격 인사" }, { kind: "question", sub: "question", text: "진행할까요?" }];
	const peer = fakePeer({
		"/api/live": () => new Response(new ReadableStream({
			start(controller) {
				// 프레임 경계가 조각 중간에 와도 한 사건씩 넘긴다.
				const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(": ping\n\n");
				controller.enqueue(new TextEncoder().encode(body.slice(0, 17)));
				controller.enqueue(new TextEncoder().encode(body.slice(17)));
				controller.close();
			},
		})),
	});
	const catalog = sessionCatalog([...localProviders(adapters, { home: dir }), peerProvider("book", "http://book.test/", { fetch: peer.fetch })]);
	const until = async (check) => {
		const deadline = Date.now() + 5000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("no live events");
			await new Promise((r) => setTimeout(r, 10));
		}
	};

	const local = [];
	const stopLocal = catalog.watch("claude:a/s.jsonl", (ev) => local.push(ev));
	t.after(stopLocal);
	await until(() => local.some((ev) => ev.kind === "hello"));

	const remote = [];
	const stopRemote = catalog.watch("@book/claude:a/s.jsonl", (ev) => remote.push(ev));
	t.after(stopRemote);
	await until(() => remote.length >= 2);
	assert.deepEqual(remote, frames);
	assert.deepEqual(peer.calls, ["http://book.test/api/live?id=claude%3Aa%2Fs.jsonl"]);
});

test("sessions open in Herdr come first by workspace and pane, even past the 200 limit; peers keep their own herdr field; no herdr data leaves the order unchanged", async (t) => {
	const at = (number, pane) => ({ workspace: `w${number}`, label: `공간 ${number}`, number, pane: `w${number}:p${pane}` });
	const files = {};
	for (const [name, updated] of [["a", "2026-10-05"], ["b", "2026-10-04"], ["c", "2026-10-03"], ["d", "2026-10-02"], ["e", "2026-10-01"]]) {
		files[`.claude/projects/p/${name}.jsonl`] = [claudeSession("/w/x", `세션 ${name}`), `${updated}T00:00:00Z`];
	}
	const dir = await home(t, files);
	const path = (name) => join(dir, `.claude/projects/p/${name}.jsonl`);
	const open = new Map([[path("c"), at(1, 1)], [path("a"), at(3, 2)], [path("e"), at(3, 1)]]);
	const peer = fakePeer({ "/api/sessions": [
		{ id: "claude:p/r1.jsonl", provider: "claude", title: "원격 Herdr", updated: "2026-10-06T00:00:00Z", host: null, herdr: at(1, 1) },
		{ id: "claude:p/r2.jsonl", provider: "claude", title: "원격 일반", updated: "2026-10-07T00:00:00Z", host: null },
	] });
	const make = (herdr) => sessionCatalog([...localProviders(adapters, { home: dir, herdr }), peerProvider("book", "http://book.test", { fetch: peer.fetch })]);
	const listed = await make({ sessions: async () => open }).list();
	assert.deepEqual(listed.map((s) => s.id), [
		"claude:p/c.jsonl", "claude:p/e.jsonl", "claude:p/a.jsonl", "@book/claude:p/r1.jsonl", "@book/claude:p/r2.jsonl", "claude:p/b.jsonl", "claude:p/d.jsonl",
	]);
	assert.deepEqual(listed[0].herdr, at(1, 1));
	assert.equal(listed.find((s) => s.id === "claude:p/b.jsonl").herdr, undefined);
	assert.deepEqual(listed[3].herdr, at(1, 1), "a peer's herdr field is passed through as sent");
	const none = (await make({ sessions: async () => new Map() }).list()).map((s) => s.id);
	const without = (await make(null).list()).map((s) => s.id);
	assert.deepEqual(none, without);
	assert.deepEqual(without, ["@book/claude:p/r1.jsonl", "@book/claude:p/r2.jsonl", "claude:p/a.jsonl", "claude:p/b.jsonl", "claude:p/c.jsonl", "claude:p/d.jsonl", "claude:p/e.jsonl"]);
});
