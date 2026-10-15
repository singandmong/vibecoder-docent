# 구조

```
prompt/docent.md          코어. 호스트 중립 프롬프트. 유일한 진실.
app/server.mjs            로컬 웹앱 서버. 조립과 HTTP 경로. 세션은 catalog.mjs, 설명 요청은 ask.mjs 에 맡기고 NDJSON 스트림/JSON으로 응답
app/catalog.mjs           세션 목록 module: 이 컴퓨터의 제공자(호스트 adapter + 정규화 전사 캐시)와 다른 컴퓨터의 제공자를 같은 interface 로, 세션 id → 제공자(모르면 400), 합친 목록(Herdr 에 열린 세션 먼저, 그다음 최근 활동 순 200개, 꾸미기는 세션의 제공자가), 파일 경로 → 세션 id(목록과 같은 depth·match 규칙). 세션 id 의 경로 부분은 운영체제와 관계없이 `/` (ADR 0056·0057·0060)
app/herdr-workspaces.mjs  Herdr 작업 공간: `herdr agent list`, `herdr workspace list` 를 3초 캐시로 읽어 세션 파일 경로(또는 경로 없이 알린 세션 id) → {workspace, label, number, pane}. 파일 자리 찾기는 herdrEntryFor. PATH 의 herdr, 없으면 ~/.local/bin/herdr, 1.5초 제한, 실패하면 정보 없음. 목록 정렬 비교(compareSessions) 포함 (ADR 0060·0064)
app/ask.mjs               설명 요청 module: 작업 열기·합류·재생, 사용자 질문 우선 게이트, 같은 스레드 순서 실행, 설명 → 근거 → 저장 → 뒤에서 학습 분류. runner 를 받아 쓴다 (ADR 0050)
app/runner.mjs            omp 실행 정책 한곳: 사용자 전역 설정 격리, 한 번 호출(-p)과 RPC 대화, 중단·바로잡기 (ADR 0028)
app/omp-bin.mjs           OMP_BIN → 실행할 명령. `.js`·`.mjs`·`.cjs` 진입점은 지금 Node 로 실행(Windows 는 shebang 을 못 읽음). runner·models·doctor·시작 확인이 모두 거침 (ADR 0062)
app/depth.mjs             설명 깊이 module: 고른 깊이 > 분야 판정(분야별 설정이 있을 때만) > 기본값, 판정 실패 규칙, thinking 표. 터미널 상태줄도 같은 표를 씀 (ADR 0028·0040·0051)
app/errors.mjs            화면에 보여 줄 오류(httpError)
app/conversation.mjs      스레드 = 살아 있는 RPC 대화. 전사는 처음 한 번 + 이후 새 기록만, 닫힌 스레드는 저장된 문답으로 복원 (ADR 0028)
app/jobs.mjs              설명 작업 레지스트리: 대기·분류·설명·완료·실패·중단, 같은 requestId 합류, 스트림 이벤트 (ADR 0029)
app/prefetch.mjs          세션 감시기 공유·미리 설명 예약·10분 5개 상한 (ADR 0031)
app/live.mjs              세션 폴링 → 질문·결과·계획만 선별, 재생에도 같은 기준 적용. 바이트는 session-file.mjs, 줄 해석은 호스트 adapter 의 events (ADR 0054)
app/session-file.mjs      세션 파일 읽기 module: 머리, 잘린 첫 줄을 버린 꼬리, 넓혀 가며 읽는 꼬리, 이어 읽기(끝나지 않은 줄 보관, 줄어든 파일은 처음부터) (ADR 0054)
app/jev.mjs               TypeSafe Jev 의미 판정. 사용 불가 시 구조화 질문만 유지하고 제한 안내
app/store.mjs             문답·요청 기록 module: learning.json 원자적 저장, 모든 입구에서 프로필 확인, 요청 키·문답 식별자, 요청 상태(시작·완료·실패·중단), 즐겨찾기, 기본 프로필의 기존 questions.jsonl 읽기 (ADR 0052)
app/learning.mjs          프로필 설정·의미 분류 계획(전사 없이)·핵심 단어·학습 상태·관련 기억 (ADR 0014·0030)
app/thread.mjs            스레드 식별자: 질문 대상 내용(공백 차이 무시)의 해시, "" 는 세션 전체 대화. 문답마다 스레드를 붙이고, 같은 세션의 앞선 답을 다시 설명한 문답은 그 답의 스레드에 둔다 (ADR 0022·0052·0053)
app/conversations.mjs     대화 목록과 스레드 소속(서버·웹·터미널 공용, 브라우저에도 정적 파일로 제공): 서버가 붙인 thread 로만 소속을 정함, 세션 전체 대화 + 사건 카드 + 카드 없는 저장 대화(마지막 활동 순, 각 대화의 마지막 답 포함), 질문과 함께 보낼 카드 목록 정리, 카드·답의 질문 대상 모양, 카드의 화면 제목과 3문장 요약(`cardDisplay`, `summarySentences`) (ADR 0053·0068)
app/session-client.mjs    설명 요청의 화면 쪽 상태 module(웹·터미널 공용, 브라우저에도 정적 파일로 제공): 진행 중인 설명, 대기 질문(순서대로, 다른 세션·프로필 것은 보내지 않음), 중단한 질문을 그 자리의 빈 입력창에 되돌리기, 바로잡기, 같은 requestId 로 다시 붙기(받은 글을 비우고 시작), 끊긴 연결 다시 붙기, 미리 설명 따라가기, 실시간 사건 다시 붙기. 화면은 onChange 알림을 그리기만 함 (ADR 0029·0055)
app/transport.mjs         서버와 주고받는 transport adapter(웹·터미널 공용, 브라우저에도 정적 파일로 제공): JSON 요청, NDJSON 설명 스트림, SSE 실시간 사건, 서버 {error} 문구와 HTTP 상태를 TransportError 로 (ADR 0055)
app/models.mjs            omp 채팅 모델 카탈로그·단가·정확한 selector 검증 (ADR 0016)
app/evidence.mjs          소스 검증·근거 추출·원문 위치와 주변 맥락 해석 (ADR 0014)
app/review.mjs            답 속 용어 링크용 용어집: 저장된 핵심 단어 + `용어(풀이)` 규칙 추출
app/wiki.mjs              배운 내용 다시보기 용어 사전: 핵심 단어 검증·집계·옛 문답 일괄 추출 (ADR 0020)
app/trim.mjs              긴 전사 줄이기: 120,000자 넘으면 앞 턴은 사용자 발화만, 최근 턴은 그대로 (ADR 0009)
app/peers.mjs             다른 컴퓨터의 제공자: 원격 세션 목록·전사·라이브, 문답은 가져오지 않음. 목록 항목에 이 컴퓨터의 ssh 별칭(`ssh`)을 붙이고 그쪽이 보낸 값은 버림. interface 는 catalog.mjs (ADR 0011·0014·0056·0067)
app/ssh-aliases.mjs       `~/.ssh/config` 의 Host 별칭(Include 포함)을 `ssh -G` 로 풀어 peer URL 과 같은 컴퓨터의 별칭을 고름. 10분 캐시, 목록은 최대 1초만 기다림 (ADR 0067)
app/dialogue.mjs          질문 대상 검증, 사건 카드의 질문 대상·스레드·미리 설명 요청문, 분류용 최근 대화 (ADR 0022·0028)
app/slots.mjs             답 → {status, headline, explain, details[]}, Markdown 블록 보존 (ADR 0017)
app/index.html            세션·작업 내용·카드별 대화·즐겨찾기·설정·배운 내용 다시보기·PiP. Streamdown 로컬 자산으로 Markdown 표시. 대화 목록과 스레드 소속은 /conversations.mjs, 서버와 주고받기는 /transport.mjs, 설명 요청 상태는 /session-client.mjs (ADR 0015·0017·0053·0055)
app/mobile.css           600px 이하 단일 화면 탐색, 터치와 화면 키보드 레이아웃
app/mobile.mjs           PWA 설치, 연결 안내, 모바일 표시 상태
app/sw.js                개인 기록 없는 오프라인 안내만 캐시
app/terminal-ui.mjs       터미널 클라이언트 화면: 대화, 입력창(자리별 초안), 대기 질문, `/` 명령 목록, 선택창(세션·대화·저장된 답변·프로필·설정), 진짜 커서 위치. 대화 목록과 스레드 소속은 conversations.mjs, 설명 요청 상태는 session-client.mjs (ADR 0038·0039·0053·0055·0068)
app/session-model.mjs     설명 대상 세션의 모델: 정규화 전사의 마지막 `(모델: X)` 표식, omp 카탈로그(60초 캐시)와 맞춰 정확한 모델 하나로. 프로필에 고른 모델이 없을 때의 설명·분류 모델 (ADR 0069)
app/terminal-select.mjs   터미널 선택창의 상태 없는 부분: 낱말 거르기, 줄 수가 다른 항목의 스크롤 시작점, 한 화면 그리기(검색창, 목록, 미리 보기, 도움말), 입력 위치 커서 칸 (ADR 0068)
app/terminal-status.mjs   터미널 상태줄 규칙 표와 그리기, 좁은 화면 항목 빼기 (ADR 0040)
app/terminal-markdown.mjs Pi Markdown 렌더러 연결과 제어 문자 차단. 한글 옆 강조는 `app/assets/terminal-cjk.js`(웹과 같은 remark + `@streamdown/cjk` 파서를 `app/terminal-cjk-src.mjs` 에서 미리 묶은 것)가 강조 구간을 찾아 CommonMark 가 거절할 구분 기호 바깥에 U+FEFF 를 끼우고 렌더 뒤 지움 (ADR 0038·0061·0065)
app/markdown-remark.mjs   웹 Markdown 의 remark 플러그인 순서. `@streamdown/cjk` 로 한글 옆 강조와 취소선을 풂. 빌드 입력이라 배포 패키지에서 빠짐 (ADR 0061)
app/terminal-theme.mjs    OMP titanium 역할별 색 (ADR 0038)
app/terminal-herdr.mjs    Herdr 안에서 agents 창에 도슨트 상태(대기, 작업 중, 막힘)와 재시작 명령을 알림 (ADR 0043)
app/herdr-launch.mjs      `docent herdr`: 터미널(TTY)이면 그 창에서 도슨트 터미널을 바로 실행, `--split` 이거나 TTY 가 아니면 Herdr 창을 나눠 띄우고 이미 있으면 이동. 세션을 고르고 꺼진 서버는 server-process.mjs 로 켬 (ADR 0044·0059)
app/server-process.mjs    `docent start`, `docent stop`: 명령과 떨어진 프로세스로 서버를 켜고(출력은 DOCENT_HOME/server.log) /api/health 의 pid 로 끔. Windows 는 WMI `Win32_Process.Create` 로 만들어 SSH 세션이 끝나도 남고, WMI 가 막혔으면 분리 프로세스로 켜고 경고 (ADR 0057·0058·0066)
app/install-omp.mjs       `docent install-omp`: 프론트매터 + 코어를 결합해 omp 서브에이전트 정의로, `/docent` 확장 복사. 셸 없이 모든 OS 에서 같은 명령 (ADR 0057)
adapters/omp/docent-command.ts  OMP `/docent` 슬래시 명령. `docent herdr`를 부르는 얇은 확장 (ADR 0044)
app/doctor.mjs            `docent doctor`: Node, omp와 모델, 서버와 세션 수, 선택적 모델 호출 점검 (ADR 0041)
INSTALL-AGENT.md          링크 하나로 에이전트가 따라 하는 설치 안내 (ADR 0041)
bin/docent-mobile.mjs    Tailscale Serve 상태 확인과 명시적 사설 HTTPS 설정
scripts/transcript-omp.mjs    omp 세션 adapter: 목록 메타 / 전사 / 사건 카드 후보. pi 도 쓰는 omp 모양 adapter (모듈 + CLI, ADR 0054)
scripts/transcript-claude.mjs Claude Code 세션 adapter. 사용자 발화 없는 세션 숨김, 옆 폴더의 서브에이전트 전사를 띄운 자리에 접어 넣고 그 변경 표시(stamp)를 냄 (모듈 + CLI, ADR 0013·0054)
scripts/transcript-codex.mjs  Codex CLI rollout adapter (모듈 + CLI, ADR 0032·0054)
scripts/transcript-gemini.mjs Gemini CLI 채팅 기록 adapter(갱신 연산 접기, 작업 폴더는 파일 또는 .project_root) (모듈 + CLI, ADR 0032·0054)
scripts/transcript-pi.mjs     pi 세션 adapter: 줄을 읽을 때 한 번 omp 모양으로 바꿔 omp adapter 를 씀 (모듈 + CLI, ADR 0032·0054)
scripts/transcript-jsonl.mjs  adapter 공용: jsonl 줄 읽기(잘린 줄 건너뜀), 전사 머리말 쓰기와 작업 폴더 읽기(모르면 null), CLI (ADR 0054)
scripts/transcript-source.mjs 메시지·내용 버전 기반 소스 표시, 코드와 서브에이전트 원문 보존
docs/                     개념·범위·결정
```

