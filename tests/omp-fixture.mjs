// 가짜 omp 로 실제 서버를 띄우는 테스트 픽스처. 분류는 print 모드, 설명은 RPC 대화로 흉내 낸다.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const firstModel = "fixture/vendor/cheap";
export const secondModel = "fixture/other";
export const catalog = { models: [
	{ kind: "chat", provider: "fixture", id: "vendor/cheap", selector: firstModel, name: "Cheap", cost: { input: 0.15, output: 0.6, cacheRead: 0.003 }, apiKey: "never-expose-catalog-secret" },
	{ kind: "chat", provider: "fixture", id: "other", selector: secondModel, name: "Other", cost: { input: 0, output: 0 } },
	{ kind: "embedding", provider: "fixture", id: "embed", selector: "fixture/embed", name: "Embedding", cost: { input: 1, output: 1 } },
] };

export async function until(check, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!await check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for model fixture");
		await delay(10);
	}
}

const line = (value) => JSON.stringify(value) + "\n";

export async function fixture(t) {
	const home = await mkdtemp(join(tmpdir(), "docent-model-test-"));
	const stateHome = join(home, "state");
	const executable = join(home, "omp.mjs");
	const catalogFile = join(home, "catalog.json");
	const controlFile = join(home, "control.json");
	const logFile = join(home, "calls.jsonl");
	const releaseFile = join(home, "release");
	const sessionFile = join(home, ".claude/projects/project/session.jsonl");
	const sessionId = "claude:project/session.jsonl";
	await mkdir(dirname(sessionFile), { recursive: true });
	await mkdir(stateHome);
	// Pre-model preferences must normalize without migrating or discarding old records.
	await writeFile(join(stateHome, "learning.json"), JSON.stringify({ version: 1, profiles: [{ id: "default", name: "기본", defaultDifficulty: "NORMAL", domainDifficulties: {} }], items: [], records: [], requests: {} }));
	await writeFile(sessionFile, line({ type: "user", uuid: "u1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "검색 상태를 설명해줘" } }));
	await writeFile(catalogFile, JSON.stringify(catalog));
	await writeFile(controlFile, "{}");
	await writeFile(logFile, "");
	// control: holdPlanning, failPlanning, failExplanation, slowExplanation(ms per chunk)
	// 가짜 omp 는 `.mjs` 라 서버가 OMP_BIN 을 Node 로 실행한다(shebang 에 기대지 않아 Windows 에서도 된다).
	await writeFile(executable, `import { appendFile, readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const control = async () => JSON.parse(await readFile(${JSON.stringify(controlFile)}, 'utf8'));
const log = value => appendFile(${JSON.stringify(logFile)}, JSON.stringify(value) + '\\n');
const model = flag('--model');
const provider = flag('--provider');
if (args[0] === '--version') {
	console.log('omp-fixture 0.0.0');
} else if (args[0] === 'models') {
	process.stdout.write(await readFile(${JSON.stringify(catalogFile)}, 'utf8'));
} else if (flag('--mode') === 'rpc') {
	const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
	// splitUtf8: 한 줄을 한글 글자 한가운데서 두 번에 나눠 쓴다(파이프 청크 경계 재현).
	const outSplit = async value => {
		const bytes = Buffer.from(JSON.stringify(value) + '\\n'), cut = bytes.lastIndexOf(Buffer.from('설')) + 1;
		process.stdout.write(bytes.subarray(0, cut)); await delay(30); process.stdout.write(bytes.subarray(cut));
	};
	let turn = 0;
	let current = null;
	const run = async (message, id) => {
		const mine = ++turn;
		current = mine;
		const c = await control();
		await log({ planning: false, model, provider, pid: process.pid, message });
		if (c.failExplanation) { process.stderr.write('never-expose-execution-secret'); process.exit(2); }
		out({ type: 'agent_start' });
		const text = '# ' + (model ?? 'default') + '\\n\\n설명 깊이와 출력을 줄이지 않은 답변입니다.' + (message.includes('바로잡기') ? '\\n\\n보정을 반영했어요.' : '');
		for (const piece of text.match(/[\\s\\S]{1,8}/g)) {
			if (current !== mine) return;
			out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: piece } });
			if (c.slowExplanation) await delay(c.slowExplanation);
		}
		if (current !== mine) return;
		current = null;
		const end = { type: 'agent_end', messages: [{ role: 'user', content: [{ type: 'text', text: message }] }, { role: 'assistant', content: [{ type: 'text', text }] }] };
		if (c.splitUtf8) await outSplit(end); else out(end);
	};
	out({ type: 'ready', protocolVersion: 1 });
	for await (const raw of createInterface({ input: process.stdin })) {
		if (!raw.trim()) continue;
		const command = JSON.parse(raw);
		if (command.type === 'prompt') { out({ id: command.id, type: 'response', command: 'prompt', success: true }); run(command.message); }
		else if (command.type === 'abort') { current = null; out({ id: command.id, type: 'response', command: 'abort', success: true }); out({ type: 'agent_end', messages: [] }); }
		else if (command.type === 'abort_and_prompt') { current = null; out({ type: 'agent_end', messages: [] }); out({ id: command.id, type: 'response', command: 'abort_and_prompt', success: true }); run(command.message); }
		else out({ id: command.id, type: 'response', command: command.type, success: true });
	}
} else {
	const planning = flag('--system-prompt').endsWith('learning-planner.txt');
	const c = await control();
	await log({ planning, model, provider });
	if (planning && c.holdPlanning) {
		const deadline = Date.now() + 10000;
		while (!await stat(${JSON.stringify(releaseFile)}).catch(() => null)) {
			if (Date.now() > deadline) process.exit(3);
			await delay(10);
		}
	}
	if (planning && c.failPlanning) {
		process.stderr.write('never-expose-execution-secret');
		process.exit(2);
	}
	console.log(planning ? JSON.stringify({ kind: 'why', domains: [], concepts: [] }) : '[]');
}
`);
	let server;
	let address;
	async function stop() {
		if (!server || server.exitCode !== null || server.signalCode !== null) return;
		const exit = once(server, "exit");
		server.kill("SIGTERM");
		await exit;
	}
	async function start() {
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const port = reservation.address().port;
		await new Promise((resolve) => reservation.close(resolve));
		address = `http://127.0.0.1:${port}`;
		server = spawn(process.execPath, [join(root, "app/server.mjs")], { cwd: root, env: { ...process.env, HOME: home, DOCENT_HOME: stateHome, DOCENT_HOST: "127.0.0.1", DOCENT_PORT: String(port), DOCENT_PEERS: "", DOCENT_ON_LISTEN: "", TYPESAFE_API_KEY: "", OMP_BIN: executable }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let startupError;
		server.on("error", (error) => { startupError = error; });
		server.stdout.on("data", (chunk) => { output += chunk; });
		server.stderr.resume();
		await until(() => {
			if (startupError) throw startupError;
			if (server.exitCode !== null) throw new Error("Fixture server exited before listening");
			return output.includes(`docent: ${address}/`);
		});
	}
	t.after(async () => { await stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
	await start();
	return {
		sessionId,
		ompBin: executable,
		sessionFile,
		get address() { return address; },
		async api(path, method = "GET", value) {
			const response = await fetch(address + path, { method, ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) });
			return { status: response.status, body: await response.json() };
		},
		ask(requestId, profileId = "default", extra = {}) { return this.api("/api/ask", "POST", { id: sessionId, question: "왜 이렇게 했어?", requestId, profileId, ...extra }); },
		/** NDJSON 스트림 요청. 받은 줄을 모두 돌려준다. `onLine` 은 줄마다 불린다. */
		async stream(body, onLine) {
			const response = await fetch(address + "/api/ask", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ id: sessionId, profileId: "default", ...body }), signal: AbortSignal.timeout(15000) });
			const lines = [];
			let buffer = "";
			for await (const chunk of response.body) {
				buffer += Buffer.from(chunk).toString("utf8");
				let index;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const value = JSON.parse(buffer.slice(0, index));
					buffer = buffer.slice(index + 1);
					lines.push(value);
					await onLine?.(value);
				}
			}
			return lines;
		},
		async calls() { return (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((entry) => JSON.parse(entry)); },
		control(value) { return writeFile(controlFile, JSON.stringify(value)); },
		release() { return writeFile(releaseFile, "ready"); },
		catalog(value) { return writeFile(catalogFile, JSON.stringify(value)); },
		appendSession(entry) { return appendFile(sessionFile, line(entry)); },
		async appendSubagent(id, entry) {
			const dir = join(dirname(sessionFile), "session", "subagents");
			await mkdir(dir, { recursive: true });
			return appendFile(join(dir, `agent-${id}.jsonl`), line(entry));
		},
		stored() { return readFile(join(stateHome, "learning.json"), "utf8").then(JSON.parse); },
		async restart() { await stop(); await start(); },
	};
}
