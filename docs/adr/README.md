# Architecture decision

- 상태: 채택
- 갱신일: 2026-09-08

## 제품 경계

Wattari Gattari는 Claude Code와 Codex가 소유한 네이티브 세션을 발견하고 연결하는
얇은 로컬 CLI입니다. Waga는 별도 daemon, 대화 transcript, 승인 UI, provider 세션을
소유하지 않습니다.

- 기본 목록은 모든 프로젝트의 활성 세션이며 `--cwd PATH`로 제한합니다.
- 생성·접속·보관은 provider 공개 CLI 또는 native daemon에 위임합니다.
  새 세션에는 Waga 사용법과 신뢰 경계를 주입하며, 보관은 대화 로그를 영구 삭제하지 않습니다.
- `send`는 단방향, `ask`는 대상 transcript의 첫 답변을 기다립니다. `--until-idle`은
  Codex에서 제출한 turn의 완료·마지막 메시지를 확인하지만, Claude에서는 peer 답변 후
  idle만 확인하며 native turn 상관관계·최종 답변을 보장하지 않습니다.
- peer 메시지는 사용자 지시·승인이 아닌 불신 입력입니다. 기존 sandbox·승인 정책을
  유지하며 자동 릴레이와 자동 작업 배정은 하지 않습니다.

## Provider 경계

- Claude: `claude agents --json`, native peer Unix socket, `claude --bg`,
  `claude attach`, `claude rm`을 사용합니다.
- Claude 생성 시 실행별 `--settings`에 제목 훅을 추가합니다. 시작 훅은 기능을 등록하고,
  `UserPromptSubmit`은 UUID별 이름 변경 요청을 한 번 전달합니다. 전달 전에는 대기 이름,
  전달 후에는 native 목록 이름을 표시합니다. 전달은 적용 확인이 아니므로 실패 시 F2로
  재요청합니다. 훅 없는 세션은 로컬 별칭입니다. 전역 설정·로그 수정이나 추가 모델 호출·폴링은 없습니다.
- Codex: 기존 native App Server daemon의 Agents 소유 최상위 세션만 사용하며,
  세션 생성·resume·archive와 메시지 전달도 그 daemon에 위임합니다. 일반 CLI나
  VSCode 대화 기록은 dock에 섞지 않습니다.
- provider 오류는 서로 격리하고 경고를 표시합니다. 불완전한 Codex 목록을 삭제로 취급하지 않습니다.
- 사용량은 Claude OAuth usage endpoint·Codex App Server에서 읽어 5분 캐시합니다.
  조회 실패는 세션 발견에 영향을 주지 않습니다.
- RPC 제출 확인 timeout은 전달 여부 불명으로 취급하며 자동 재전송·원격 작업 중단을 하지 않습니다.

## Dock backend

Dock은 세션 목록과 관리를 담당합니다. 대화·도구·승인·모델 실행과 그 화면은 provider가 소유합니다.
사용법과 단축키는 [README](../../README.ko.md)에 둡니다.

- 오른쪽 미리보기는 선택한 세션의 마지막 입력·응답을 읽기 전용으로 표시합니다.
  Codex는 `thread/items/list`를 최대 3페이지·페이지당 50항목, Claude는 해당 UUID의
  JSONL 끝 256KiB까지만 읽습니다. 도구 출력·사고 내용은 제외하며 조회 범위 제한을 표시합니다.
  선택 debounce 150ms, 메모리 캐시 5초·최대 20세션, 입력·응답 각각 4,000자로 제한합니다.
  숨긴 dock·좁은 화면에서는 조회하지 않으며 별도 transcript 저장·모델 호출·daemon 기동은 없습니다.

- `auto`는 tmux가 있으면 `tmux`, 없으면 `direct`를 선택합니다.
- `tmux`는 네이티브 TUI마다 window를 재사용하고 여러 terminal client에 같은 화면을
  제공합니다. tmux 밖에서는 격리 server를, tmux 안에서는 현재 server의 Waga session을
  사용해 중첩 tmux를 피합니다.
- Claude 창은 선택 시 Linux `/proc`의 frontend 명령이 요청한 `attach`와 일치하는지 확인합니다.
  native Agents View로 이동했거나 식별할 수 없으면 해당 창만 재접속합니다. 주기적 감시는 없습니다.
- Codex 창은 실행별 `tui.terminal_title=["thread-id"]`와 선택 시 화면 상단 두 줄로 식별합니다.
  0.153.2의 UUID 29자+`...` 제목은 알려진 목록과 접두사 충돌 시 재접속합니다. 제목은 재사용
  힌트일 뿐 메시지 대상은 항상 전체 ID입니다. 전역 설정과 transcript는 수정하지 않습니다.
  일치하는 제목에 상단이 빈 줄인 경우는 재사용하지만, `Agent command center`·다른 세션·
  식별 실패·캡처 실패·빈 응답은 재접속합니다.
- 종료된 창과 강제 재접속은 선택한 세션의 `attach`/`resume`으로 frontend를 교체합니다.
- 격리 tmux server의 `Alt+A`는 세션 window와 분리된 provider Agents View를 열고,
  `Alt+G`는 Dock으로 돌아갑니다.
- Waga session에만 mouse mode를 적용합니다. provider가 휠을 처리하면 전달하고,
  아니면 tmux scrollback을 사용합니다.
- `direct`는 현재 terminal을 네이티브 TUI에 넘긴 뒤 detach 또는 종료 시 dock을
  복원합니다. window 재사용, 공통 복귀 키와 화면 공유는 제공하지 않습니다.

tmux는 화면 배치와 전환만 소유합니다. provider daemon, 세션, transcript와 작업은
Waga dock 또는 tmux window의 수명과 독립적입니다.

진단 이벤트는 세션 ID·loaded 목록 변화·tmux 창 조작·native TUI 종료 결과만 기록하며
프롬프트와 transcript는 제외합니다. 30일 보관용 logrotate·timer 설정은 [integrations](../../integrations/)에 둡니다.

## 변경 검증

`관측 → 최소 재현 → 가설 → 계측 → 수정 → 회귀 테스트`로 진행합니다.
파서·어댑터는 실제 출력 fixture로, 실제 provider는 이름·작업 디렉터리가 `waga-proof-*`인
폐기용 세션으로만 검증합니다. 명령과 결과 해석은 [테스트 절차](../testing-plan.md)를 따릅니다.
최종 tree에서 예상 밖 staged·untracked 파일과 완료된 TODO를 정리하고 미검증 런타임을 명시합니다.

`git push`, npm 배포, 사용자 전역 설정 변경과 기존 세션 조작은 별도 사용자 요청이
있을 때만 수행합니다.
