# omp 어댑터

## 설치

```sh
docent install-omp            # → ~/.omp/agent/agents/vibecoder-docent.md, ~/.omp/agent/extensions/vibecoder-docent-command.ts
docent install-omp --project  # → ./.omp/agents/, ./.omp/extensions/ (현재 폴더에서만)
```

`frontmatter.md` + `../../prompt/docent.md` 를 이어 붙이고, `docent-command.ts` 확장을 복사한다(`app/install-omp.mjs`). 셸을 쓰지 않아 macOS, Linux, Windows PowerShell 에서 같은 명령이다. 코어나 확장을 고치면 다시 실행. 저장소에서는 `node bin/docent.mjs install-omp`.

## `/docent` (Herdr)

Herdr 창의 omp 입력창에서 `/docent`를 치면 오른쪽 창에 도슨트 터미널이 뜨고 지금 omp 세션이 바로 열린다. 이미 같은 작업 공간에 도슨트 창이 있으면 그 창으로 이동한다. 확장은 `docent herdr --cwd <세션 폴더> --session-file <세션 파일>`만 부르므로 `docent`가 PATH 에 있어야 한다. 새 omp 세션은 첫 메시지 전에는 비어 있어서 같은 폴더의 최근 세션이 열린다 (ADR 0044).

## 호출

메인 에이전트가 `task` 로 스폰한다. 지시문에 전사 위치와 질문을 넣는다.

```json
{
  "context": "바이브코더가 도슨트에게 묻는다.",
  "tasks": [{
    "agent": "vibecoder-docent",
    "task": "전사: history://Main\n질문: 지금 뭐 한 거야?"
  }]
}
```

## 도구 제한

`tools: read, grep, glob` — 쓰기·실행 도구가 스폰 시점에 제거된다. 프롬프트의 "코드 안 만짐" 규칙을 호스트 수준에서도 강제한다.

`read-summarize: false` — `read` 가 파일 구조 요약 대신 원문을 돌려준다. 도슨트는 코드 구조가 아니라 내용을 봐야 한다.

## 결과 형태

omp 는 서브에이전트 결과를 `{"answer": "..."}` 로 감싸 돌려준다(구조화 yield). 코어 프롬프트와 무관한 호스트 동작. 메인 에이전트는 `answer` 값만 사용자에게 그대로 전달한다.
