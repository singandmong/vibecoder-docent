/** 화면에 그대로 보여 줄 수 있는 오류. `status` 가 HTTP 상태 코드가 된다. */
export function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}
