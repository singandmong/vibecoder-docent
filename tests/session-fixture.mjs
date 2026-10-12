// 호스트 adapter 시험 도우미. 임시 HOME 의 호스트 세션 폴더에 fixture 파일을 쓰고,
// 서버와 같은 읽기(session-file.mjs)로 adapter interface 를 거쳐 메타·전사·사건 카드를 본다.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readHead, readTail } from "../app/session-file.mjs";

export const jsonl = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");

/** `<HOME>/<adapter.dir>/<rel>` 에 entries 를 쓴다. `files` 는 HOME 기준 상대 경로 → 내용(옆 폴더 표시 파일, 서브에이전트 등). */
export async function sessionFixture(t, adapter, rel, entries, files = {}) {
	const home = await mkdtemp(join(tmpdir(), `docent-${adapter.id}-`));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, adapter.dir, rel);
	const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`);
	for (const [file, content] of Object.entries(files)) {
		await mkdir(dirname(join(home, file)), { recursive: true });
		await writeFile(join(home, file), content);
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, lines.join(""));
	const text = await readFile(path, "utf8");
	const { size } = await stat(path);
	return {
		path,
		home,
		meta: await adapter.meta(await readHead(path, adapter.headBytes), path),
		transcript: await adapter.transcript(text, path),
		events: adapter.events(text),
		/** 줄 `index` 의 가운데에서 자른 머리(그 앞 줄들 + 반쪽 줄)와 꼬리(반쪽 줄 + 그 뒤 줄들). */
		async cutAt(index) {
			const before = Buffer.byteLength(lines.slice(0, index).join(""));
			const cut = before + Math.floor(Buffer.byteLength(lines[index]) / 2);
			return {
				meta: await adapter.meta(await readHead(path, cut), path),
				events: adapter.events(await readTail(path, size - cut, size)),
			};
		},
	};
}
