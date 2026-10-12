# 0056 — 세션 목록은 catalog.mjs 한 module이 맡고, 이 컴퓨터와 다른 컴퓨터의 제공자는 같은 interface를 낸다

Date: 2026-10-12
Status: Accepted. 구조 점검 후보 7. ADR 0011(원격 docent가 제공자), 0044(세션 파일 → 세션 id), 0045(목록에 붙이는 저장소·브랜치·최근 작업), 0054(호스트 adapter)의 동작을 한 seam 위에 둔다.

## Context

1. 세션 제공자가 두 모양이었다. 이 컴퓨터의 제공자(`jsonlProvider`)는 `{id, root, events, list, pathOf, recent, transcript}`, 다른 컴퓨터의 제공자(`peerProvider`)는 `{id, host, owns, list, transcript, live}`였다. 그래서 부르는 쪽이 필드를 보고 종류를 갈랐다: 제공자 찾기의 `p.owns ? … : id.startsWith(…)`, 라이브의 `p.live ? p.live(…) : watchSession(p.pathOf(…), p, …)`(hub와 `/api/live` 두 번), 목록 꾸미기의 `if (session.host) return session`와 `.recent?.(…)`, 찾기 경로의 `p.root && path.startsWith(…)`.
2. 세션 id와 파일 경로를 잇는 규칙이 세 곳에 있었다: 목록(`<제공자>:<상대 경로>`), `pathOf`, `/api/sessions/resolve`. 찾기 경로는 제공자 폴더 아래의 `.jsonl`인지만 보고 adapter의 `depth`·`match`를 보지 않았다. 그래서 목록이 보여 주지 않는 파일(Gemini 서브에이전트 파일 `chats/<부모>/…`, 이름이 `rollout-*`가 아닌 Codex 파일)도 세션 id를 받았고, `pathOf`도 `match`와 `depth`를 보지 않아 그 id로 전사가 열렸다. 재현: `tests/catalog.test.mjs` "a file path resolves only when the list would show that file"가 고치기 전 `Missing expected rejection: .gemini/tmp/demo/chats/parent/session-child.jsonl`로 실패. HEAD 서버도 같은 두 파일에 200과 id를 돌려줬다.
3. `/api/live`는 제공자만 먼저 찾고 응답 머리를 쓴 다음 경로를 검사했다. 잘못된 로컬 id(`claude:../x.txt`)는 머리를 쓴 뒤 400을 던져 서버 프로세스가 끝났다(HEAD 서버에서 확인). 2를 고쳐 `pathOf`가 엄격해지면 이 경우가 늘어난다(예: 고치기 전에 찾기 경로로 받은 Gemini 서브에이전트 id).
4. 문서가 어긋나 있었다. `app/peers.mjs` 머리 주석은 "원격 문답 역사는 가져오지 않는다", ADR 0011 §1과 Consequences는 "`/api/history`를 받아 와 합쳐 보인다"였다. 코드는 `/api/history`를 원격에 묻지 않고(`peers.mjs`에 그 호출이 없다), 서버의 `/api/history`는 선택한 프로필의 로컬 기록만 읽는다. ADR 0014가 Status와 "저장과 재전송"에서 원격 문답 자동 합치기를 이미 중단했다. 틀린 쪽은 ADR 0011의 그 문장이다.

## Decision

1. **제공자 interface는 하나다.** 두 종류가 모두 `{id, host, owns, check, list, describe, transcript, watch, idOf}`를 낸다.
   - `host`: 이 컴퓨터면 null, 아니면 다른 컴퓨터 이름. 학습 범위(`sourceScope`)가 이 값을 쓴다.
   - `owns(id)`: id 앞부분이 이 제공자인가. `check(id)`: 이 제공자가 가질 수 없는 모양이면 400을 바로 던진다.
   - `describe(sessions)`: 목록에 보일 세션에 저장소·브랜치·워크트리·최근 작업을 붙인다. 이 컴퓨터의 제공자는 자기 파일과 git 폴더로 붙이고, 다른 컴퓨터의 제공자는 그쪽 서버가 붙여 보낸 값을 그대로 둔다(여기 폴더로 다시 찾지 않는다).
   - `watch(id, send)`: 라이브 사건을 흘리고 stop을 돌려준다. 이 컴퓨터의 제공자는 `watchSession`을 스스로 부른다.
   - `idOf(path)`: 이 컴퓨터의 파일 경로가 이 제공자 목록의 세션이면 id. 다른 컴퓨터의 제공자는 늘 null이다.
