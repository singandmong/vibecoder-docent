# 바이브코더 도슨트 설치 안내 (AI 에이전트용)

> For AI coding agents (Claude Code in the terminal or the Claude app, Codex CLI or the Codex app, omp, Gemini CLI, pi). The user gave you this link and asked you to install Vibecoder Docent. Run the checks yourself and onboard the user through questions with choices, using your host's built-in question tool. Talk to the user in easy Korean. 사용자는 이 링크를 주고 "설치해줘"라고만 했다. 확인은 직접 명령으로 하고, 결정은 호스트에 내장된 질문 도구로 선택지를 보여 주며 하나씩 묻는다.

## 질문하는 방법

결정이 필요할 때마다 호스트의 **내장 질문 도구**를 쓴다. 선택지를 글로 늘어놓고 답을 기다리지 않는다.

| 호스트 | 내장 질문 도구 |
|---|---|
| Claude Code (터미널, Claude 앱) | `AskUserQuestion` |
| Codex (CLI, Codex 앱) | `request_user_input`. 없고 `request_user_input_async`만 있으면 그것을 쓴다 |
| omp | `ask` |
| Gemini CLI | `ask_user` |

- 도구 이름이 다르더라도 "질문 + 선택지"를 보여 주는 도구가 있으면 그것을 쓴다.
- 질문마다 선택지는 2~4개, 짧은 이름과 한 줄 설명을 단다. 추천 선택지를 맨 앞에 두고 이름 끝에 "(추천)"을 붙인다. "기타" 선택지는 만들지 않는다. 대부분의 도구가 직접 입력 칸을 따로 제공한다.
- 한 번에 묻는 질문은 도구가 허용하는 만큼 묶되, 앞 답에 따라 달라지는 질문은 나중에 묻는다.
- **답을 받기 전에는 다음 단계로 넘어가지 않는다.** 비동기 질문 도구(예: Codex의 `request_user_input_async`)만 있으면 질문을 보낸 뒤 그 차례를 끝내고 사용자의 다음 메시지를 기다린다. 기다리다가 추천 선택지로 대신 정하지 않는다.
- 질문 도구가 정말 없을 때만 번호를 붙인 선택지를 글로 쓰고, 사용자가 번호로 답하게 한다.
- 사용자가 "알아서", "추천대로"라고 하면 추천 선택지로 진행하고 다시 묻지 않는다.
- 진행 중 안내, 질문, 마무리 보고를 모두 쉬운 한국어로 쓴다. 중간 안내도 영어로 쓰지 않는다.

## 지켜야 할 것

- 직접 확인할 수 있는 것(버전, 설치 여부, 포트, 세션 수)은 묻지 말고 명령으로 확인한다.
- 비밀값(API 키, 로그인 토큰)을 사용자에게 받아 적거나 파일에 쓰지 않는다. 로그인은 사용자가 직접 한다.
- `sudo`, 관리자 권한 설치, 시스템 서비스 등록(LaunchAgent, systemd, 작업 스케줄러)은 하지 않는다.
- 이미 설치된 Node.js 버전 관리 도구(nvm, fnm, volta, asdf, Homebrew, winget 등)가 있으면 그것을 쓴다.
- 공개 인터넷 노출(Tailscale Funnel, 포트 포워딩)은 하지 않는다. 도슨트에는 로그인 기능이 없다.
- 환경변수 `DOCENT_PORT`, `DOCENT_HOME`, `npm_config_prefix`가 이미 정해져 있으면 그대로 따른다. 명령에 포트를 따로 적지 않아도 `docent`와 `docent doctor`가 `DOCENT_PORT`를 쓴다.

## 1. 확인 (질문 없음)

아래를 실행하고 결과만 기억한다.

```sh
node --version          # v22.19.0 이상인지
omp --version           # omp가 있는지
docent --version        # 이미 설치된 도슨트가 있는지 (없으면 오류)
npm ls -g videcoder-docent   # 예전 이름 패키지가 남았는지
```

사용자에게 한 줄로 알린다: "설치 전에 확인했어요: Node.js …, omp …, 도슨트 …"

## 2. 시작 질문

질문 도구로 한 번에 묻는다.

**질문 1. 도슨트를 어디서 볼까요?** (여러 개 고를 수 있으면 여러 개 선택 허용)

| 선택지 | 설명 |
|---|---|
| 브라우저 (추천) | 컴퓨터 브라우저에서 세션과 설명을 본다 |
| 터미널 | 터미널 창에서 `docent-tui`로 본다 |
| 휴대폰 | 같은 사설망(Tailscale)으로 휴대폰 홈 화면에 붙인다 |
| macOS 앱 | 저장소에서 앱을 직접 만든다. 서명되지 않은 앱이다 |

