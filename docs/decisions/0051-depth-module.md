# 0051 — 설명 깊이 결정을 depth module 하나에 둔다

Date: 2026-10-12
Status: Accepted. 구조 점검 후보 7. ADR 0014의 깊이 규칙과 ADR 0028의 thinking 표는 그대로다.

## Context

"이번 설명을 얼마나 깊게, 왜"를 알려면 세 파일을 읽어야 했다. `depth.mjs`에는 thinking 표 하나만 있었다. 깊이 규칙(`resolveDifficulty`)과 분야 판정 프롬프트·해석은 `learning.mjs`에 있었다. 분야 판정을 부를지, 판정이 실패하면 어떻게 할지는 설명 요청 흐름 안에 한 줄씩 들어 있었고 시험이 없었다. 질문을 열 때는 고른 깊이를 검사하려고 결과를 버리는 `resolveDifficulty`를 불렀다.

## Decision

1. `depth.mjs`가 설명 깊이 module이다. interface는 `depthDecider({ runner, prompt })`가 돌려주는 `decide({ profile, override, question, focus, model, signal, onJudging })`와 열기 전 검사용 `checkOverride(override)`다. 결과는 `{ difficulty, difficultySource, thinking }`다.
2. 순서: 질문이 고른 깊이 > (분야별 깊이를 설정한 프로필만) 분야 판정 결과와 기본값 중 더 어려운 쪽 > 프로필 기본값.
3. 분야 판정 실패: 고른 모델이 있으면 다른 모델로 바꾸지 않고 실패한다. 기본 모델이면 분야 없이 프로필 기본값으로 설명한다. 중단은 중단이다. 기존 동작과 같다.
4. `DIFFICULTIES`, `DOMAINS`, `DOMAINS_PROMPT`도 여기에 둔다. 터미널 상태줄이 같은 파일의 thinking 표를 쓰므로 `depth.mjs`는 서버 저장소를 불러오지 않는다. 이를 위해 `httpError`를 `app/errors.mjs`로 옮겼다.

## Consequences

- 깊이 규칙과 실패 규칙을 runner 하나만 흉내 내어 시험한다(`tests/depth.test.mjs`).
- 저장된 답의 모양(`difficulty`, `difficultySource`)은 바뀌지 않는다. `thinking`은 저장하지 않는다.
- 영향 범위: `app/depth.mjs`, `app/errors.mjs`(신규), `app/learning.mjs`, `app/ask.mjs`, `app/server.mjs`, `app/runner.mjs`, `app/dialogue.mjs`, `tests/depth.test.mjs`, `tests/learning.test.mjs`.
