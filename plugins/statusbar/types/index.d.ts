export type StatusbarWindow = { percentUsed: number; resetsAt?: string }

export type StatusbarEffort =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'level'; level: string }

export type StatusbarFable =
  | { kind: 'unknown' }
  | { kind: 'absent' }
  | { kind: 'reading'; window: StatusbarWindow }

// 지금 브랜치 PR의 상태. 번호는 Claude Code가 힌트 줄에 보여 주므로 담지 않는다.
export type StatusbarPullRequest = {
  state: 'open' | 'draft' | 'merged' | 'closed'
  merge?: 'clean' | 'conflict' | 'behind'
  checks?: 'pass' | 'fail' | 'pending'
  review?: 'approved' | 'changes' | 'required'
}

export type StatusbarGitOperation = 'rebasing' | 'merging' | 'cherry-picking' | 'reverting' | 'bisecting'

// starship의 git_status가 세는 것과 같다: 스태시 수, 그리고 바뀐 파일을 종류별로.
export type StatusbarGitChanges = {
  conflicted: number
  stashed: number
  deleted: number
  renamed: number
  modified: number
  staged: number
  untracked: number
}

// 세션이 선 저장소의 한 시점. branch가 없으면 HEAD가 떨어져 있고 commit이 그 자리를 채운다.
// upstream이 없으면 추적하는 원격 브랜치가 없거나 사라졌다.
export type StatusbarGit = {
  project: string
  worktree?: string
  branch?: string
  commit?: string
  operation?: StatusbarGitOperation
  upstream?: { ahead: number; behind: number }
  changes: StatusbarGitChanges
  pr?: StatusbarPullRequest
}

// 상태 줄이 그리는 한 시점의 값. fable이 없으면 요금제 한도가 없는 세션이다.
export type StatusbarSnapshot = {
  model: string
  effort: StatusbarEffort
  context: { tokens?: number; window: number; percent?: number }
  fiveHour?: StatusbarWindow
  sevenDay?: StatusbarWindow
  fable?: StatusbarFable
  fableFetchedAt?: number
  git?: StatusbarGit
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    statusbar: { snapshot: Shaped<StatusbarSnapshot | null> }
  }
}
