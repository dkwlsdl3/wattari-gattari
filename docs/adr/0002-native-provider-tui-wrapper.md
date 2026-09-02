# ADR 0002: 대화는 제공자 기본 TUI에 위임한다

- 상태: 대체됨 — ADR 0003
- 결정일: 2026-09-02
- 대체 범위: ADR 0001의 커스텀 세션 대화 화면과 통합 승인 화면

## 맥락

> 이 문서는 Waga 자체 overview를 유지하던 중간 설계의 역사 기록입니다. 현재 구조를
> 설명하지 않습니다.

Wattari Gattari가 Codex와 Claude의 대화 화면을 직접 그리면서 입력 편집, transcript
줄바꿈, 스트리밍, diff와 명령 카드, 슬래시 명령, 토큰 표시, 마우스와 승인 UI까지
제공자 CLI와 중복 구현하게 됐습니다. 이 방식은 제공자 CLI가 바뀔 때마다 같은 기능을
추적해야 하고, 2026-09-02에는 휠 지원을 위해 터미널 마우스 추적을 켠 결과 WezTerm의
기본 드래그 선택이 막히는 회귀가 실제로 발생했습니다.

Codex App Server는 `--remote`로 기존 Codex 터미널 UI를 연결할 수 있고, Claude Code는
`agents`와 `attach`로 공식 세션 화면을 제공합니다. 따라서 별도 대화 UI를 유지할
이유보다 기본 UI를 재사용할 이점이 큽니다.

## 결정

Wattari Gattari는 여러 제공자의 세션을 한곳에서 찾고 전환하는 **얇은 control-plane
wrapper**로 한정합니다.

- Waga 화면은 workspace별 세션 목록, 상태, 이름, 순서, 완료 표시와 수명주기만
  제공합니다.
- 세션을 열면 Waga는 raw mode와 자체 입력 처리를 중지하고 터미널을 제공자 기본
  TUI에 넘깁니다.
- Codex 세션은 Waga App Server socket에 `codex --remote … resume <thread-id>`로
  연결합니다.
- 새 Codex 세션은 빈 thread를 미리 만들어 resume하지 않습니다. 기본 TUI가 영속
  thread를 직접 만들고 Waga monitor가 `thread/started`를 관찰해 카탈로그에 등록합니다.
- Claude background 세션은 `claude attach <id>`로 연결하고, 새 Claude 세션 관리는
  Waga peer 지침을 제공하는 소규모 plugin을 로드한 `claude agents --cwd <workspace>`에
  위임합니다.
- 제공자 TUI가 종료되면 Waga가 세션 상태를 다시 읽고 목록 화면만 복구합니다.
- 대화 작성, transcript, 스트리밍, diff·명령 카드, 슬래시 명령, 토큰·한도,
  마우스 스크롤과 민감 작업 승인은 제공자 기본 TUI가 소유합니다.
- Waga는 provider 설정을 임의로 축소하지 않습니다. 별도의 peer shadow 실행만 기존
  read-only·도구 비활성 격리를 유지합니다.
- 세션 간 요청은 ADR 0001의 한 요청·한 응답, read-only shadow, 승인 불신 계약을
  그대로 유지합니다.
- 이 peer 통신은 단순한 세션 목록 열람이 아닙니다. 호출 세션이 `waga ask`를 실행하면
  broker가 대상 세션의 대화 문맥을 격리된 shadow fork로 읽고, 대상 문맥에서 생성한
  답변 한 건을 호출 세션에 돌려줍니다. 어느 쪽 세션이든 먼저 요청할 수 있습니다.
- 요청과 답변은 원본 대상 transcript에 쓰지 않습니다. 따라서 상대 작업을 깨우거나
  끼어들지 않으면서 문맥에 기반한 협업은 가능하지만, 양쪽 원본 transcript가 자동으로
  이어지는 무한 릴레이는 아닙니다.
- Waga가 새로 여는 Codex와 Claude 세션은 `waga agents`로 peer를 발견하고
  `waga ask`로 한 번 질문하는 방법을 시스템 지침으로 받습니다. Waga 도입 전에
  이미 생성된 Claude 세션의 과거 시스템 프롬프트는 소급해서 변경하지 않습니다.

## 결과

- Codex와 Claude가 UI 기능을 추가하거나 수정하면 Waga를 바꾸지 않아도 그대로
  사용할 수 있습니다.
- Waga가 유지할 provider seam은 실행 명령과 세션 식별자 변환으로 줄어듭니다.
- Waga 화면에서는 대화 내용을 직접 입력하거나 읽지 않습니다. 사용자는 세션을
  선택해 해당 제공자 TUI로 들어갑니다.
- Waga가 별도로 띄운 Codex App Server의 호환성은 계속 관리해야 하지만, Codex 화면
  자체를 복제하는 비용보다 훨씬 작습니다.
- ADR 0001의 사람 중심 제어, 화면과 세션 수명의 분리, 자동 오케스트레이션 금지는
  유지합니다. 커스텀 대화 화면과 통합 승인 화면에 관한 세부 결정만 이 ADR이
  대체합니다.
