# 0057 — 서버는 `docent start`로 백그라운드에 켜고 `docent stop`으로 끈다. omp 연동은 `docent install-omp`, 세션 id의 경로는 `/`

Date: 2026-10-14
Status: Accepted. 배포본(0.22.0)을 새 사용자처럼 설치한 E2E와 Windows PC 설치에서 나온 문제를 고친다. ADR 0041(에이전트 설치 안내), 0044(`docent herdr`, `/docent`), 0056(세션 목록)의 동작을 바꾼다.

## Context

1. **Windows에서 서버가 켜지지 않았다.** `bin/docent.mjs`가 서버를 `import(resolve(…))`로 불렀다. Windows의 절대 경로 `C:\…`는 ESM 지정자가 아니라 URL로 읽혀 `ERR_UNSUPPORTED_ESM_URL_SCHEME`(`Received protocol 'c:'`)로 끝났다. 이 줄은 0.15.0부터 있었다. 시험 픽스처는 `app/server.mjs`를 바로 띄워 이 경로를 지나지 않았다.
2. **Windows에서 모든 세션이 `bad session id`였다.** 세션 목록의 자리 규칙(ADR 0056 §3)이 `path.startsWith(root + "/")`, `split("/")`로 POSIX 구분자를 가정했다. Windows에서는 목록의 id가 `omp:-docent-e2e\2026-….jsonl`이 되고, 그 id로 전사, 라이브, 질문을 열면 모두 400이었다. 작업 내용 카드도 나오지 않았다. 워크트리 판정(`app/repo.mjs`)도 `resolve`가 돌려준 `\` 경로를 `/worktrees/`로만 찾아 Windows에서는 워크트리 폴더 이름을 저장소 이름으로 보였다(0.18.1에서 고친 문제가 Windows에 남음).
3. **에이전트가 켠 서버가 사라졌다.** INSTALL-AGENT 5단계는 macOS, Linux에서 `nohup docent --no-open > … &`였다. omp의 bash 도구는 명령의 프로세스 그룹을 기한에 정리해서, 시험에서 서버가 기한(60초) 뒤 기록 없이 꺼졌고 첫 질문이 `Failed to fetch`로 실패했다. `nohup sleep 300 &`도 같은 방식으로 사라졌다.
4. **Windows 안내 명령이 메모장을 열었다.** 5단계의 `Start-Process -WindowStyle Hidden -FilePath docent`는 PowerShell이 `docent.ps1`을 먼저 고르고 `.ps1`의 기본 동작(열기)으로 메모장을 띄웠다. 서버는 켜지지 않았고, 이 방식은 `server.log`도 만들지 않아 안내의 "server.log 마지막 줄"을 읽을 수 없었다.
5. **Windows에서 omp 연동 설치 명령을 쓸 수 없었다.** `sh "$(npm root -g)/vibecoder-docent/scripts/install-omp.sh"`는 PowerShell과 명령 프롬프트에 `sh`가 없다. Git for Windows의 `sh.exe`를 부르는 한 줄도 Windows PowerShell 5.1이 인자 안의 겹따옴표를 깨뜨려(`unexpected EOF while looking for matching ')'`) 실패했다. 경로를 PowerShell이 넘기면 한글 사용자 폴더가 ANSI 코드 페이지로 깨졌다(`C:\Users\?깊걧\…`). PowerShell 7에서는 됐다.

## Decision

1. **`docent start [--port N] [--host …] [--peer …]`는 서버를 이 명령과 떨어진 프로세스로 켠다.** POSIX에서는 새 세션(`detached`), Windows에서는 창 없는 분리 프로세스(`detached`, `windowsHide`)다. 출력은 `DOCENT_HOME/server.log`(기본 `~/.docent/server.log`)에 이어 쓴다. `/api/health`가 답할 때까지 최대 15초 기다리고, 이미 켜져 있으면 새로 띄우지 않는다. 켜지지 않으면 기록의 마지막 다섯 줄과 함께 실패한다. `docent herdr`도 같은 함수(`app/server-process.mjs`)로 서버를 켠다.
2. **`docent stop [--port N]`은 `/api/health`가 알려 준 pid로 신호를 보낸다.** `/api/health`는 `{app, version, pid}`를 돌려준다. HTTP로 서버를 끄는 경로는 두지 않는다. 브라우저의 다른 페이지가 보내는 요청(CSRF)이나 Tailscale 공유를 거친 요청으로 서버가 꺼지지 않게 하려는 것이다. pid가 없는 0.23 이전 서버는 끄지 않고 켠 창에서 끄라고 알린다. 끈 뒤 다른 pid로 다시 응답하면 서비스 관리자(launchd 등)가 다시 띄운 것으로 알린다.
3. **에이전트 설치 안내의 서버 켜기는 모든 운영체제에서 `docent start` 하나다.** `nohup`, `Start-Process`로 따로 띄우지 않는다. 예전 서버가 켜져 있으면 `docent stop` 뒤 `docent start`.
4. **omp 연동 설치는 `docent install-omp [--project]`다.** `app/install-omp.mjs`가 셸 없이 프론트매터 + 코어 프롬프트를 이어 서브에이전트 정의를 쓰고 `/docent` 확장을 복사한다. 결과는 예전 스크립트와 바이트까지 같다. `scripts/install-omp.sh`는 지운다. `/docent`는 Herdr 창에서만 동작하므로 Herdr 밖(Windows 포함)에서는 `docent-tui`를 안내한다.
5. **세션 id의 경로 부분은 운영체제와 관계없이 `/`다.** 목록 자리 규칙은 `path.relative`와 `path.sep`으로 판정하고, id는 `relative(root, path)`를 `/`로 이어 만든다. macOS, Linux의 id는 그대로다. 워크트리 판정은 `\`와 `/`를 모두 받는다.
6. **Windows PowerShell의 스크립트 실행이 막혀 있으면 `.cmd`를 붙인다.** 기본 실행 정책(`Restricted`)에서는 `docent`가 `docent.ps1`로 풀려 `UnauthorizedAccess`로 실패한다. `docent.cmd`는 된다. 안내는 실행 정책을 바꾸지 않고 `.cmd`를 쓰게 한다.
7. **CI에 Windows 작업을 둔다.** 가짜 omp, herdr를 shebang 스크립트로 만들어 서버에 물리는 시험(ask, doctor, herdr-launch, models, terminal)은 Windows에서 실행할 수 없어 빼고 나머지를 돌린다. 새 시험 `tests/server-process.test.mjs`가 실제 `docent start`로 서버를 켜고 `/`로 이어진 세션 id로 전사를 연 뒤 `docent stop`으로 끈다. 고치기 전 Windows에서는 2의 id 때문에 실패한다(`["omp:-proj\\2026-…jsonl"]`).

## Consequences

- 에이전트가 `docent start`로 켠 서버는 명령 실행이 끝난 뒤에도 남는다. macOS에서 omp bash 도구 기한(20초)을 넘겨 살아 있었고, Windows의 omp가 자기 셸 도구로 켠 서버도 도구 기한(120초) 뒤까지 같은 pid로 응답했다.
- Windows에 SSH로 접속해 `docent start`를 실행하면 SSH 연결이 끝날 때 서버도 꺼진다. Windows OpenSSH가 세션의 작업 개체(job object)를 정리하고, Node의 분리 프로세스는 작업 개체를 벗어나지 않는다. 그 컴퓨터의 터미널이나 에이전트에서 켜야 한다. README에 적는다.
- Windows에서 `docent stop`은 신호 대신 프로세스를 바로 끝낸다(Node의 `process.kill`). 서버의 정상 종료 처리(모델 프로세스 정리)는 돌지 않는다. 저장은 문답마다 끝나 있으므로 잃는 기록은 없다.
- 0.22.0 이하를 Windows에서 실행해 본 사용자는 서버가 켜지지 않았으므로 옮길 기록이 없다. macOS, Linux의 저장된 세션 id는 바뀌지 않는다.
- `scripts/install-omp.sh`를 부르던 운영 문서는 `docent install-omp`로 바꾼다. 지난 ADR과 CHANGELOG의 옛 이름은 그때의 기록이라 고치지 않는다.
- 영향 범위: `bin/docent.mjs`, `app/server-process.mjs`(신규), `app/install-omp.mjs`(신규), `app/herdr-launch.mjs`, `app/server.mjs`, `app/catalog.mjs`, `app/repo.mjs`, `scripts/install-omp.sh`(삭제), `tests/server-process.test.mjs`(신규), `.github/workflows/ci.yml`, `INSTALL-AGENT.md`, `README.md`, `adapters/omp/`, `docs/architecture.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`.
