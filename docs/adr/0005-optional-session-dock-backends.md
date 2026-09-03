# ADR 0005: session dock의 tmux 의존은 선택 사항이다

- 상태: 채택
- 결정일: 2026-09-03
- 확장: ADR 0004의 tmux 전환 레이어

## 맥락

ADR 0004의 tmux backend는 한 키 복귀, window 재사용, 여러 terminal client의 동일 화면
공유를 제공합니다. 반면 Waga의 핵심 가치인 provider 통합 목록과 상호 메시징에는
terminal multiplexer가 필요하지 않습니다. tmux 설치 여부가 Waga 전체의 실행 조건이
되면 얇은 bridge라는 제품 경계와 맞지 않습니다.

Waga가 PTY, scrollback, resize, mouse, 복수 client attach를 직접 구현하면 provider TUI와
terminal multiplexer를 다시 만드는 셈입니다. 이 기능은 직접 소유하지 않습니다.

## 결정

- 대화형 dock은 `auto`, `direct`, `tmux` backend를 가집니다.
- 기본값 `auto`는 tmux를 우선 사용합니다. tmux 실행 파일을 찾을 수 없을 때만 `direct`로
  fallback합니다. tmux 명령 자체가 실패한 경우에는 원인을 숨기지 않고 실패합니다.
- `--backend tmux`는 ADR 0004의 재사용 가능한 window와 복수 client 공유를 명시적으로
  선택합니다. tmux가 없으면 오류를 반환합니다.
- `--backend direct`는 overview 프로세스가 현재 terminal을 선택한 provider TUI에 그대로
  넘깁니다. provider TUI가 detach 또는 종료되면 raw mode와 alternate screen을 복구하고
  같은 overview로 돌아옵니다.
- direct backend에서 Claude는 `Ctrl+Z`, Codex는 `Ctrl+D`로 현재 native view를 빠져나와
  overview로 복귀합니다. Waga가 입력을 가로채지 않으므로 공통 `Alt+G` 단축키는
  제공하지 않습니다.
- native TUI가 terminal을 소유한 동안 overview의 자동 발견과 화면 출력은 멈춥니다.
- `waga list`, `send`, `ask`, `open`, provider session/daemon 소유권은 backend와 무관합니다.
- `waga doctor`는 tmux를 선택 기능으로 보고하되, tmux 부재만으로 실패하지 않습니다.

## 경계와 결과

direct backend는 tmux window 재사용, 동일 화면 공유, Waga가 관리하는 지속적 terminal
view를 제공하지 않습니다. 여러 terminal에서 같은 provider session에 붙을 수 있는지는
provider의 native attach 계약에 따릅니다.

tmux backend는 더 좋은 전환 사용감을 제공하지만 선택 사항입니다. Waga는 WezTerm 같은
특정 terminal emulator에도, tmux에만도 종속되지 않습니다. PTY multiplexer를 새로
구현하지 않으므로 유지보수 표면은 backend 선택과 terminal 인계·복구에 한정됩니다.
