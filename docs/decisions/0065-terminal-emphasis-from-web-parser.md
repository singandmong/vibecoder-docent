# 0065 — 터미널의 한글 옆 강조는 웹과 같은 파서가 정한 구간에 U+FEFF를 끼워 맞춘다

Date: 2026-10-14
Status: Accepted. ADR 0061의 결정 2(터미널은 한 줄 단위 규칙으로 `*` 짝을 맞춘다)와 결정 3의 "터미널에는 새 의존성을 더하지 않는다"를 바꾼다. ADR 0061의 웹 쪽 결정과 U+FEFF를 끼워 pi-tui를 속이는 방법 자체는 그대로다.

## Context

1. 0.24.0의 `cjkFriendlyEmphasis`는 `*` 묶음의 짝을 줄마다 스스로 세어 맞췄다. 웹(remark + `@streamdown/cjk`)과 같은 규칙을 손으로 다시 구현한 것이라 어긋날 틈이 있었다. ADR 0061도 길이가 다른 묶음(`***`)이 뒤섞이거나 여러 줄에 걸친 코드 범위 안에 `*`가 있으면 짝을 잘못 볼 수 있다고 적었다.
2. `~~취소~~`는 아예 다루지 않았다.
3. 웹은 파서가 이미 정확하다. 문제는 터미널이 같은 답을 얻는 방법이다. pi-tui의 `marked`는 확장을 꽂을 수 없지만, `Markdown`의 `transform(text)`로 원문을 바꾸는 통로는 열려 있다.
4. 파서 패키지(`unified`, `remark-parse`, `remark-gfm`, `@streamdown/cjk`)는 devDependency다. 터미널은 npm 패키지의 실행 경로이므로 설치본에 그대로 쓸 수 없다. 웹은 이미 esbuild로 미리 묶은 `app/assets/docent-markdown.js`를 배포한다.

## Decision

1. **구간은 웹 파서가 정한다.** `app/terminal-cjk-src.mjs`가 `remark-parse`, Streamdown 기본값과 같은 `remark-gfm`, `@streamdown/cjk`를 `app/markdown-remark.mjs`와 같은 순서로 꽂아 원문을 파싱한다. `strong`, `emphasis`, `delete` 노드마다 여는 구분 기호 범위 `[노드 시작, 첫 자식 시작)`과 닫는 범위 `[마지막 자식 끝, 노드 끝)`을 `position.offset`에서 얻는다. 이어 붙은 범위는 한 묶음으로 합친다(`***`는 노드 둘의 범위가 이어진 것이다).
2. **끼우는 조건은 CommonMark가 거절하는 경우 하나다.** 묶음의 안쪽 이웃 글자가 구두점이나 기호이고, 바깥쪽 이웃이 공백도 구두점도 아닐 때만 묶음의 바깥쪽에 U+FEFF를 하나 끼운다. 여는 묶음은 바로 앞, 닫는 묶음은 바로 뒤다. 문장 처음과 끝은 공백으로 본다. 오프셋이 어긋나지 않게 뒤에서부터 끼운다.
3. **코드는 건드리지 않는다.** 파서가 코드 범위와 코드 블록을 강조로 읽지 않으므로 여러 줄 코드 범위 안의 `*`도 자연히 제외된다. 줄 단위 코드 범위 계산은 없앴다.
4. **파서는 `app/assets/terminal-cjk.js`로 미리 묶어 배포한다.** `app/build.mjs`가 `app/terminal-cjk-src.mjs`를 esbuild(ESM, node, minify, 법적 고지 주석 없음)로 묶는다. 출력은 결정적이라 CI의 `git diff --exit-code -- app/assets`를 통과한다. 원본 `.mjs`는 설치본에서 빼므로 `package.json`의 `files`에 `!app/terminal-cjk-src.mjs`를 더했다. 묶인 패키지는 웹 번들에 이미 들어 있어 `THIRD_PARTY_NOTICES.md`는 그대로다. `app/terminal-markdown.mjs`가 번들을 가져와 `cjkFriendlyEmphasis`로 다시 내보낸다.
5. **웹과 어긋나지 않는지 시험이 지킨다.** `tests/terminal-markdown.test.mjs`의 대조 시험이 까다로운 문장 목록에서 터미널 렌더의 굵게, 기울임, 취소선 글자와 웹 파이프라인 mdast 노드의 글자가 같은지 본다.

## Consequences

- `***"굵게 기울임"***을`, `**"a"** 및 *"b"*를`, `~~"취소"~~는`, 여러 줄 코드 범위 뒤의 강조가 웹과 같게 나온다. 줄 경계를 넘는 강조도 파서가 본 대로다.
- 터미널 번들이 새로 생긴다(약 166KB, 압축 전). 웹 번들(약 775KB)과 패키지가 겹치지만 설치 의존성은 늘지 않는다. 터미널 모듈을 처음 불러올 때 파서 초기화 비용이 든다.
- 원문 길이만큼 파싱을 한 번 더 한다. `*`, `_`, `~`가 없는 글은 파싱하지 않고 그대로 돌려준다.
- `_`, `~~` 구분 기호도 같은 규칙으로 보정된다. 다만 pi-tui가 `~~`와 `_`를 얼마나 엄격하게 읽는지는 pi-tui 몫이고, 시험은 `~~"취소"~~는`까지 확인한다.
- 렌더 뒤 U+FEFF를 모두 지우는 `sanitizeRenderedLine`은 그대로여서 사용자가 쓴 U+FEFF도 함께 지워진다.
- 영향 범위: `app/terminal-cjk-src.mjs`(신규), `app/assets/terminal-cjk.js`(신규), `app/terminal-markdown.mjs`, `app/build.mjs`, `package.json`(`files`), `tests/terminal-markdown.test.mjs`, `docs/architecture.md`, `CHANGELOG.md`.
