// 다른 컴퓨터의 docent 를 세션 제공자로 (ADR 0011, interface 는 catalog.mjs, ADR 0056). 세션 목록·전사·라이브만 그쪽 API 에서 받아 온다.
// 답은 여기 omp 가 만든다. 원격 세션 id 는 `@<이름>/<원래 id>`.
// 원격 프로필 ID는 로컬 사용자와 동일인임을 보장하지 않으므로 문답 역사는 가져오지 않는다 (ADR 0014).
const LIST_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30_000;

/** `fetch` 는 HTTP 연결 자리, `ssh(name, base)` 는 그 컴퓨터에 닿는 이 컴퓨터의 ssh 별칭을 찾는 자리다(ssh-aliases.mjs, ADR 0067). 시험은 메모리 안의 가짜를 넘긴다. */
export function peerProvider(name, base, { fetch = globalThis.fetch, ssh = null } = {}) {
	const prefix = `@${name}/`;
	const url = (path, sid) => `${base.replace(/\/$/, "")}${path}?id=${encodeURIComponent(sid.slice(prefix.length))}`;
	const get = async (u, ms) => {
		const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
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
				// 별칭은 이 컴퓨터의 ssh 설정에서 온다. 그쪽 서버가 보낸 ssh 값은 믿지 않고 버린다.
				return (await r.json()).filter((s) => !s.host).map(({ ssh: _remote, ...s }) => ({ ...s, id: prefix + s.id, host: name, ...(alias ? { ssh: alias } : {}) }));
			} catch (e) {
				console.error(`docent: ${name} 세션 목록을 못 받았어요 (${e.message})`);
				return [];
			}
		},
		/** 저장소·브랜치·최근 작업은 그쪽 서버가 자기 파일로 붙여 보냈다. 여기 폴더로 다시 찾지 않는다. */
		describe: async (sessions) => sessions,
		async transcript(sid) {
			return (await get(url("/api/transcript", sid), FETCH_TIMEOUT_MS)).text();
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
