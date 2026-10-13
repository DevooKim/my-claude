// 마지막 응답의 입력 토큰 가운데 프롬프트 캐시가 읽어 준 몫: read가 total 중 얼마.
export type PromptBandCache = { read: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'prompt-band': { cache: PromptBandCache | null }
  }
}
