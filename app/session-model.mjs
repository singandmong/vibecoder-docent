// 설명 대상 세션이 쓰던 모델 (ADR 0069). 정규화 전사의 `(모델: X)` 표식 중 마지막 것을 omp 카탈로그의 정확한 모델로 바꾼다.
// 프로필에서 모델을 고르지 않았을 때(기본)의 설명·분류 모델이 된다. 찾지 못하면 omp 기본 모델로 가고 그렇다고 알린다.
import { modelCatalog } from "./models.mjs";

const MARK = /\(모델: ([^)\n]+)\)/g;
const CATALOG_TTL = 60_000;
/** 호스트별로 같은 id 가 여러 공급자에 있을 때 먼저 볼 공급자. */
const HOME_PROVIDERS = { claude: ["anthropic"], codex: ["openai-codex", "openai"], gemini: ["google", "google-gemini-cli", "google-antigravity"] };

/** 전사에서 마지막으로 표시된 모델. 없으면 null. */
export function lastModelMark(transcript) {
	let last = null;
	for (const match of String(transcript ?? "").matchAll(MARK)) last = match[1].trim();
	return last || null;
}

const idOf = (model) => model.selector.slice(model.provider.length + 1);

/**
 * 전사 표기를 카탈로그의 정확한 모델 하나로. omp 는 `공급자/id`(추론 접미 `:high` 가능), Claude 와 Codex 는 id 만 적는다.
 * 같은 id 가 여러 공급자에 있으면 세션 호스트의 공급자가 하나로 가려질 때만 고르고, 아니면 null(추측하지 않는다).
 * @param {string|null} raw
 * @param {{selector: string, provider: string}[]} models
 * @param {string} [host] 세션 제공자 id(omp, claude, codex, gemini, pi)
 */
export function matchSessionModel(raw, models, host) {
	if (!raw) return null;
	const names = [raw];
	const colon = raw.lastIndexOf(":");
	if (colon > 0) names.push(raw.slice(0, colon));
	for (const name of [...names]) if (/-\d{8}$/.test(name)) names.push(name.replace(/-\d{8}$/, "")); // Claude 의 날짜 붙은 id
	for (const name of names) {
		const exact = models.find((model) => model.selector === name);
		if (exact) return exact;
		const same = models.filter((model) => idOf(model) === name);
		if (same.length === 1) return same[0];
		if (same.length > 1) {
			for (const provider of HOME_PROVIDERS[host] ?? []) {
				const home = same.filter((model) => model.provider === provider);
				if (home.length === 1) return home[0];
			}
		}
	}
	return null;
}

let cache = null;
async function catalogModels() {
	if (cache && Date.now() - cache.at < CATALOG_TTL) return cache.models;
	try {
		const { models } = await modelCatalog();
		cache = { at: Date.now(), models };
		return models;
	} catch {
		return cache?.models ?? [];
	}
}

/** @returns {Promise<{raw: string|null, model: object|null}>} raw 는 전사의 표기, model 은 카탈로그에서 찾은 모델 */
export async function sessionModel(transcript, host) {
	const raw = lastModelMark(transcript);
	if (!raw) return { raw: null, model: null };
	return { raw, model: matchSessionModel(raw, await catalogModels(), host) };
}
