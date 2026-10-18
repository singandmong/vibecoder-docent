# 0073 — 릴리스에 macOS 앱 포함

Date: 2026-10-18
Status: Accepted

## 문제

웹, PWA, 터미널, CLI 는 npm 패키지 하나로 릴리스마다 함께 바뀌지만 macOS 앱(Electron)은 `npm run build:macos` 로 각자 만들어야 했다. 배포할 때 앱도 같이 나가기를 원했다.

## 결정

1. 태그 릴리스 작업이 npm 패키지를 올린 뒤 GitHub 의 macOS 러너 두 대에서 앱을 만든다. `macos-15` 는 Apple Silicon(arm64), `macos-15-intel` 은 Intel(x64)이다. 각자 `Vibecoder-Docent-<버전>-macos-<arch>.zip` 을 같은 릴리스에 붙인다.
2. Developer ID 인증서가 없으므로 임시(ad-hoc) 서명만 한다. `build-macos.mjs` 가 묶은 뒤 `codesign --force --deep --sign -` 와 `--verify --strict` 를 한다. 서명이 깨진 채면 Apple Silicon 이 "손상된 앱"으로 거부하기 때문이다. 공증은 하지 않는다.
3. 내려받은 앱은 처음 한 번 Gatekeeper 확인(우클릭 > 열기 또는 `xattr -dr com.apple.quarantine`)이 필요하다고 README 에 적는다.
4. 앱은 ADR 0072 의 화면 업데이트 대상이 아니다. 앱이 이미 켜진 `docent` 서버를 쓰면 서버 업데이트로 화면도 바뀌고, 앱이 직접 켠 서버는 업데이트 화면에서 "앱을 다시 설치하세요"라고 안내한다.

## 결과

- 릴리스마다 tgz 와 zip 두 개가 함께 나온다. 앱 빌드가 실패해도 npm 패키지 릴리스는 이미 끝나 있다(앱 작업은 따로 실패로 보인다).
- Apple Developer 계정이 생기면 이 작업에 Developer ID 서명, 하드닝 런타임, 공증과 staple 을 더해 Gatekeeper 확인을 없앤다. 그때 이 ADR 을 새 ADR 로 대체한다.
