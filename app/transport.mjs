// 도슨트 서버와 주고받는 transport adapter (ADR 0055). 웹과 터미널이 같은 adapter 를 쓴다.
// fetch, ReadableStream, TextDecoder 만 쓰므로 브라우저도 /transport.mjs 정적 파일로 불러온다. node: module 을 쓰지 않는다.
// 오류 문구는 서버가 준 {error} 를 그대로 싣는다. 화면에 맞게 다듬는 일(터미널 제어 문자 제거 등)은 각 화면이 한다.

export class TransportError extends Error {
	constructor(message, status = 0) {
		super(message);
		this.name = "TransportError";
		this.status = status;
	}
}

function apiMessage(value, fallback) {
	if (value && typeof value === "object" && typeof value.error === "string" && value.error.trim()) return value.error;
	if (typeof value === "string" && value.trim()) return value;
	return fallback;
}

/** 줄 단위 본문을 끝까지 읽는다. 마지막 줄에 줄바꿈이 없어도 그 줄을 넘긴다. 한 글자가 두 조각으로 나뉘어 와도 이어 붙인다. */
async function readLines(body, onLine) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			let offset;
			while ((offset = buffer.indexOf("\n")) >= 0) {
				onLine(buffer.slice(0, offset));
				buffer = buffer.slice(offset + 1);
			}
			if (done) break;
		}
		if (buffer) onLine(buffer);
	} finally {
		reader.releaseLock();
	}
}

export class HttpTransport {
	/** baseUrl: 서버 주소. 브라우저는 location.origin. fetchImpl 은 테스트에서 바꿔 끼운다. */
	constructor(baseUrl, fetchImpl = globalThis.fetch) {
		if (typeof fetchImpl !== "function") throw new Error("이 환경에서는 fetch 를 사용할 수 없어요.");
		this.baseUrl = String(baseUrl).replace(/\/+$/, "");
		// 브라우저 fetch 는 다른 객체를 this 로 부르면 Illegal invocation 이 난다. 함수로만 부른다.
		this.fetch = (url, init) => fetchImpl(url, init);
	}

	url(path) {
		return new URL(String(path).replace(/^\/+/, ""), `${this.baseUrl}/`);
	}

	async responseError(response, fallback) {
		const raw = await response.text().catch(() => "");
		let value = raw;
		try { value = raw ? JSON.parse(raw) : null; } catch {}
		return new TransportError(apiMessage(value, fallback), response.status);
	}

	/** 요청을 보내고 응답을 연다. 연결 실패는 status 0 의 TransportError, 서버 실패는 서버 문구와 status. */
	async open(path, init, fallback, failure) {
		let response;
		try {
			response = await this.fetch(this.url(path), init);
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw new TransportError(error?.message || fallback);
		}
		if (!response.ok) throw await this.responseError(response, failure);
		return response;
	}

	async json(path, { method = "GET", body, signal } = {}) {
		const response = await this.open(path, {
			method,
			headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal,
		}, "연결할 수 없어요.", "도슨트 서버가 요청을 처리하지 못했어요.");
		try { return await response.json(); }
		catch { throw new TransportError(`서버 응답을 읽을 수 없어요 (${response.status}).`, response.status); }
	}