## 두 경로

| | 웹앱 (ADR 0005, 기본) | 서브에이전트 (ADR 0002, 배관) |
| --- | --- | --- |
| 사용자 | 브라우저에서 직접 | 메인 에이전트에게 부탁 |
| 코어 전달 | `--system-prompt prompt/docent.md` | 설치된 agents/vibecoder-docent.md |
| 전사 | 서버가 jsonl 정규화해 대화 입력으로 (처음 한 번 + 이후 새 기록) | `history://<id>` 또는 정규화한 md 경로 |
| 출력 | 평문 → `slots.mjs` → 카드 | `{"answer": 평문}` |
| 도구 제한 | 설명은 `--tools read`, 분류는 도구 없음 (runner.mjs) | 프론트매터 `tools:` |

## 세 가지 추가 화면 (ADR 0037)

모바일 PWA, 터미널, macOS 앱도 위 웹앱 경로의 같은 서버를 사용한다. 설명과 분류를 화면별로 구현하지 않는다. 같은 서버와 프로필의 문답을 이어 보며, 서로 다른 서버의 학습 기억을 자동으로 합치지 않는다.

- 모바일은 기존 웹 화면을 600px 이하 단일 화면 탐색으로 표시한다. 서비스 워커는 `/offline.html`만 저장하고 `/api/` 응답은 `no-store`다. HTTPS는 사용자가 명시적으로 설정한 Tailscale Serve를 사용하며 공개 Funnel은 금지한다.
- 터미널은 HTTP와 SSE, NDJSON을 읽는 Node 클라이언트다. 서버는 별도로 실행한다. `terminal-ui.mjs`는 Pi 대화형 모드의 배치(제목과 단축키, 대화, 진행 표시, 가로선 사이 입력창, 두 줄 상태줄)를 그린다. 세션을 고르면 이어서 그 세션의 대화 선택창이 열린다(웹 카드와 같은 제목과 요약 규칙인 `conversations.mjs`의 `cardDisplay`, 새 카드가 위, 고른 항목의 AI 출력 미리 보기). `@`, `#`, `$`를 입력창 첫 글자로 치면 세션, 대화, 설정 선택창이 열리고(Ctrl+P, Ctrl+T, Ctrl+O, Ctrl+G는 같은 창), `/`는 입력창 아래 명령 목록을 띄운다. 선택창은 `terminal-select.mjs`로 그리며 맨 위 검색창에 친 글자로 거르고 PgUp/PgDn으로 한 화면씩 움직인다. 설정은 `PATCH /api/profiles/:id`와 `GET /api/models`로 바꾸고 즐겨찾기는 `GET/POST /api/favorites`다 (ADR 0039·0068). 프레임을 쓴 뒤에는 진짜 터미널 커서를 입력창 캐럿이나 선택창 검색창 위치로 옮겨 보이게 해 한글 조합 글자와 후보 창이 그 자리에 붙게 한다(`DOCENT_HARDWARE_CURSOR=0`이면 숨김). 상태줄은 `terminal-status.mjs`의 규칙 표(`docs/terminal-status-line.md`)로 그리며, 즐겨찾기 수는 `GET /api/favorites`, 학습 시간과 문답 수는 문답 기록, 추론 수준은 `depth.mjs`의 `THINKING`에서 계산한다 (ADR 0040). 초안과 커서는 프로필, 세션, 스레드, 질문/바로잡기별로 메모리에 보관한다. 답 선택은 읽는 위치만 바꾸며 요청이나 스레드를 만들지 않는다. `terminal-markdown.mjs`는 `@earendil-works/pi-tui`의 Markdown 렌더러로 설명과 원문을 그리며, 렌더링 전에 제어 문자를 제거하고 색 코드 외의 터미널 제어를 내보내지 않는다. `terminal-theme.mjs`의 역할별 색상은 OMP `titanium-prompt-focus` 값이며 본문은 터미널 기본 색을 상속하고 NO_COLOR를 존중한다. 터미널 종료는 서버를 끄지 않는다 (ADR 0038). 웹과 다른 점과 남은 계획은 `docs/terminal-parity-plan.md`.
- macOS 앱은 격리된 Electron 창에서 기존 웹 화면을 연다. `/api/health`의 제품 식별자를 확인해 로컬 서버를 재사용하거나 자식 서버를 시작한다. 앱이 소유한 서버만 종료한다.
- `GET /api/health`는 `{app: "vibecoder-docent", version, pid}`를 반환한다. 서버 확인용이지 사용자 인증 수단이 아니다. `docent stop`은 이 pid 로 이 컴퓨터에서 신호를 보내며, HTTP로 서버를 끄는 경로는 없다 (ADR 0057).


