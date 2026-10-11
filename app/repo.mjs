import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * 작업 폴더가 속한 git 저장소 이름. 위로 올라가며 .git 을 찾는다.
 * 워크트리의 .git 은 "gitdir: <저장소>/.git/worktrees/<이름>" 파일이라 그 경로에서 원래 저장소 이름을 읽는다.
 * 서브모듈처럼 worktrees 가 아닌 gitdir 은 그 폴더 이름을 그대로 쓴다.
 */
export async function repoNameOf(cwd) {
	let dir = cwd;
	for (let i = 0; i < 8 && dir && dir !== "/"; i++) {
		const git = join(dir, ".git");
		const st = await stat(git).catch(() => null);
		if (st) return (st.isFile() && (await worktreeRepo(git, dir))) || basename(dir);
		dir = dirname(dir);
	}
	return null;
}

async function worktreeRepo(gitFile, dir) {
	const text = await readFile(gitFile, "utf8").catch(() => "");
	const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
	const common = gitdir && /^(.+)\/worktrees\/[^/]+\/?$/.exec(resolve(dir, gitdir))?.[1];
	if (!common) return null;
	return basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
}
