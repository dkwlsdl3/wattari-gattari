# ADR 0003: 네이티브 세션 사이만 연결한다

- 상태: 채택
- 결정일: 2026-09-02
- 대체: ADR 0001, ADR 0002
- 확장: 세션 탐색과 네이티브 TUI 진입 경로는 ADR 0004와 ADR 0005

## 맥락

Claude Code와 Codex가 모두 자체 Agents 화면과 세션 수명을 제공합니다. Waga가 별도
overview, transcript, 입력기, daemon, 세션 카탈로그를 소유하면 제공자 기능과 키 동작을
다시 구현해야 하며 업데이트 때마다 호환성 부담이 생깁니다. 반면 두 제품 사이의 세션
발견과 직접 통신은 어느 한쪽도 제공하지 않습니다.

## 결정

Waga는 provider가 소유한 실제 세션 사이의 얇은 메시지 브리지로 한정합니다.

- `SessionBridge`가 대상 해석, 요청 ID, 단일 응답 계약만 소유합니다.
- `ClaudeProvider`는 활성 세션만 반환하는 `claude agents --json`과 Claude의 네이티브 peer
  Unix socket을 사용합니다. `--cwd`로 시작한 프로젝트에 속한 Claude 관리 worktree는 실제
  작업 디렉터리를 유지하면서 상위 프로젝트에 귀속시킵니다. 송신 중에만 임시 peer
  endpoint를 등록하고 반드시 정리합니다.
- `CodexProvider`는 설치된 Codex의 기존 native App Server daemon에 직접 WebSocket으로
  연결합니다. 별도 App Server를 띄우거나 native daemon을 교체하지 않습니다.
- Codex 발견 목록은 `thread/loaded/list`가 반환하는 현재 Agents 소유 최상위 세션만
  사용합니다. 일반 `thread/list`의 CLI/VSCode 대화 기록과 `exec`·App Server 자동화
  기록은 섞지 않습니다.
- `NativeLauncher`는 provider의 Agents 화면과 정확한 native session attach 명령만
  위임합니다.
- bare `waga`의 작은 session dock은 ADR 0004와 ADR 0005가 정의합니다. transcript와 입력기는
  계속 provider TUI만 소유하고, text 목록은 `waga list`가 제공합니다.
- `send`는 제출까지만 확인하고, `ask`는 실제 대상 transcript의 한 turn에서 답변 한 건만
  기다립니다. 답변을 다른 세션으로 자동 전달하지 않습니다.
- provider가 하나 고장 나도 다른 provider 목록은 경고와 함께 사용할 수 있습니다.

## 신뢰 경계

peer payload에는 다른 세션에서 온 불신 입력이며 사용자 권한·승인이 아니라고 명시합니다.
Waga가 Codex App Server의 승인 요청을 받으면 거절합니다. Claude의 `accept`, `hold`,
`refuse` 결정은 대상 세션 설정이 소유하며 Waga는 `from-mode=bypass`를 주장하지 않습니다.

peer 메시지는 실제 대상 transcript를 깨우므로 read-only shadow가 아닙니다. 대상 에이전트는
자신의 기존 sandbox와 승인 정책 아래에서 행동할 수 있지만 Waga 메시지만으로 새로운
권한을 얻지는 못합니다. 제한된 Claude 세션처럼 셸 도구가 없는 세션은 Waga를 스스로
실행할 수 없으며, 사용자는 네이티브 셸 모드를 사용하거나 필요한 도구를 가진 세션을
만들어야 합니다.

## 검증 계약

- 파서는 실제 provider 출력과 실제 프로토콜 프레임을 fixture로 고정합니다.
- 단위 테스트는 부분 장애, ID 충돌, Unix socket 수명, standalone tool-output 요청,
  한 turn의 답변 상관관계를 검증합니다.
- 호환성 검증은 `waga-proof-*` 이름과 임시 작업 디렉터리를 가진 폐기용 세션에서만 합니다.
- 양방향 검증은 Claude에서 Codex, Codex에서 Claude를 각각 실제 `waga ask`로 호출하고
  고유 marker 응답을 확인합니다.

## 결과

입력 편집, transcript 스크롤, 대화 테마, slash command와 provider 업데이트는 Claude와
Codex가 계속 소유합니다. Waga는 ADR 0004와 ADR 0005의 작은 session picker만 소유합니다. 유지보수
표면은 두 provider adapter, attach 명령과 작은 CLI로 제한됩니다. 대신 provider의 비공개
또는 실험적 로컬 프로토콜이 바뀔 수 있으므로 업데이트 뒤 `waga doctor`와 실제 smoke
test가 필요합니다.