## 코어가 가정하는 것

- 과제에 **전사**(또는 전사 위치)와 **사용자 질문**이 들어 있다. 웹앱에서는 한 스레드가 이어지는 대화이고, 전사 갱신이 뒤에 이어 붙는다.
- 전사는 시간순으로 읽히는 텍스트다. 사용자 발화, 에이전트 발화, 도구 호출 요약, AI가 사용자에게 한 질문(질문 문장·선택지)과 `ask` 답이 구분된다.
- 읽기 도구만 있다. 쓰기·실행 도구는 없다(있어도 쓰지 않는다).

코어는 호스트·도구·경로 이름을 모른다. 이 셋은 모두 어댑터(웹앱 서버 또는 프론트매터)가 채운다.

## 세션 제공자

`app/catalog.mjs` 의 `sessionCatalog(providers)` 가 세션 목록 module 이다 (ADR 0056). 제공자는 이 컴퓨터의 것(`localProviders`)과 다른 컴퓨터의 것(`peerProvider`) 모두 `{id, host, owns, check, list, describe, transcript, watch, idOf}` 를 낸다. 서버의 `/api/sessions`, `/api/sessions/resolve`, `/api/transcript`, `/api/live`, 미리 설명 감시, 설명 요청의 전사는 모두 이 module 에 위임한다. 세션 자리는 제공자 폴더 아래 `depth` 단계 폴더 안, 이름이 `match` 와 맞는 파일이고, 목록 걷기·id → 경로·경로 → id 가 같은 규칙을 쓴다. 목록에 없는 자리의 id 는 400, 경로는 404. 이 컴퓨터의 제공자는 Herdr 에 열린 세션 항목에 `herdr: {workspace, label, number, pane}` 을 붙이고(`localProviders` 의 `herdr` 옵션), 목록은 200개로 자르기 전에 이 컴퓨터 Herdr 세션(작업 공간 번호, 창 번호), 다른 컴퓨터의 Herdr 세션(컴퓨터별), 나머지(최근 활동) 순으로 정렬한다. 다른 컴퓨터의 `herdr` 는 그쪽 서버가 보낸 그대로 쓴다 (ADR 0060).

