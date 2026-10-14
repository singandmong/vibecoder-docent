# 0066 — Windows에서 WMI로 서버를 만들지 못하면 분리 프로세스로 켜고 알린다

Date: 2026-10-14
Status: Accepted. ADR 0058(Windows 서버를 WMI로 만들기)의 "WMI가 막히면 실패한다"를 바꾼다.

## Context

ADR 0058은 `docent start`가 Windows에서 PowerShell의 `Invoke-CimMethod Win32_Process Create`로 서버를 만들게 했다. 회사 관리 PC처럼 WMI나 PowerShell이 정책으로 막혀 있거나 PowerShell이 PATH에 없으면 `docent start`가 바로 실패했다. 그런 PC에서도 터미널이나 에이전트 안에서 켜는 일반적인 쓰임(ADR 0057)은 분리 프로세스로 충분했다.

## Decision

1. Windows에서 WMI 생성이 실패하면(PowerShell 실행 실패, `ReturnValue`가 0이 아님) 0.23.0과 같은 분리 프로세스(`detached`, `windowsHide`)로 켠다.
2. 그렇게 켰으면 `startServer`가 `fallback`에 까닭을 돌려주고, `docent start`는 서버 주소와 함께 경고를 낸다: 이 창이나 SSH 연결을 닫으면 서버도 꺼질 수 있다.
3. 분리 프로세스가 켜지기 전에 끝나면 지금처럼 기록의 마지막 줄과 함께 실패한다.

## Consequences

- WMI가 막힌 PC에서도 `docent start`가 된다. SSH로 켠 서버가 연결 종료 뒤 남는 것은 WMI가 될 때만이고, 아닐 때는 경고로 알린다.
- PC에서 PowerShell을 PATH에서 뺀 상태로 `docent start`를 실행해 경고와 함께 켜지는지 확인한다.
