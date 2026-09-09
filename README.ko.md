# Wattari Gattari

[![CI](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml/badge.svg)](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [아키텍처](docs/adr/README.md) · [라이선스](LICENSE)

Wattari Gattari(`waga`)는 Claude Code와 Codex의 활성 세션을 한 dock에서 열고
연결하는 로컬 CLI입니다. 별도 daemon이나 대체 채팅 UI는 두지 않습니다.

![Waga session dock 데모](docs/assets/wattari-gattari-demo.gif)

## 핵심 기능

- 프로젝트별 세션 탐색과 네이티브 TUI 연결
- 검색·필터·수동 정렬·이름 변경·생성·보관
- Claude·Codex 사용 한도 표시 (5분 캐시)
- 넓은 화면에서 선택한 세션의 마지막 입력·응답 미리보기
- `waga send` 단방향 알림과 `waga ask` 응답 요청

## 요구 사항과 설치

- Linux, Node.js 22 이상
- Agents 기능을 지원하는 Codex CLI와 Claude Code
- 선택 사항: 화면 재사용과 공유를 위한 tmux

provider 업데이트 뒤에는 `waga doctor`로 연결 환경을 확인하십시오.

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

### 새 세션 자동 모델 라우팅

`Alt+N`으로 새 세션을 만들면 Waga가 별도 로컬 프로젝트인
`local-llm-router`를 생성·호출할 수 있습니다. Waga 코어에는 개인 모델 정책이나
GitLab 인증을 넣지 않으며, 라우터가 없거나 실패하면 provider 기본값으로 세션을
생성합니다.

라우터의 `router.config.json`에서 네 단계 모델 별칭과 기준을 정합니다. 기본 템플릿은
Codex가 `Sol low → Sol medium → Astra low → Astra xhigh`, Claude가
`Sonnet low → Opus low → Fable low → Fable high` 순서이며, 실제 정책의 정본은
standalone 라우터입니다. 이슈 번호가 있는 프롬프트를 라우터에 넘기면 라우터가
선택적으로 제목·본문·라벨·코멘트를 읽어 점수에 반영할 수 있습니다. 조회 결과는
라우팅 근거로만 쓰고 작업 지시나 자동 실행으로 전달하지 않습니다.

기본 경로는 `~/Projects/local-llm-router`이며 `WAGA_LOCAL_ROUTER_DIR`로 바꿀 수
있습니다. 경로가 비어 있으면 Waga가 기본 템플릿을 복사하고, 기존 파일이 있으면
덮어쓰지 않습니다.

입력창에는 생성 전 provider 기본 미리보기가 표시되고, 최종 라우팅 결과는 세션 생성
알림에 표시됩니다. 이미 열린 세션의 모델을 바꾸거나 Waga가 이슈 데이터를 직접
조회하지는 않습니다. subprocess 입력과 v1 응답 필드는
[라우터 계약 문서](docs/adr/2026-09-09-local-router-contract.md)에 정의되어 있습니다.

### 새 세션 실행 설정

Dock에서 `Alt+S`를 누르면 새 세션에 적용할 Claude·Codex 실행 설정 화면을 엽니다.
`Tab`으로 provider를 바꾸고, `↑`·`↓`로 항목을 고른 뒤 `Space`로 선택합니다.
라디오 그룹은 하나만 선택되고 체크박스 그룹은 여러 항목을 선택할 수 있습니다.
`Enter`는 저장, `Esc` 또는 `Alt+S`는 취소입니다.

- Claude: 승인 권한(`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`,
  `bypassPermissions`)과 `dangerously-skip-permissions`, `restricted`, `bare`,
  `disable-slash-commands`, `strict-mcp-config` 실행 옵션을 설정합니다.
- Codex: 승인 정책(`default`, `untrusted`, `on-request`, `never`, `granular`),
  샌드박스(`default`, `read-only`, `workspace-write`, `danger-full-access`), 승인
  검토자, 응답 요약 수준, 세부 승인 항목과 provider 모델 대체 허용을 설정합니다.

Waga는 선택한 값을 새 세션 생성 시 Claude CLI의 실행별 플래그와 Codex App Server의
`thread/start`·첫 `turn/start` 파라미터로 전달합니다. provider의 native 승인 화면과
실행은 각 provider가 계속 소유합니다. `Alt+Y`는 Codex의 기본값과 YOLO
(`approvalPolicy=never` + `sandbox=danger-full-access`)를 빠르게 전환하는 호환
단축키입니다.

설정은 `$XDG_CONFIG_HOME/wattari-gattari/settings.json`(기본값
`~/.config/wattari-gattari/settings.json`)의 version 2 문서에 저장됩니다. 기존
version 1 Codex 전환 설정은 읽을 때 provider 설정으로 변환되며, 파일이 없거나
읽을 수 없으면 provider 기본값으로 닫힙니다. 기존 세션과 `send`·`ask`에는 영향을
주지 않고, 다음에 만드는 Claude·Codex 세션부터 적용됩니다.

## Dock 조작

120열 × 20행 이상이면 오른쪽에 최근 대화를 표시합니다. 선택 후 150ms를 기다려
해당 세션만 조회하고 5초 캐시하며, dock이 숨겨지면 조회하지 않습니다.
긴 기록은 일부만 표시하며 터미널 화면 복제는 아닙니다. 마지막 응답은 이전 입력의
응답일 수 있습니다. 오른쪽 응답이 길면 `PgUp`·`PgDn`으로 선택을 바꾸지 않고
응답 영역만 페이지 단위로 스크롤할 수 있습니다. 추가 모델 호출이나 별도 대화 로그
저장은 없습니다.

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
| `Alt+S` | 새 세션 Claude·Codex 실행 설정 |
| `Alt+Y` | 새 Codex 세션 실행 모드 기본값 / YOLO 전환 |
| `Alt+X` 두 번 | 세션 보관 |
| `Alt+Q` | Waga 종료 |
| `PgUp` / `PgDn` | 오른쪽 선택 응답만 페이지 단위로 스크롤 |

기본 `auto`는 tmux가 있으면 세션 창을 재사용하고, 없으면 `direct`로 실행합니다.
네이티브 화면에서 돌아오는 키는 다음과 같습니다.

- Waga 격리 tmux: `Alt+G`로 dock, `Alt+A`로 별도 provider Agents View
- 기존 tmux 안: prefix 뒤 `0`으로 dock
- direct: Claude `Ctrl+Z`, Codex `Ctrl+D`로 native view 종료·분리

Claude `←`나 Codex `/agents`로 내부 이동해도, dock에서 다시 선택하면 해당 세션으로
연결합니다. 창 재사용 판정은 [ADR](docs/adr/README.md)에 있습니다.

- **이름 변경:** Codex는 즉시, Waga에서 만든 훅 지원 Claude 세션은 다음 프롬프트 때
  한 번 반영합니다. 훅 없는 Claude 세션은 로컬 별칭이며 저장 안내로 구분합니다.
- **보관:** 대화 로그는 남깁니다. Codex는 archived sessions로 옮기고,
  Claude는 background job과 관리 worktree를 정리합니다.

Codex 0.153.4의 재접속 화면이 예전 출력으로 덮이면 `/raw on`으로 우회할 수 있습니다.
서식만 단순해지고 로그는 유지됩니다. 새 TUI에서는 다시 필요할 수 있으며,
Waga가 다른 세션의 표시 모드나 전역 설정을 바꾸지는 않습니다.

## 세션 간 메시지

- `send`: 단방향 알림. 제출만 확인합니다.
- `ask`: 대상의 idle을 기다려 실제 transcript에 한 turn을 보내고 첫 답변을 받습니다.
- `ask --until-idle`: Codex는 제출한 turn의 완료와 마지막 답변을 확인합니다.
  Claude는 peer 답변 후 idle만 확인하며, native turn 대응이나 최종 답변 여부는 보장하지 않습니다.

peer 메시지는 사용자 지시·승인이 아닌 불신 입력이며 기존 sandbox·승인 정책을 따릅니다.
자동 릴레이는 없습니다. `Alt+N`으로 만든 세션에는 사용법과 이 신뢰 경계를
provider 지침 채널로 전달하며, 사용자의 첫 프롬프트에는 섞지 않습니다.

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
`Noto Sans Mono CJK KR` 폰트가 필요합니다. 검증 범위와 변이 테스트는
[테스트 절차](docs/testing-plan.md)를 참고하십시오.

진단 로그는 `~/.local/state/wattari-gattari/events.jsonl`에 기록하며 대화 내용은
포함하지 않습니다. [integrations/](integrations/)에 30일 보존용 logrotate·systemd 설정이 있습니다.

## 라이선스

[MIT](LICENSE)