이 컴퓨터의 제공자는 호스트 adapter 하나를 감싼다. adapter 는 `{id, dir, depth, match, headBytes, meta(head, path), transcript(text, path), events(chunk), stamp?(path)}` 이고 줄 해석, 숨김·제목 규칙, 작업 폴더 찾기를 안에 가진다 (ADR 0054). 지금은 `omp`(`~/.omp/agent/sessions/*/*.jsonl`), `claude`(`~/.claude/projects/*/*.jsonl`, 서브에이전트 파일을 `stamp`로 캐시 기준에 포함), `codex`(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), `gemini`(`~/.gemini/tmp/*/chats/session-*.jsonl`, 작업 폴더는 `.project_root`), `pi`(`~/.pi/agent/sessions/*/*.jsonl`). 목록은 바뀐 파일의 머리만 다시 읽는다. 새 호스트는 adapter 모듈 하나 + 서버의 `localProviders` 배열 한 줄. 전사 출력 모양(`## user` / `## assistant` / `→ 도구(…) ⇒ ok·에러·사용자 답`, AI의 질문은 질문 문장·선택지 포함)은 호스트가 달라도 같아야 한다. 도슨트는 구분하지 않는다. 머리말의 작업 폴더를 모르면 `?` 로 적고, 학습 범위는 이를 작업 폴더 없음으로 읽는다.

