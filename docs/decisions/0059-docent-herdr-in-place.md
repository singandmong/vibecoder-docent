# 0059 — `docent herdr`는 터미널에서 그 자리에 열고, `--split`일 때만 옆 창을 만든다

Date: 2026-10-14
Status: Accepted. 사용자 요청. ADR 0044의 결정 1과 2(항상 오른쪽 창을 나누거나 기존 도슨트 창으로 이동)를 일부 대체한다. 나머지(세션 고르기, OMP 확장 구조)는 그대로다.

## Context

셸 창에서 `docent herdr`를 치면 항상 오른쪽에 새 창이 생겼다. 사용자는 터미널에서 친 명령이면 바로 그 창에서 열리기를 원한다. 새 창이 필요한 곳은 TTY가 없는 OMP `/docent` 확장뿐이다.

## Decision

1. 표준 입력과 표준 출력이 모두 TTY이고 `--split`이 없으면, 서버를 확인하고(꺼져 있으면 켠다) 세션을 고른 뒤 `docent-tui --url <주소> [--session <id>]`를 `stdio: "inherit"`로 이 프로세스의 터미널에서 실행한다. 종료 코드는 TUI의 것을 그대로 돌려준다. 이 모드는 Herdr가 없어도 되고, 기존 도슨트 창으로 이동하지 않는다.
2. `--split`이 있거나 TTY가 아니면 ADR 0044 그대로 동작한다(같은 작업 공간의 도슨트 창으로 이동, 없으면 오른쪽으로 분할).
3. OMP 확장 `adapters/omp/docent-command.ts`는 `pi.exec`에 TTY가 없으므로 `--split`을 명시해 부른다.
4. 결정은 `shouldOpenInPlace({ split, isTTY })`로 분리해 테스트에서 주입한다. TUI 실행은 `launchInPlace({ spawn })`로 대체할 수 있다.

## Consequences

- 셸에서는 `docent herdr`가 지금 창을 TUI로 바꾼다. 옆 창이 필요하면 `docent herdr --split`.
- `/docent` 확장을 쓰는 사용자는 `docent install-omp`를 다시 실행해 확장을 갱신해야 `--split`이 전달된다.
- herdr-launch 테스트는 shebang 가짜 스크립트를 쓰므로 Windows에서는 건너뛴다.
