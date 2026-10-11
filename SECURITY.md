# 보안 정책

## 보안 모델

바이브코더 도슨트는 사용자 컴퓨터에서만 도는 로컬 도구다. 중앙 서버도, 계정·로그인도 없다. 신뢰 경계는 **이 컴퓨터**(그리고 켠 경우 테일스케일 사설망)다.

- 서버는 기본으로 `127.0.0.1`, 기본 포트 4747에만 연다. **인증이 없다.** 포트에 닿을 수 있는 사람은 세션 목록·전사를 읽고, 질문을 보내고, 문답·학습 기록을 읽을 수 있다.
- `--host tailscale`(또는 `DOCENT_HOST=tailscale`)은 이 컴퓨터의 테일스케일 IPv4에 **추가로** 연다. loopback은 그대로 유지한다.
- `--host`·`DOCENT_HOST`에는 임의 주소를 넣을 수 있다. `0.0.0.0`, 공인 IP, 포트 포워딩으로 공개 인터넷에 열지 않는다. 테일스케일 Funnel에도 올리지 않는다.
- 원격 접근의 인증과 암호화는 테일스케일이 담당한다. peer 트래픽은 평문 HTTP다(`http://<기기>:4747`). 모바일 PWA는 Tailscale Serve에서 HTTPS를 종료하고 도슨트의 loopback HTTP로 연결한다. `docent-mobile --enable`만 명시적으로 Serve를 설정하며, 기존 다른 서비스의 443 설정과 공개 Funnel이 있으면 거부한다.

## 설명만 한다

- 파일을 고치거나 명령을 실행하는 경로가 없다. 코어 프롬프트(`prompt/docent.md`)가 수정·실행을 금지한다.
- 모델 호출은 설치된 omp의 headless 실행이다: `omp -p --no-session --no-title --tools read --system-prompt prompt/docent.md`. 도구는 `read` 하나만 주어진다.
- 질문 하나에 omp를 두 번 부른다(의미 분류 → 설명). 네트워크로 나가는 것은 그 omp가 하는 호출, 켠 경우 Jev 판정(`https://api.typesafe.ai`, `TYPESAFE_API_KEY`), peer 조회뿐이다.

## 읽는 것과 저장하는 것

- 읽는 것: `~/.omp/agent/sessions`와 `~/.claude/projects`의 세션 파일, 그리고 사용자가 원문 보기로 여는 파일.
- 쓰는 것: `DOCENT_HOME`(기본 `~/.docent`) 하나뿐이다. `learning.json`에 프로필·문답·답·근거 발췌·학습 기록이 들어간다. 임시 파일 + fsync + rename으로 저장하고 `0600`으로 만든다. 옛 `questions.jsonl`은 기본 프로필의 과거 기록으로 읽기만 한다.
- 전사는 저장하지 않는다. 질문할 때 그때 정규화해 `os.tmpdir()`의 `docent-*` 폴더에 `0600`으로 쓰고, 요청이 끝나면 지운다.
- 비밀값은 파일에 쓰지 않는다. Jev 키는 환경변수 `TYPESAFE_API_KEY`로만 받는다. omp 인증은 omp가 스스로 관리하고 도슨트는 다루지 않는다.
- 저장소에는 비밀값도 개인 세션 기록도 커밋하지 않는다. `.gitignore`가 `.env*`, `data/`, `evals/transcripts/`를 제외한다.
- PWA 서비스 워커는 개인 기록이 없는 `/offline.html`만 캐시한다. API에는 `no-store`를 적용한다. 브라우저 localStorage의 입력 초안과 선택 설정은 그대로 기기에 남으므로 기기를 공유할 때 주의한다.
- macOS 앱의 Chromium 프로필과 화면 설정은 Electron의 사용자 데이터 폴더에 별도로 남는다. 설명 기록의 정본은 여전히 `DOCENT_HOME`이다. 렌더러의 Node 접근은 끄고 샌드박스를 사용한다.
- 터미널 클라이언트는 세션 원문의 제어 문자를 제거해 터미널 명령으로 해석되지 않게 표시한다. 설명 생성은 서버의 기존 읽기 전용 경로만 사용한다.

## 전사에 비밀이 섞일 수 있다

에이전트 세션 기록에는 API 키, 토큰, 개인 경로, 사내 정보가 들어 있을 수 있다.

- 질문할 때 그 전사 텍스트가 로컬 omp 프로세스로 넘어간다. 그 뒤 어디로 가는지는 사용자의 omp 설정(provider)에 달려 있다.
- peer를 켜면 원격 컴퓨터의 전사 텍스트를 평문 HTTP로 받아 온다. 암호화는 테일스케일 터널 몫이다. **신뢰하는 내 기기끼리만** 연결한다.
- 근거 발췌는 `learning.json`에 남으므로 그 파일을 공유·백업할 때 주의한다.

## 취약점 제보

GitHub Security 탭의 **Report a vulnerability**(Private vulnerability reporting)로 알린다.

<https://github.com/singandmong/vibecoder-docent/security/advisories/new>

공개 이슈에는 쓰지 않는다. 함께 적으면 좋은 것:

- 재현 방법과 영향(무엇을 읽거나 할 수 있게 되는지)
- 도슨트 버전(`docent --version`), 설치 방법, OS
- Node 버전(`node -v`), omp 버전(`omp --version`)

답변은 최선 노력으로 한다. 별도 포상 제도는 없다.

## 지원 범위

최신 릴리스만 지원한다. 수정은 최신 릴리스 기준으로 내보낸다.