	profiles(signal) { return this.json("/api/profiles", { signal }); }
	sessions(signal) { return this.json("/api/sessions", { signal }); }
	models(signal) { return this.json("/api/models", { signal }); }
	/** 이 세션의 모델(모델을 고르지 않았을 때 설명에 쓰임). {raw, model}: model 이 null 이면 omp 기본 모델 */
	sessionModel(sessionId, signal) { return this.json(`/api/session-model?${new URLSearchParams({ id: sessionId })}`, { signal }); }
	evidence(sessionId, ref, profileId = "default", signal) {
		const query = new URLSearchParams({ id: sessionId, ref, profileId });
		return this.json(`/api/evidence?${query}`, { signal });
	}
	glossary(profileId = "default", signal) {
		return this.json(`/api/glossary?${new URLSearchParams({ profileId })}`, { signal });
	}
	wiki(profileId = "default", signal) {
		return this.json(`/api/wiki?${new URLSearchParams({ profileId })}`, { signal });
	}
	wikiExtract(profileId = "default") {
		return this.json("/api/wiki/extract", { method: "POST", body: { profileId } });
	}
	updateProfile(id, patch) { return this.json(`/api/profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }); }
	favorites(sessionId, profileId, signal) {
		const query = new URLSearchParams({ profileId, id: sessionId });
		return this.json(`/api/favorites?${query}`, { signal });
	}
	/** 즐겨찾기 켜기/끄기. focus 는 {label, text} 또는 세션 전체 대화(null). */
	setFavorite(sessionId, profileId, favorite, focus) {
		return this.json("/api/favorites", { method: "POST", body: { profileId, id: sessionId, favorite, focus } });
	}

	history(sessionId, profileId, signal) {
		const query = new URLSearchParams({ id: sessionId, profileId });
		return this.json(`/api/history?${query}`, { signal });
	}

	jobs(sessionId, profileId, signal) {
		const query = new URLSearchParams({ id: sessionId, profileId });
		return this.json(`/api/jobs?${query}`, { signal });
	}

	/** 세션의 실시간 사건(SSE). 연결이 닫히면 돌아온다. 다시 붙는 일은 부르는 쪽이 한다. */
	async events(sessionId, profileId, signal, onEvent, onOpen) {
		const query = new URLSearchParams({ id: sessionId, profileId });
		let response;
		try {
			response = await this.open(`/api/live?${query}`, { headers: { accept: "text/event-stream" }, signal }, "실시간 연결을 열 수 없어요.", "실시간 기록을 열 수 없어요.");
		} catch (error) {
			if (signal?.aborted) return;
			throw error;
		}
		if (!response.body) throw new TransportError("실시간 응답 본문이 비어 있어요.");
		onOpen?.();
		let data = [];
		const dispatch = () => {
			if (!data.length) return;
			const payload = data.join("\n");
			data = [];
			try { onEvent(JSON.parse(payload)); }
			catch (error) {
				if (error instanceof SyntaxError) return;
				throw error;
			}
		};
		await readLines(response.body, (value) => {
			const text = value.endsWith("\r") ? value.slice(0, -1) : value;
			if (!text) { dispatch(); return; }
			if (text[0] === ":") return;
			const colon = text.indexOf(":");
			const field = colon < 0 ? text : text.slice(0, colon);
			if (field === "data") data.push(colon < 0 ? "" : text.slice(colon + (text[colon + 1] === " " ? 2 : 1)));
		});
		dispatch();
	}

	/** 설명 요청(NDJSON 스트림). 줄마다 onEvent 를 부르고 마지막 결과(answer, error, cancelled)를 돌려준다. */
	async ask(body, signal, onEvent) {
		const response = await this.open("/api/ask", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/x-ndjson" },
			body: JSON.stringify(body),
			signal,
		}, "설명 요청을 전송하지 못했어요.", "설명 요청을 처리하지 못했어요.");
		if (!response.body) throw new TransportError("설명 응답 본문이 비어 있어요.");
		let outcome = null;
		await readLines(response.body, (raw) => {
			const text = raw.trim();
			if (!text) return;
			let event;
			try { event = JSON.parse(text); }
			catch { return; }
			onEvent(event);
			if (["answer", "error", "cancelled"].includes(event?.type)) outcome = event;
		});
		if (!outcome) throw new TransportError("설명이 끝나기 전에 연결이 닫혔어요.");
		return outcome;
	}

	cancel(profileId, requestId) {
		return this.json("/api/ask/cancel", { method: "POST", body: { profileId, requestId } });
	}

	steer(profileId, requestId, message) {
		return this.json("/api/ask/steer", { method: "POST", body: { profileId, requestId, message } });
	}
}
