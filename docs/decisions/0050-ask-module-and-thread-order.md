# 0050 — 설명 요청을 한 module로 모으고, 같은 스레드의 설명은 서버가 순서대로 실행한다

Date: 2026-10-12
Status: Accepted. 구조 점검 후보 1. ADR 0029 §4 "같은 스레드의 질문은 순서대로 실행한다"를 서버에서 지킨다.

## Context

1. 설명 요청의 흐름(차례 → 요청 시작 저장 → 분야 판정 → 설명 → 근거 검증 → 저장 → 뒤에서 학습 분류)이 `server.mjs` 안의 `runAsk`, `classifyLater`, `openAsk`와 모듈 전역의 runner, 대화 묶음, 작업 목록, 미리 설명 게이트에 나뉘어 있었다. 이 흐름은 서버 프로세스를 가짜 omp로 띄워야만 시험할 수 있었다.
2. 같은 스레드의 질문 순서는 브라우저와 터미널의 대기 질문 목록만 지켰다. 미리 설명이 도는 카드 스레드에 사용자가 질문하거나, 두 화면(웹과 터미널, 탭 두 개)이 같은 스레드에 질문하면 두 번째 질문이 같은 RPC 대화에 들어가 `conversation is busy`로 실패했다. 그 실패를 처리하던 코드가 대화를 닫아 첫 설명의 프로세스도 끊고, 스레드의 대화 맥락을 잃었다. 재현 테스트에서 두 번째 질문은 상태 코드 없는 500으로 끝났다.
3. 미리 설명 게이트는 새 미리 설명이 사용자 질문 중에 시작하지 않게만 했다. 이미 도는 미리 설명은 기다리지 않았다.

## Decision

1. `app/ask.mjs`의 `createAsk({ runner, providerOf, prompts, notify })`가 설명 요청 module이다. interface는 `open`, `has`, `cancel`, `steer`, `list`, `waiting`, `close`다. 작업 목록, 스레드 대화 묶음, 사용자 질문 우선 게이트, 스레드 차례, 근거 표식 캐시를 안에 둔다. `server.mjs`는 HTTP 해석과 NDJSON·JSON 응답만 한다.
2. runner가 seam이다. 운영 adapter는 omp 프로세스(`runner.mjs`), 테스트 adapter는 각본대로 답하는 in-process runner다. 학습 기록은 `DOCENT_HOME` 임시 폴더로 대신한다.
3. 같은 (프로필, 세션, 스레드)의 설명 작업은 들어온 순서대로 하나씩 실행한다. 차례를 기다리는 작업은 `queued` 상태로 남는다. 사용자 질문은 이미 도는 미리 설명을 멈추지 않고 그 끝을 기다린다. 기다리는 중에 중단하면 요청 기록 없이 중단으로 끝나고 뒤 순서는 그대로 이어진다.
4. 차례는 게이트 → 스레드 순서로 받는다. 미리 설명은 사용자 질문이 없을 때만 스레드 차례에 들어가므로, 사용자 질문이 미리 설명의 게이트를 막고 미리 설명이 사용자 질문의 스레드 차례를 막는 교착이 생기지 않는다.
5. 미리 설명의 10분 5개 상한은 미리 설명 예약 규칙이라 `prefetch.mjs`에 남긴다. 예약 중복 확인은 `has`로 하므로 서버가 요청 키를 손으로 만들지 않는다.

## Consequences

- 같은 카드 스레드에서 미리 설명과 사용자 질문이 겹쳐도 둘 다 답하고, 한 RPC 대화의 맥락이 이어진다.
- 두 화면이 같은 스레드에 동시에 물으면 늦게 온 질문은 앞 설명이 끝날 때까지 `queued`로 보인다.
- 설명 요청 흐름을 프로세스 없이 시험한다(`tests/ask-module.test.mjs`). 프로세스 시험은 HTTP·NDJSON 형식과 실제 RPC 확인용으로 남는다.
- 다른 모델을 고른 같은 스레드 질문은 대화가 달라도 같은 차례를 따른다.
- 영향 범위: `app/ask.mjs`(신규), `app/server.mjs`, `app/prefetch.mjs`, `app/conversation.mjs`, `tests/ask-module.test.mjs`, `tests/ask.test.mjs`, `docs/architecture.md`.
