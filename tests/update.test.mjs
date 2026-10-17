// 새 버전 확인과 설치 (ADR 0072). GitHub 응답은 가짜 fetch 로, 설치는 가짜 npm 으로 흉내 낸다.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLatest, installPrefix, installRelease, isNewer, parseVersion } from "../app/update.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture } from "./omp-fixture.mjs";

const BYTES = Buffer.from("fake tgz");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const release = (tag, extra = {}) => ({
	tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-18T00:00:00Z",
	assets: [{ name: `vibecoder-docent-${tag.replace(/^v/, "")}.tgz`, digest: `sha256:${SHA}`, browser_download_url: `https://github.com/singandmong/vibecoder-docent/releases/download/${tag}/vibecoder-docent-${tag.replace(/^v/, "")}.tgz` }],
	...extra,
});
const respond = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("versions compare by number, not by text, and odd tags never count as newer", () => {
	assert.equal(isNewer("0.30.0", "0.29.9"), true);
	assert.equal(isNewer("v0.10.0", "0.9.0"), true, "10 is newer than 9 although it sorts first as text");
	assert.equal(isNewer("0.29.2", "0.29.2"), false);
	assert.equal(isNewer("0.29.1", "0.29.2"), false, "an older release is never offered");
	assert.equal(isNewer("1.0.0-rc.1", "0.1.0"), false);
	assert.equal(parseVersion("latest"), null);
});

test("a newer release is installable only with this repository's file and its sha256", async () => {
	const ok = await checkLatest({ current: "0.29.2", fetchImpl: respond(release("v0.30.0")), fresh: true });
	assert.deepEqual([ok.available, ok.installable, ok.sha256], [true, true, SHA]);
	const noDigest = await checkLatest({ current: "0.29.2", fetchImpl: respond(release("v0.30.0", { assets: [{ ...release("v0.30.0").assets[0], digest: null }] })), fresh: true });
	assert.deepEqual([noDigest.available, noDigest.installable], [true, false]);
	assert.match(noDigest.reason, /sha256/);
	const elsewhere = await checkLatest({ current: "0.29.2", fetchImpl: respond(release("v0.30.0", { assets: [{ ...release("v0.30.0").assets[0], browser_download_url: "https://evil.example/x.tgz" }] })), fresh: true });
	assert.equal(elsewhere.installable, false, "a file outside the project's release downloads is refused");
	const same = await checkLatest({ current: "0.30.0", fetchImpl: respond(release("v0.30.0")), fresh: true });
	assert.deepEqual([same.available, same.installable], [false, false]);
	await assert.rejects(checkLatest({ current: "0.29.2", fetchImpl: respond(release("v0.30.0", { prerelease: true })), fresh: true }), { status: 502 });
	await assert.rejects(checkLatest({ current: "0.29.2", fetchImpl: async () => { throw new TypeError("fetch failed"); }, fresh: true }), /인터넷 연결/);
});

test("a download that does not match its sha256 is never installed", async () => {
	let ran = 0;
	const run = async () => { ran++; };
	const fetchImpl = async () => new Response(Buffer.from("tampered"));
	await assert.rejects(installRelease({ url: "https://github.com/x/y.tgz", sha256: SHA, prefix: "/p", fetchImpl, run }), /sha256/);
	assert.equal(ran, 0);
	let args;
	await installRelease({ url: "https://github.com/x/vibecoder-docent-0.30.0.tgz", sha256: SHA, prefix: "/p", fetchImpl: async () => new Response(BYTES), run: async (a) => { args = a; } });
	assert.deepEqual(args.slice(0, 5), ["install", "-g", "--prefix", "/p", "--ignore-scripts"]);
	assert.match(args.at(-1), /vibecoder-docent-0\.30\.0\.tgz$/);
});

test("only an npm global install has a prefix to update; a repository checkout has none", { skip: process.platform === "win32" }, async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "docent-prefix-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const pkg = join(home, "prefix", "lib", "node_modules", "vibecoder-docent");
	await mkdir(pkg, { recursive: true });
	assert.equal(await installPrefix(pkg), join(home, "prefix"));
	// npm 이 링크한 경우도 실제 위치로 판단한다.
	await symlink(pkg, join(home, "link"));
	assert.equal(await installPrefix(join(home, "link")), join(home, "prefix"));
	assert.equal(await installPrefix(join(home, "vibecoder-docent")), null);
	assert.equal(await installPrefix(), null, "this test runs from the repository, not an install");
});

test("the server reports a newer release but refuses to install when it was not installed with npm -g", async (t) => {
	const fake = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(release("v99.0.0"))); });
	fake.listen(0, "127.0.0.1");
	await once(fake, "listening");
	t.after(() => fake.close());
	const before = process.env.DOCENT_UPDATE_API;
	process.env.DOCENT_UPDATE_API = `http://127.0.0.1:${fake.address().port}/latest`;
	t.after(() => { if (before === undefined) delete process.env.DOCENT_UPDATE_API; else process.env.DOCENT_UPDATE_API = before; });
	const f = await fixture(t);
	const info = (await f.api("/api/update?fresh=1")).body;
	assert.deepEqual([info.available, info.latest, info.canInstall], [true, "99.0.0", false]);
	assert.match(info.reason, /npm 전역/);
	assert.equal(info.sha256, undefined, "the download address and hash stay on the server");
	const applied = await f.api("/api/update", "POST", { apply: true });
	assert.equal(applied.status, 403);
	assert.equal((await f.api("/api/health")).body.version.startsWith("99"), false, "nothing was installed");
});
