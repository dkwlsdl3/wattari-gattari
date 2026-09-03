# ADR 0004: tmux는 세션 화면이 아니라 전환 레이어다

- 상태: 채택, 선택적 백엔드로 확장됨 — ADR 0005
- 결정일: 2026-09-03
- 확장: ADR 0003의 세션 탐색과 네이티브 TUI 진입 경로

## 맥락

ADR 0003에서 Waga 자체 대화 화면을 제거하자 provider 업데이트를 따라가는 비용은
줄었지만, 사용자는 `waga` 목록에서 다시 `claude agents` 또는 `codex agents`를 거쳐야
했습니다. 반대로 Waga가 transcript, 입력기, slash command를 다시 그리면 네이티브 TUI를
재구현하던 문제로 돌아갑니다.

필요한 기능은 새 채팅 UI가 아니라 세 가지입니다. Claude와 Codex 세션을 한 목록에서
보고, 선택한 세션의 네이티브 TUI로 바로 들어가며, 한 키 경로로 통합 목록에 복귀해야
합니다. 이 전환은 WezTerm 같은 특정 terminal emulator에 의존해서는 안 됩니다.

tmux 안에서 다시 별도 tmux client를 attach하면 prefix, detach, mouse 입력이 중첩됩니다.
따라서 이미 tmux 안인지에 따라 진입 전략도 달라야 합니다.

## 결정

- 대화형 terminal에서 bare `waga`는 모든 workspace의 세션을 모은 전역 통합 dock을
  엽니다. `waga --cwd PATH`를 명시한 경우에만 해당 workspace로 제한합니다. 비대화형
  호출과 `waga list`는 기존 text 출력을 유지합니다.
- Waga overview는 workspace별 접이식 트리에 세션 이름, provider, 상태, 검색과 선택을
  그립니다. 선택한 workspace에서 provider가 소유할 새 세션의 첫 요청을 작성하는 한 줄
  입력기만 추가하며 transcript, 후속 대화 입력, 승인, token 표시, slash command는
  그리지 않습니다.
- `Ctrl+N`은 새 세션 입력기를 열고 `Tab`으로 Claude/Codex를 전환합니다. Claude는 공개
  background CLI, Codex는 기존 native App Server daemon으로 생성하며 완료 후 목록을
  새로고침합니다. 문자 명령은 IME 조합 상태에 영향받지 않도록 `Ctrl+N`, `Ctrl+R`,
  `Ctrl+Q`를 사용합니다.
- 선택한 Claude 세션은 `claude attach <native-id>`, Codex 세션은 기존 native daemon의
  socket을 지정한 `codex resume <native-id> --remote …`로 엽니다.
- 각 네이티브 TUI는 tmux window 하나를 사용하며 session ID를 window option에 기록합니다.
  같은 세션을 다시 선택하면 새 프로세스를 만들지 않고 그 window를 재사용합니다.
- tmux 밖에서는 Waga 전용 socket과 server를 사용합니다. 사용자 기본 tmux server나
  설정 파일을 읽거나 바꾸지 않습니다.
- tmux 안에서는 중첩 attach를 만들지 않습니다. 현재 tmux server에 전역 Waga session
  하나를 만들고 `switch-client`로 전환합니다. 명시적 `--cwd` dock만 workspace별로
  분리합니다. `Ctrl+Q` 또는 `Ctrl+C`는 `switch-client -l`로 원래 session에 돌아갑니다.
- 같은 Waga tmux session에 여러 terminal client가 붙으면 네이티브 세션별 window를
  중복 실행하지 않고 같은 pane을 공유합니다. 출력과 입력뿐 아니라 선택한 window도
  tmux session 단위로 공유되는 제약을 받아들입니다.
- 네이티브 TUI에서는 사용자의 tmux prefix 뒤 `0`으로 overview에 돌아옵니다. 격리
  server에서만 `Alt+G`도 같은 동작으로 제공합니다.
- Waga는 mouse mode를 강제하지 않습니다. 기존 tmux의 mouse 정책과 terminal emulator의
  드래그 선택을 존중합니다.
- overview와 네이티브 window는 detach 뒤에도 남습니다. 이는 provider 세션을 소유하기
  위해서가 아니라 terminal view를 재사용하기 위한 수명입니다.
- 새 `waga` 진입 프로세스는 설치된 `src/**/*.mjs` 내용 지문을 overview window option과
  비교합니다. 지문이 다르거나 없는 구 overview만 `respawn-window`로 교체하고, provider
  네이티브 window와 세션은 유지합니다. 별도 watcher daemon이나 수동 restart 명령은
  추가하지 않습니다.

## 경계

tmux는 화면 배치와 전환만 소유합니다. provider daemon, 세션 상태, transcript, 도구,
승인과 모델 실행은 계속 Claude Code와 Codex가 소유합니다. Waga의 provider seam은 세션
발견 결과를 정확한 attach 명령으로 바꾸고 첫 요청으로 native session을 생성하는
부분까지입니다.

기존 사용자 tmux session, provider session, native daemon에는 입력하거나 종료 신호를
보내지 않습니다. 실제 통합 검증은 `waga-proof-*` 이름의 별도 tmux socket과 임시
workspace에서만 수행합니다.

## 결과

- 사용자는 한 번의 `waga` 진입 후 project와 provider 구분 없이 세션을 선택할 수 있습니다.
- 세션 내부 사용감과 업데이트는 각 provider의 네이티브 TUI를 그대로 따릅니다.
- 기존 tmux 사용자에게 tmux-in-tmux를 만들지 않으며 WezTerm 전용 구현도 없습니다.
- Waga가 유지할 UI는 작은 session picker와 tmux 전환 계약으로 제한됩니다.
