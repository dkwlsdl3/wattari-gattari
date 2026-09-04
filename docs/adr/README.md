# Architecture decision

- 상태: 채택
- 갱신일: 2026-09-03

## 제품 경계

Wattari Gattari는 Claude Code와 Codex가 소유한 네이티브 세션을 발견하고 연결하는
얇은 로컬 CLI입니다. Waga는 별도 daemon, 대화 transcript, 승인 UI, provider 세션을
소유하지 않습니다.

- bare `waga`는 모든 프로젝트의 활성 세션을 하나의 dock에 표시합니다.
- `--cwd PATH`는 목록을 한 프로젝트로 제한합니다.
- 세션을 열면 Claude `attach` 또는 Codex `resume`으로 정확한 네이티브 TUI에
  연결합니다. 대화, 도구, 승인과 모델 실행은 provider가 계속 소유합니다.
- 새 세션과 보관 요청은 provider의 공개 CLI 또는 native daemon 경계에 위임합니다.
  새 세션에는 provider 지침 채널로 Waga 사용법과 peer 신뢰 경계를 전달합니다. 보관은
  활성 목록에서 제외하지만 대화 로그를 영구 삭제하지 않습니다.
- `send`는 단방향 알림이고 `ask`는 실제 대상 transcript에서 첫 답변을 기다립니다.
  `--until-idle`은 정확한 요청 작업이 끝난 뒤 최종 답변을 반환합니다. 자동 릴레이와
  자동 작업 배정은 없습니다.
- peer payload는 다른 세션에서 온 불신 입력이며 사용자 지시나 승인이 아닙니다.
  수신 에이전트의 기존 sandbox와 승인 정책이 그대로 적용됩니다.

## Provider 경계

- Claude: `claude agents --json`, native peer Unix socket, `claude --bg`,
  `claude attach`, `claude rm`을 사용합니다.
- Codex: 기존 native App Server daemon의 Agents 소유 최상위 세션만 사용하며,
  세션 생성·resume·archive와 메시지 전달도 그 daemon에 위임합니다. 일반 CLI나
  VSCode 대화 기록은 dock에 섞지 않습니다.
- provider 하나가 실패해도 다른 provider 목록은 경고와 함께 사용할 수 있습니다.
- Dock의 사용량은 Claude OAuth usage endpoint와 Codex App Server에서 읽어 5분 캐시하며,
  조회 실패는 세션 발견에 영향을 주지 않습니다.
- 파서와 프로토콜 어댑터는 실제 출력 fixture로 검증합니다. 실제 통합 검증은
  `waga-proof-*` 이름과 임시 작업 디렉터리를 가진 폐기용 세션만 사용합니다.

## Dock backend

Dock은 프로젝트별 접이식 목록, 검색·필터, 수동 순서, 새 세션 입력과 보관만
제공합니다. transcript, 후속 입력, slash command와 승인 화면은 그리지 않습니다.

- `auto`는 tmux가 있으면 `tmux`, 없으면 `direct`를 선택합니다.
- `tmux`는 네이티브 TUI마다 window를 재사용하고 여러 terminal client에 같은 화면을
  제공합니다. tmux 밖에서는 격리 server를, tmux 안에서는 현재 server의 Waga session을
  사용해 중첩 tmux를 피합니다.
- Dock에서 세션을 다시 열면 기존 window의 frontend를 정확한 `attach`/`resume` 명령으로
  교체하므로 provider Agents View에 머물지 않습니다.
- Waga session에만 mouse mode를 적용합니다. provider가 휠을 처리하면 전달하고,
  아니면 tmux scrollback을 사용합니다.
- `direct`는 현재 terminal을 네이티브 TUI에 넘긴 뒤 detach 또는 종료 시 dock을
  복원합니다. window 재사용, 공통 복귀 키와 화면 공유는 제공하지 않습니다.

tmux는 화면 배치와 전환만 소유합니다. provider daemon, 세션, transcript와 작업은
Waga dock 또는 tmux window의 수명과 독립적입니다.

Waga는 세션 ID, loaded 목록 변화, tmux 창 조작과 native TUI 종료 결과만 로컬 진단
이벤트로 기록합니다. 프롬프트와 transcript는 기록하지 않으며 이벤트 파일은 30일 뒤
회전·삭제합니다.

## 변경 검증

넓은 변경은 `관측 → 최소 재현 → 가설 → 계측 → 수정 → 회귀 테스트`의 작은 루프로
진행합니다. 완료하려면 최종 tree에서 다음을 확인합니다.

- 관련 동작과 회귀 테스트, `npm run check`, `npm pack --dry-run`
- `git diff --check`와 예상 밖 staged·untracked 파일 부재
- 실제 provider 검증은 폐기용 세션으로 한정
- 완료된 `TODO.md` 항목 삭제와 미검증 런타임의 명시

`git push`, npm 배포, 사용자 전역 설정 변경과 기존 세션 조작은 별도 사용자 요청이
있을 때만 수행합니다.