## 웹앱 요청 흐름

1. `GET /api/sessions` — 각 제공자의 세션 파일 머리만 읽어 제목·폴더·시각. 최신순 200개. 이 200개에는 저장소(`repo`), 지금 브랜치(`branch`, `detached`), 워크트리 폴더(`worktree`), 전사 꼬리에서 고른 최근 작업 한 줄(`recent`)을 붙인다(ADR 0045).
2. 프로필·세션을 고른다. 세션 목록은 최근 10개부터 보여 주고 "더 보기"로 늘린다. 세션을 고르면 작업 내용이 펼쳐지고, 카드를 누르면 그 카드의 대화 스레드가 열린다(ADR 0022). 스레드 식별자(`thread`)는 서버가 질문 대상 내용으로 발급하고, 대상이 없으면 `""`(세션 전체 대화)다. 즐겨찾기는 `GET/POST /api/favorites`로 프로필·세션·스레드별로 `learning.json`에 저장한다.
3. `POST /api/ask {id, question, profileId, difficulty?, requestId, auto?, focus?, cards?}` — 같은 requestId 작업이 진행 중이면 합류, 저장된 결과가 있으면 재생, 없으면 작업을 연다. 작업: 요청 시작 저장 → 깊이 결정(이번 질문 선택 > 분야별 설정이 있을 때만 짧은 분야 판정 > 프로필 기본값) → 스레드 대화에 전사(또는 갱신분)·기억 후보 요약·이번 질문 맥락을 보내 설명 스트림 → 이 대화에 실제로 보낸 근거만 검증 → 문답·요청 완료 저장(`learning.classification: "pending"`) → 답을 돌려준 뒤 뒤에서 학습 분류(질문·질문 대상·최근 대화·방금 한 답·카드 목록·기억 후보)를 붙이고 라이브 연결로 `{kind: "record"}`를 알린다 (ADR 0032). `Accept: application/x-ndjson`이면 `stage`·`delta`·`steer`·`reset`과 끝줄(`answer`·`error`·`cancelled`)을 줄 단위로 보낸다.
4. 설명 중 Esc/멈춤은 `POST /api/ask/cancel`(모델 호출을 끊고 문답을 남기지 않음, 요청은 `cancelled`), ⌘Enter/"지금 바로잡기"는 `POST /api/ask/steer`(같은 대화 맥락에서 다시 답함), Enter는 대기 질문. `GET /api/jobs`로 새로고침 뒤 진행 중 작업에 다시 붙는다 (ADR 0029). 이 화면 쪽 규칙은 웹과 터미널이 `session-client.mjs` 하나로 같이 쓴다 (ADR 0055).
5. 대화에는 짧은 결론과 핵심 설명을 먼저 그리고 세부 내용을 접어 둔다. "원문 보기"는 `/api/evidence`로 왼쪽 서랍(세션 목록 + 작업 내용 칸 너비)을 열고, 에이전트·사용자 원문은 Markdown으로, 도구 결과는 고정폭으로 보여 준다. 앱이 만든 요청문은 서버가 준 `display`로 보여 준다. 답의 `suggest`가 있으면 해당 카드 대화로 옮기기 버튼을 둔다.
6. 프로필/세션 전환 시 이전 응답을 새 화면에 반영하지 않는다. 같은 requestId의 재전송은 저장한 결과를 돌려주고, 새로운 의문은 새 ID로 다시 설명한다.

