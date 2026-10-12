# 0054 — 호스트마다 세션 adapter 하나, 세션 파일 읽기는 session-file.mjs 한 곳

Date: 2026-10-12
Status: Accepted. 구조 점검 후보 6. ADR 0012(재생), 0013(서브에이전트 접기), 0032(호스트 추가)의 동작은 그대로다.

## Context

1. 다섯 호스트 파일이 같은 jsonl 줄 읽기(`parse*Lines`, `// 잘린 줄 무시`)를 따로 가졌다. 서버와 `live.mjs`는 `events(parse(...))` 순서를 알아야 했고, pi는 줄을 읽을 때 한 번, 이벤트를 뽑을 때 또 한 번 엔트리 모양을 바꿨다.
2. 호스트 규칙이 서버의 providers 표에 흩어져 있었다. Claude의 "사용자 발화 없는 세션 숨김"은 서버 쪽 감싸기였고, Gemini 작업 폴더 대신 쓰는 `.project_root` 읽기는 메타와 전사에 두 번 적혀 있었으며, Claude 서브에이전트는 서버가 세 함수를 이어 붙였다.
3. 파일 꼬리를 읽고 잘린 첫 줄을 버리는 코드가 서버(`readTail`)와 `live.mjs`(재생)에 따로 있었고, 이어 읽기(offset, 끝나지 않은 줄)는 `live.mjs` 안에 있었다.
4. 학습 범위(`sourceScope`)는 전사 머리말 `- 작업 폴더: …` 줄에서 작업 폴더를 읽는다. 작업 폴더를 모르는 세션은 머리말에 `?`가 적히는데 이것을 폴더 이름으로 읽어 `project:local:?` 범위를 만들었다. 서로 관계없는 세션들의 학습 기억이 한 범위로 묶였다(재현: `tests/transcript-scope.test.mjs`, 고치기 전 `project:local:?`).

## Decision

1. 호스트마다 adapter 하나(`scripts/transcript-<호스트>.mjs`)가 interface `{id, dir, depth, match, headBytes, meta(head, path), transcript(text, path), events(chunk), stamp?(path)}`를 낸다. 줄 해석, 호스트 정규화, 목록에서 숨길지와 제목 규칙, 작업 폴더 찾기는 adapter 안에 있다. 경로가 필요한 adapter만 경로를 쓴다(Gemini `.project_root`, Claude 서브에이전트와 그 변경 표시).
2. pi는 omp 모양 adapter(`ompShapedAdapter`)에 "줄을 omp 모양으로 바꾸기"와 "사용자 발화 없으면 숨김"을 넘겨 만든다. 바꾸기는 줄을 읽을 때 한 번만 한다.
3. 공용 jsonl 줄 읽기, 전사 머리말 쓰기·작업 폴더 읽기, CLI는 `scripts/transcript-jsonl.mjs` 한 곳이다. 맥 앱 묶음은 `scripts/transcript-*` 를 복사하므로 이 이름을 쓴다.
4. `app/session-file.mjs`가 세션 파일 바이트 읽기를 맡는다: 머리, 잘린 첫 줄을 버린 꼬리, 넓혀 가며 읽는 꼬리(`pickFromTail`), 이어 읽기(`followFile`: 끝나지 않은 줄 보관, 기준점보다 작아진 파일은 처음부터). 서버의 `jsonlProvider`(목록, 최근 작업, 전사)와 `live.mjs`(재생, 새 줄)가 이것을 쓴다.
5. 학습 범위의 작업 폴더는 머리말을 쓰는 쪽과 같은 module(`transcriptCwd`)이 읽고, 모르는 값(`?`)은 null로 읽는다. 작업 폴더가 없으면 프로젝트 범위도 없다. 모델이 읽는 머리말 줄은 그대로 남긴다. 구조화 메타 대신 머리말을 읽는 까닭: 원격 docent 세션은 전사 글만 오므로 같은 규칙 하나로 로컬과 원격을 함께 다룬다.
6. `providers` 배열 모양(`id`, `root`, `events`, `list`, `pathOf`, `recent`, `transcript`)은 유지한다. 세션 목록·찾기 경로는 이번에 바꾸지 않는다.

## Consequences

- 한 호스트의 세션 파일을 이해하려면 그 adapter 파일만 읽으면 된다. 새 호스트는 adapter 모듈 하나와 providers 배열 한 줄이다.
- `/api/sessions`, 전사 markdown, 라이브 이벤트는 기존 fixture와 실제 세션 표본(omp 40, codex 40, claude 4, gemini 1개)에서 옛 함수 조합과 같다.
- 작업 폴더를 모르는 세션은 이제 학습 기억을 다른 세션과 나누지 않는다. 이미 `project:local:?`로 저장된 옛 기억 항목은 옮기지 않는다(그 범위로 다시 묶이는 새 세션이 없어 자연히 쓰이지 않는다).
- JSON 객체가 아닌 줄(`null`, 숫자)은 이제 잘린 줄처럼 건너뛴다. 전에는 목록이나 전사가 오류로 멈췄다.
- Gemini CLI(`scripts/transcript-gemini.mjs <파일>`)도 서버처럼 `.project_root`의 작업 폴더를 머리말에 적는다.
- 남은 일: 재생이 파일 끝을 기준점으로 잡을 때 쓰는 중인 마지막 줄은 다음 읽기에서 앞부분 없이 오므로 그 한 줄은 놓친다(기존 동작, 이번에 바꾸지 않음).
- 영향 범위: `scripts/transcript-{omp,claude,codex,gemini,pi}.mjs`, `scripts/transcript-jsonl.mjs`(신규), `app/session-file.mjs`(신규), `app/live.mjs`, `app/server.mjs`(providers), `app/learning.mjs`(`sourceScope`), `tests/transcript-*.test.mjs`, `tests/session-file.test.mjs`(신규), `tests/session-fixture.mjs`(신규), `tests/live.test.mjs`, `tests/transcript.test.mjs`, `tests/evidence.test.mjs`.
