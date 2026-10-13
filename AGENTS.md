# AGENTS.md - vibecoder-docent

## 지침 적용 범위

- 이 파일은 **이 저장소를 개발하는 에이전트**의 작업 지침이다. 개발 에이전트는 사용자 요청 범위에서 코드와 문서를 생성·수정하고 빌드·테스트·실행으로 검증한다. 커밋·푸시·배포는 별도 요청이 있을 때만 한다.
- **제품 도슨트**는 앱의 설명 생성이나 도슨트 서브에이전트로 실행되는 역할이다. 설명 전용·읽기 전용 제한은 제품 도슨트에 적용하며, 저장소 개발 에이전트의 구현·검증을 금지하지 않는다.
- 제품 도슨트의 실행 지침은 `prompt/docent.md`가 유일한 정본이다. 개발 중 이 파일을 읽으면 제품의 동작을 정의하는 수정·검토 대상이며, 개발 에이전트 자신의 역할 지침으로 적용하지 않는다.
- 아래 문서는 필요할 때 읽는 참고 자료다. 제품 프롬프트와 과거 결정 문서를 개발 지침에 자동 포함하지 않도록 일반 Markdown 링크를 사용한다.

## 프로젝트 핵심

- 바이브코더가 웹앱과 PiP, 모바일 PWA, 터미널, macOS 앱에서 작업 기록을 이해하고 복습하는 설명 전용 도슨트. 화면들은 같은 로컬 서버와 학습 기억을 사용한다(ADR 0037). 서브에이전트 어댑터는 배관·평가용.
- 제품 도슨트는 설명만 한다. 사용자의 작업 코드를 수정하거나 커밋하거나 실행하지 않는다.
- 답변 언어는 쉬운 한국어. 용어를 쓰면 한 줄로 풀어 쓴다.

## 구조 규칙

- 코어 프롬프트는 `prompt/docent.md` 하나. 호스트·도구·경로 이름을 쓰지 않는다.
- 어댑터(`adapters/<host>/`)는 프론트매터와 설치 방법만. 프롬프트 본문을 복사하지 않는다.
- 런타임 코드는 `bin/`(CLI), `app/`(서버·웹·터미널·데스크톱), `scripts/`뿐. 웹 기반 설명 표시에는 Streamdown·React와 로컬 빌드를 사용한다. 자산은 패키지에 포함하고 실행 중 CDN은 사용하지 않는다 (ADR 0015·0037).
- 새 결정은 `docs/decisions/NNNN-*.md` 로 남긴다. 문서 안에서 결정을 번복하지 않는다.
- 코어나 omp 확장을 고치면 `node bin/docent.mjs install-omp` 를 다시 실행한다.
- 학습 기억은 사용자·개념·범위를 구분한다. EASY/NORMAL/HARD는 선호이며 능력 등급이 아니다. 근거·저장·PiP 계약은 ADR 0014를 따른다.
- 화면(CSS, 레이아웃, 여백, 버튼 배치)을 고치면 글자, 여백, 정렬을 검사한다. 이 프로젝트의 규칙과 명령은 `docs/design-check.md`, 공통 절차는 전역 스킬 `jev-design-check`. 관리자 기기에서는 `~/SERVICES/docent/jev-env npm run check:design`으로 Jev 판정까지 통과시킨다(키 위치와 기기별 주의는 `~/SERVICES/docent/README.md`). 그 밖의 환경에서는 `TYPESAFE_API_KEY`를 환경변수로만 넣는다. "Jev로 검사했다"는 키를 넣은 실행 결과일 때만 말한다. 화면 문구에 가운데 점과 엠 대시를 쓰지 않는다.

## 운영 원칙

- `AGENTS.md` 는 300줄 미만. 상세 규칙은 문서로 분리.
- 비밀값은 파일에 쓰지 않는다.
- 공개 저장소 `origin`(singandmong/vibecoder-docent) 의 `main` 이 정본이다. 2026-10 에 foxion37 계정에서 singandmong 조직으로 옮겼고 옛 주소는 GitHub 가 넘겨 준다. 변경은 CHANGELOG·버전 갱신 → noreply 작성자로 커밋 → `main` 푸시 → `v<버전>` 태그 푸시 순서. 태그가 GitHub Release tgz 를 만든다. `archive` 원격(옛 비공개 히스토리)에는 푸시하지 않는다.

## 빠른 링크

- [프로젝트 맥락](CONTEXT.md)
- [개념](docs/concept.md)
- [초기 범위](docs/scope.md)
- [현재 구조](docs/architecture.md)
- [디자인 검사](docs/design-check.md)
- [열린 질문](docs/open-questions.md)
- [0001 문서 우선](docs/decisions/0001-docs-first.md)
- [0002 코어와 어댑터](docs/decisions/0002-host-agnostic-core-omp-first.md)
- [제품 도슨트 프롬프트 (개발 에이전트 지침 아님)](prompt/docent.md)
- [omp 어댑터](adapters/omp/README.md)
- [0003 전사 정규화](docs/decisions/0003-eval-transcripts-and-normalizer.md)
- [0004 답 형식](docs/decisions/0004-answer-format.md)
- [0005 로컬 웹앱](docs/decisions/0005-surface-local-web-app.md)
- [0006 라이브와 기억](docs/decisions/0006-live-and-memory.md)
- [0007 배포](docs/decisions/0007-distribution.md)
- [0008 용어집과 복습](docs/decisions/0008-glossary-and-faq.md)
- [0009 긴 전사](docs/decisions/0009-long-transcripts.md)
- [0010 미리 알려주기](docs/decisions/0010-proactive-hints.md)
- [0011 다른 컴퓨터 연결](docs/decisions/0011-peers-over-tailscale.md)
- [0012 최근 사건 재생](docs/decisions/0012-refresh-and-replay.md)
- [0013 Claude 서브에이전트 전사](docs/decisions/0013-claude-subagent-transcripts.md)
- [0014 학습 기억과 근거](docs/decisions/0014-learning-evidence-and-pip.md)
- [0015 설명 중심 화면](docs/decisions/0015-explanation-first-surface.md)
- [0016 모델 선택](docs/decisions/0016-docent-model-selection.md)
- [0028 격리 실행과 스레드 대화](docs/decisions/0028-isolated-runner-and-live-threads.md)
- [0029 중단과 바로잡기](docs/decisions/0029-ask-jobs-stop-steer-queue.md)
- [0030 학습 분류](docs/decisions/0030-light-learning-classification.md)
- [0031 서버 미리 설명](docs/decisions/0031-server-side-pre-explanation.md)
- [0032 분류 시점과 세션 제공자](docs/decisions/0032-classify-after-answer-and-more-hosts.md)
- [0033 카드 원문](docs/decisions/0033-card-output-as-first-message.md)
- [0034 공유 설정](docs/decisions/0034-host-toggle-in-settings.md)
- [0035 모양 설정](docs/decisions/0035-settings-tabs-and-content-size.md)
- [0036 프로젝트 이름](docs/decisions/0036-rename-vibecoder.md)
- [0037 모바일, 터미널, macOS](docs/decisions/0037-mobile-terminal-and-macos.md)
