export type StatusbarWindow = { percentUsed: number; resetsAt?: string }

export type StatusbarEffort =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'level'; level: string }

export type StatusbarFable =
  | { kind: 'unknown' }
  | { kind: 'absent' }
  | { kind: 'reading'; window: StatusbarWindow }

// 상태 줄이 그리는 한 시점의 값. fable이 없으면 요금제 한도가 없는 세션이다.
export type StatusbarSnapshot = {
  model: string
  effort: StatusbarEffort
  context: { tokens?: number; window: number; percent?: number }
  fiveHour?: StatusbarWindow
  sevenDay?: StatusbarWindow
  fable?: StatusbarFable
  fableFetchedAt?: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    statusbar: { snapshot: Shaped<StatusbarSnapshot | null> }
  }
}
