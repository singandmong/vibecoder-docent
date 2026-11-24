// 텔레그램 Bot API 클라이언트. Node 내장 fetch 만 쓴다. 재시도는 하지 않는다(봇 module 몫).
// 토큰은 URL 경로에 들어가므로 오류·로그 어디에도 URL 이나 원래 오류 문장을 싣지 않는다.

export class TelegramError extends Error {
	constructor(message, { status = 0, method = "", description = "", retryAfter = null } = {}) {
		super(message);
		this.name = "TelegramError";
		this.status = status;
		this.method = method;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/** 문자열 안의 토큰을 <token> 으로 바꾼다. 로그로 나가기 전 마지막 안전망이다. */
export function redactToken(text, token) {
	const s = String(text ?? "");
	return token ? s.split(String(token)).join("<token>") : s;
}

export function telegramApi({ token, base = process.env.DOCENT_TELEGRAM_API || "https://api.telegram.org", fetch = globalThis.fetch } = {}) {
	const root = String(base).replace(/\/$/, "");
	return {
		async call(method, params = {}, { signal, timeoutMs = 15_000 } = {}) {
			const timeout = AbortSignal.timeout(timeoutMs);
			let res;
			try {
				res = await fetch(`${root}/bot${token}/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(params),
					// 다른 주소로 돌려도 따라가지 않는다.
					redirect: "manual",
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
			} catch (e) {
				const code = e?.cause?.code ?? e?.code ?? e?.name ?? "알 수 없음";
				throw new TelegramError(`텔레그램 ${method} 요청 실패 (${redactToken(code, token)})`, { status: 0, method });
			}
			let body = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			if (body?.ok === true) return body.result;
			const status = Number(body?.error_code) || res.status || 0;
			const description = redactToken(typeof body?.description === "string" ? body.description : "", token);
			const retry = Number(body?.parameters?.retry_after);
			throw new TelegramError(`텔레그램 ${method} 요청 실패 (${status})`, {
				status,
				method,
				description,
				retryAfter: Number.isFinite(retry) && retry >= 0 && body?.parameters?.retry_after != null ? retry : null,
			});
		},
	};
}
