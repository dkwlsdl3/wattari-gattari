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

v1 `issues`에는 본문·코멘트 원문을 포함하지 않습니다. opt-in v2의 별도
`issueContext`만 아래 계약에 따라 작업 자료를 전달합니다. model alias와 effort의 의미는 라우터와 native
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
계속합니다. LLM 판정 기본 timeout은 45초입니다. Waga subprocess timeout은 두 단계와 종료 여유를
포함한 75초이며, stdout/stderr 각각 256KiB로 제한합니다. 사용자 정의 LLR 시간 제한이
이 예산을 넘으면 Waga가 먼저 timeout할 수 있습니다.

standalone LLR이 정책의 원본이며 Waga의 `src/local-router-template`은 bootstrap
복사본입니다. 두 저장소는 동일한 v1 fixture와 subprocess smoke test를 유지하고,
지원하지 않는 `contractVersion`은 Waga가 fallback합니다.

## 선택적 진행 이벤트

Waga는 `WAGA_ROUTER_PROGRESS=1`을 전달합니다. 지원하는 LLR은 stderr에
`WAGA_ROUTER_PROGRESS {"version":1,"stage":"judge","message":"판정 응답 대기 · 모델 / 추론 강도"}`
형태의 JSONL을 보내며, stdout의 최종 v1 JSON 계약은 유지합니다.
단계는 `prepare`, `issue`, `judge`, `judge-text`, `decision`, `fallback`입니다.
`judge-text`는 최대 1,000자의 누적 공개 판정 설명이며 모달의 같은 영역을 갱신합니다.
Claude는 `stream-json --verbose --include-partial-messages`의 text delta에서 reason을
추출하고, Codex exec는 완료된 agent_message 단위로 갱신합니다. 내부 사고·도구 출력은
표시하지 않으며 중간 설명은 최종 판정으로 사용하지 않습니다.
메시지는 최대 1,000자, 수신 줄은 최대 4,096자로 제한하고 잘못된 이벤트·일반 stderr는
진행 화면에 표시하지 않습니다. 원문 프롬프트·이슈 본문·판정기의 내부 사고는 전송하지 않습니다.
이벤트 미지원 LLR은 그대로 작동하며 Waga는 응답 대기와 최종 결과만 표시합니다.

기존 별도 LLR용 변경은 `integrations/local-router-progress.patch`에 있습니다.
LLR 저장소에서 `git apply --check /absolute/path/to/local-router-progress.patch`로
현재 소스와의 호환성을 확인한 뒤 적용합니다. Waga는 기존 LLR을 자동 덮어쓰지 않습니다.

`test/fixtures/local-router-progress.txt`는 패치를 적용한 LLR의 `runCli`와 `routeTask`를
실행하여 캡처한 stderr입니다. 이슈 조회와 모델 판정만 테스트 응답으로 주입했습니다.
실제 네트워크 조회·모델 실행을 검증한 fixture는 아닙니다.

## v2 조회 자료 재사용

`WAGA_ROUTER_CONTEXT=1`을 지원하는 LLR은 `contractVersion: 2`와
`issueContext: { issues: [...] }`를 반환합니다. 기존 v1 응답도 계속 허용합니다.
각 항목은 `iid`, `url`(없으면 빈 문자열), `fetchedAt`, `updatedAt`(없으면 null),
`text`, `truncated`만 허용합니다. 최대 3건·전체 JSON 32KiB이며 iid는 issueRefs에
있어야 합니다. URL은 HTTP(S), 날짜는 파싱 가능한 문자열로 검증합니다.

LLR이 이미 조회한 제목·본문·라벨·댓글의 정규화 자료를 재사용하며 추가 조회하지
않습니다. 길이 제한과 정규화 때문에 truncated=true로 표시합니다. Waga는 원래
사용자 프롬프트 뒤에 불신 자료임을 명시한 JSON, 작업 디렉터리, 조회 시각·출처를
붙입니다. 부족한 내용·최신 상태가 필요할 때 재조회하도록 안내합니다. 자료는 별도
로그·캐시 파일로 저장하지 않으며 provider의 일반 세션 입력으로 전달됩니다.
프롬프트와 첨부 합계가 120KiB를 넘으면 첨부를 생략하고 진행 화면에 알립니다.

Claude 스트리밍 형식 근거: https://code.claude.com/docs/en/headless#stream-responses
Codex 완료 메시지 형식은 로컬 exec의 exec_events.rs 및
`exec/tests/event_processor_with_json_output.rs`의 agent_message 테스트로 확인했습니다.
스트리밍 테스트는 해당 문서·소스 형식의 합성 이벤트를 사용하며 실제 모델 호출
검증은 아닙니다. v2 fixture는 패치된 LLR CLI에 조회·판정 응답을 주입해 캡처했습니다.
