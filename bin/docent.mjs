#!/usr/bin/env node
// `docent` — 웹앱을 켜고 브라우저를 연다. 이미 켜져 있으면 브라우저만 연다.
// 옵션: --no-open, --port N, --host <ip|tailscale>, --peer 이름=URL (반복 가능). ~/.docent/config.json 의 host/peers/port 가 기본값.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-v") || args.includes("--version")) {
	const { readFileSync } = await import("node:fs");
	console.log(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version);
	process.exit(0);
}
if (args[0] === "doctor") {
	const rest = args.slice(1);
	const unknown = rest.find((arg, i) => !["--json", "--probe", "--port"].includes(arg) && rest[i - 1] !== "--port");
	if (unknown) {
		console.error(`docent doctor: 알 수 없는 옵션이에요: ${unknown}\nusage: docent doctor [--json] [--probe] [--port N]`);
		process.exit(2);
	}
	const { diagnose, formatReport } = await import("../app/doctor.mjs");
	const { config } = await import("../app/store.mjs");
	const portArg = rest.includes("--port") ? Number(rest[rest.indexOf("--port") + 1]) : Number(process.env.DOCENT_PORT ?? (await config()).port ?? 4747);
	if (!Number.isInteger(portArg) || portArg < 1 || portArg > 65535) {
		console.error("docent doctor: 포트는 1에서 65535 사이 정수여야 해요.");
		process.exit(2);
	}
	const report = await diagnose({ port: portArg, probe: rest.includes("--probe") });
	console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
	process.exit(report.ok ? 0 : 1);
}
if (args[0] === "start" || args[0] === "stop") {
	const [command, ...rest] = args;
	const usage = command === "start" ? "usage: docent start [--port N] [--host <ip|tailscale>] [--peer 이름=URL ...]" : "usage: docent stop [--port N]";
	const known = new Set(command === "start" ? ["--port", "--host", "--peer"] : ["--port"]);
	const unknown = rest.find((arg, i) => !known.has(arg) && !known.has(rest[i - 1]));
	const missingValue = rest.some((arg, i) => known.has(arg) && (rest[i + 1] === undefined || known.has(rest[i + 1])));
	if (unknown || missingValue) {
		console.error(`docent ${command}: ${unknown ? `알 수 없는 옵션이에요: ${unknown}` : "옵션 뒤에 값이 필요해요."}\n${usage}`);
		process.exit(2);
	}
	const { config } = await import("../app/store.mjs");
	const port = Number(rest.includes("--port") ? rest[rest.indexOf("--port") + 1] : process.env.DOCENT_PORT ?? (await config()).port ?? 4747);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`docent ${command}: 포트는 1에서 65535 사이 정수여야 해요.`);
		process.exit(2);
	}
	const { startServer, stopServer } = await import("../app/server-process.mjs");
	try {
		if (command === "start") {
			const result = await startServer({ port, args: rest.filter((arg, i) => arg !== "--port" && rest[i - 1] !== "--port") });
			console.log(result.started
				? `docent: 백그라운드로 켰어요 → ${result.url}\n  기록: ${result.log}\n  끄기: docent stop`
				: `docent: 이미 켜져 있어요 → ${result.url}`);
			if (result.fallback) console.warn(`docent: Windows 관리 도구(WMI)로 켜지 못해 일반 방식으로 켰어요. 이 창이나 SSH 연결을 닫으면 서버도 꺼질 수 있어요.\n  까닭: ${result.fallback}`);
			process.exit(0);
		}
		const result = await stopServer({ port });
		if (result.reason === "no-pid") {
			console.error(`docent stop: ${result.url} 의 서버는 0.23.0 이전 버전이라 이 명령으로 끌 수 없어요. 서버를 켠 창에서 Ctrl+C 로 끄세요.`);
			process.exit(1);
		}
		console.log(result.reason === "not-running" ? `docent: 켜져 있는 서버가 없어요 → ${result.url}`
			: result.reason === "restarted" ? `docent: 서버를 껐지만 바로 다시 켜졌어요 → ${result.url}\n  launchd 같은 서비스 관리자가 다시 띄운 것 같아요. 그 서비스에서 멈추세요.`
			: `docent: 서버를 껐어요 → ${result.url}`);
		process.exit(0);
	} catch (error) {
		console.error(`docent ${command}: ${error.message}`);
		process.exit(1);
	}
}
if (args[0] === "update") {
	const rest = args.slice(1);
	const unknown = rest.find((arg, i) => arg !== "--check" && arg !== "--port" && rest[i - 1] !== "--port");
	if (unknown) {
		console.error(`docent update: 알 수 없는 옵션이에요: ${unknown}\nusage: docent update [--check] [--port N]`);
		process.exit(2);
	}
	const { readFileSync } = await import("node:fs");
	const { config } = await import("../app/store.mjs");
	const { checkLatest, installPrefix, installRelease } = await import("../app/update.mjs");
	const { serverAt } = await import("../app/server-process.mjs");
	const current = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;
	const port = Number(rest.includes("--port") ? rest[rest.indexOf("--port") + 1] : process.env.DOCENT_PORT ?? (await config()).port ?? 4747);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error("docent update: 포트는 1에서 65535 사이 정수여야 해요.");
		process.exit(2);
	}
	try {
		const info = await checkLatest({ current, fresh: true });
		if (!info.available) {
			console.log(`docent: 최신 버전이에요 (v${current})`);
			process.exit(0);
		}
		console.log(`docent: 새 버전이 있어요 v${current} → v${info.latest}`);
		if (rest.includes("--check")) process.exit(0);
		if (!info.installable) throw new Error(info.reason);
		const running = await serverAt(port);
		if (running) {
			// 켜 둔 서버가 직접 설치하고 자기 옵션 그대로 다시 켜진다.
			const response = await fetch(`http://127.0.0.1:${port}/api/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: true }), signal: AbortSignal.timeout(240_000) });
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.error || `서버가 업데이트하지 못했어요 (HTTP ${response.status}).`);
			process.stdout.write("docent: 설치했어요. 서버가 다시 켜지기를 기다려요");
			const deadline = Date.now() + 60_000;
			let now = null;
			while (Date.now() < deadline) {
				await new Promise((done) => setTimeout(done, 1000));
				process.stdout.write(".");
				now = await serverAt(port);
				if (now?.version === result.to) break;
			}
			console.log("");
			if (now?.version !== result.to) throw new Error("설치는 끝났지만 새 서버가 60초 안에 켜지지 않았어요. docent start 로 켜세요.");
			console.log(`docent: v${result.to} 서버가 켜졌어요. 열려 있는 터미널은 /재시작, 웹은 새로고침하세요.`);
		} else {
			const prefix = await installPrefix();
			if (!prefix) throw new Error("npm 전역으로 설치한 도슨트만 업데이트할 수 있어요. 저장소에서 실행 중이면 git pull 하세요.");
			await installRelease({ url: info.url, sha256: info.sha256, prefix });
			console.log(`docent: v${info.latest} 를 설치했어요. 켜 둔 서버가 없어 다시 켤 것은 없어요.`);
		}
		process.exit(0);
	} catch (error) {
		console.error(`docent update: ${error.message}`);
		process.exit(1);
	}
}
if (args[0] === "herdr") {
	const rest = args.slice(1);
	const value = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
	const known = new Set(["--session", "--session-file", "--cwd", "--port"]);
	const split = rest.includes("--split");
	const unknown = rest.find((arg, i) => arg !== "--split" && !known.has(arg) && !known.has(rest[i - 1]));
	if (unknown || [...known].some((name) => rest.includes(name) && !value(name))) {
		console.error(`docent herdr: ${unknown ? `알 수 없는 옵션이에요: ${unknown}` : "옵션 뒤에 값이 필요해요."}\nusage: docent herdr [--split] [--session <id> | --session-file <경로>] [--cwd <폴더>] [--port N]`);
		process.exit(2);
	}
	const { launchInHerdr, launchInPlace, shouldOpenInPlace } = await import("../app/herdr-launch.mjs");
	const { config } = await import("../app/store.mjs");
	try {
		const options = {
			port: Number(value("--port") ?? process.env.DOCENT_PORT ?? (await config()).port ?? 4747),
			session: value("--session") ?? null,
			sessionFile: value("--session-file") ?? null,
			cwd: value("--cwd") ?? process.cwd(),
		};
		if (shouldOpenInPlace({ split })) process.exit((await launchInPlace(options)).code);
		const result = await launchInHerdr(options);
		const where = result.session ? `세션 ${result.session}` : "세션 목록";
		console.log(result.action === "focused"
			? `이미 열린 도슨트 창(${result.pane})으로 이동했어요.`
			: `오른쪽 창(${result.pane})에 도슨트를 띄웠어요. ${where}을 열어요.${result.startedServer ? " 꺼져 있던 서버도 켰어요." : ""}`);
		process.exit(0);
	} catch (error) {
		console.error(`docent herdr: ${error.message}`);
		process.exit(error.code === "NOT_HERDR" ? 2 : 1);
	}
}
if (args[0] === "install-omp") {
	const unknown = args.slice(1).find((arg) => arg !== "--project");
	if (unknown) {
		console.error(`docent install-omp: 알 수 없는 옵션이에요: ${unknown}\nusage: docent install-omp [--project]`);
		process.exit(2);
	}
	const { installOmp } = await import("../app/install-omp.mjs");
	const result = await installOmp({ project: args.includes("--project") });
	console.log(`installed: ${result.agent}\ninstalled: ${result.extension} (/docent, 새 omp 세션부터 적용)`);
	process.exit(0);
}
if (args.includes("-h") || args.includes("--help")) {
	console.log(
		[
			"usage: docent [--no-open] [--port N] [--host <ip|tailscale>] [--peer 이름=URL ...]",
			"       docent start [--port N] [--host ...] [--peer ...]   서버를 백그라운드로 켬. 기록은 ~/.docent/server.log",
			"       docent stop [--port N]   백그라운드로 켠 서버를 끔",
			"       docent update [--check] [--port N]   GitHub 릴리스의 새 버전을 확인하고 설치. 켜 둔 서버는 새 파일로 다시 켜짐",
			"       docent doctor [--json] [--probe] [--port N]   설치 상태 점검. --probe 는 모델을 한 번 불러 로그인까지 확인",
			"       docent herdr [--split] [--session <id> | --session-file <경로>]   이 터미널 창에서 바로 도슨트 TUI 를 엶. --split 이면 Herdr 창 오른쪽에 띄움",
			"       docent install-omp [--project]   omp 서브에이전트 정의와 /docent 명령 설치. 코어나 확장을 고친 뒤에도 다시 실행",
			"  --host tailscale     이 컴퓨터의 테일스케일 주소에도 열어 다른 컴퓨터의 docent 가 읽어 가게 한다",
			"  --peer book=http://peer-host.example:4747   그 컴퓨터의 세션을 내 목록에 합친다",
			"  ~/.docent/config.json  {\"host\":\"tailscale\",\"peers\":{\"book\":\"http://peer-host.example:4747\"}}",
			"  TYPESAFE_API_KEY     (선택) Jev 판정 사용",
			"  docent-tui [--url URL]  Ghostty, Kaku 등에서 터미널 화면으로 연결",
			"  docent-mobile [--enable]  모바일 PWA용 Tailscale 사설 HTTPS 연결 확인",
		].join("\n"),
	);
	process.exit(0);
}
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.DOCENT_PORT ?? 4747);
const url = `http://127.0.0.1:${port}/`;
const openBrowser = !args.includes("--no-open");
if (flag("--host")) process.env.DOCENT_HOST = flag("--host");
const peers = args.flatMap((a, i) => (a === "--peer" && args[i + 1] ? [args[i + 1]] : []));
if (peers.length) process.env.DOCENT_PEERS = [process.env.DOCENT_PEERS, ...peers].filter(Boolean).join(",");

// Windows 의 start 는 명령이 아니라 cmd 의 내장 명령이므로 cmd 로 부른다.
const openers = { darwin: ["open"], win32: ["cmd", "/c", "start", ""], linux: ["xdg-open"] };
const opener = openers[process.platform];
const open = () => {
  if (!openBrowser || !opener) return;
  execFile(opener[0], [...opener.slice(1), url], () => {});
};

const alive = await fetch(`${url}api/sessions`).then((r) => r.ok).catch(() => false);
if (alive) {
	console.log(`docent: 이미 켜져 있어요 → ${url}`);
	open();
	process.exit(0);
}

const { ompCommand } = await import("../app/omp-bin.mjs");
const ompCheck = ompCommand(process.env.OMP_BIN ?? "omp", ["--version"]);
const missing = await new Promise((res) => execFile(ompCheck.command, ompCheck.args, (err) => res(Boolean(err))));
if (missing) {
	console.error("docent: omp 를 찾을 수 없어요. 도슨트는 설치된 omp 로 답을 만들어요. https://omp.sh 에서 설치하고 로그인한 뒤 다시 실행하세요.");
	process.exit(1);
}

process.env.DOCENT_PORT = String(port);
process.env.DOCENT_ON_LISTEN = openBrowser ? "open" : "";
await import("../app/server.mjs");
