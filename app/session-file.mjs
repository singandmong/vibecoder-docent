// 세션 파일 읽기 module. 머리, 잘린 첫 줄을 버린 꼬리, 넓혀 가며 읽는 꼬리, 이어 읽기를 한곳에서 한다.
// 줄 해석은 하지 않는다. 돌려준 글을 호스트 adapter 가 읽는다.
import { open, stat } from "node:fs/promises";

const NEWLINE = 0x0a;

/** [start, end) 바이트. 그사이 파일이 줄었으면 읽힌 만큼만. */
async function readRange(path, start, end) {
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(Math.max(0, end - start));
		const { bytesRead } = await fh.read(buf, 0, buf.length, start);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

/** 파일 머리 bytes 만큼. 끝의 잘린 줄은 그대로 둔다(adapter 가 읽지 못하는 줄로 건너뛴다). */
export async function readHead(path, bytes) {
	return (await readRange(path, 0, bytes)).toString("utf8");
}

/**
 * 파일 끝 bytes 만큼. 파일 처음부터가 아니면 잘린 첫 줄을 버린다(글자 중간에서 잘렸어도 그 줄째 버리므로 깨진 글자가 남지 않는다).
 * `size` 는 호출자가 이미 본 파일 크기. 없으면 지금 크기.
 */
export async function readTail(path, bytes, size) {
	const end = size ?? (await stat(path)).size;
	const start = Math.max(0, end - bytes);
	const buf = await readRange(path, start, end);
	if (start === 0) return buf.toString("utf8");
	const nl = buf.indexOf(NEWLINE);
	return nl < 0 ? "" : buf.subarray(nl + 1).toString("utf8");
}

/**
 * 꼬리를 `widths` 순서로 넓혀 가며 읽고 `pick(text)` 가 빈 값이 아니면 돌려준다.
 * 파일 전체를 읽었는데도 비었으면 마지막 결과(빈 값)를 돌려준다.
 */
export async function pickFromTail(path, widths, pick, size) {
	const end = size ?? (await stat(path)).size;
	let picked;
	for (const bytes of widths) {
		picked = pick(await readTail(path, bytes, end));
		if (picked || bytes >= end) break;
	}
	return picked;
}

/**
 * 이어 읽기. 감시 하나에 하나.
 * - `start(bytes)`: 지금 파일 끝을 기준점으로 삼고 꼬리 bytes 를 돌려준다. 파일이 없으면 null.
 * - `next()`: 기준점 뒤에 새로 끝난 줄들. 아직 끝나지 않은 줄은 남겨 두었다가 다음 읽기와 합친다
 *   (여러 바이트 글자가 읽기 사이에서 잘려도 깨지지 않는다). 새 줄이 없으면 "". 파일이 없으면 null.
 *   파일이 기준점보다 작아졌으면 새로 쓰인 것으로 보고 처음부터 다시 읽는다.
 */
export function followFile(path) {
	let offset = -1;
	let remainder = Buffer.alloc(0);
	return {
		async start(bytes) {
			const st = await stat(path).catch(() => null);
			if (!st) return null;
			const tail = await readTail(path, bytes, st.size);
			offset = st.size;
			remainder = Buffer.alloc(0);
			return tail;
		},
		async next() {
			if (offset < 0) throw new Error("followFile: start() 를 먼저 불러야 해요");
			const st = await stat(path).catch(() => null);
			if (!st) return null;
			if (st.size < offset) {
				offset = 0;
				remainder = Buffer.alloc(0);
			}
			if (st.size === offset) return "";
			const fresh = await readRange(path, offset, st.size);
			offset += fresh.length;
			const chunk = remainder.length ? Buffer.concat([remainder, fresh]) : fresh;
			// 줄바꿈 바이트(0x0a)는 여러 바이트 글자 안에 나오지 않으므로 여기서 자르면 글자가 깨지지 않는다.
			const nl = chunk.lastIndexOf(NEWLINE);
			remainder = nl >= 0 ? chunk.subarray(nl + 1) : chunk;
			return nl >= 0 ? chunk.subarray(0, nl + 1).toString("utf8") : "";
		},
	};
}