2. **`app/catalog.mjs`가 세션 목록 module이다.** `localProviders(adapters, {home})`가 이 컴퓨터의 제공자들을 만들고(전사 캐시 8개와 작업 폴더별 git 위치 기억을 함께 쓴다), `sessionCatalog(providers)`가 그 위에서 다음을 맡는다.
   - `providerOf(id)`: 모르는 제공자는 400 `unknown provider`, 그 제공자가 가질 수 없는 id는 400 `bad session id`. 바로 던지므로 라이브 스트림을 열기 전에 부를 수 있다.
   - `list()`: 모든 제공자의 목록을 합쳐 최근 활동(`updated`) 순 200개로 자르고, 남은 세션을 그 세션의 제공자에게 꾸미게 한다.
   - `transcript(id)`, `watch(id, send)`: 제공자에게 넘긴다.
   - `resolve(path)`: 경로를 세션 id로 바꾼다. 어느 제공자도 받지 않으면 404(문구는 그대로).
3. **목록 자리 규칙은 하나다.** 제공자 폴더 아래 `depth` 단계 폴더 안에 있고 이름이 `match`와 맞는 파일만 세션 자리다. 목록 걷기, id → 경로(`pathOf`), 경로 → id(`idOf`)가 같은 규칙을 쓴다. 경로 → id는 여기에 더해 비어 있지 않은 보통 파일이어야 한다(목록과 같은 조건).
4. **서버는 조립과 위임만 한다.** `hub`의 `watch`는 `catalog.watch`, `createAsk`의 세션 출처는 `catalog.providerOf`, `/api/sessions`·`/api/sessions/resolve`·`/api/transcript`는 한 줄 위임이다. `/api/live`는 `catalog.providerOf(id)`로 id를 먼저 확인한 뒤 스트림을 연다. 원문 보기의 전사도 `catalog.transcript`로 읽는다.
5. **다른 컴퓨터 제공자의 HTTP는 넘겨받는 자리(`fetch`)다.** 서버는 기본 `fetch`를 쓰고, 시험은 메모리 안의 가짜를 넘겨 실제 `peerProvider`를 거친다.
6. **원격 문답은 가져오지 않는다(지금 동작 유지).** ADR 0011 §1의 "`/api/history`를 받아 와 합쳐 보인다"와 Consequences의 "`/api/history`가 합쳐 보이지만"은 ADR 0014 이후 사실이 아니다. 원격 docent에서 받는 것은 세션 목록, 전사, 라이브뿐이다. `peers.mjs` 머리 주석이 맞으므로 근거로 ADR 0014를 덧붙였다. ADR 0011 본문은 고치지 않는다.

## Consequences

- 부르는 쪽은 제공자 종류를 묻지 않는다. 새 종류의 제공자는 같은 interface 하나를 내면 된다. 이 컴퓨터의 새 호스트는 여전히 adapter 하나와 서버의 `localProviders` 배열 한 줄이다.
- `docent herdr`에 목록이 보여 주지 않는 세션 파일(Gemini 서브에이전트, 이름이 `rollout-*`가 아닌 Codex 파일)을 넘기면 이제 404이고, ADR 0044대로 작업 폴더의 최근 세션을 연다.
- 고치기 전에 찾기 경로로 받은 그런 id로 저장된 문답·즐겨찾기는 남아 있지만, 그 id로 전사·라이브를 열면 400이다.
- `/api/live`의 잘못된 id는 서버를 끝내지 않고 400 JSON으로 답한다(프로필이 있든 없든).
- 찾기 경로는 adapter의 숨김 규칙(예: 사용자 발화가 없는 Claude 세션)은 보지 않는다. 그 파일도 호스트 세션 자리에 있는 세션 파일이고, 숨김은 목록의 제목 규칙이라서다. 지금 동작 그대로다.
- 같은 gitdir의 HEAD는 제공자마다 한 번 읽는다(전에는 목록 한 번에 한 번). Claude와 Codex 세션이 같은 저장소면 HEAD 파일을 한 번 더 읽고 결과는 같다.
- `/api/sessions`, `/api/transcript`, 원격 제공자를 거친 목록·전사는 임시 HOME(Claude, Codex 세션)에서 HEAD 서버와 바이트까지 같다.
- 영향 범위: `app/catalog.mjs`(신규), `app/peers.mjs`, `app/server.mjs`, `tests/catalog.test.mjs`(신규), `docs/architecture.md`, `CONTEXT.md`.
