import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitLocationOf, headOf, repoNameOf } from "../app/repo.mjs";

async function tree() {
	const root = await mkdtemp(join(tmpdir(), "docent-repo-"));
	const at = async (path, gitdir) => {
		const dir = join(root, path);
		await mkdir(dir, { recursive: true });
		if (gitdir === undefined) await mkdir(join(dir, ".git"));
		else await writeFile(join(dir, ".git"), `gitdir: ${gitdir}\n`);
		return dir;
	};
	return { root, at };
}

test("워크트리 폴더는 원래 저장소 이름을 쓴다 (폴더 이름과 워크트리 이름이 달라도)", async () => {
	const { root, at } = await tree();
	await at("RELAYER3");
	const wt = await at("RELAYER3/.claude/worktrees/SCREENS", join(root, "RELAYER3/.git/worktrees/cafe-teasers"));
	await mkdir(join(wt, "_local/samples"), { recursive: true });
	assert.equal(await repoNameOf(wt), "RELAYER3");
	assert.equal(await repoNameOf(join(wt, "_local/samples")), "RELAYER3");
});

test("상대 gitdir 와 bare 저장소 워크트리도 저장소 이름을 찾는다", async () => {
	const { at } = await tree();
	await at("app");
	assert.equal(await repoNameOf(await at("app/.worktrees/feat", "../../.git/worktrees/feat")), "app");
	assert.equal(await repoNameOf(await at("wt/b", "/srv/repos/portwright.git/worktrees/b")), "portwright");
});

test("일반 저장소와 서브모듈은 그 폴더 이름, git 밖이면 null", async () => {
	const { root, at } = await tree();
	assert.equal(await repoNameOf(await at("plain")), "plain");
	assert.equal(await repoNameOf(await at("plain/vendor/lib", "../../.git/modules/lib")), "lib");
	await mkdir(join(root, "loose"));
	assert.equal(await repoNameOf(join(root, "loose")), null);
});

test("워크트리는 워크트리 폴더 이름과 그 워크트리의 브랜치를, 일반 저장소는 워크트리 없이 브랜치를 준다", async () => {
	const { root, at } = await tree();
	const main = await at("RELAYER3");
	await writeFile(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
	const gitdir = join(root, "RELAYER3/.git/worktrees/cafe-teasers");
	await mkdir(gitdir, { recursive: true });
	await writeFile(join(gitdir, "HEAD"), "ref: refs/heads/feat/chart-v3\n");
	const wt = await at("RELAYER3/.claude/worktrees/SCREENS", gitdir);
	const place = await gitLocationOf(join(wt, "src"));
	assert.deepEqual({ ...place, gitdir: undefined }, { repo: "RELAYER3", worktree: "SCREENS", gitdir: undefined });
	assert.deepEqual(await headOf(place.gitdir), { branch: "feat/chart-v3" });
	assert.equal((await gitLocationOf(main)).worktree, null);
	assert.deepEqual(await headOf((await gitLocationOf(main)).gitdir), { branch: "main" });
});

test("브랜치가 아닌 커밋을 가리키면 짧은 커밋 id 와 detached, HEAD 를 못 읽으면 null", async () => {
	const { root, at } = await tree();
	const dir = await at("detached");
	await writeFile(join(dir, ".git/HEAD"), `${"a1b2c3d4e5".repeat(4)}\n`);
	assert.deepEqual(await headOf(join(dir, ".git")), { branch: "a1b2c3d", detached: true });
	assert.equal(await headOf(join(root, "missing")), null);
});
