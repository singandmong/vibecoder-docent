# 보안성 검토 계획 (개발계)

- 대상: `singandmong/vibecoder-docent` main `a026b08` (v0.30.2)
- 범위: 개발계만. 운영 중인 맥미니, 맥북의 launchd 서버(포트 4747)와 실제 세션 기록, 학습 기록, 비밀값은 건드리지 않는다.
- 산출물: 1차 결과 `docs/security/2026-10-18-phase1-code.md`, 2차 결과 `docs/security/2026-10-18-phase2-pentest.md`. 보고서에 개인 정보, 비밀값, 실제 세션 내용을 적지 않는다.
- 고치기: 검토 중에는 발견만 기록한다. 수정 범위와 순서는 결과를 보고 따로 정한다.

## 위협 모델

| 자산 | 위치 | 노출 경로 |
|---|---|---|
| 코딩 세션 전사(코드, 경로, 대화) | `~/.omp`, `~/.claude`, `~/.codex`, `~/.gemini`, `~/.pi` | `/api/transcript`, `/api/live`, `/api/evidence`, 설명 프롬프트 |
| 학습 기록, 즐겨찾기, 설정 | `~/.docent/learning.json`, `config.json` | `/api/history`, `/api/profiles` 등 |
| 모델 호출 권한과 비용 | 로컬 `omp` 로그인 | `/api/ask`, `/api/wiki/extract`, 미리 설명 |
| 코드 실행 | 서버 프로세스, `omp`, `npm`, `ssh`, `herdr`, `tailscale` | 업데이트, 자식 프로세스 인자, 프롬프트 인젝션 |
| 사용자 화면 | 브라우저, PWA, Electron 앱, 터미널 | XSS, 터미널 제어 문자, 클립보드 |
| 공급망 | GitHub Release, CI, npm 의존성 | 태그, 워크플로, 업데이트 다운로드 |

공격자 가정:
1. 같은 컴퓨터의 브라우저에서 연 악성 웹 페이지(CSRF, DNS 재바인딩, 교차 출처 읽기).
2. 같은 테일넷(또는 `--host` 로 연 LAN)의 다른 기기. 서버에 인증이 없다.
3. 악성 내용을 담은 세션 전사(에이전트가 읽은 웹 페이지, 저장소 파일)로 들어오는 프롬프트 인젝션과 표시 공격.
4. 악성 또는 장악된 peer 도슨트 서버.
5. 업데이트 경로의 중간자, 변조된 릴리스.

## 1차: 코드 레벨 점검

읽기 전용 검토. 공격 면을 넷으로 나눠 동시에 본다. 각 발견은 위치(파일:줄), 공격 시나리오, 전제 조건, 영향, 심각도(높음, 중간, 낮음, 참고), 확신도를 적는다.

| 묶음 | 파일 | 볼 것 |
|---|---|---|
| A. HTTP 서버와 API | `app/server.mjs`, `catalog.mjs`, `peers.mjs`, `evidence.mjs`, `store.mjs`, `dialogue.mjs`, `ask.mjs`, `live.mjs`, `session-file.mjs`, `update.mjs` | 인증 없는 API, Host/Origin 검사, CSRF, DNS 재바인딩, CORS, 세션 id → 경로 변환과 경로 이탈, 정적 파일, 본문 크기, SSE 자원 고갈, peer SSRF와 원격 응답 신뢰, 테일스케일 노출, 업데이트 엔드포인트 |
| B. 프로세스 실행과 모델 | `runner.mjs`, `omp-bin.mjs`, `install-omp.mjs`, `herdr-launch.mjs`, `herdr-workspaces.mjs`, `server-process.mjs`, `ssh-aliases.mjs`, `repo.mjs`, `doctor.mjs`, `update.mjs`, `adapters/omp/*`, `prompt/docent.md` | 명령 인자 주입, 셸 사용, PowerShell/WMI, 업데이트 무결성, omp 격리(도구, 확장, 기억 끄기)와 전사 속 프롬프트 인젝션이 실행으로 이어지는지 |
| C. 화면 | `app/index.html`, `mobile.mjs`, `sw.js`, `app/assets` 빌드 입력, `app/desktop/main.cjs`, `terminal-*.mjs`, `scripts/transcript-*.mjs` | XSS(Markdown 렌더, innerHTML, 링크), 서비스 워커 캐시, Electron 보안 설정, 터미널 제어 문자와 OSC 52, 전사 파서 |
| D. 저장과 공급망 | `store.mjs`, `learning.mjs`, 로그 출력, `.github/workflows/*`, `package.json`/lock, `scripts/build-macos.mjs` | 파일 권한, 원자적 쓰기, 로그의 비밀값, CI 권한과 트리거, 액션 고정, 릴리스 무결성, 의존성 |

## 2차: 모의 공격

1차 결과로 시나리오를 확정한다. 모두 개발계 인스턴스에서 한다.

개발계 인스턴스:
- 저장소 코드로 서버를 별도 포트(4790번대)에 켠다. `HOME`, `DOCENT_HOME` 은 임시 폴더, 세션은 가짜 전사 파일, `OMP_BIN` 은 시험용 가짜 omp(`tests/omp-fixture.mjs` 방식)라 실제 기록, 모델 비용, 비밀값이 없다.
- 원격 기기 시나리오가 필요하면 같은 가짜 데이터로 이 컴퓨터의 테일스케일 주소에 몇 분만 열고 끝나면 닫는다.

기본 시나리오(1차 결과에 따라 더하고 뺀다):
1. 다른 출처 웹 페이지에서 API 읽기, 쓰기, 설명 요청(CSRF, CORS).
2. DNS 재바인딩(Host 헤더 위조)으로 기록 읽기, 업데이트 호출.
3. 세션 id, ref, 정적 경로로 임의 파일 읽기(경로 이탈).
4. 원격 기기에서 인증 없이 기록 읽기, 모델 호출 남용, 업데이트 시도.
5. 악성 전사: 웹 화면 XSS, 터미널 제어 문자, 프롬프트 인젝션으로 omp 도구 실행 유도.
6. 악성 peer 응답: 화면 주입, 큰 응답, 리디렉트.
7. 자원 고갈: 큰 본문, SSE 연결 다수, 동시 설명 요청.
8. 업데이트: 가짜 릴리스(해시 불일치, 다른 주소, 하위 버전)로 설치 유도.

각 시나리오의 결과는 재현 명령, 관찰, 성공 여부, 영향으로 적는다. 끝나면 개발계 프로세스, 임시 폴더, 테일스케일 리스너를 정리한다.
