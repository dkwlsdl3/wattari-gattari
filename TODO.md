# Wattari Gattari — TODO

활성 작업만 둡니다. 완료 항목은 삭제하고 이력은 `git log`로 확인합니다.

검증 명령과 결과 재사용 기준: [테스트 검증 절차](docs/testing-plan.md).

## 메시지 접수·결과 회수 런타임 검증

- Unix socket 및 native provider 접근이 허용된 환경에서 `waga-proof-*` 세션으로
  busy Claude 접수·표식 답변, Codex 동시 요청·완료 응답, timeout 후 `waga result`를 검증합니다.
- 전체 `npm run check`를 통과시키고 미리보기 벤치마크 기준 초과를 별도로 진단합니다.

## 독립 tmux 화면 런타임 검증

- 소켓 접근 가능한 환경에서 `test/tmux-integration.test.mjs`를 실행하고,
  폐기용 두 terminal client로 목록 선택·Alt+G·Alt+A·연결 해제·크기 변경을 확인합니다.
  현재 sandbox에서는 tmux 소켓 연결이 `Operation not permitted`로 차단됩니다.

## 새 세션 입력·진행 모달 실측

- 새 dock에서 Shift+Enter 여러 줄 입력·↑↓ 커서 이동·생성 단계 모달을 실제 터미널로
  확인합니다. LF/CSI-u 입력 및 생성 단계 전달은 자동 테스트로 검증합니다.

## 라우터 진행 이벤트 연결

- 별도 local-llm-router 저장소에 `integrations/local-router-progress.patch`를 적용하고
  `npm run check` 및 새 dock의 이슈 조회·판정 설명 스트리밍·결과 표시와 작업 세션의 조회 자료 재사용을 실측합니다.
  현재 작업 환경에서 해당 저장소는 쓰기 권한 범위 밖이므로 임시 복사본으로 검증합니다.
