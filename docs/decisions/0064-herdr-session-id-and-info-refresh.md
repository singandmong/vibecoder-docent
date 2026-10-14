# 0064 — 세션 id만 알리는 Herdr 창도 작업 공간에 잇고, 세션 정보는 목록을 새로 받을 때 다시 그린다

Date: 2026-10-14
Status: Accepted. ADR 0060(Herdr 작업 공간 이름과 순서)을 넓힌다. 정렬 규칙과 캐시는 그대로다.

## Context

1. Herdr는 창의 에이전트가 연 세션을 `agent_session`으로 알린다. 종류는 둘이다. 세션 파일 경로(`kind: "path"`, omp와 Claude Code 훅의 `transcript_path`)와 세션 id(`kind: "id"`, 경로 없이 id만 넘기는 훅). 0.24.0은 경로만 받아서 id만 알린 창의 세션은 작업 공간 이름도 순서도 붙지 않았다.
2. 웹의 "세션 정보" 팝업은 세션을 고를 때 한 번만 그렸다. 목록은 15초마다 다시 받아 카드의 작업 공간 이름은 바뀌는데, 열어 둔 팝업은 그 세션을 다시 골라야 바뀌었다.

## Decision

1. **id 항목도 받는다.** `mapSessions`는 경로 항목을 절대 경로로, id 항목을 `id:<값>`으로 담는다. 세션 파일의 자리는 `herdrEntryFor(open, path)`가 찾는다. 경로가 먼저이고, 없으면 파일 이름(확장자 뺀)이 그 id와 같거나 `-<id>`, `_<id>`로 끝나는 id 항목이다. Claude Code `<id>.jsonl`, Codex `rollout-<시각>-<id>.jsonl`, omp `<시각>_<id>.jsonl`이 모두 이 모양이다. 8자보다 짧은 id는 여러 파일 이름 끝과 우연히 맞을 수 있어 받지 않는다.
2. **세션 정보는 목록을 새로 받을 때 다시 그린다.** 지금 세션의 새 목록 항목으로 팝업을 다시 만들고, 열려 있었으면 연 채로 둔다. 보이는 값(작업 폴더, 저장소, 기기, SSH 접속, Herdr 작업 공간, 시각, 첫 요청)이 같으면 그리지 않아 링크를 누르거나 글을 고르는 중에 화면이 바뀌지 않는다. 다른 세션을 고르면 닫힌 채로 새로 그린다.

## Consequences

- Herdr가 id만 알리는 에이전트의 세션도 목록 맨 위에 작업 공간 순서로 모이고 이름이 붙는다. 실제 Codex(0.153.4) 창에서 확인했다. Herdr는 `{"kind":"id","source":"herdr:codex"}`로 받았고, 운영 서버(0.25.0) 목록에서 그 `rollout-…-<id>.jsonl`에 작업 공간과 창이 붙었다. 파일 이름 모양은 `tests/herdr-workspaces.test.mjs`로 고정한다.
- Codex는 첫 질문을 보낸 뒤에야 세션을 알린다(SessionStart 훅의 `transcript_path`가 그때 생김). 그 전에는 목록에 Codex 세션 파일도 없다.
- Codex의 `shell_environment_policy.inherit = "core"`는 훅 환경에서 `HERDR_*`를 지워 Herdr 연동 훅이 아무것도 알리지 않는다. `inherit = "all"`과 `include_only`에 core 변수, `HERDR_*`, `set`의 변수 이름을 함께 두면 core와 같은 범위에 `HERDR_*`만 더해진다. 설정 파일을 바꾼 뒤에는 이미 떠 있는 `codex app-server`가 다시 시작해야 적용된다(같은 값을 `-c`로 넘긴 새 창에서는 바로 알렸다).
- Herdr에서 이름을 바꾸면 카드와 열린 세션 정보가 같은 새로고침(최대 15초와 Herdr 캐시 3초)에 바뀐다.
