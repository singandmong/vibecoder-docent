// 세션 목록 module (ADR 0056). 이 컴퓨터의 세션 폴더와 다른 컴퓨터의 도슨트(peers.mjs)를 같은 제공자 interface 로 묶는다.
//
// 제공자 interface (두 종류가 모두 낸다):
//   id                      "claude", "@book" 처럼 세션 id 앞부분
//   host                    null 이면 이 컴퓨터, 아니면 다른 컴퓨터 이름
//   owns(sessionId)         이 제공자의 세션 id 인가(앞부분만 본다)
//   check(sessionId)        이 제공자가 가질 수 없는 모양의 id 면 400 을 던진다
//   list()                  세션 목록 항목들(정렬 전, 꾸미기 전)
//   describe(sessions)      목록에 보일 세션에 붙일 정보(저장소, 브랜치, 워크트리, 최근 작업)를 붙여 같은 순서로 돌려준다
//   transcript(sessionId)   정규화 전사 markdown
//   watch(sessionId, send)  라이브 사건을 send 로 흘리고 stop 을 돌려준다
//   idOf(path)              이 컴퓨터의 파일 경로가 이 제공자 목록의 세션이면 그 id, 아니면 null
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { httpError } from "./errors.mjs";
import { watchSession } from "./live.mjs";
import { compareSessions } from "./herdr-workspaces.mjs";
import { gitLocationOf, headOf } from "./repo.mjs";
import { recentLine } from "./session-recent.mjs";
import { pickFromTail, readHead } from "./session-file.mjs";

const LIST_MAX = 200;
const MAX_SESSION_BYTES = 80 * 1024 * 1024;
const TRANSCRIPT_CACHE = 8;
// 최근 작업 한 줄은 꼬리부터 읽는다. 끝부분이 도구 결과뿐이면 한 번 더 넓게 읽는다.
const RECENT_TAIL_BYTES = [256 * 1024, 2 * 1024 * 1024];

/**
 * 이 컴퓨터의 호스트 adapter 들을 세션 제공자로. 파일은 `<home>/<adapter.dir>` 아래 `depth` 단계 폴더 안에 있고 이름이 `match` 와 맞아야 한다.
 * 파일을 읽는 일은 session-file.mjs, 읽은 글의 해석(목록 메타·숨김, 전사, 사건 카드)은 adapter 가 한다 (ADR 0054).
 * `adapter.stamp(path)` 는 본 파일 밖에서 전사에 들어가는 것(예: 서브에이전트 파일)의 변경 표시다.
 * 제공자들은 전사 캐시(최근 8개)와 작업 폴더별 git 위치 기억을 함께 쓴다.
 * `herdr`(herdr-workspaces.mjs 의 `herdrWorkspaces()`)를 주면 Herdr 창에 열린 세션 항목에 `herdr: {workspace, label, number, pane}` 을 붙인다 (ADR 0060). 없으면 붙이지 않는다.
 */
export function localProviders(adapters, { home, herdr = null }) {
	const transcripts = new Map();
	const places = new Map();
	/** 작업 폴더의 git 위치(저장소, 워크트리, gitdir). 폴더 구조는 잘 바뀌지 않아 폴더별로 기억한다. */
	const placeOf = async (cwd) => {
		if (!cwd) return null;
		if (!places.has(cwd)) places.set(cwd, await gitLocationOf(cwd));
		return places.get(cwd);
	};
	return adapters.map((adapter) => localProvider(adapter, { home, transcripts, placeOf, herdr }));
}

