# Wattari Gattari

> Claude Code와 Codex의 네이티브 세션을 한곳에서 열고 연결합니다.

[![CI](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml/badge.svg)](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [아키텍처](docs/adr/README.md) · [라이선스](LICENSE)

Wattari Gattari(`waga`)는 Claude Code와 Codex의 활성 세션을 보여 주고, 선택한
세션의 네이티브 TUI로 연결하는 로컬 CLI입니다. 별도 daemon이나 대체 채팅 UI는
두지 않습니다.

![Waga session dock 데모](docs/assets/wattari-gattari-demo.gif)

## 핵심 기능

- 모든 프로젝트의 Claude·Codex 세션을 하나의 dock에서 탐색
- 정확한 네이티브 세션으로 attach/resume
- 검색, provider 필터, 수동 정렬, 이름 변경, 새 세션 생성과 보관
- 5분 캐시된 Claude·Codex 한도를 dock에 표시
- `waga send` 단방향 알림과 `waga ask` 단일 응답 요청
- peer 입력을 불신 입력으로 표시하고 기존 sandbox와 승인 정책 유지

## 요구 사항과 설치

- Linux, Node.js 22 이상
- Agents 기능을 지원하는 Codex CLI와 Claude Code
- 선택 사항: 화면 재사용과 공유를 위한 tmux

Codex CLI 0.152.1과 Claude Code 2.1.259에서 검증했습니다. provider 업데이트 뒤에는
`waga doctor`를 실행해 주십시오.

```bash
git clone git@github.com:dkwlsdl3/wattari-gattari.git
cd wattari-gattari
npm install
npm link
waga doctor
```

이 프로젝트는 npm에 배포하지 않습니다.

## 빠른 시작

```bash
waga                            # 모든 프로젝트의 통합 dock
waga --cwd ~/work/my-app        # 한 프로젝트로 제한
waga --backend direct           # tmux 없이 실행
waga --backend tmux             # tmux backend 필수
waga list --provider claude
waga list --json

waga send codex:<thread-id> "ADR을 확인해 주세요"
waga ask claude:<session-id> "현재 API 계약을 검토해 주세요"
waga ask codex:<thread-id> "전체 검증을 수행해 주세요" --until-idle
waga open codex --cwd ~/work/my-app
```

`waga agents`는 `waga list`의 별칭입니다. 대상은 `claude:<id>` 또는
`codex:<id>`처럼 provider 접두사가 붙은 ID를 권장합니다.

## Dock 조작

| 키 | 동작 |
|---|---|
| `↑` / `↓` | 이동 |
| `Shift+↑` / `Shift+↓` | 세션 표시 순서 변경 |
| `←` / `→` / `Enter` | 프로젝트 접기·펼치기 |
| 세션에서 `Enter` | 실행 중인 네이티브 TUI로 복귀 |
| 세션에서 `Alt+Enter` | 네이티브 TUI 강제 재접속 |
| `/` / `Tab` | 검색 / provider 필터 |
| `F2` | 선택한 세션 이름 변경 |
| `Alt+N` / `Alt+R` | 새 세션 / 새로고침 |
| `Alt+X` 두 번 | 세션 보관 |
| `Alt+Q` | Waga 종료 |

보관은 활성 목록에서만 제외하고 대화 로그는 남깁니다. Codex는 archived sessions로
옮기고, Claude는 transcript를 보존하면서 background job과 관리 worktree를 정리합니다.

기본 `auto` backend는 tmux가 있으면 실행 중인 세션 window를 그대로 재사용하고, 없으면
`direct`로 전환합니다. tmux backend에서는 prefix 뒤 `0`으로 dock에 돌아오며 Waga의
격리 server에서는 `Alt+G`로 dock, `Alt+A`로 별도 provider Agents View를 엽니다.
Agents View로 이동해도 세션 TUI window는 유지됩니다. direct backend에서는 Claude
`Ctrl+Z`, Codex `Ctrl+D`로 native view에서 빠져나옵니다.
Claude의 `←`나 Codex의 `/agents`로 내부 이동한 창은 Dock에서 다시 열 때 확인하고
필요하면 선택한 세션으로 재접속합니다. Codex는 Waga가 여는 TUI의 terminal title을
세션 식별 표식으로 사용합니다. 전역 설정은 변경하지 않습니다.

`F2`는 Codex의 실제 세션 이름을 바로 바꿉니다. Waga에서 새로 만든 Claude 세션은
다음 프롬프트 제출 때 네이티브 이름에 한 번 반영합니다. 훅이 없는 기존 Claude 세션은
Waga 로컬 이름만 바뀌며 저장 안내에서 구분합니다. 전역 설정 변경이나 별도 모델 호출은 없습니다.

## 세션 간 메시지

`send`는 제출까지만 확인하는 단방향 알림입니다. `ask`는 대상이 유휴 상태가 되기를
기다린 뒤 실제 transcript에 한 turn을 보내고 첫 답변을 반환합니다.
Codex의 `--until-idle`은 제출한 turn의 완료를 확인하고 마지막 에이전트 메시지를
반환합니다. Claude는 peer 답변 수신 후 idle을 확인하지만, 해당 native turn과의
상관관계나 답변이 최종 transcript 결과라는 보장은 없습니다. 자동 릴레이는 없으며
모든 peer 메시지는 사용자 지시나 승인이 아닌 불신 입력입니다.

Dock의 `Alt+N`으로 만든 세션에는 `waga agents`, `waga send`, `waga ask` 사용법과
peer 신뢰 경계가 provider의 지침 채널을 통해 자동으로 전달됩니다. 사용자의 첫
프롬프트에는 이 안내를 섞지 않습니다.

Waga의 세션 연결·종료 진단 이벤트는
`~/.local/state/wattari-gattari/events.jsonl`에 기록됩니다. 대화 내용은 기록하지
않으며, `integrations/`에 한 달 보존용 logrotate와 user systemd timer가 있습니다.

Claude가 사용자 확인 없이 답하려면 대상 세션에서 inbound 메시지를 허용해야 합니다.

```bash
claude agents --settings '{"crossSessionInbound":"accept"}'
```

## 데모와 개발

```bash
npm run demo          # 가짜 provider로 메시지 계약 실행
npm run demo:dock     # 가짜 세션으로 dock 실행
npm run demo:record   # VHS로 GIF 재생성
npm run check
npm run benchmark     # 메모리 내 처리·화면 문자열 생성만 측정 (provider I/O·터미널 출력 제외)
npm pack --dry-run
```

GIF 생성에는 [VHS](https://github.com/charmbracelet/vhs), `ttyd`, `ffmpeg`,
`Noto Sans Mono CJK KR` 폰트가 필요합니다. 설계와 검증 경계는
[아키텍처 결정](docs/adr/README.md)에 있습니다.

## 라이선스

[MIT](LICENSE)
