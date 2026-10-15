# 웹 실행 기록

웹의 **실행 그래프**는 가져온 OpenTelemetry 실행 기록을 표시합니다. **세션 대화**는
기존 작업 단계와 연결된 native 세션에 질의하는 화면입니다. 둘의 상태는 독립적입니다.

## 가져오기

Claude Code에서 명시적으로 켠 enhanced telemetry가 내보낸 OTLP HTTP JSON의
`resourceSpans` 문서를 **기록 가져오기**에서 선택합니다. JSONL 로그나 JavaScript 워크플로
스크립트를 해석하지 않습니다. 파일 최대 4MiB, span 최대 5,000개, 실행 최대 100개입니다.
동일한 span ID는 중복 계산하지 않으며, 같은 정규화 문서를 다시 가져오면 기존 기록을 반환합니다.
수집 시점이 다른 문서는 별도 스냅샷입니다. 수신 서버를 상시 열거나 기존 세션 설정을 바꾸지 않습니다.

- 기본은 도구·모델 이름, 세션·워크플로·에이전트 ID, 시각, 토큰 수 등의 허용된 메타데이터만 저장합니다.
- 입력·출력·diff는 가져오기 창에서 선택한 경우만 저장합니다. 내용 자체에는 코드·비밀 값이 있을 수 있습니다.
  계정 속성 제거가 본문 비밀 값 제거를 뜻하지 않습니다.
- 내용은 항목당 16,000자, 이벤트 20개이며 잘리면 화면에 표시합니다.
- 저장 위치는 `$XDG_STATE_HOME/wattari-gattari/executions` (기본 `~/.local/state` 아래),
  디렉터리는 본인 소유 0700, 파일은 0600입니다. 서버 cwd별로 조회를 제한합니다.
- 로컬 인증과 동일 출처 검사를 거칩니다. 가져온 내용은 텍스트로만 표시하며 명령을 실행하지 않습니다.

## 표시 의미

`traceId`·`parentSpanId`로 확인된 다른 에이전트의 호출만 연결합니다. 내부 execution span을
거슬러 호출자를 찾으며, 없는 부모나 순환을 추측으로 보완하지 않습니다. 시간 순서는 도구 목록의
표시 순서일 뿐 작업 의존성이 아닙니다. 실행 종료를 확인하지 못한 span은 ‘종료 미확인’입니다.

**호출 종료는 검사 통과가 아닙니다.** status unset/OK와 종료 시각만으로 테스트·작업을
통과시키지 않습니다. span 오류는 오류로 표시하지만 명령 내부의 실패는 출력에서 확인해야 합니다.
스크립트의 명시적인 의존성, 별도 검사 종료 코드, 독립 검증 판정과 재시도 정책은 후속 연결 대상입니다.

## 실제 입력 fixture

`test/fixtures/claude-workflow-otel.json`은 폐기용 `waga-proof-workflow-capture`에서
Claude Code 2.1.300의 Workflow 도구와 Haiku 5.5로 실행한 `diagnose-fix-sum`의 실제
41개 span입니다. resource·계정 속성은 제거하고 테스트에 필요한 속성과 도구 이벤트만 남겼습니다.

메인에서 산술 테스트 실패 → 조사 agent의 Read → 수정 agent의 Read/Edit → 메인에서 검사
통과가 관측됐습니다. scan→fix 데이터 전달은 스크립트에는 있지만 이 trace의 부모 관계에는
없으므로 그 선을 생성하지 않습니다. 첫 Bash는 assertion 실패 후 `echo`가 정상 종료하여
도구가 정상 반환했습니다. 이 입력으로 ‘정상 반환 ≠ 검사 통과’를 회귀 검증합니다.
별도 `node sum.test.mjs` 실행에서도 종료 코드 0과 `SUM_CHECK_OK`를 확인했습니다.
이는 산술 수정과 관측 경로의 실험이며 독립 리뷰나 실제 프로젝트 품질을 입증하지 않습니다.

실험 프로세스에는 MemoryMax 1.5GiB, swap 0, CPUQuota 200%를 적용했습니다.
메모리 샘플은 실행 후반 6회로 전체 실행의 최대·최소를 보장하지 않습니다.

## 근거

- [Claude Code workflow 실행 인터페이스](https://code.claude.com/docs/en/workflows)
- [Claude Code telemetry와 enhanced trace](https://code.claude.com/docs/en/monitoring-usage)
- [OpenTelemetry OTLP JSON 형식](https://opentelemetry.io/docs/specs/otlp/)

Claude Platform의 Console destination과 Claude Code의 환경 변수 설정은 별도 경로입니다.
기존 세션 전체가 자동으로 수집된다고 가정하지 않습니다.
