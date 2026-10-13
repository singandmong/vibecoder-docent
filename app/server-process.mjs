// 백그라운드 서버 켜기와 끄기 (ADR 0057). `docent start`, `docent stop`, `docent herdr` 가 같이 쓴다.
// 켤 때는 이 명령과 떨어진 프로세스(POSIX 는 새 세션, Windows 는 창 없는 분리 프로세스)로 띄워
// 터미널을 닫거나 에이전트의 명령 실행이 끝나도 서버가 남게 한다. 출력은 DOCENT_HOME/server.log 에 이어 쓴다.
// 끌 때는 /api/health 가 알려 준 프로세스 번호로 신호를 보낸다. HTTP 로 서버를 끄는 길은 두지 않는다.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCENT_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/docent.mjs");
const START_WAIT_MS = 15_000;
const STOP_WAIT_MS = 10_000;

const getJson = (url, ms = 3000) => fetch(url, { signal: AbortSignal.timeout(ms) }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const healthOf = async (url) => {
	const health = await getJson(`${url}api/health`, 1000);
	return health?.app === "vibecoder-docent" ? health : null;
};

/** 그 포트의 도슨트 서버가 /api/health 로 알려 준 것. 꺼져 있으면 null. 0.17 이전 서버는 /api/health 가 없어 세션 목록 응답으로 알아본다. */
export async function serverAt(port) {
	const url = `http://127.0.0.1:${port}/`;
	return (await healthOf(url)) ?? (Array.isArray(await getJson(`${url}api/sessions`, 15_000)) ? { app: "vibecoder-docent" } : null);
}

export const serverLog = (env = process.env) => join(env.DOCENT_HOME || join(homedir(), ".docent"), "server.log");

const tail = (file) => {
	try {
		return readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim()).slice(-5).join("\n");
	} catch {
		return "";
	}
};

/**
 * 서버를 백그라운드로 켠다. 이미 켜져 있으면 그대로 둔다. `args` 는 `--host`, `--peer` 처럼 서버에 넘길 나머지 옵션이다.
 * @returns {Promise<{ started: boolean, url: string, log: string }>}
 */
export async function startServer({ port, args = [], env = process.env }) {
	const url = `http://127.0.0.1:${port}/`;
	const log = serverLog(env);
	if (await serverAt(port)) return { started: false, url, log };
	mkdirSync(dirname(log), { recursive: true });
	const serverArgs = [DOCENT_BIN, "--no-open", "--port", String(port), ...args];
	let alive = () => !exited;
	let exited = false;
	if (process.platform === "win32") {
		const pid = await createViaWmi(serverArgs, log, env);
		alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return error.code === "EPERM";
			}
		};
	} else {
		const fd = openSync(log, "a");
		const child = spawn(process.execPath, serverArgs, { detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env });
		closeSync(fd);
		child.once("exit", () => { exited = true; });
		child.unref();
	}
	const deadline = Date.now() + START_WAIT_MS;
	while (alive() && Date.now() < deadline) {
		await sleep(300);
		if (await healthOf(url)) return { started: true, url, log };
	}
	const last = tail(log);
	throw new Error(`도슨트 서버를 켜지 못했어요. 기록: ${log}${last ? `\n${last}` : ""}`);
}

// Windows OpenSSH 는 세션을 작업 개체(job object)에 넣고 세션이 끝나면 안의 프로세스를 모두 끝낸다. Node 의 분리 프로세스도 못 벗어난다.
// WMI Win32_Process.Create 로 만든 프로세스는 WmiPrvSE 의 자식이라 그 작업 개체 밖에 있다. 환경 변수는 WMI 가 호출자 것을 물려주지 않으므로
// PowerShell 이 자기가 물려받은 환경을 읽어 Win32_ProcessStartup.EnvironmentVariables 로 넘긴다. 값(TYPESAFE_API_KEY 등)이 -EncodedCommand 에 들어가지 않는다.
const WMI_SCRIPT = `
$ErrorActionPreference = 'Stop'
$names = @('DOCENT_WMI_CMDLINE', 'DOCENT_WMI_CWD')
$cmd = $env:DOCENT_WMI_CMDLINE
$cwd = $env:DOCENT_WMI_CWD
$vars = @(Get-ChildItem env: | Where-Object { $names -notcontains $_.Name -and -not $_.Name.StartsWith('=') } | ForEach-Object { $_.Name + '=' + $_.Value })
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$vars }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $cwd; ProcessStartupInformation = $si }
if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine('Win32_Process.Create ReturnValue=' + $r.ReturnValue); exit 1 }
[Console]::Out.WriteLine('PID=' + $r.ProcessId)
`;

const quoteCmd = (value) => `"${String(value).replaceAll('"', '""')}"`;

function createViaWmi(serverArgs, log, env) {
	const inner = `${[process.execPath, ...serverArgs].map(quoteCmd).join(" ")} >> ${quoteCmd(log)} 2>&1`;
	const wmiEnv = { ...env, DOCENT_WMI_CMDLINE: `cmd /d /c "${inner}"`, DOCENT_WMI_CWD: process.cwd() };
	const encoded = Buffer.from(WMI_SCRIPT, "utf16le").toString("base64");
	return new Promise((done, fail) => {
		const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: wmiEnv });
		let out = "";
		let err = "";
		ps.stdout.on("data", (chunk) => { out += chunk; });
		ps.stderr.on("data", (chunk) => { err += chunk; });
		ps.once("error", fail);
		ps.once("close", (code) => {
			const pid = Number(/PID=(\d+)/.exec(out)?.[1]);
			if (code === 0 && pid) done(pid);
			else fail(new Error(`도슨트 서버를 켜지 못했어요(WMI). ${err.trim().split(/\r?\n/).slice(0, 3).join(" ")}`));
		});
	});
}

/**
 * 그 포트의 서버를 끈다.
 * - not-running: 켜져 있는 서버가 없다
 * - no-pid: 0.23 이전 서버라 프로세스 번호를 알 수 없다. 켠 창에서 꺼야 한다
 * - restarted: 껐지만 다른 프로세스 번호로 다시 켜졌다(launchd 같은 서비스 관리자)
 * @returns {Promise<{ stopped: boolean, url: string, reason?: "not-running" | "no-pid" | "restarted" }>}
 */
export async function stopServer({ port }) {
	const url = `http://127.0.0.1:${port}/`;
	const health = await serverAt(port);
	if (!health) return { stopped: false, url, reason: "not-running" };
	if (!Number.isInteger(health.pid)) return { stopped: false, url, reason: "no-pid" };
	try {
		process.kill(health.pid, "SIGTERM");
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
	const deadline = Date.now() + STOP_WAIT_MS;
	while (Date.now() < deadline) {
		await sleep(300);
		const now = await healthOf(url);
		if (!now) return { stopped: true, url };
		if (now.pid !== health.pid) return { stopped: true, url, reason: "restarted" };
	}
	throw new Error(`서버(프로세스 ${health.pid})가 ${STOP_WAIT_MS / 1000}초 안에 꺼지지 않았어요.`);
}
