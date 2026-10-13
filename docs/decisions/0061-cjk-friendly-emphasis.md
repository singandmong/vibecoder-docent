# 0061 — 한글 옆의 `**강조**`는 웹에서 `@streamdown/cjk`, 터미널에서 U+FEFF 끼우기로 읽는다

Date: 2026-10-14
Status: Accepted. 웹 화면(ADR 0015의 Streamdown)과 터미널 Markdown(ADR 0038의 pi-tui 렌더)에서 Markdown 해석 규칙을 하나 더한다. 지난 ADR의 다른 결정은 그대로다.

## Context

1. **`**\`안녕하세요\`**를`이 굵게 나오지 않고 별표가 그대로 보였다.** CommonMark는 닫는 `**`가 오른쪽에 붙은(right-flanking) 것으로 인정받으려면 앞이 구두점일 때 뒤가 공백이나 구두점이어야 한다고 정한다. 닫는 `**` 앞은 구두점(코드 범위의 백틱)이고 뒤는 한글이므로 닫는 표시가 되지 못한다. 한글은 공백으로 띄우지 않고 조사를 바로 붙이므로 이 규칙에 자주 걸린다.
2. 같은 이유로 `**"문장"**을`, `**(괄호)**는`, `**안녕.**하세요`가 모두 실패했다. 여는 쪽도 뒤집혀서 `한글**"문장"**을`처럼 한글 뒤에서 구두점이 바로 이어지면 여는 표시가 되지 못했다. CommonMark 이슈 #650으로 알려진 문제이고 규칙을 바꾸는 쪽은 열려 있다.
3. 웹은 Streamdown(remark, micromark), 터미널은 pi-tui가 내부에 가진 `marked`를 쓴다. 두 파서는 별개라 한 곳을 고쳐도 다른 쪽은 그대로다.
4. pi-tui는 `marked` 인스턴스를 모듈 안에 숨겨 두어 확장(`marked-cjk-friendly` 등)을 꽂을 수 없다. 파서를 건드리지 않고 쓸 수 있는 통로는 `Markdown`의 `options.transform(text, width)`(파싱 직전에 원문을 바꿔 돌려주는 함수)뿐이다.

## Decision

1. **웹은 `@streamdown/cjk@1.0.4`(devDependency, 번들에 포함)를 쓴다.** Streamdown 공식 플러그인이고 `remark-cjk-friendly`(micromark 확장), `remark-cjk-friendly-gfm-strikethrough`(`~~` 취소선), GFM 자동 링크 경계 보정을 한꺼번에 가져온다. 플러그인 간 순서는 Streamdown이 `plugins={{ cjk }}`로 쓰는 것과 같다. 앞 플러그인은 `remark-gfm`보다 먼저, 뒤 플러그인은 그 다음에 둔다. 도슨트는 `remarkPlugins`를 직접 넘기므로 같은 순서를 `app/markdown-remark.mjs`의 `docentRemarkPlugins(extra)`가 만든다. 용어 링크 플러그인(`docentProse`)은 맨 뒤다. peer 요구는 `unified ^11`(설치본 11.0.5), micromark `^4`(4.0.2)로 이미 충족한다.
2. **터미널은 파서가 아니라 원문을 고친다.** `app/terminal-markdown.mjs`의 `cjkFriendlyEmphasis(source)`가 `Markdown`의 `transform`으로 들어가 `*` 묶음 중 한글 바로 옆에서 CommonMark가 틀리게 볼 것만 골라 U+FEFF를 하나 끼운다.
   - 구두점 뒤에 한글이 오는 `*` 묶음은 CommonMark가 여는 표시로만 본다. 기다리는 여는 표시(같은 길이)가 있으면 닫는 표시로 보고 묶음 뒤에 U+FEFF를 끼운다. 없으면 그대로 둔다.
   - 한글 뒤에 구두점이 오는 `*` 묶음은 닫는 표시로만 본다. 기다리는 여는 표시가 없으면 여는 표시로 보고 묶음 앞에 U+FEFF를 끼운다.
   - U+FEFF는 JS의 `\s`에 걸려 marked가 공백으로 읽고, 폭이 0이어서 줄바꿈 계산을 바꾸지 않는다. 렌더가 끝난 줄에서 `sanitizeRenderedLine`이 모두 지운다.
   - 코드 블록(``` 와 ~~~), 인라인 코드 범위, `\` 이스케이프는 글자 하나도 건드리지 않는다. 빈 줄과 코드 블록에서 기다리는 여는 표시 목록을 비운다.
   - 한글 바로 옆이 아닌 `*`는 그대로이므로 `a**b**c` 같은 ASCII 규칙은 바뀌지 않는다. `_`와 `~~`는 다루지 않는다(터미널에서 쓰임이 드물고, 취소선은 pi-tui가 따로 엄격하게 해석한다).
3. **터미널에는 새 의존성을 더하지 않는다.** `marked-cjk-friendly@0.1.2`는 `Marked` 인스턴스에 꽂는 확장이라 pi-tui의 숨은 인스턴스에는 쓸 수 없고, pi-tui 안쪽 `marked`를 가져와 `Tokenizer.prototype`을 고치는 방법은 설치 구조(hoist)에 따라 다른 사본이 잡힐 수 있어 쓰지 않는다. pi-tui가 확장 통로를 열면 이 전처리를 `marked-cjk-friendly`로 바꾼다.

## Consequences

- 시험 문장 `**\`안녕하세요\`**를`, `**"문장"**을`, `**(괄호)**는`, `**안녕.**하세요`, `한글**"문장"**을`가 웹 mdast에서 `strong`이 되고 터미널에서 굵게(SGR 1) 나온다. 고치기 전에는 웹이 `text`, 터미널이 별표 그대로였다.
- 웹 번들이 약 26KB 커진다(748,888 → 774,849바이트, 압축 전). 새로 번들에 들어간 패키지 10개를 `THIRD_PARTY_NOTICES.md` 표와 원문에 더했다. 배포본은 미리 만든 `app/assets/docent-markdown.js`를 쓰므로 설치 의존성은 늘지 않는다.
- Streamdown은 `~~` 취소선과 URL 경계(`https://…。다음 문장`)도 같이 보정한다. 도슨트 답에서 보이는 모양이 CommonMark 원래 규칙과 달라지는 곳은 한글, 한자, 가나 바로 옆뿐이다.
- 터미널 전처리는 한글 옆 `*` 묶음의 짝을 한 줄 단위 규칙으로 맞춘다. 길이가 다른 묶음(`***`)이 뒤섞이거나 여러 줄에 걸친 코드 범위 안의 `*`는 짝을 잘못 볼 수 있다. 이때 생기는 손해는 U+FEFF가 한 번 더 들어가는 것인데 렌더 뒤에 지워지므로 굵게가 안 나오거나 하나 더 나오는 정도다.
- 렌더 결과에서 사용자가 쓴 U+FEFF(바이트 순서 표시)도 함께 지워진다. 눈에 보이지 않는 글자다.
- 영향 범위: `app/markdown.jsx`, `app/markdown-remark.mjs`(신규), `app/terminal-markdown.mjs`, `tests/markdown-remark.test.mjs`(신규), `tests/terminal-markdown.test.mjs`, `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `app/assets/docent-markdown.js`(재빌드).
