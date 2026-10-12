# my-claude

개인용 Claude Code 플러그인 마켓플레이스.

## 설치


Claude Code 프롬프트에서:

```
/plugin install statusbar --marketplace DevooKim/my-claude
```

마켓플레이스 추가 질문에는 `y`, 범위는 user를 고르면 됩니다.

## 플러그인

### statusbar

프롬프트 입력창 아래 힌트 줄 밑에 상태 줄을 그립니다.

```
✻ Opus 5.5  ●●●○○ high · C ━━━━━━━─── 71%  715k/1M · S ━───────── 13%  ↻3h35m   W ━───────── 4%  ↻5d
my-claude/fix-bar · worktree-fix-bar · !3+2?1⇡1 · PR #12
```

git 줄은 starship 프롬프트와 같은 기호와 색으로 그려 셸 프롬프트와 똑같이 보입니다.

사용량 줄

- 모델과 effort: `/effort` 선택 창과 같은 색, xhigh는 반짝임, max는 흐르는 무지개
- 컨텍스트 사용률과 토큰
- 5시간·주간 사용 한도 사용률과 초기화까지 남은 시간, Fable 모델이면 Fable 주간 한도
- 바 색은 남은 비율에 따라 초록 → 노랑(50% 이하) → 주황(25% 이하) → 빨강(10% 이하, `!`)

git 줄 (저장소 안에서만)

- `프로젝트[/워크트리] · 브랜치 · 상태`를 `·`로 나눠 이어 씀. 경로는 굵은 하늘색(`#57C7FF`), 브랜치는 굵은 회색, 상태는 노랑
- 상태 기호(starship `git_status`와 같음): `=` 충돌, `$` 스태시, `×` 삭제, `»` 이름 바꿈, `!` 수정, `+` 스테이징, `?` 추적 안 함, `⇡` 앞섬, `⇣` 뒤처짐. 깨끗하고 upstream과 같으면 아무것도 없음
- HEAD가 떨어지면 브랜치 자리에 `(커밋)`, 리베이스·병합·체리픽·revert·bisect 중이면 브랜치 뒤에 `(REBASING)`처럼 표시
- 브랜치 PR 번호(`gh` 로그인 필요): 누르면 기본 브라우저로 PR 페이지가 열림(전체 화면 모드에서 클릭). 색이 상태: draft 회색, 머지할 수 있지만 승인 전(리뷰 전·CI 진행 중 포함) 주황, 승인까지 끝나 머지 가능 초록, 충돌·CI 실패·변경 요청으로 머지 불가 빨강, 병합됨 보라. Claude Code의 PR 표시와 겹치면 `/config`의 Show PR status footer를 끄면 됨
- 파일을 바꾸는 도구가 끝날 때마다, 그리고 15초마다 다시 읽음. PR 상태는 브랜치가 바뀌거나 푸시·PR 명령 뒤 곧바로, 그 밖에는 3분마다(GitHub가 아직 계산 중이면 20초 뒤)

서브에이전트와 할 일(Task)은 Claude Code가 직접 보여 주므로 따로 그리지 않습니다.

테스트: `claude plugin test plugins/statusbar`
