# 0062 — `OMP_BIN`이 JS 파일이면 Node로 실행한다. Windows CI가 모든 시험을 돌린다

Date: 2026-10-14
Status: Accepted. ADR 0057의 7번(Windows CI에서 ask, doctor, herdr-launch, models, terminal 시험을 뺀다)을 대체한다. 서버가 omp를 부르는 방식(ADR 0028)과 환경변수 `OMP_BIN`의 뜻은 그대로고 JS 파일 경로만 더 받는다.

## Context

1. **Windows는 shebang을 읽지 못한다.** 시험 픽스처(`tests/omp-fixture.mjs`)는 가짜 omp를 `#!node` 첫 줄이 있는 `.mjs` 파일로 쓰고 `OMP_BIN`에 넣었다. POSIX는 이 파일을 바로 실행하지만 Windows의 `spawn`, `execFile`은 실행하지 못한다. Node는 셸 없이 `.cmd`도 실행하지 못한다. 그래서 CI의 Windows 작업은 ask, doctor, models, terminal, herdr-launch 시험을 목록으로 빼고 있었다. 빠진 시험이 가리키는 omp 호출 경로(runner, models, doctor)는 Windows에서 한 번도 검증되지 않았다.
2. **실사용에도 같은 모양이 있다.** npm으로 설치한 omp는 Windows에서 `omp.cmd` 래퍼와 그 뒤의 JS 진입점으로 이루어진다. 래퍼를 셸 없이 실행할 수 없으므로, 사용자가 JS 진입점을 `OMP_BIN`으로 직접 줄 수 있어야 한다.
3. omp를 실행하는 자리는 네 곳이다: `app/runner.mjs`(분류, 설명), `app/models.mjs`(모델 카탈로그), `app/doctor.mjs`(`omp --version`, `models --json`), `bin/docent.mjs`(시작 전 `omp --version` 확인).

## Decision

1. **`app/omp-bin.mjs`의 `ompCommand(bin, args = [])`가 실행 명령을 정한다.** 경로가 `.js`, `.mjs`, `.cjs`로 끝나면(대소문자 무시) `{ command: process.execPath, args: [bin, ...args] }`, 아니면 `{ command: bin, args }`다. 위 네 곳은 모두 이 함수를 거쳐 `spawn`, `execFile`을 부른다. `omp`처럼 PATH에서 찾는 이름과 `.exe`는 그대로 실행한다.
2. **시험 픽스처의 가짜 omp는 shebang 없이 `.mjs`로만 쓴다.** 서버가 1의 규칙으로 Node에 실행시키므로 어느 운영체제에서도 같다. 파일 권한(`0o700`)도 필요 없다.
3. **Windows CI 작업은 `node --test tests/*.test.mjs` 전체를 돌린다.** 제외 목록과 설명 주석을 지운다. 글롭은 셸이 아니라 Node가 푼다.
4. **Windows에 없는 기능만 이유를 적어 건너뛴다.**
   - Herdr 관련 시험(`tests/herdr-launch.test.mjs`)은 Herdr가 Windows에 없어 건너뛴다. 이 파일은 다른 작업이 소유한다.
   - `tests/ask.test.mjs`의 "graceful server shutdown ..."은 Windows에서 건너뛴다. Windows의 `process.kill`은 신호를 보내지 않고 프로세스를 바로 끝내므로 서버의 SIGTERM 종료 처리(실행 중인 모델 중단, 요청을 cancelled로 기록)가 돌지 않는다(ADR 0057 Consequences). 서버가 죽은 뒤 다시 켜면 그 요청은 `cancelled`가 아니라 `error`로 보인다.
5. **저장 파일 교체(`rename`)는 Windows에서만 잠금 오류를 다시 시도한다.** 전체 시험을 Windows에서 처음 돌리자 시험이 무작위로 5초 기다림 끝에 실패했다(터미널 화면에 `설명을 만들지 못했어요: EPERM: operation not permitted, rename '...learning.json.….tmp'`). `app/store.mjs`가 임시 파일을 `learning.json`, `config.json`으로 `rename`하는데, Windows는 대상 파일을 백신이나 방금 읽은 핸들이 잠깐 잡고 있으면 `EPERM`, `EACCES`, `EBUSY`로 거절한다. 사용자의 Windows에서도 질문 저장이 가끔 실패할 수 있는 실제 결함이다. `replaceFile`이 Windows에서 이 세 오류일 때만 10ms부터 10ms씩 늘려 최대 20번 다시 시도하고, 그 밖의 오류와 POSIX에서는 첫 실패를 그대로 던진다.

## Consequences

- Windows의 omp 호출 경로(분류, 설명 대화, 모델 카탈로그, doctor, 시작 확인)가 CI에서 실제 자식 프로세스로 검증된다.
- `OMP_BIN=C:\...\cli.js` 처럼 JS 진입점을 직접 줄 수 있다. 같은 모양이 macOS, Linux에서도 된다.
- JS 파일 확장자를 가진 실행 파일이 따로 있는 설치(드문 경우)는 이제 Node로 실행된다. 그런 파일은 이전에도 shebang을 가진 스크립트였을 때만 실행됐다.
- 데스크톱 앱(`app/desktop/main.cjs`)은 `OMP_BIN`이 가리키는 파일을 찾아 서버에 그 경로를 넘길 뿐 omp를 실행하지 않아 바뀌지 않는다.
- 영향 범위: `app/omp-bin.mjs`(신규), `app/runner.mjs`, `app/models.mjs`, `app/doctor.mjs`, `app/store.mjs`, `bin/docent.mjs`, `tests/omp-fixture.mjs`, `tests/omp-bin.test.mjs`(신규), `tests/ask.test.mjs`, `.github/workflows/ci.yml`.
