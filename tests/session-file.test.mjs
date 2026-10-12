import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { followFile, pickFromTail, readHead, readTail } from "../app/session-file.mjs";

async function tempFile(t, content) {
	const dir = await mkdtemp(join(tmpdir(), "docent-session-file-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	await writeFile(path, content);
	return path;
}

test("tail drops the line it cut into, even inside a multibyte character, and head keeps its cut end", async (t) => {
	const path = await tempFile(t, "첫째 줄\n둘째 줄\n셋째 줄\n");
	const size = Buffer.byteLength("첫째 줄\n둘째 줄\n셋째 줄\n");
	// 줄마다 11바이트. 끝에서 13바이트는 둘째 줄 "줄" 글자의 마지막 바이트부터라 글자 중간에서 시작한다.
	assert.equal(await readTail(path, 13, size), "셋째 줄\n");
	assert.equal(await readTail(path, size, size), "첫째 줄\n둘째 줄\n셋째 줄\n");
	assert.equal(await readTail(path, 3), "", "a tail inside one line has no whole line");
	assert.equal(await readHead(path, 11), "첫째 줄\n");
	assert.ok((await readHead(path, 15)).startsWith("첫째 줄\n둘"), "the cut end stays for the adapter to skip");
	assert.equal(await readHead(path, 1024), "첫째 줄\n둘째 줄\n셋째 줄\n");
});

test("a tail that holds nothing widens until something is found or the file is read whole", async (t) => {
	const path = await tempFile(t, `{"pick":"오래된 답"}\n${'{"noise":1}\n'.repeat(20)}`);
	const seen = [];
	const pick = (text) => { seen.push(text.length); return /"pick":"([^"]+)"/.exec(text)?.[1] ?? ""; };
	assert.equal(await pickFromTail(path, [30, 100, 10_000], pick), "오래된 답");
	assert.equal(seen.length, 3, "the first two tails held only noise");
	seen.length = 0;
	assert.equal(await pickFromTail(path, [30, 10_000, 20_000], () => ""), "");
	const empty = await tempFile(t, "");
	assert.equal(await pickFromTail(empty, [30, 100], pick), "");
});

test("following returns only completed lines, joins a character split across writes, and restarts on a shrunk file", async (t) => {
	const path = await tempFile(t, "옛 줄 1\n옛 줄 2\n");
	const file = followFile(path);
	assert.equal(await file.start(1024), "옛 줄 1\n옛 줄 2\n");
	assert.equal(await file.next(), "");

	const line = Buffer.from("새 줄 한글\n");
	await appendFile(path, line.subarray(0, 5)); // "새 " + "줄"의 첫 바이트
	assert.equal(await file.next(), "", "an unfinished line waits");
	await appendFile(path, line.subarray(5));
	await appendFile(path, "다음 줄도");
	assert.equal(await file.next(), "새 줄 한글\n");
	await appendFile(path, " 끝\n");
	assert.equal(await file.next(), "다음 줄도 끝\n");

	await writeFile(path, "다시 씀\n"); // 기준점보다 작아진 파일은 처음부터
	assert.equal(await file.next(), "다시 씀\n");
	await rm(path);
	assert.equal(await file.next(), null);
	assert.equal(await followFile(path).start(1024), null);
});