`GET /api/models`는 설치된 omp 카탈로그를 공개 필드만 골라 반환한다. 프로필의 `model`은 정확한 selector 또는 null이며, `PATCH /api/profiles/:id`로 저장한다. `model`이 null(기본)이면 설명 대상 세션의 모델을 쓴다: `session-model.mjs`가 정규화 전사의 마지막 `(모델: X)` 표식을 카탈로그의 정확한 모델 하나로 바꾸고(omp는 `공급자/id`, Claude와 Codex는 id만 적으므로 같은 id가 여러 공급자에 있으면 세션 호스트의 공급자가 하나로 가려질 때만 고름), 못 찾으면 omp 기본 모델로 간다. `GET /api/session-model?id=`가 이 결과를 `{raw, model}`로 보여 준다. 새 설명 요청은 시작 시 모델을 고정하고 분류·설명 모두 같은 provider/model로 호출한다. 프로필에서 명시적으로 고른 모델의 실행 실패는 다른 모델로 대체하지 않는다. `answer.model`은 요청 당시 선택값이고 `answer.modelSource`는 `profile`, `session`, `default`(omp 기본 모델) 중 하나이며 실제 과금·호스트 내부 실행 계측값은 아니다. 프로필의 `modelScope`는 모델 선택 목록을 좁히는 selector 목록 또는 null(전체)이고 설명에 쓰이는 모델은 바꾸지 않는다. 가격은 USD/백만 토큰 참고값으로 입력·출력을 나눠 표시한다. 완료 요청 재전송은 이후 모델 설정이나 카탈로그가 바뀌어도 기존 답과 모델 선택을 유지한다 (ADR 0016·0069).