function localProvider(adapter, { home, transcripts, placeOf, herdr }) {
	const { id, depth = 1, match = /\.jsonl$/, headBytes } = adapter;
	const root = join(home, adapter.dir);
	const metas = new Map();
	const recents = new Map();
	const walk = async (dir, level) => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		const found = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (level < depth) {
				if (entry.isDirectory()) found.push(...await walk(path, level + 1));
			} else if (entry.isFile() && match.test(entry.name)) found.push(path);
		}
		return found;
	};
	/** 목록이 보는 자리인가: root 아래 `depth` 단계 폴더 안에 있고 이름이 `match` 와 맞는 파일. 목록, id → 경로, 경로 → id 가 같은 규칙을 쓴다. */
	const listable = (path) => {
		const rel = relative(root, path);
		if (!rel || isAbsolute(rel)) return false;
		const parts = rel.split(sep);
		return parts[0] !== ".." && parts.length === depth + 1 && match.test(parts[depth]);
	};
	/** root 기준 상대 경로. 세션 id 에는 운영체제와 관계없이 `/` 로 쓴다(Windows 경로의 `\` 도 `/`). */
	const relOf = (path) => relative(root, path).split(sep).join("/");
	/** 세션 id → 파일 경로. id 는 `<제공자>:<root 기준 상대 경로>` 이다. */
	const pathOf = (sid) => {
		const path = resolve(root, sid.slice(id.length + 1));
		if (!listable(path)) throw httpError(400, "bad session id");
		return path;
	};
	/** 최근 작업 한 줄. 파일이 바뀌었을 때만 꼬리를 다시 읽는다. */
	const recent = async (sid) => {
		const path = pathOf(sid);
		const st = await stat(path);
		const cached = recents.get(path);
		if (cached?.mtimeMs === st.mtimeMs) return cached.line;
		const line = await pickFromTail(path, RECENT_TAIL_BYTES, (tail) => recentLine(adapter.events(tail)), st.size);
		recents.set(path, { mtimeMs: st.mtimeMs, line });
		return line;
	};
	return {
		id,
		host: null,
		owns: (sid) => sid.startsWith(`${id}:`),
		/** 머리 읽기는 파일이 바뀐 것만. 이어 쓰는 세션은 머리가 한 번 다 찼으면 다시 읽지 않는다. */
		async list() {
			const out = [];
			const open = (await herdr?.sessions()) ?? new Map();
			for (const path of await walk(root, 0)) {
				const st = await stat(path).catch(() => null);
				if (!st?.size) continue;
				const cached = metas.get(path);
				let m;
				if (cached && (cached.mtimeMs === st.mtimeMs || (cached.m && cached.full && st.size >= cached.size))) m = cached.m;
				else {
					m = await adapter.meta(await readHead(path, headBytes), path);
					metas.set(path, { mtimeMs: st.mtimeMs, size: st.size, full: st.size >= headBytes, m });
				}
				if (!m) continue;
				const rel = relOf(path);
				out.push({
					id: `${id}:${rel}`,
					provider: id,
					title: m.title,
					project: m.cwd ? basename(m.cwd) : rel.split("/")[0],
					...(m.cwd ? { repo: (await placeOf(m.cwd))?.repo ?? null } : {}),
					cwd: m.cwd,
					started: m.started,
					updated: st.mtime.toISOString(),
					bytes: st.size,
					first: m.first ?? null,
					host: null,
					...(open.has(resolve(path)) ? { herdr: open.get(resolve(path)) } : {}),
				});
			}
			return out;
		},
		/** 브랜치는 바뀌므로 매번 HEAD 를 읽는다. 같은 gitdir 은 한 번만 읽는다. */
		describe(sessions) {
			const heads = new Map();
			return Promise.all(sessions.map(async (session) => {
				const place = await placeOf(session.cwd);
				if (place?.gitdir && !heads.has(place.gitdir)) heads.set(place.gitdir, headOf(place.gitdir));
				const head = place?.gitdir ? await heads.get(place.gitdir) : null;
				const line = await recent(session.id).catch(() => "");
				return { ...session, ...(place?.worktree ? { worktree: place.worktree } : {}), ...head, ...(line ? { recent: line } : {}) };
			}));
		},
		/** 같은 파일(크기·수정 시각·stamp)이면 정규화 결과를 다시 쓴다. 질문·원문 보기·전사 보기가 함께 쓴다. */
		async transcript(sid) {
			const path = pathOf(sid);
			const st = await stat(path);
			if (st.size > MAX_SESSION_BYTES) throw httpError(413, "session too large");
			const version = `${st.size}:${st.mtimeMs}:${adapter.stamp ? await adapter.stamp(path) : ""}`;
			const cached = transcripts.get(path);
			if (cached?.version === version) return cached.md;
			const md = await adapter.transcript(await readFile(path, "utf8"), path);
			transcripts.delete(path);
			transcripts.set(path, { version, md });
			while (transcripts.size > TRANSCRIPT_CACHE) transcripts.delete(transcripts.keys().next().value);
			return md;
		},
		check: (sid) => void pathOf(sid),
		watch: (sid, send) => watchSession(pathOf(sid), adapter, send),
		/** 목록이 보지 않는 자리의 파일, 아직 저장되지 않은 새 세션(첫 메시지 전)의 빈 파일은 null. */
		async idOf(path) {
			if (!listable(path)) return null;
			const st = await stat(path).catch(() => null);
			if (!st?.isFile() || !st.size) return null;
			return `${id}:${relOf(path)}`;
		},
	};
}

/**
 * 제공자들 위의 세션 목록. 세션 id 로 제공자 찾기, 합친 목록(Herdr 에 열린 세션 먼저, 그다음 최근 활동 순 200개, 꾸미기는 그 세션을 가진 제공자가),
 * 이 컴퓨터의 파일 경로 → 세션 id 를 맡는다.
 */
export function sessionCatalog(providers) {
	/** 모르는 제공자, 그 제공자가 가질 수 없는 id 는 400. 라이브 스트림을 열기 전에 부를 수 있도록 바로 던진다. */
	const providerOf = (sessionId) => {
		const provider = providers.find((p) => p.owns(sessionId));
		if (!provider) throw httpError(400, "unknown provider");
		provider.check(sessionId);
		return provider;
	};
	return {
		providerOf,
		async list() {
			const listed = await Promise.all(providers.map(async (provider) => (await provider.list()).map((session) => ({ provider, session }))));
			const all = listed.flat();
			// Herdr 에 열린 세션이 먼저(ADR 0060), 나머지는 최근 활동 순. 자르기 전에 정렬해 Herdr 세션이 200개 밖으로 밀리지 않는다.
			const hostOrder = (host) => providers.findIndex((p) => p.host === host);
			all.sort((a, b) => compareSessions(a.session, b.session, hostOrder));
			const top = all.slice(0, LIST_MAX);
			const described = new Map();
			await Promise.all(providers.map(async (provider) => {
				const own = top.filter((entry) => entry.provider === provider).map((entry) => entry.session);
				if (!own.length) return;
				(await provider.describe(own)).forEach((session, i) => described.set(own[i], session));
			}));
			return top.map((entry) => described.get(entry.session));
		},
		transcript: async (sessionId) => providerOf(sessionId).transcript(sessionId),
		watch: (sessionId, send) => providerOf(sessionId).watch(sessionId, send),
		/** 에이전트가 알려 준 자기 세션 파일 경로 → 세션 id (docent herdr, ADR 0044). 이 컴퓨터의 제공자만 답한다. */
		async resolve(path) {
			const absolute = resolve(path);
			for (const provider of providers) {
				const id = await provider.idOf(absolute);
				if (id) return id;
			}
			throw httpError(404, "이 파일은 도슨트가 읽는 세션 폴더에 없거나 아직 비어 있어요.");
		},
	};
}
