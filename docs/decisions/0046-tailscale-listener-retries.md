# 0046 — 테일스케일 대기는 열릴 때까지 다시 시도하고 서버를 끄지 않는다

Date: 2026-10-11
Status: Accepted. ADR 0034 Consequences의 "옛 `host: "tailscale"`로 시작하면 기존대로 시작이 멈춘다"를 바꾼다.

## Context

맥북은 옛 설정 `{"host": "tailscale"}`로 launchd에서 켜진다. 부팅 직후 Tailscale보다 docent가 먼저 뜨면 두 가지로 꺼졌다. 주소를 못 받으면 `tailscale ip 를 알 수 없어요`로 시작 단계에서 멈췄고, 주소는 받았지만 아직 그 주소에 열 수 없으면 `listen EADDRNOTAVAIL`로 loopback까지 함께 꺼졌다. launchd KeepAlive가 다시 띄우기를 되풀이하다 Tailscale이 준비되면 그제야 정상이 됐다. 그동안 이 컴퓨터의 `docent` 명령과 다른 컴퓨터(peer)의 세션 목록 모두 이 서버를 쓸 수 없었다.

## Decision

1. 127.0.0.1은 항상 먼저 연다. 이것을 열지 못하면(포트 충돌 등) 지금처럼 서버를 끈다.
2. 옛 `host: "tailscale"`(CLI `--host tailscale`, `DOCENT_HOST=tailscale` 포함)과 설정창의 `tailscale: 참`은 같은 길로 테일스케일 대기를 추가로 연다.
3. 테일스케일 주소를 못 찾거나 그 주소에 열 수 없으면 서버를 끄지 않고 5초, 10초, 30초, 이후 60초 간격으로 다시 시도한다. 로그는 첫 실패 한 번만 남기고, 열리면 열린 주소를 남긴다.
4. 설정창에서 공유를 켜거나 끄면 다시 시도를 멈추고 그 요청을 따른다.
5. 다른 고정 주소(`--host 100.x.y.z` 등)를 직접 준 경우는 바꾸지 않는다. 열지 못하면 서버를 끈다.

## Consequences

- 부팅 순서와 상관없이 loopback은 바로 응답하고, 테일스케일 공유는 Tailscale이 준비된 뒤 몇 초 안에 열린다.
- 공유가 다시 시도 중인 동안 `GET /api/host`는 `tailscale: false`를 돌려준다. 실제로 열린 상태만 알린다.
- 영향 범위: `app/server.mjs`.