## 라이브 흐름 (ADR 0006)

1. 세션을 고르면 페이지가 `GET /api/live?id=&profileId=` SSE 를 연다. 서버는 세션마다 감시기 하나를 두고 화면 구독과 미리 설명이 함께 쓴다. `profileId` 없는 구독(다른 컴퓨터의 docent)은 미리 설명을 예약하지 않는다.
2. `live.mjs` 가 먼저 파일 꼬리 512KB 에서 최근 이벤트 5개를 `past: true` 로 보내고(ADR 0012), 그 뒤 파일 끝에서 시작해 1초마다 새로 끝난 줄을 읽어(`session-file.mjs`) 호스트 adapter 의 `events` 로 이벤트를 뽑는다. 카드 이벤트에는 서버가 만든 `focus`·`thread`와 미리 설명 상태(`ask`·`autoState`)가 붙는다.
3. 구조화된 질문은 바로 선별한다. 어시스턴트 발화는 Jev로 질문·결과·계획인지 판정한다. 진행 중계·도구 오류·종료 신호 자체는 카드로 보내지 않는다. 판정기가 없거나 실패하면 구조화 질문만 남기고 제한을 알린다.
4. 작업 내용 카드는 한 줄 요약 제목, 3문장 이내 요약, 상태로 이루어지고 원문은 접어 둔다. 요약은 준비된 설명의 결론과 핵심 설명 앞부분에서 만든다. 카드를 누르면 그 카드의 스레드가 열리고, 첫 메시지로 사건 원문(AI 출력 내용과 선택지)이 전체 너비로 보인다(ADR 0033). 카드에는 원문 아코디언이 없다. 모델 호출은 없다. 새 사건은 질문 대상·입력·읽던 위치를 바꾸지 않는다. 설명 생성과 근거 검증은 수동 질문과 같은 `/api/ask` 경로다.
5. `/api/ask`는 의미 분류의 질문 종류·개념·이해 대상·분야와 답·검증된 근거·용어·바로잡기를 현재 프로필에 저장한다. 미리 설명은 수동 반복 횟수나 이해 상태를 바꾸지 않는다. `GET /api/history?id=&profileId=`로 해당 로컬 프로필의 이전 문답을 읽는다(`thread`·`display` 포함).

## 배운 내용 다시보기 (ADR 0008·0017)

왼쪽 상단 책 아이콘 "배운 내용 다시보기"는 단어 중심 용어 사전이다 (ADR 0020). `GET /api/wiki?profileId=`가 문답마다 저장한 핵심 단어(`keywords`)를 모아 단어·한 줄 뜻·등장 횟수·관련 대화(답의 결론 한 줄)·첫 코드 블록을 돌려준다. 새 문답의 단어는 학습 분류 호출이 함께 뽑으므로 모델 호출이 늘지 않는다. 단어가 없는 옛 문답은 사용자가 "용어 정리"를 누를 때 `POST /api/wiki/extract`로 최대 30개를 모델 호출 한 번에 정리한다. 옛 `questions.jsonl` 줄의 단어는 원본을 고치지 않고 `learning.json`의 `legacyKeywords`에 둔다. 개념별 이해 상태는 설명 전략을 고르는 내부 기억이며 화면에 편집 UI를 두지 않는다(ADR 0021). `GET /api/learning`, `PATCH /api/learning/:id`는 API로만 남아 있다. 자주 묻는 질문 순위와 질문 종류 통계는 없앴다.

## 미리 설명 (ADR 0031)

