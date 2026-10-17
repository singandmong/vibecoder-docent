#!/usr/bin/env node
import { runTerminal } from "../app/terminal-ui.mjs";
import { terminalSafeText } from "../app/terminal-input.mjs";

const HELP = [
	"사용법: docent-tui [--url <주소>] [--session <세션 id>]",
	"  --url <주소>          도슨트 서버 주소 (기본값: http://127.0.0.1:4747)",
	"  --session <세션 id>   시작하자마자 이 세션을 연다 (docent herdr, OMP /docent 가 사용)",
	"  -h, --help    도움말 보기",
	"",
	"docent-tui 는 이미 실행 중인 서버에 연결하며 서버를 시작하거나 종료하지 않아요.",
	"별도 터미널에서 docent --no-open 으로 서버를 시작한 다음 실행하세요.",
	"",
	"입력창이 항상 화면 아래에 있어요. 그냥 입력하고 Enter 로 질문을 보내세요.",
	"세션을 고르면 이어서 대화 선택창이 열려요. 카드 목록과 고른 카드의 내용을 보고 Enter 로 열어요.",
	"입력창에 / 를 쓰면 명령 목록이, @ 는 세션, # 은 대화, $ 는 설정 선택창이 열려요.",
	"선택창은 맨 위 검색창에 글자(한글 포함)를 쳐서 거르고, 방향키와 PgUp/PgDn 으로 움직이고, Enter 로 골라요.",
	"Esc 는 검색어를 지우고, 비어 있으면 닫아요. 대화를 읽다가 Esc 를 누르면 대화 선택창으로 돌아가요.",
	"@ # $ 로 시작하는 질문은 앞에 공백을 하나 두고 쓰세요.",
	"",
	"단축키: Ctrl+P 세션 | Ctrl+T 대화 | Ctrl+O 저장된 답변 | Ctrl+G 프로필 | Ctrl+F 즐겨찾기",
	"/자세히 답변 세부 내용 | /근거 답변 인용 원문 | /복습 배운 용어 검색",
	"/업데이트 새 버전 받아 설치 후 이 터미널도 새 버전으로 | /재시작 같은 세션으로 다시 열기(서버가 먼저 업데이트됐을 때)",
	"Ctrl+R 같은 요청 다시 연결, 새로고침 | Ctrl+S 바로잡기 전환 | Ctrl+J 줄바꿈",
	"붙여넣기로 여러 줄을 입력할 수 있고 q, i, ! 같은 글자도 그대로 입력돼요.",
	"한글 입력이 어긋나면 DOCENT_HARDWARE_CURSOR=0 으로 진짜 커서를 숨길 수 있어요.",
	"마우스: 휠 스크롤(한 칸에 3줄), 클릭으로 선택창 항목 고르기와 입력창 커서 옮기기, 끌어서 복사, 두 번 눌러 낱말 복사.",
	"터미널(Herdr)의 글자 선택이 필요하면 /마우스 로 끄거나 DOCENT_MOUSE=0 으로 시작하세요.",
	"Bun 으로도 실행돼요: bun bin/docent-tui.mjs (기본과 지원 기준은 Node).",
].join("\n");

function usageError(message) {
	console.error(`docent-tui: ${message}\n\n${HELP}`);
	process.exitCode = 2;
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
	console.log(HELP);
} else {
	let baseUrl = "http://127.0.0.1:4747";
	let initialSession = null;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--url") {
			if (!args[index + 1] || args[index + 1].startsWith("--")) {
				usageError("--url 뒤에 서버 주소가 필요해요.");
				break;
			}
			baseUrl = args[++index];
		} else if (args[index] === "--session") {
			if (!args[index + 1] || args[index + 1].startsWith("--")) {
				usageError("--session 뒤에 세션 id 가 필요해요.");
				break;
			}
			initialSession = args[++index];
		} else {
			usageError(`알 수 없는 인자예요: ${terminalSafeText(args[index])}`);
			break;
		}
	}
	if (process.exitCode !== 2) {
		try {
			const url = new URL(baseUrl);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
				throw new Error("주소에는 http 또는 https 서버의 원점만 지정하세요. 예: http://127.0.0.1:4747");
			}
			baseUrl = url.origin;
		} catch (error) {
			usageError(error.message || "서버 주소를 확인하세요.");
		}
	}
	if (process.exitCode !== 2) {
		try {
			const result = await runTerminal({ baseUrl, initialSession });
			if (result?.restart) {
				// /재시작, /업데이트: 같은 실행 파일을 새로 띄운다. npm 이 파일을 바꿨으면 새 버전이 뜬다. 같은 서버와 세션으로 이어 연다.
				const { spawn } = await import("node:child_process");
				const nextArgs = [process.argv[1], "--url", baseUrl, ...(result.session ? ["--session", result.session] : [])];
				const child = spawn(process.execPath, nextArgs, { stdio: "inherit", env: process.env });
				const code = await new Promise((done) => child.on("exit", (exitCode, signal) => done(signal ? 1 : exitCode ?? 0)));
				process.exitCode = code;
			}
		} catch (error) {
			console.error(`docent-tui: ${terminalSafeText(error?.message || String(error))}`);
			process.exitCode = 1;
		}
	}
}