**질문 2. 설치가 끝나면 작은 확인 요청을 한 번 보낼까요?**

| 선택지 | 설명 |
|---|---|
| 보내기 (추천) | 모델을 한 번 불러 omp 로그인까지 확인한다. 아주 적은 사용량이 든다 |
| 건너뛰기 | 첫 질문을 할 때 확인한다 |

**질문 3. 새 사건 자동 선별(Jev)을 쓸까요?**

| 선택지 | 설명 |
|---|---|
| 나중에 (추천) | 없어도 질문과 설명은 모두 된다. 일반 문장의 결과, 계획 카드만 덜 보인다 |
| 지금 설정 방법 보기 | TypeSafe API 키를 사용자가 직접 셸 설정에 넣는 방법을 안내한다. 에이전트는 키 값을 받지 않는다 |

## 3. 필요할 때만 묻는 질문

1단계 결과에 따라 해당하는 것만 묻는다.

**Node.js가 없거나 22.19보다 낮을 때: "Node.js를 어떻게 올릴까요?"**
- 찾은 버전 관리 도구 (추천): 예를 들어 "nvm으로 22 LTS 설치". 찾은 도구 이름을 그대로 쓴다.
- 공식 설치 파일: https://nodejs.org 에서 사용자가 직접 설치하고 알려 준다.

**omp가 없을 때: "omp를 설치할까요?"**
- 설치하기 (추천): https://omp.sh 의 공식 설치 방법을 읽고 그대로 실행한다. 설치 명령을 추측하지 않는다.
- 직접 설치: 사용자가 설치하고 알려 준다.

**omp를 새로 설치했거나 7단계에서 모델 호출이 실패했을 때: "omp 로그인을 마쳤나요?"**
- 다른 터미널 창에서 `omp`를 실행해 로그인하라고 먼저 안내한 뒤 묻는다.
- 마쳤어요 (추천): 다음 단계로 간다.
- 방법을 모르겠어요: `omp`를 실행하면 나오는 로그인 안내를 따르라고 다시 설명하고 다시 묻는다.

**예전 이름 패키지(`videcoder-docent`)가 있을 때: "예전 이름의 도슨트를 지울까요?"**
- 지우고 새로 설치 (추천): `npm uninstall -g videcoder-docent`
- 그대로 두기: 명령 이름이 겹칠 수 있다고 알린다.

**도슨트 서버가 이미 켜져 있고 버전이 다를 때(5단계): "켜져 있는 예전 도슨트를 어떻게 할까요?"**
- 새 버전으로 다시 켜기 (추천): `docent stop` 뒤 `docent start`. `docent stop`이 0.23.0 이전 서버라 끌 수 없다고 하면 사용자가 켜 둔 창에서 끄도록 안내한다.
- 그대로 두기: 새 기능 일부가 안 보일 수 있다고 알린다.

## 4. 설치

공개 GitHub Release 패키지를 설치한다.

```sh
npm install -g https://github.com/singandmong/vibecoder-docent/releases/latest/download/vibecoder-docent.tgz
docent --version
```

- 이미 설치되어 있으면 같은 명령이 최신 버전으로 업데이트한다.
- 권한 오류(`EACCES`)가 나면 `sudo`를 쓰지 말고, npm 전역 경로가 사용자 폴더를 가리키는지 확인하거나 버전 관리 도구로 설치한 Node를 쓴다.
- Windows PowerShell에서 `docent --version`이 "이 시스템에서 스크립트를 실행할 수 없으므로"(`UnauthorizedAccess`)로 실패하면 이후 모든 명령에 `.cmd`를 붙여 실행한다(`docent.cmd`, `docent-tui.cmd`). 실행 정책은 바꾸지 않는다.

## 5. 서버 켜기

먼저 `docent doctor`로 서버가 이미 켜져 있는지 본다. 꺼져 있으면 백그라운드로 켠다. macOS, Linux, Windows 모두 같다.

```sh
docent start
```

`docent start`는 서버를 이 명령과 떨어진 프로세스로 켜고 응답할 때까지 기다린다. 에이전트의 명령 실행이 끝나거나 터미널을 닫아도 서버가 남는다. `nohup`이나 `Start-Process`로 따로 띄우지 않는다. 출력은 `~/.docent/server.log`(`DOCENT_HOME`이 있으면 그 폴더)에 쌓이고, 켜지 못하면 그 기록의 마지막 줄을 함께 보여 주므로 원인을 쉬운 말로 알린다. 끄는 명령은 `docent stop`이다. 자동 시작 등록은 하지 않는다.

