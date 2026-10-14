import { test } from "node:test";
import assert from "node:assert/strict";
import { createSshAliases } from "../app/ssh-aliases.mjs";
import { peerProvider } from "../app/peers.mjs";

const HOME = "/home/u";

/** files: 경로 → 내용. readdir 은 같은 폴더 아래 파일 이름을 돌려준다. Windows 의 `D:\home\u\...` 도 `/home/u/...` 로 읽는다. */
function fakeFs(files) {
	const norm = (path) => String(path).replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
	return {
		readFile: async (raw) => {
			const path = norm(raw);
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[path];
		},
		readdir: async (raw) => {
			const dir = norm(raw);
			const names = Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1));
			if (!names.length) throw new Error("ENOENT");
			return names;
		},
	};
}

/** ssh -G 흉내: 별칭 → HostName. 목록에 없으면 별칭 자체가 호스트 이름이 된다. */
function fakeExec(hostnames, calls = []) {
	return async (file, args) => {
		calls.push([file, ...args]);
		assert.equal(file, "ssh");
		assert.equal(args[0], "-G");
		const alias = args[1];
		return `user someone\nhostname ${hostnames[alias] ?? alias}\nport 22\nidentityfile ~/.ssh/secret_key\n`;
	};
}

const lookupOf = (table, calls = []) => async (host) => {
	calls.push(host);
	if (!table[host]) throw new Error("ENOTFOUND");
	return table[host].map((address) => ({ address }));
};

const CONFIG = [
	"Include ~/.colima/ssh_config",
	'Include "config.d/*"',
	"Host *",
	"  ServerAliveInterval 30",
	"Host book",
	"  HostName mac-book.example.ts.net",
	"Host mini mini-alt",
	"  HostName 100.64.0.2",
	"Host !bad dev-*",
	"  HostName never",
	"Match host x exec true",
	"  User nobody",
	"Host pc # 윈도우",
	"  HostName=windows-pc.example.ts.net",
].join("\n");

const FILES = {
	[`${HOME}/.ssh/config`]: CONFIG,
	[`${HOME}/.colima/ssh_config`]: "Host colima\n  HostName 127.0.0.1\n",
	[`${HOME}/.ssh/config.d/extra`]: "Host extra\n  HostName extra.example.com\n",
};

const HOSTNAMES = {
	book: "mac-book.example.ts.net",
	mini: "100.64.0.2",
	"mini-alt": "100.64.0.2",
	pc: "windows-pc.example.ts.net",
	colima: "127.0.0.1",
	extra: "extra.example.com",
};

function make(overrides = {}) {
	return createSshAliases({
		home: HOME,
		fs: fakeFs(FILES),
		exec: fakeExec(HOSTNAMES),
		lookup: lookupOf({}),
		...overrides,
	});
}

test("HostName 이 peer 주소의 호스트와 같으면 그 별칭", async () => {
	assert.equal(await make()("pc", "http://windows-pc.example.ts.net:4747"), "pc");
	// Include 한 파일(절대 경로 ~, 상대 경로 glob)의 별칭도 본다.
	assert.equal(await make()("x", "http://extra.example.com:4747"), "extra");
	assert.equal(await make()("x", "http://100.64.0.2/"), "mini");
});

test("와일드카드, 부정, Match 블록은 별칭이 아니고 ssh -G 로도 묻지 않는다", async () => {
	const calls = [];
	await make({ exec: fakeExec(HOSTNAMES, calls) })("book", "http://nothing.example:1");
	const asked = calls.map((c) => c[2]).sort();
	assert.deepEqual(asked, ["book", "colima", "extra", "mini", "mini-alt", "pc"]);
});

test("HostName 이 달라도 풀어 본 주소가 같으면 같은 컴퓨터로 본다", async () => {
	const alias = make({ lookup: lookupOf({ "mac-book": ["100.64.0.9"], "mac-book.example.ts.net": ["100.64.0.9"] }) });
	assert.equal(await alias("whatever", "http://mac-book:4747"), "book");
});

test("loopback 주소는 서로 같아도 맞추지 않는다", async () => {
	const alias = make({ lookup: lookupOf({ localhost: ["127.0.0.1"] }) });
	assert.equal(await alias("local", "http://localhost:4747"), null);
	assert.equal(await alias("local", "http://127.0.0.1:4747"), null);
});

test("여러 별칭이 맞으면 peer 이름과 같은 것, 다음은 가장 짧은 것", async () => {
	assert.equal(await make()("mini-alt", "http://100.64.0.2:4747"), "mini-alt");
	assert.equal(await make()("other", "http://100.64.0.2:4747"), "mini");
});

test("맞는 별칭이 없으면 null", async () => {
	assert.equal(await make()("zzz", "http://unknown.example:4747"), null);
	assert.equal(await make()("zzz", "not a url"), null);
});

test("ssh 가 없거나 설정 파일이 없으면 null", async () => {
	const missing = async () => { throw Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }); };
	assert.equal(await make({ exec: missing })("book", "http://mac-book.example.ts.net:4747"), null);
	assert.equal(await make({ fs: fakeFs({}) })("book", "http://mac-book.example.ts.net:4747"), null);
});

test("ssh -G 가 느리면 기다리다 null, 이후 끝나면 값이 붙는다", async () => {
	let release;
	const gate = new Promise((ok) => { release = ok; });
	const slow = async (file, args) => { await gate; return fakeExec(HOSTNAMES)(file, args); };
	const alias = make({ exec: slow, waitMs: 20 });
	assert.equal(await alias("book", "http://mac-book.example.ts.net:4747"), null);
	release();
	await new Promise((ok) => setTimeout(ok, 20));
	assert.equal(await alias("book", "http://mac-book.example.ts.net:4747"), "book");
});

test("결과는 캐시되고 실패도 캐시된다, 만료되면 다시 푼다", async () => {
	let clock = 0;
	const calls = [];
	const alias = make({ exec: fakeExec(HOSTNAMES, calls), now: () => clock, ttlMs: 1000 });
	await alias("book", "http://mac-book.example.ts.net:4747");
	await alias("book", "http://mac-book.example.ts.net:4747");
	await alias("pc", "http://nothing.example:1");
	await alias("pc", "http://nothing.example:1");
	const first = calls.length;
	assert.equal(first, 6);
	clock = 1500;
	assert.equal(await alias("book", "http://mac-book.example.ts.net:4747"), "book");
	assert.equal(calls.length, first * 2);
});

test("peerProvider 는 ssh 별칭을 붙이고 원격이 보낸 ssh 는 덮어쓴다", async () => {
	const remote = [
		{ id: "claude:a", provider: "claude", host: null, ssh: "attacker; rm" },
		{ id: "claude:b", provider: "claude", host: null },
	];
	const fetch = async () => ({ ok: true, json: async () => remote });
	const withAlias = await peerProvider("book", "http://b", { fetch, ssh: async () => "book" }).list();
	assert.deepEqual(withAlias.map((s) => [s.id, s.host, s.ssh]), [["@book/claude:a", "book", "book"], ["@book/claude:b", "book", "book"]]);
	const without = await peerProvider("book", "http://b", { fetch, ssh: async () => null }).list();
	assert.ok(without.every((s) => !("ssh" in s)));
	const broken = await peerProvider("book", "http://b", { fetch, ssh: async () => { throw new Error("x"); } }).list();
	assert.equal(broken.length, 2);
	assert.ok(broken.every((s) => !("ssh" in s)));
	const plain = await peerProvider("book", "http://b", { fetch }).list();
	assert.ok(plain.every((s) => !("ssh" in s)));
});
