// 동시에 돌릴 수 있는 일의 수를 제한한다 (ADR 0075). 넘으면 순서대로 기다리고, 기다리다 중단되면 그 자리를 건너뛴다.
// 모델 호출과 파일 읽기가 한꺼번에 몰려도 자원과 비용이 함께 늘지 않게 한다.
import { CancelledError } from "./runner.mjs";

/**
 * @param {number} max 동시에 돌릴 수 있는 수
 */
export function capacity(max) {
	let active = 0;
	const waiting = [];
	const release = () => {
		active--;
		waiting.shift()?.();
	};
	/**
	 * 자리를 얻는다. 돌려받은 함수를 부르면 자리를 넘긴다.
	 * 기다리는 동안 `signal` 이 중단되면 CancelledError 로 거절한다.
	 */
	const acquire = (signal) => new Promise((res, rej) => {
		const grant = () => {
			signal?.removeEventListener?.("abort", onAbort);
			active++;
			res(release);
		};
		const onAbort = () => {
			const index = waiting.indexOf(grant);
			if (index >= 0) waiting.splice(index, 1);
			rej(new CancelledError());
		};
		if (signal?.aborted) return rej(new CancelledError());
		if (active < max) return grant();
		waiting.push(grant);
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
	return {
		acquire,
		get active() { return active; },
		get waiting() { return waiting.length; },
	};
}
