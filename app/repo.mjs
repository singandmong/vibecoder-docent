import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * 작업 폴더가 속한 git 저장소 위치. 위로 올라가며 .git 을 찾는다.
 * 워크트리의 .git 은 "gitdir: <저장소>/.git/worktrees/<이름>" 파일이라 그 경로에서 원래 저장소 이름을 읽고,
 * 워크트리 폴더 이름을 worktree 로 돌려준다. 서브모듈처럼 worktrees 가 아닌 gitdir 은 그 폴더 이름을 저장소로 쓴다.
 * 폴더 구조는 잘 바뀌지 않아 호출자가 폴더별로 기억해도 된다. 브랜치는 바뀌므로 headOf 로 따로 읽는다.
 * @returns {Promise<{repo: string, worktree: string|null, gitdir: string|null}|null>}
 */
export async function gitLocationOf(cwd) {
	let dir = cwd;
	for (let i = 0; i < 8 && dir && dir !== "/"; i++) {
		const git = join(dir, ".git");
		const st = await stat(git).catch(() => null);
		if (st?.isDirectory()) return { repo: basename(dir), worktree: null, gitdir: git };
		if (st) {
			const text = await readFile(git, "utf8").catch(() => "");
			const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
			const gitdir = pointer ? resolve(dir, pointer) : null;
			// resolve 는 Windows 에서 `\` 경로를 돌려준다. 두 구분자를 모두 받는다.
			const common = gitdir && /^(.+)[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir)?.[1];
			if (!common) return { repo: basename(dir), worktree: null, gitdir };
			const repo = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
			return { repo, worktree: basename(dir), gitdir };
		}
		dir = dirname(dir);
	}
	return null;
}

/** 작업 폴더가 속한 git 저장소 이름. git 밖이면 null. */
export async function repoNameOf(cwd) {
	return (await gitLocationOf(cwd))?.repo ?? null;
}

/**
 * gitdir 의 HEAD 에서 지금 브랜치를 읽는다. 브랜치가 아닌 커밋을 가리키면 짧은 커밋 id 와 detached 를 돌려준다.
 * @returns {Promise<{branch: string, detached?: true}|null>}
 */
export async function headOf(gitdir) {
	const head = (await readFile(join(gitdir, "HEAD"), "utf8").catch(() => "")).trim();
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
	if (ref) return { branch: ref };
	return /^[0-9a-f]{40,64}$/.test(head) ? { branch: head.slice(0, 7), detached: true } : null;
}
