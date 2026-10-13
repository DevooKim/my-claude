import { atom, read, update } from 'claude-code'
import type { Register, TurnUsage } from 'claude-code'

import type { PromptBandCache } from '../types'

const cacheAtom = atom({ plugin: 'prompt-band', key: 'cache' } as const, null)

// 글자와 장식은 사용자의 테마(라이트·다크)를 따르는 테마 키로 쓴다.
const MUTED = 'inactive'
// 상태 색: statusbar와 같은, 라이트·다크 양쪽에서 검증된 고정 색이다.
const STATUS_COLORS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const
// 캐시 적중률을 25% 단위로 내려 원 조각으로 보인다: 꽉 찬 원은 100%일 때만. 숫자는 1% 단위 그대로.
const PIE = ['○', '◔', '◑', '◕', '●']

export type SpanStyle = { color?: string; bold?: boolean }
export type Span = { text: string; style?: SpanStyle }

export const register: Register = on => {
  // 메인 스레드의 응답 스트림은 그대로 흘려보내고, 응답이 끝나는 stop 조각에서 캐시 사용량만 읽는다.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      if (e.agentId === undefined && step.value.kind === 'stop') {
        const cache = cacheOf(step.value.usage)
        if (cache !== undefined) await update($, cacheAtom, () => cache)
      }
      yield step.value
      step = await stream.next()
    }

    return step.value
  })

  // 띠 자리는 하나라서, 아래 플러그인(또는 엔진)이 그린 것을 받아 그 위에 이 줄들을 쌓는다.
  // 설문이 떠 있거나 보일 값이 없으면 손대지 않고 넘긴다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const cache = await read($, cacheAtom)
    const rows = cache === null ? [] : [cacheRow(cache)]
    if (rows.length === 0) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const draw = (part: Span) =>
      part.style === undefined ? part.text : <Text {...part.style}>{part.text}</Text>

    // 줄마다 띠의 본문 너비(엔진의 [-] 자리를 뺀 칸)만큼 넓혀 오른쪽 끝에 붙인다.
    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Box flexDirection="row" justifyContent="flex-end" width={e.props.bodyColumns}>
            <Text wrap="truncate-end">{row.map(draw)}</Text>
          </Box>
        ))}
        {below}
      </Box>
    )
  })
}

export function cacheOf(usage: TurnUsage | null): PromptBandCache | undefined {
  if (usage === null) return undefined
  const read = usage.cache_read_input_tokens
  const total = usage.input_tokens + read + usage.cache_creation_input_tokens

  return total > 0 ? { read, total } : undefined
}

export function cacheRow({ read, total }: PromptBandCache): Span[] {
  const hit = Math.round((read / total) * 100)
  const color = STATUS_COLORS[cacheStatusOf(hit)]
  const pie = PIE[Math.floor((hit / 100) * (PIE.length - 1))] ?? PIE[0]

  return [
    { text: 'Cache ', style: { color: MUTED } },
    { text: pie, style: { color } },
    { text: ` ${hit}%`, style: { color, bold: true } },
    { text: `  ${formatTokens(read)}/${formatTokens(total)}`, style: { color: MUTED } },
  ]
}

// 캐시 적중률의 상태 단계. 이어지는 대화는 보통 90%를 넘으므로 높게 끊는다.
export function cacheStatusOf(hit: number): keyof typeof STATUS_COLORS {
  if (hit >= 90) return 'good'
  if (hit >= 70) return 'warning'
  if (hit >= 40) return 'serious'

  return 'critical'
}

export function formatTokens(count: number): string {
  if (count >= 999_500) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`

  return String(count)
}
