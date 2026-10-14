// 다른 컴퓨터(peers)에 닿는 ssh 별칭 찾기 (ADR 0067). 이 컴퓨터의 ~/.ssh/config 에서 구체적인 Host 별칭을 모으고,
// `ssh -G` 로 실제 HostName 을 풀어, peer 주소와 같은 컴퓨터를 가리키는 별칭을 고른다.
// 별칭 이름만 돌려준다. 사용자 이름, 키 경로, 포트는 어디에도 싣지 않는다. 설정 파일은 읽기만 한다.
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

const TTL_MS = 10 * 60_000;
const EXEC_TIMEOUT_MS = 2000;
const LOOKUP_TIMEOUT_MS = 2000;
const WAIT_MS = 1000;
const MAX_INCLUDE_DEPTH = 5;

const defaultExec = (file, args, { timeout }) => new Promise((ok, fail) => {
	execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout) => (error ? fail(error) : ok(stdout)));
});

/** 따옴표와 공백으로 나눈 단어들. 주석(#)은 따옴표 밖에서만 시작한다. */
function words(line) {
	const out = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m;
	while ((m = re.exec(line))) {
		if (m[2]?.startsWith("#")) break;
		out.push(m[1] ?? m[2]);
	}
	return out;
}

/** `*`, `?` 만 있는 단순 glob 을 마지막 경로 조각에서만 푼다. */
async function expandGlob(pattern, fs) {
	if (!/[*?]/.test(pattern)) return [pattern];
	const dir = dirname(pattern);
	if (/[*?]/.test(dir)) return [];
	const base = pattern.slice(dir.length + 1);
	const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
	try {
		return (await fs.readdir(dir)).filter((name) => re.test(name)).sort().map((name) => join(dir, name));
	} catch {
		return [];
	}
}

/** 파일 하나의 Host 별칭들. Include 를 따라가고, 와일드카드·부정 패턴·Match 블록은 건너뛴다. */
async function aliasesIn(file, { fs, sshDir, home }, depth, seen) {
	if (depth > MAX_INCLUDE_DEPTH || seen.has(file)) return [];
	seen.add(file);
	let text;
	try {
		text = await fs.readFile(file);
	} catch {
		return [];
	}
	const out = [];
	for (const raw of text.split(/\r?\n/)) {
		const parts = words(raw.replace(/^\s*(\S+?)\s*=\s*/, "$1 "));
		const key = parts[0]?.toLowerCase();
		if (key === "include") {
			for (const pattern of parts.slice(1)) {
				const path = pattern.startsWith("~") ? join(home, pattern.slice(1)) : isAbsolute(pattern) ? pattern : join(sshDir, pattern);
				for (const included of await expandGlob(path, fs)) out.push(...await aliasesIn(included, { fs, sshDir, home }, depth + 1, seen));
			}
		} else if (key === "host") {
			for (const name of parts.slice(1)) {
				if (/[*?!]/.test(name) || name.startsWith("-") || /[\s,]/.test(name)) continue;
				out.push(name);
			}
		}
	}
	return out;
}

/** `ssh -G` 출력에서 hostname 만. 풀리지 않으면 null. */
function hostnameOf(output) {
	const line = output.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("hostname "));
	return line ? line.slice(9).trim().toLowerCase() || null : null;
}

const isLoopback = (address) => address === "::1" || address.startsWith("127.");

const bounded = (promise, ms) => new Promise((ok) => {
	const timer = setTimeout(() => ok(null), ms);
	promise.then((value) => { clearTimeout(timer); ok(value); }, () => { clearTimeout(timer); ok(null); });
});

/**
 * fs, exec, lookup, now 는 시험용 자리다.
 *   fs.readFile(path) -> string, fs.readdir(dir) -> string[]
 *   exec(file, args, { timeout }) -> stdout
 *   lookup(host) -> [{ address }]
 */
export function createSshAliases({
	home = homedir(),
	fs = { readFile: (path) => readFile(path, "utf8"), readdir },
	exec = defaultExec,
	lookup = (host) => dnsLookup(host, { all: true }),
	now = Date.now,
	ttlMs = TTL_MS,
	waitMs = WAIT_MS,
} = {}) {
	const sshDir = resolve(home, ".ssh");
	let profiles = null;
	const results = new Map();

	const addressesOf = async (host) => {
		if (isIP(host)) return [host];
		const found = await bounded(Promise.resolve().then(() => lookup(host)), LOOKUP_TIMEOUT_MS);
		return (found ?? []).map((entry) => entry.address).filter(Boolean);
	};

	/** 별칭마다 실제 HostName. ssh 가 없거나 느리면 그 별칭은 빠진다. */
	const loadProfiles = async () => {
		const names = [...new Set(await aliasesIn(join(sshDir, "config"), { fs, sshDir, home }, 0, new Set()))];
		const resolved = await Promise.all(names.map(async (alias) => {
			const output = await bounded(Promise.resolve().then(() => exec("ssh", ["-G", alias], { timeout: EXEC_TIMEOUT_MS })), EXEC_TIMEOUT_MS + 500);
			const hostname = output && hostnameOf(output);
			return hostname ? { alias, hostname } : null;
		}));
		return resolved.filter(Boolean);
	};

	const compute = async (name, base) => {
		let target;
		try {
			target = new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		} catch {
			return null;
		}
		if (!target || isLoopback(target) || target === "localhost") return null;
		if (!profiles || now() - profiles.at >= ttlMs) profiles = { at: now(), promise: loadProfiles() };
		const list = await profiles.promise;
		if (!list.length) return null;
		const matched = new Set(list.filter((p) => p.hostname === target).map((p) => p.alias));
		if (!matched.size) {
			const wanted = new Set((await addressesOf(target)).filter((a) => !isLoopback(a)));
			if (wanted.size) {
				const hosts = [...new Set(list.map((p) => p.hostname))];
				const addresses = new Map(await Promise.all(hosts.map(async (host) => [host, await addressesOf(host)])));
				for (const p of list) if (addresses.get(p.hostname).some((a) => wanted.has(a))) matched.add(p.alias);
			}
		}
		if (!matched.size) return null;
		return [...matched].sort((a, b) => (b === name) - (a === name) || a.length - b.length || (a < b ? -1 : 1))[0];
	};

	/** 별칭 이름 또는 null. 10분 캐시(실패도). 처음 풀이가 waitMs 안에 안 끝나면 null 을 먼저 주고 뒤에서 계속 푼다. */
	return function sshAliasFor(name, base) {
		const key = `${name}\0${base}`;
		let entry = results.get(key);
		if (!entry || now() - entry.at >= ttlMs) {
			entry = { at: now(), promise: compute(name, base).catch(() => null) };
			results.set(key, entry);
		}
		return bounded(entry.promise, waitMs);
	};
}

/** 이 컴퓨터의 실제 ~/.ssh/config 를 보는 기본 인스턴스. */
export const sshAliasFor = createSshAliases();
