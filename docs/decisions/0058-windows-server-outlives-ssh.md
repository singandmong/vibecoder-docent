# 0058 — Windows에서 `docent start`는 WMI로 서버를 만들어 SSH 연결이 끝나도 남긴다

Date: 2026-10-14
Status: Accepted. ADR 0057 Consequences의 "Windows에 SSH로 접속해 `docent start`를 실행하면 SSH 연결이 끝날 때 서버도 꺼진다" 한계와 Decision 1의 "Windows에서는 창 없는 분리 프로세스(`detached`, `windowsHide`)" 부분을 대체한다. 나머지 0057의 결정은 그대로다.

## Context

- `ssh pc 'docent.cmd start'`로 켠 서버가 SSH 연결이 끝나면 꺼졌다. Windows OpenSSH가 세션을 작업 개체(job object)에 넣고 세션이 끝날 때 그 안의 프로세스를 모두 끝낸다. Node의 `detached`는 새 프로세스 그룹과 콘솔 분리일 뿐 작업 개체를 벗어나지 못한다.
- 원격에서 켜 두고 다른 기기에서 쓰려는 사용자가 이 한계에 걸렸다. README에 "그 컴퓨터에서 직접 켜라"고 적어 두었지만 고치기를 원했다.

## Decision

1. **win32에서 `startServer`는 WMI `Win32_Process.Create`로 서버를 만든다.** PowerShell의 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`를 쓰고, 만들어진 프로세스는 WmiPrvSE의 자식이라 SSH 세션의 작업 개체 밖에 있다. 명령 줄은 `cmd /d /c ""<node>" "<bin/docent.mjs>" --no-open --port N … >> "<server.log>" 2>&1"`이고, 창은 `Win32_ProcessStartup.ShowWindow=0`으로 숨긴다. 출력 이어쓰기는 `cmd`의 리다이렉션이 맡는다. 만들어진 cmd의 pid를 돌려받는다.
2. **PowerShell 스크립트는 `-EncodedCommand`(UTF-16LE base64)로 넘긴다.** `C:\Users\성큐` 같은 비 ASCII 경로가 인자 인코딩으로 깨지지 않게 한다. 스크립트 본문은 고정이고 경로, 명령 줄은 PowerShell이 물려받은 환경 변수(`DOCENT_WMI_CMDLINE`, `DOCENT_WMI_CWD`)로 읽는다.
3. **환경 변수는 PowerShell이 물려받은 환경을 읽어 `Win32_ProcessStartup.EnvironmentVariables`(`NAME=value` 문자열 배열)로 넘긴다.** WMI로 만든 프로세스는 호출자의 환경이 아니라 시스템/사용자 기본 환경을 받는다. 시험에서 이 배열은 자식에 그대로 도착했다(`DOCENT_HOME`, `OMP_BIN`, `TYPESAFE_API_KEY`, `DOCENT_*`, `Path`, 비 ASCII 경로 값). 값이 스크립트나 명령 줄에 들어가지 않으므로 `TYPESAFE_API_KEY` 같은 비밀이 `powershell`, `cmd`, `node`의 명령 줄(`Win32_Process.CommandLine`)에 나타나지 않는다. 전달용 `DOCENT_WMI_*` 두 변수는 서버 환경에서 뺀다.
4. **일찍 끝난 서버 감지는 둘로 나뉜다.** 건강 확인 반복(`/api/health`)은 그대로이고, POSIX는 자식의 `exit`, Windows는 만든 cmd pid의 `process.kill(pid, 0)`이 `ESRCH`를 던지면 15초를 기다리지 않고 `server.log` 마지막 줄과 함께 실패한다. POSIX 동작은 바뀌지 않는다.
5. **`docent stop`은 바꾸지 않는다.** `/api/health`가 알려 준 node pid를 `process.kill`로 끝낸다. cmd 래퍼는 자식(node)이 끝나면 따라서 끝난다.

## Consequences

- PC에서 `ssh pc 'docent.cmd start'` 뒤 SSH를 닫고 새 SSH로 `/api/health`를 부르면 같은 서버가 `{app, version, pid}`로 답했다. 프로세스 트리는 `WmiPrvSE → cmd → node`다. `docent stop` 뒤 health가 사라지고 node, cmd 모두 남지 않았다.
- 서버는 SSH 연결이 끝나도, 로그아웃한 뒤에도 남는다. 사용자가 로그오프하면 Windows가 정리할 수 있다는 점은 일반 서비스와 같다.
- WMI 호출 권한이 필요하다(관리자 그룹이 아니어도 자기 프로세스 생성은 된다). WMI가 막힌 컴퓨터에서는 `docent start`가 "(WMI)"와 PowerShell 오류와 함께 실패한다. 예전 분리 프로세스로 돌아가는 대체 경로는 두지 않는다. 대체 경로는 SSH 종료 때 서버가 조용히 사라지는 같은 문제를 숨기기 때문이다.
- 서버 프로세스의 부모가 `docent start`를 부른 셸이 아니다. 그 셸을 닫아도 서버는 남고, 서버가 끝나도 셸에 신호가 가지 않는다.
- PowerShell 시작이 한 번 더 들어가 켜는 시간이 1초 안팎 늘 수 있다.
- 영향 범위: `app/server-process.mjs`, README(SSH 한계 문장 삭제).
