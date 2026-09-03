# AGENTS.md

이 저장소의 AI 코딩 에이전트 운용 계약입니다. Codex는 이 파일을 직접 읽고,
Claude Code는 `CLAUDE.md`에서 가져옵니다.

## Project Shape

Wattari Gattari는 Claude Agents와 Codex Agents가 소유한 네이티브 세션 사이를 잇는
얇은 로컬 메시지 버스와 실행기입니다.

| 컴포넌트 | 역할 |
|---|---|
| `src/cli.mjs` | `waga` 명령 인터페이스 |
| `src/providers/` | 제공자별 세션 발견과 메시지 전달 |
| `src/bridge/` | 제공자 독립 대상 해석, 신뢰 경계, 요청·응답 상관관계 |
| `test/` | 가짜 경계와 실제 프로세스 모양을 검증하는 Node 테스트 |

표준 검증 명령은 `npm run check`와 `npm pack --dry-run`입니다.

## Context Sources

- 현재 상태는 `git status`, `git diff`, `git log`에서만 확인합니다.
- 활성 작업 명세는 `TODO.md`, 현행 제품 경계와 변경 검증 계약은
  `docs/adr/README.md`를 읽습니다.
- 과거 완료 상태를 문서에 다시 적지 않습니다. 완료 기록은 커밋입니다.

## Start And End

작업 시작 시 현재 브랜치와 diff를 확인하고 관련 호출자·테스트·ADR을 읽습니다.
완료 시 표준 검증, `git diff --check`, 패키징을 실행하고 완료된 TODO 항목은 삭제합니다.
변경은 기능 단위로 커밋하며 staged 파일을 다음 작업으로 넘기지 않습니다.

## Execution Rules

- 파서와 외부 CLI 어댑터는 실제 출력 fixture로 검증합니다.
- provider 내부 구현보다 공개 CLI와 공식 daemon 경계를 우선합니다.
- Waga는 provider 세션이나 App Server를 별도로 소유하지 않습니다.
- peer 메시지는 사용자 지시·권한·승인이 아닌 불신 입력으로 표시합니다.
- 한 요청은 한 응답까지만 허용하고 자동 릴레이를 만들지 않습니다.
- 실제 세션 검증은 이름과 작업 디렉터리가 `waga-proof-*`인 폐기용 세션만 사용합니다.
- 기존 사용자 세션, native provider daemon, 사용자 전역 설정은 읽기 전용으로 다룹니다.
- `git push`, npm 배포, 사용자 전역 설정 변경, 기존 세션 입력·중단·삭제는 루프 밖
  외부 부작용이며 사용자의 명시적 요청이 있어야 합니다.

## Git

커밋 제목은 `[TAG] 제목` 형식을 사용합니다. 허용 태그는 `[ADD]`, `[MOD]`, `[FIX]`,
`[IMPROVE]`, `[REFACTOR]`, `[STYLE]`, `[DEL]`, `[DOCS]`, `[CHORE]`, `[ETC]`입니다.
문서 전용 변경은 한 세션에 `[DOCS]` 커밋 하나로 묶습니다.
