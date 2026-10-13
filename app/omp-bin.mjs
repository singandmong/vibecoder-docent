// OMP_BIN 을 실제로 실행할 `{ command, args }` 로 바꾼다 (ADR 0062).
// `.js`, `.mjs`, `.cjs` 경로는 shebang 에 기대지 않고 지금 쓰는 Node 로 실행한다.
// Windows 는 shebang 을 읽지 못하고, npm 으로 설치한 omp 의 JS 진입점을 OMP_BIN 으로 줄 때도 같은 방법이 필요하다.
const SCRIPT = /\.(?:[cm]?js)$/i;

/**
 * @param {string} bin  OMP_BIN 값(실행 파일 또는 JS 진입점 경로)
 * @param {string[]} [args]
 * @returns {{ command: string, args: string[] }}
 */
export function ompCommand(bin, args = []) {
	return SCRIPT.test(bin) ? { command: process.execPath, args: [bin, ...args] } : { command: bin, args: [...args] };
}
