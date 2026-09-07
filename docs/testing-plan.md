# 테스트 검증 절차

## 구획

| 구획 | 검증 계약 |
|---|---|
| 메시지 신뢰 경계 | 정확한 대상, 모호함·부재 거부, 요청 ID, 불신 입력, 무전달 |
| provider·통신·사용량 | 응답 페이지·상관관계, 상태·timeout, 연결 정리, 인증 실패·캐시 |
| 목록·순서·별칭 | 늦은 갱신, 일시 누락, 화면 소유권, 선택 유지, 저장 실패 |
| 실행·tmux·dock | 창 재사용, 재접속, 실패 정리, signal·종료 코드, 격리 프로세스 |
| CLI·진단·로그 | 잘못된 입력, 출력·종료 코드, 제어문자, 파일 권한·회전 |

각 구획은 호출 구현과 테스트를 함께 대조합니다. 발견한 결함은 수정 전 실패를
확인하고, 수정 후 관련 테스트와 전체 회귀를 실행합니다. 검토 기록과 당시 hash는
`test/mutation/*-review.json`, 활성 작업은 `TODO.md`, 완료 이력은 `git log`를 따릅니다.

## 일반 회귀

```sh
npm run check
npm run benchmark
npm pack --dry-run
git diff --check
```

벤치마크는 1,000개 세션의 메모리 내 처리·문자열 프레임 구성입니다.
provider 응답 속도나 실제 터미널 표시 속도를 측정하지 않습니다.
실제 tmux 통합 테스트의 skip 여부도 별도로 확인합니다.

## 선정 변이 재실행

```sh
node scripts/mutation-check.mjs provider /absolute/new-provider-report
node scripts/mutation-check.mjs overview /absolute/new-overview-report
node scripts/mutation-check.mjs lifecycle /absolute/new-lifecycle-report
node scripts/mutation-check.mjs cli /absolute/new-cli-report
node scripts/mutation-check.mjs title /absolute/new-title-report
```

출력 폴더는 아직 존재하지 않아야 합니다. 실행기는 임시 복사본에서
`test/mutation/cases.json`의 위험 분기를 하나씩 변경합니다. 원본 checkout과
사용자 세션에는 변이를 적용하지 않습니다. Node 외 새 검증 의존성은 없습니다.

- 먼저 정상 baseline을 확인하고, 각 변이의 구문을 검사한 뒤 관련 테스트를 실행합니다.
- 생존은 전체 테스트로 다시 확인합니다. 정상 코드로 복구한 baseline도 확인합니다.
- 일반 실패·테스트 timeout·프로세스 timeout·runner 오류를 구분합니다.
- TAP 원본, 명령·Node 버전·timeout, source/test/lockfile hash를 `report.json`과 함께 보존합니다.
- 자동 생성된 검토 기록은 hash 대상에서 제외합니다. 테스트와 구현은 제외하지 않습니다.

이 실행기는 **선정 결함 주입**입니다. 앞서 StrykerJS로 수행한 변이 검사와 도구·분모가
다르므로 점수를 합산하지 않습니다. 최초 추산 5,061개 후보를 전부 실행하는 명령도
아닙니다. 신규 분기는 사례를 추가하거나 Stryker 실행 범위를 다시 선정해야 합니다.

## 결과를 재사용할 조건

통과는 테스트 동결 근거가 아닙니다. 구현·관련 테스트·공유 의존성·lockfile·Node 또는
검증 설정이 바뀌면 관련 구획을 재실행합니다. 영향 범위가 불명확하면 네 구획 모두
실행하고 신뢰 경계의 Stryker 범위도 재검토합니다. runner 오류와 미실행은 통과가 아닙니다.

네이티브 모델의 실제 응답, Claude 최종 답변 상관관계, 외부 OAuth 서비스,
동시 다중 프로세스의 저장 충돌은 격리 fixture 테스트만으로 입증되지 않습니다.
실제 provider 검증은 `waga-proof-*` 폐기용 세션에 한정하고 별도 결과로 기록합니다.
