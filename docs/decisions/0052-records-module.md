# 0052 — 문답과 요청 기록은 store.mjs 한 module이 맡고, 모든 입구에서 프로필을 확인한다

Date: 2026-10-12
Status: Accepted. 구조 점검 후보 6. ADR 0014의 프로필 분리와 ADR 0029의 요청 재전송 규칙은 그대로다.

## Context

1. 문답을 쓰는 쪽(`beginRequest`, `settleRequest`, `completeAnswer`)은 `learning.mjs`, 읽는 쪽(`history`, 즐겨찾기, 핵심 단어 저장)은 `store.mjs`에 있었다.
2. 프로필 확인이 세 방식이었다. 학습 함수는 안에서 확인했고, `history`와 즐겨찾기는 확인하지 않았으며, HTTP 경로마다 `await profile(profileId)`를 먼저 불러야 했다. 빠뜨리면 없는 프로필에 빈 목록을 돌려주거나 기록을 썼다.
3. 요청 키 형식(`프로필:requestId`)을 서버가 손으로 한 번 더 썼다. 스레드 식별자는 저장 파일 module에 있었고 `dialogue.mjs`가 다시 내보냈다. 문답 식별자(`rowKey`)는 용어 사전 module에서 가져왔다. 화면 오류(`httpError`)는 학습 module에 있었다.

## Decision

1. `store.mjs`가 문답·요청 기록 module이다. 한 프로필의 문답과 설명 요청 상태를 읽고 쓰는 모든 입구(`history`, `saveKeywords`, `favorites`, `setFavorite`, `storedRequest`, `beginRequest`, `settleRequest`, `completeAnswer`)가 프로필을 확인한다. 없으면 404다.
2. 요청은 (프로필, requestId)로 연다. 요청 키는 `requestKey` 하나로만 만든다. 진행 중 작업 목록과 저장된 요청이 같은 함수를 쓴다. `beginRequest`가 돌려준 요청 손잡이로 실패·중단·완료를 기록한다.
3. 문답 식별자(`rowKey`)와 프로필 확인(`profileFrom`)도 여기에 둔다. `learning.mjs`는 프로필 설정, 기억 후보, 학습 분류 해석과 기억 갱신만 맡고, 갱신은 이 module의 원자적 저장 안에서 한다.
4. 스레드 식별자(`threadKey`, `threadText`)는 저장이 아니라 대화 개념이라 `app/thread.mjs`로 옮긴다.
5. HTTP 경로는 프로필 확인을 따로 하지 않는다.

## Consequences

- 새 경로가 프로필 확인을 빠뜨려도 기록 module이 막는다. 응답 코드는 그대로다(없는 프로필 404).
- 오류가 둘이면(없는 프로필과 잘못된 근거 ID) 이제 400이 먼저 나올 수 있다.
- 읽을 때마다 `learning.json` 전체를 다시 읽는 비용은 이번에 줄이지 않았다.
- 영향 범위: `app/store.mjs`, `app/learning.mjs`, `app/thread.mjs`(신규), `app/dialogue.mjs`, `app/wiki.mjs`, `app/ask.mjs`, `app/server.mjs`, `tests/records.test.mjs`, `tests/learning.test.mjs`, `tests/dialogue.test.mjs`.