프로필이 세션을 열면 서버가 12시간 동안 그 세션을 지켜보고, 탭을 닫아도 선별된 새 질문·결과·계획을 EASY로 미리 설명한다. requestId는 프로필·세션·스레드로 정해져 브라우저가 같은 요청으로 붙거나 저장된 답을 받는다. 켜기/끄기는 프로필 `autoExplain`(새 설치와 새 프로필은 끔, 필드 없는 옛 프로필은 켬, ADR 0063), 상태는 `GET /api/prefetch`. 프로필마다 한 번에 하나, 10분에 5개까지이며, 사용자 질문이 진행 중이거나 막 끝났으면 기다린다. 미리 설명이 도는 스레드에 사용자가 물으면 그 질문은 미리 설명이 끝난 뒤 같은 대화에서 이어진다(ADR 0050). 과거 재생은 미리 설명하지 않는다. 미리 설명도 스레드 대화에 보이므로 이어 묻기 맥락에 들어간다.

## 속도 (ADR 0028·0030)

모든 omp 호출은 `runner.mjs`가 기억(recall·retain)·확장·스킬·규칙·LSP 탐색을 끄고 thinking을 명시해 실행한다(EASY·NORMAL=low, HARD=medium, 분류·용어 추출=off). 학습 분류는 설명이 끝난 뒤 돈다. 정규화 전사와 근거 표식은 파일 크기·수정 시각(Claude Code는 서브에이전트 파일 포함) 기준으로 캐시한다. 스레드 대화는 전사를 한 번만 보내고 이후에는 새 기록만 보낸다. 동시에 열린 대화는 최대 4개, 유휴 10분 뒤 닫는다.

## 다른 컴퓨터 (ADR 0011)

`~/.docent/config.json`의 `peers`마다 제공자가 붙는다. 원격 세션 ID는 `@이름/원래id`. 목록·전사·라이브를 원격에서 읽고 답변은 내 omp로 만든다. ADR 0014부터 원격 문답은 자동으로 합치지 않는다. 같은 프로필 ID가 같은 사람이라는 보장이 없기 때문이다. `--host tailscale`은 테일스케일 IPv4에도 열며 loopback은 유지한다. 같은 대기는 설정창 "다른 기기에서 열기"(`GET/POST /api/host`)로 실행 중에도 켜고 끌 수 있고, 상태는 config.json의 `tailscale`에 저장한다 (ADR 0034).

## 개인화 저장과 PiP (ADR 0014)

`learning.json`의 문답 레코드가 답과 근거의 정본이다. 개념별 설명 이력과 완료 요청은 recordId를 참조한다. 임시 파일+fsync+rename으로 저장하며, 같은 폴더는 한 서버만 수정한다. 기존 `questions.jsonl`은 기본 프로필의 역사로만 읽는다. 프로필은 인증이 아닌 개인화 선택이다.

지원되는 보안 컨텍스트에서 Document PiP 창을 연다. 작은 창은 본문의 미니 버전이다: 작업 내용 카드 목록과 선택한 카드의 대화·입력창만 보이고 비중은 약 35:65다(좁으면 위/아래, 720px 이상이면 좌/우, ADR 0026). 본문과 같은 초안·스레드·답변 상태·요청 경로를 공유하고 별도 SSE나 모델 호출은 만들지 않는다. 원문 보기와 배운 내용 다시보기는 본문에서 연다. 부모 페이지가 닫히면 함께 닫히고, 미지원 브라우저에서는 사유만 안내한다. 투명도나 일반 팝업 대체는 없다.

## 표시와 빌드 (ADR 0015)

Streamdown·React는 Markdown 표시를 담당하며 나머지 페이지 상태는 기존 흐름을 유지한다. 설명·복습·PiP에 같은 렌더링 원칙을 적용한다. 표·목록·코드 블록은 슬롯 내부에서 구조를 보존한다. 긴 설명은 접거나 크게 열고, 근거 원문은 설명과 구별한다. 임의 HTML·실행 링크·추적 이미지를 차단한다.

`npm run build`로 로컬 자산을 만들고 `npm pack`의 prepack에서도 빌드한다. 서버는 정해진 자산 경로만 제공한다. 릴리스 패키지에 자산을 넣으므로 사용자 실행 시 빌드 도구나 CDN 접속이 필요하지 않다.

## 코어를 고칠 때

`prompt/docent.md` 만 고친다. 웹앱은 매 요청 파일을 읽으므로 재시작 불필요. 서브에이전트 경로는 `docent install-omp` 재실행.