## 6. 점검

```sh
docent doctor
```

`[!!]` 줄과 "다음에 할 일"을 해결하고 다시 실행한다. 기계로 읽으려면 `docent doctor --json`을 쓴다.

| 값 | 뜻 |
|---|---|
| `node.ok` | Node.js 버전이 충분한지 |
| `omp.found`, `omp.chatModels` | omp가 있고 모델 목록을 읽을 수 있는지 |
| `server.running`, `server.version`, `server.sessions` | 서버가 켜져 있는지, 버전, 제공자별 세션 수 |
| `probe.ok` | `--probe`일 때 모델을 실제로 한 번 불렀는지 |
| `next` | 남은 할 일 |

## 7. 확인 요청 (질문 2에서 "보내기"를 골랐을 때)

```sh
docent doctor --probe
```

실패하면 3단계의 "omp 로그인을 마쳤나요?"를 묻는다.

## 8. 고른 화면 준비

| 고른 것 | 할 일 |
|---|---|
| 브라우저 | `docent` 실행. 이미 켜진 서버에 브라우저만 연다 |
| 터미널 | 사용법 안내: 다른 터미널 창에서 `docent-tui`. Herdr 창 안이면 `docent herdr`로 오른쪽 창에 바로 띄울 수 있다고 알린다. 호스트가 omp면 `docent install-omp`로 서브에이전트 정의와 `/docent` 명령을 설치하고, 새 omp 세션에서 `/docent`를 쓰라고 안내한다. `/docent`는 Herdr 창 안에서만 동작하므로 Herdr를 쓰지 않으면(Windows 포함) `docent-tui`를 쓰라고 알린다 |
| 휴대폰 | `docent-mobile`로 상태 확인. Tailscale이 없거나 로그인 전이면 그 방법을 안내한다. 준비되면 질문 도구로 **"휴대폰 공유를 지금 켤까요?"** (켜기 (추천) / 나중에)를 묻고, 켜기면 `docent-mobile --enable`. 안내된 HTTPS 주소를 휴대폰에서 열고 홈 화면에 추가하게 한다 |
| macOS 앱 | 저장소를 내려받아 `npm ci && npm run build:macos`. 서명되지 않은 앱이라 처음 열 때 macOS가 확인을 요구할 수 있다고 알린다 |
| Jev 설정 방법 보기 | 셸 설정 파일에 `export TYPESAFE_API_KEY=...`를 사용자가 직접 넣고 서버를 다시 켜라고 안내한다 |

## 9. 마무리

질문 도구로 마지막 하나를 묻는다: **"설치가 끝났어요. 바로 열어 볼까요?"**
- 브라우저로 열기 (추천): `docent`
- 나중에: 다음에 여는 방법만 알려 준다.

그리고 짧게 보고한다.

- 설치한 도슨트 버전과 서버 주소
- 읽을 수 있는 세션 수 (`docent doctor` 결과)
- 쓰는 법 세 줄: 세션을 고른다 → 작업 내용 카드를 누른다 → 궁금한 것을 묻는다
- 컴퓨터를 다시 켠 뒤에는 터미널에서 `docent start`로 켜고 `docent`로 브라우저를 연다는 것

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| `docent: command not found` | `npm prefix -g`의 `bin` 폴더가 PATH에 있는지. 셸을 새로 열었는지 |
| `omp 를 찾을 수 없어요` | `omp --version`. 다른 셸에서 PATH가 다르면 `OMP_BIN`에 omp 실행 파일 경로 지정 |
| 서버가 바로 꺼짐, `EADDRINUSE` | 포트를 다른 프로그램이 쓰는 중. `docent start --port 4848`로 켜고 `docent doctor --port 4848`로 점검 |
| 세션이 0개 | omp, Claude Code, Codex, Gemini CLI, pi 중 하나로 작업을 한 번 시작한 뒤 다시 확인 |
| 모델 호출 실패 | `omp`를 실행해 로그인 상태와 기본 모델 확인. 도슨트 설정에서 다른 모델을 고를 수 있음 |
| 서버 버전이 다르다고 나옴 | 예전 버전 서버가 켜져 있음. 3단계의 해당 질문으로 처리 |
| Windows PowerShell에서 `docent`가 `UnauthorizedAccess`로 실패 | 스크립트 실행이 막힌 PowerShell. `docent.cmd`처럼 `.cmd`를 붙여 실행 |
