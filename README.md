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
✻ Opus 5.5  ●●●○○ high  │  ctx ━━━━━━━─── 71%  715k/1M  │  5h ━───────── 13%  ↻3h35m   주간 ━───────── 4%  ↻5d
```

- 모델과 effort: `/effort` 선택 창과 같은 색, xhigh는 반짝임, max는 흐르는 무지개
- 컨텍스트 사용률과 토큰
- 5시간·주간 사용 한도 사용률과 초기화까지 남은 시간, Fable 모델이면 Fable 주간 한도
- 바 색은 남은 비율에 따라 초록 → 노랑(50% 이하) → 주황(25% 이하) → 빨강(10% 이하, `!`)

테스트: `claude plugin test plugins/statusbar`
