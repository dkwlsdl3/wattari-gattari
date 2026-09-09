# local-llm-router

Waga가 새 세션을 만들 때 호출하는 개인 라우터입니다. 이 프로젝트는 Waga와
분리되어 있으므로 모델 별칭, 작업 신호, GitLab 이슈 조회 정책을 자유롭게 바꿀 수
있습니다.

`router.config.json`의 모델 별칭과 승격 프로파일을 먼저 확인하십시오. 이슈 번호가
프롬프트에 있으면 라우터는 현재 작업 디렉터리에서 `glab issue view --comments
--output json`을 읽기 전용으로 호출해 제목·본문·라벨·코멘트를 라우팅 근거에 포함합니다.
인증이 없거나 조회가 실패하면 프롬프트 규칙으로 폴백하며 세션 생성은 계속됩니다.

```bash
npm test
node src/cli.mjs route --provider codex --cwd /path/to/repo --prompt '#123번 이슈 확인해봐' --json
```

코멘트와 본문은 라우팅 점수 계산에만 사용합니다. 자동으로 모델에 전달하거나 작업을
실행하지 않습니다.
