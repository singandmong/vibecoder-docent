// 호스트 adapter(transcript-<호스트>.mjs)가 함께 쓰는 것: 세션 jsonl 줄 읽기, 전사 머리말, CLI.
// 머리말의 작업 폴더 줄은 쓰는 쪽(adapter)과 읽는 쪽(학습 범위)이 여기 한 곳의 약속을 쓴다.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const UNKNOWN = "?";

/**
 * jsonl 글을 줄마다 JSON 객체로. 읽지 못하는 줄(머리 끝·꼬리 처음에서 잘린 줄, 아직 쓰는 중인 줄)과 객체가 아닌 줄은 건너뛴다.
 * 필요한 만큼만 읽도록 하나씩 내준다. `map` 은 호스트 엔트리를 다른 호스트 모양으로 바꿀 때 쓴다.
 */
export function* jsonLines(text, map = (entry) => entry) {
	for (const line of text.split("\n")) {
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry === null || typeof entry !== "object") continue;
		yield map(entry);
	}
}

/** 전사 맨 앞 머리말 줄들. 모르는 값은 `?` 로 적는다(모델이 읽는 글). */
export const transcriptHeader = ({ title, source, cwd, started }) => [
	`# ${title}`,
	"",
	`- 원본: ${source}`,
	`- 작업 폴더: ${cwd ?? UNKNOWN}`,
	`- 시작: ${started ?? UNKNOWN}`,
	"",
];

/** 전사 머리말의 작업 폴더. 모르면(`?`) null. 원격 docent 가 보낸 전사도 같은 머리말이라 같은 규칙으로 읽는다. */
export function transcriptCwd(markdown) {
	const cwd = /^- 작업 폴더: (.+)$/m.exec(markdown)?.[1]?.trim();
	return cwd && cwd !== UNKNOWN ? cwd : null;
}

/** adapter 파일을 직접 실행했을 때의 CLI: <session.jsonl> [out.md]. out 을 빼면 stdout. 불러오기만 했으면 아무것도 하지 않는다. */
export async function transcriptCli(moduleUrl, adapter) {
	if (!process.argv[1] || fileURLToPath(moduleUrl) !== process.argv[1]) return;
	const [, , input, output] = process.argv;
	if (!input) {
		console.error(`usage: ${basename(process.argv[1])} <session.jsonl> [out.md]`);
		process.exit(2);
	}
	const md = await adapter.transcript(readFileSync(input, "utf8"), input);
	if (output) {
		writeFileSync(output, md);
		console.error(`wrote ${output} (${md.length} chars)`);
	} else process.stdout.write(md);
}
