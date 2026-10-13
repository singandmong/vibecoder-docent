# 기여 안내

바이브코더 도슨트에 고칠 점이나 아이디어가 있으면 이슈와 PR로 알려 주면 된다. 이 문서는 개발을 시작하는 데 필요한 것만 적는다.

## 준비물

- Node.js 22 이상 (`engines.node`가 `>=22`)
- 설치·로그인된 omp — 도슨트는 답을 만들 때 이 컴퓨터의 omp를 headless로 부른다. 없으면 실행되지 않는다.
- (선택) Claude Code 세션을 함께 읽으려면 `~/.claude/projects`에 세션이 있으면 된다. 별도 설치 없음.
- (선택) Jev 판정을 쓰려면 환경변수 `TYPESAFE_API_KEY`. 없으면 구조화 질문만 라이브 카드로 뜨고 나머지 기능은 그대로 돈다.

## 개발 시작

```sh
npm ci            # package-lock.json 기준 설치
npm run build     # app/assets/ 프런트엔드 자산 생성 (커밋 대상)
npm start         # = node app/server.mjs → http://127.0.0.1:4747
node --test tests/*.test.mjs   # 2초 안에 끝나는 회귀 검사
npm run check:design          # 화면을 고쳤을 때: 실제 Chrome에서 글자, 여백, 정렬 규칙 검사
```

`app/assets/`는 커밋한다. 실행 중 CDN을 쓰지 않기 때문이고(ADR 0015), CI가 빌드 결과를 다시 만들어 커밋된 것과 같은지 본다. `app/assets/docent-markdown.js`를 손으로 고치지 말고 `app/markdown.jsx`를 고친 뒤 `npm run build`를 돌린다.

개발 중에는 저장 폴더와 포트를 갈라 쓴다. 실제 `~/.docent`를 건드리지 않는다.

```sh
DOCENT_HOME=/tmp/docent-dev DOCENT_PORT=4803 DOCENT_PEERS= npm start
```

자주 쓰는 환경변수: `DOCENT_HOME`, `DOCENT_PORT`, `DOCENT_HOST`, `DOCENT_PEERS`, `OMP_BIN`.

## 구조 규칙

- **코어 프롬프트는 `prompt/docent.md` 하나.** 호스트·도구·파일 경로 이름을 쓰지 않는다. 코어가 아는 것은 "과제 지시문에 전사 위치와 질문이 있다"뿐이다.
- **어댑터는 얇은 껍데기.** `adapters/<host>/`에는 프론트매터와 설치 방법만 두고(예: `adapters/omp/`), 프롬프트 본문을 복사하지 않는다. 코어는 `docent install-omp`(`app/install-omp.mjs`)가 붙여서 설치한다.
- **런타임 코드 위치는 `bin/`, `app/`, `scripts/`.** 설명 표시에는 Streamdown·React와 로컬 자산을 쓰고, 정적 자산은 패키지에 넣는다.
- **도슨트는 설명 전용.** 코드 수정·명령 실행·커밋 경로를 새로 만들지 않는다. 모델 도구 제한도 읽기 전용으로 유지한다.
- **결정은 `docs/decisions/NNNN-*.md`에 남긴다.** 이미 있는 ADR의 결론을 문서 안에서 조용히 뒤집지 않는다. 뒤집어야 하면 새 ADR을 쓴다.
- **문서는 한국어 평서체**("~다")로 쓴다. README처럼 사용자에게 읽히는 안내만 쉬운 문장을 쓴다.
- **`AGENTS.md`는 300줄 미만 유지.** 자세한 규칙은 `docs/`로 뺀다.
- **비밀값과 실제 세션 기록을 커밋하지 않는다.** `.env*`, `data/`, `evals/transcripts/`는 무시 대상이다. 스크린샷·문서 예시는 가짜 데이터로 만든다.
- **변경은 `CHANGELOG.md`에 적는다.** [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식이고 0.x 동안은 minor가 새 기능, patch가 고침이다. 버전 올리기와 태그는 관리자가 한다.

## 테스트

- `node --test tests/*.test.mjs` — 근거 표시·학습 기억·슬롯 파싱·용어집 같은 결정적 로직을 검사한다. 빠르므로 PR 전에 돌린다.
- 이 테스트는 **실제 모델 호출과 브라우저 동작을 검증하지 않는다.** 의미 분류·난이도·재설명은 실제 omp로, 작은 창(PiP)은 실제 브라우저로 확인해야 한다. 어떤 검증을 했는지 PR에 적는다.
- 버그를 고칠 때는 재현이 먼저다. 같은 버그가 다시 나면 실패하는 테스트가 정말 남길 가치가 있는지 따져 보고, 아니면 일회성 스크립트로 확인한다.
- `npm run check:design` — 화면(CSS, 레이아웃, 여백)을 고쳤을 때 돌린다. 실제 Chrome을 띄워 표본 답과 입력창을 그리고 글자 크기, 굵기, 여백, 정렬 16개 규칙을 잰다. 규칙 목록, 측정 표본, 함정은 `docs/design-check.md`에 있다. `TYPESAFE_API_KEY`가 있으면 같은 기준을 Jev로도 판정하고, 수치와 Jev 둘 다 통과해야 성공이다. Chrome 경로는 `CHROME_BIN`으로 바꿀 수 있다. 기준을 바꾸려면 `docs/design-check.md`와 `scripts/check-design.mjs`의 규칙 표를 함께 고치고 이유를 CHANGELOG에 적는다.
- 포매터·린터 전체 실행은 하지 않는다. 주변 코드 스타일(들여쓰기 탭, 문자열은 겹따옴표·백틱)을 따른다.

## 라이선스

이 저장소는 MIT 라이선스다(`LICENSE`). 기여한 코드도 같은 조건으로 들어온다. 패키지에 포함된 Pretendard 글꼴은 SIL OFL 1.1이며 라이선스 전문을 `app/assets/Pretendard-LICENSE.txt`에 함께 넣는다.

## PR 전 확인 목록

- [ ] `node --test tests/*.test.mjs` 통과
- [ ] 프런트엔드를 고쳤으면 `npm run build` 후 `app/assets/` 변경분 포함
- [ ] 화면을 고쳤으면 `npm run check:design` 통과 (가능하면 `TYPESAFE_API_KEY`로 Jev 판정까지)
- [ ] 서버를 띄워 고친 경로를 실제로 한 번 써 봤다(수동 확인 내용을 적는다)
- [ ] `prompt/docent.md`나 `adapters/omp/`를 고쳤으면 `docent install-omp` 재실행 안내도 함께
- [ ] `CHANGELOG.md`에 한 줄 추가
- [ ] 결정이 바뀌었으면 `docs/decisions/`에 새 ADR, 아니면 필요 없다고 판단한 이유
- [ ] 비밀값·개인 경로·실제 전사가 들어가지 않았다
- [ ] 커밋 메시지는 `feat:`, `fix:`, `docs:` 접두어를 쓰고 한 가지 일만 담는다
