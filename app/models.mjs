import { execFile } from "node:child_process";
import { ompCommand } from "./omp-bin.mjs";

const OMP_BIN = process.env.OMP_BIN ?? "omp";
const BILLING_NOTICE = "OMP 모델 카탈로그의 입력, 출력 단가는 USD / 100만 토큰 기준 참고값이에요. 연결, 인증 또는 실제 청구액을 보장하지 않으며, 0도 무료를 뜻하지 않아요. 구독 포함량, 캐시, 가격 구간에 따라 실제 비용이 달라질 수 있어요.";
const catalogError = () => Object.assign(new Error("OMP 모델 카탈로그를 읽지 못했어요. 설치와 모델 설정을 확인해 주세요. 요청 내용과 비밀값 보호를 위해 원시 실행 로그는 표시하거나 저장하지 않아요."), { status: 502 });

function catalogCost(cost) {
	const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (!cost || !valid(cost.input) || !valid(cost.output)) return null;
	const result = { input: cost.input, output: cost.output };
	for (const key of ["cacheRead", "cacheWrite"]) if (valid(cost[key])) result[key] = cost[key];
	return result;
}

/** The catalog is not proof of provider authentication or actual billing. */
export function modelCatalog() {
	return new Promise((resolve, reject) => {
		const target = ompCommand(OMP_BIN, ["models", "--json"]);
		const child = execFile(target.command, target.args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TERM: "dumb" } }, (error, stdout) => {
			if (error) return reject(catalogError());
			try {
				const catalog = JSON.parse(stdout);
				if (!Array.isArray(catalog?.models)) throw catalogError();
				const models = [];
				const seen = new Set();
				for (const model of catalog.models) {
					if (!model || model.kind !== "chat") continue;
					if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id || model.selector !== `${model.provider}/${model.id}` || typeof model.name !== "string" || !model.name) throw catalogError();
					if (seen.has(model.selector)) continue;
					seen.add(model.selector);
					models.push({ selector: model.selector, provider: model.provider, name: model.name, cost: catalogCost(model.cost) });
				}
				resolve({ models, source: "omp", billingNotice: BILLING_NOTICE });
			} catch {
				reject(catalogError());
			}
		});
		child.stdin?.end();
	});
}

/** Only exact catalog selectors are accepted, never CLI aliases or fuzzy names. */
export async function selectedModel(selector) {
	if (selector === null) return null;
	if (typeof selector !== "string" || !selector || selector.length > 2048) throw Object.assign(new Error("모델은 카탈로그의 정확한 선택값 또는 null이어야 해요."), { status: 400 });
	const selected = (await modelCatalog()).models.find((model) => model.selector === selector);
	if (!selected) throw Object.assign(new Error("선택한 모델이 OMP 채팅 모델 카탈로그에 없어요. 설정에서 모델을 다시 선택해 주세요."), { status: 400 });
	return selected;
}
