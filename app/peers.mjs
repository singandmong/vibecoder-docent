// 다른 컴퓨터의 docent 를 세션 제공자로 (ADR 0011, interface 는 catalog.mjs, ADR 0056). 세션 목록·전사·라이브만 그쪽 API 에서 받아 온다.
// 답은 여기 omp 가 만든다. 원격 세션 id 는 `@<이름>/<원래 id>`.
// 원격 프로필 ID는 로컬 사용자와 동일인임을 보장하지 않으므로 문답 역사는 가져오지 않는다 (ADR 0014).
const LIST_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30_000;
// 그쪽 서버 응답 크기 상한. 전사 상한은 이 컴퓨터의 세션 파일 상한(catalog.mjs MAX_SESSION_BYTES)과 같게 둔다.
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 80 * 1024 * 1024;
// 원격 SSE 가 이만큼 쌓이도록 한 줄도 끝나지 않으면 연결을 끊는다.
const MAX_FRAME_BYTES = 1024 * 1024;

/** 목록 항목에서 이 컴퓨터의 화면·정렬이 쓰는 필드만, 맞는 형식일 때만 남긴다. 모르는 필드와 다른 형식은 버린다. */
const SESSION_TEXT_FIELDS = ["id", "provider", "title", "project", "repo", "cwd", "started", "updated", "first", "worktree", "branch", "recent"];
export function cleanPeerSession(value) {
	if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) return null;
	const out = {};
	for (const key of SESSION_TEXT_FIELDS) if (typeof value[key] === "string") out[key] = value[key];
	if (Number.isFinite(value.bytes)) out.bytes = value.bytes;
	if (value.detached === true) out.detached = true;
	const herdr = value.herdr;
	if (herdr && typeof herdr === "object") {
		const entry = {};
		for (const key of ["workspace", "label", "number", "pane"]) {
			const v = herdr[key];
			if (typeof v === "string" || Number.isFinite(v)) entry[key] = v;
		}
		if (Object.keys(entry).length) out.herdr = entry;
	}
	return out;
}

/** `fetch` 는 HTTP 연결 자리, `ssh(name, base)` 는 그 컴퓨터에 닿는 이 컴퓨터의 ssh 별칭을 찾는 자리다(ssh-aliases.mjs, ADR 0067). 시험은 메모리 안의 가짜를 넘긴다. */
export function peerProvider(name, base, { fetch = globalThis.fetch, ssh = null } = {}) {
	const prefix = `@${name}/`;
	const url = (path, sid) => `${base.replace(/\/$/, "")}${path}?id=${encodeURIComponent(sid.slice(prefix.length))}`;
	/** 본문을 max 바이트까지만 읽는다. 넘으면 끊고 오류로 알린다. */
	const readCapped = async (r, max) => {
		const declared = Number(r.headers?.get?.("content-length") ?? 0);
		if (declared > max) throw new Error(`${name}: 응답이 너무 커요`);
		if (!r.body) {
			const text = await r.text();
			if (Buffer.byteLength(text) > max) throw new Error(`${name}: 응답이 너무 커요`);
			return text;
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of r.body) {
			size += chunk.length;
			if (size > max) {
				try { await r.body.cancel?.(); } catch { /* 이미 끊겼을 수 있다 */ }
				throw new Error(`${name}: 응답이 너무 커요`);
			}
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString("utf8");
	};
	const get = async (u, ms) => {
		// 그쪽 서버가 다른 주소로 돌려도 따라가지 않는다. 우리 서버를 통해 다른 곳을 부르는 통로가 되면 안 된다.
		const r = await fetch(u, { signal: AbortSignal.timeout(ms), redirect: "manual" });
		if (!r.ok) throw new Error(`${name}: ${r.status}`);
		return r;
	};
	return {
		id: `@${name}`,
		host: name,
		owns: (sid) => sid.startsWith(prefix),
		/** 원격 id 의 나머지 모양은 그쪽 서버가 판단한다. */
		check() {},
		async list() {
			try {
				const found = ssh ? Promise.resolve(ssh(name, base)).catch(() => null) : null;
				const r = await get(`${base.replace(/\/$/, "")}/api/sessions`, LIST_TIMEOUT_MS);
				const alias = found && (await found);
				const raw = r.body ? JSON.parse(await readCapped(r, MAX_LIST_BYTES)) : await r.json();
				if (!Array.isArray(raw)) throw new Error(`${name}: 세션 목록이 배열이 아니에요`);
				// 자기 컴퓨터가 알린 세션(host 참)과 ssh 값은 믿지 않고 버린다. 별칭만 이 컴퓨터의 ssh 설정에서 붙인다.
				return raw.filter((s) => s && !s.host).map(cleanPeerSession).filter(Boolean).map((s) => ({ ...s, id: prefix + s.id, host: name, ...(alias ? { ssh: alias } : {}) }));
			} catch (e) {
				console.error(`docent: ${name} 세션 목록을 못 받았어요 (${e.message})`);
				return [];
			}
		},
		/** 저장소·브랜치·최근 작업은 그쪽 서버가 자기 파일로 붙여 보냈다. 여기 폴더로 다시 찾지 않는다. */
		describe: async (sessions) => sessions,
		async transcript(sid) {
			const r = await get(url("/api/transcript", sid), FETCH_TIMEOUT_MS);
			return r.body ? await readCapped(r, MAX_TRANSCRIPT_BYTES) : await r.text();
		},
		/** 원격 SSE 를 그대로 흘려보낸다. stop 을 돌려준다. */
		watch(sid, send) {
			const ctl = new AbortController();
			(async () => {
				try {
					const r = await fetch(url("/api/live", sid), { signal: ctl.signal });
					if (!r.ok || !r.body) throw new Error(`${name}: ${r.status}`);
					let buf = "";
					const decoder = new TextDecoder();
					for await (const chunk of r.body) {
						buf += decoder.decode(chunk, { stream: true });
						if (buf.length > MAX_FRAME_BYTES) throw new Error(`${name}: 응답이 너무 커요`);
						let nl;
						while ((nl = buf.indexOf("\n\n")) >= 0) {
							const frame = buf.slice(0, nl);
							buf = buf.slice(nl + 2);
							const data = frame.split("\n").find((l) => l.startsWith("data: "));
							if (data) send(JSON.parse(data.slice(6)));
						}
					}
				} catch (e) {
					if (!ctl.signal.aborted) send({ kind: "warn", text: `${name} 연결이 끊겼어요: ${e.message}`, at: new Date().toISOString() });
				}
			})();
			return () => ctl.abort();
		},
		/** 다른 컴퓨터의 세션은 이 컴퓨터의 파일 경로가 없다. */
		idOf: async () => null,
	};
}

/** "이름=URL,이름=URL" 문자열과 config.peers 를 합친다. */
export function parsePeers(env, fromConfig) {
	const peers = { ...(fromConfig ?? {}) };
	for (const part of (env ?? "").split(",")) {
		const [name, ...rest] = part.split("=");
		if (name?.trim() && rest.length) peers[name.trim()] = rest.join("=").trim();
	}
	return peers;
}
