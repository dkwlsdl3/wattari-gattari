# local-llm-router 입출력 계약

- 상태: 채택
- 갱신일: 2026-09-09

## 경계

Waga는 새 세션을 만들 때만 별도 `local-llm-router` 프로젝트를 subprocess로
호출합니다. 라우터는 사용자가 고른 provider를 바꾸지 않고, 그 provider 안에서
model과 reasoning effort를 선택합니다. Waga는 라우팅 정책을 재현하지 않고, 응답
계약을 검증한 뒤 provider 기본값으로 안전하게 대체합니다.

## 요청

호출 형식은 다음과 같습니다.

```text
node src/cli.mjs route --provider codex|claude --prompt TEXT --cwd ABSOLUTE_PATH --json
```

- `provider`는 `codex` 또는 `claude`입니다.
- `prompt`는 trim 후 비어 있지 않은 UTF-8 문자열이며 Waga는 128KiB 이하로 제한합니다.
- `cwd`는 호출 작업 디렉터리의 절대경로입니다.
- `--json`은 기계 호출 플래그입니다. 라우터는 성공 시 stdout에 JSON 한 줄만 씁니다.
- 로그와 오류는 stdout에 섞지 않습니다.

## 성공 응답

성공 시 다음 필드를 모두 포함하는 JSON object를 한 줄 출력합니다.

| 필드 | 계약 |
| --- | --- |
| `contractVersion` | 정수 `1` |
| `provider` | 요청과 같은 `codex` 또는 `claude` |
| `model`, `effort`, `label` | 비어 있지 않은 문자열 |
| `tier` | `fast`, `routine`, `complex`, `critical` 중 하나 |
| `score` | 0 이상 정수 |
| `confidence` | `low`, `medium`, `high` 중 하나 |
| `skills`, `reasons`, `issueRefs`, `warnings` | 문자열 배열 |
| `cwd` | 요청과 같은 정규화된 절대경로 |
| `source` | `local-llm-router` |
| `issues` | `{ iid, title, labels, commentCount }` 배열 |

`issues`의 본문·코멘트 원문과 `text` 필드는 내부 점수 계산에만 사용하고 성공
응답에는 포함하지 않습니다. model alias와 effort의 의미는 라우터와 native
provider가 소유하며 Waga는 provider를 바꾸거나 별도 model allowlist를 복제하지
않습니다. v1 응답의 root와 issue 객체는 위에 적은 필드만 허용하고, 알 수 없는
필드는 계약 불일치로 처리합니다.

## 오류와 fallback

- exit `0`: 계약에 맞는 JSON 한 줄
- exit `1`: 설정·라우팅·외부 조회 등 내부 오류, 오류 설명은 stderr
- exit `2`: command 또는 입력 형식 오류, usage/오류는 stderr

Waga는 timeout, 비정상 종료, JSON 파싱 실패, contract version·필수 필드·타입
불일치를 모두 라우터 실패로 처리하고 provider 기본값을 한 번 사용합니다. Waga의
fallback routing은 LLR 성공 응답과 별도 내부 상태이며 자동 재시도나 provider 변경은
하지 않습니다.

## 시간과 크기

LLR은 이슈 조회 전체 deadline을 12초 이하로 제한하고, 각 조회에는 남은 시간을
전달합니다. 조회가 deadline을 넘으면 warning을 남기고 prompt-only 라우팅을
계속합니다. Waga subprocess timeout은 15초, stdout 제한은 256KiB입니다.

standalone LLR이 정책의 원본이며 Waga의 `src/local-router-template`은 bootstrap
복사본입니다. 두 저장소는 동일한 v1 fixture와 subprocess smoke test를 유지하고,
지원하지 않는 `contractVersion`은 Waga가 fallback합니다.
