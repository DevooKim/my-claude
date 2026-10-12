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
my-claude/fix-bar · worktree-fix-bar · !3+2?1⇡1
● Explore · Find the auth code 1m12s  │  T ●●●●○○○ 3/7  Running tests
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
- HEAD가 떨어지면 브랜치 자리에 `(커밋)`, 리베이스·병합·체리픽·revert·bisect 중이면 `(REBASING)`처럼 표시
- 파일을 바꾸는 도구가 끝날 때마다, 그리고 15초마다 다시 읽음. PR은 Claude Code의 PR 표시(`/config` Show PR status footer)를 씀

에이전트·할 일 줄 (보일 것이 있을 때만)

- 도는 서브에이전트·팀원: 1초마다 숨 쉬는 `●`, 종류(팀원은 이름) · 작업 설명, 경과 시간
- 할 일(TodoWrite·Task 도구): `T` 뒤에 할 일 하나에 점 하나(초록 끝냄, 주황 진행 중, 빈 점 남음, 10개가 넘으면 비율로), 끝낸 수/전체 수, 지금 하는 일. 다 끝나면 사라짐
- 좁은 터미널에서는 설명 → 개수 순으로 줄여 한 줄에 맞춤

테스트: `claude plugin test plugins/statusbar`
