import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type {
  On,
  RenderElement,
  RenderSurface,
  SessionAuthorization,
  SessionRateLimit,
  SessionUsage,
  TurnStepInput,
} from 'claude-code'

import type { StatusbarSnapshot } from '../types'
import {
  displayWidth,
  effortFrom,
  effortSpans,
  fableOf,
  formatTokens,
  layoutRows,
  prettyModel,
  resetIn,
  statusOf,
} from '../hooks/register'
import type { Span } from '../hooks/register'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MINUTE = 60_000
const FIVE_RESET = '2026-10-12T14:13:00Z'
const WEEK_RESET = '2026-10-15T16:00:00Z'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const ENGINE_LINE = '? for shortcuts'

const HEADER_LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 28, resetsAt: FIVE_RESET },
  { kind: 'seven_day', percentUsed: 42, resetsAt: WEEK_RESET },
]

const LIMITS = 'S ━━━─────── 28%  ↻2h13m   W ━━━━────── 42%  ↻3d'
const OPUS_ROW = `✻ Opus 5.5  effort ?  │  C ━━──────── 23%  46k/200k  │  ${LIMITS}`

const usageOf = (rateLimits: SessionRateLimit[], tokens?: number): SessionUsage => ({
  startedAt: NOW,
  context:
    tokens === undefined
      ? { window: 200_000 }
      : { tokens, window: 200_000, percent: Math.round(tokens / 2000) },
  rateLimits,
  cost: { usd: 0 },
})

const usageBody = (fablePercent: number) =>
  JSON.stringify({
    five_hour: { utilization: 28, resets_at: FIVE_RESET },
    seven_day: { utilization: 42, resets_at: WEEK_RESET },
    limits: [
      { kind: 'weekly', group: 'weekly', percent: 42, resets_at: WEEK_RESET, scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: fablePercent,
        resets_at: WEEK_RESET,
        severity: 'normal',
        is_active: false,
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  })

type Answer = { status: number; text: string; headers?: Record<string, string> }

type World = {
  model: string
  usage: SessionUsage
  auth: SessionAuthorization
  answers: Answer[]
  isReducedMotion: boolean
  settings: Record<string, unknown>
  env: Record<string, string>
}

function setUp(on: On, initial: Partial<World> & Pick<World, 'model'>) {
  const world: World = {
    usage: usageOf(HEADER_LIMITS, 46_000),
    auth: { handle: 'auth_test', kind: 'bearer' },
    answers: [],
    isReducedMotion: false,
    settings: {},
    env: {},
    ...initial,
  }
  const fetches: { url: string; auth?: string; beta?: string }[] = []
  const clock = mock.clock(on, { now: NOW })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.model', () => ({ value: world.model }))
  on('session.usage', () => ({ value: world.usage }))
  on('session.authorize', () => ({ value: world.auth }))
  on('http.fetch', ($, e) => {
    fetches.push({ url: e.url, auth: e.init?.auth, beta: e.init?.headers?.['anthropic-beta'] })
    const answer = world.answers.shift() ?? { status: 200, text: usageBody(60) }
    const ok = answer.status >= 200 && answer.status < 300

    return { value: { status: answer.status, ok, headers: answer.headers ?? {}, text: answer.text } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('settings.read', () => ({ value: { ...world.settings, prefersReducedMotion: world.isReducedMotion } }))
  on('env.get', ($, e) => ({ value: world.env[e.name] }))
  const redraws = { count: 0 }
  on('ui.invalidate', ($, e, next) => {
    redraws.count += 1

    return next(e)
  })
  // 엔진 대신 힌트 줄을 그린다: 플러그인 트리는 이 줄을 그대로 품어야 한다.
  on('ui.render', () => ({ type: 'Box', children: [ENGINE_LINE] }))

  return { world, fetches, clock, redraws }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

// 메인 스레드(또는 agentId의 서브에이전트)의 모델 요청 하나를 끝까지 흘려보낸다.
async function step(
  $: Engine,
  request: { model: string; effort?: TurnStepInput['effort']; agentId?: string },
): Promise<void> {
  const stream = $.turn.step({
    turnId: 'turn-1',
    index: 0,
    messageCount: 1,
    model: request.model,
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
  })
  let chunk = await stream.next()
  while (chunk.done !== true) chunk = await stream.next()
}

// 프롬프트 아래 힌트 줄을 그려 줄마다의 글자를 돌려준다: 첫 줄은 엔진의 줄.
async function footer(
  $: Engine,
  options: { columns?: number; surface?: RenderSurface } = {},
): Promise<string[]> {
  const ui = await $.ui.mount({
    plugin: 'statusbar',
    surface: options.surface ?? 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: ENGINE_LINE },
    viewport: { columns: (options.columns ?? 160) + 4, rows: 40, isFullscreen: true },
  })
  const tree = await ui.drawn()
  await ui.unmount()
  const children = 'children' in tree ? (tree.children ?? []) : []
  if (children.length === 1 && children[0] === ENGINE_LINE) return [ENGINE_LINE]
  const [own = '', rowsBox = ''] = children
  // 상태 줄은 엔진의 줄 아래 ROW_GAP만큼 띄운 상자에 담긴다.
  expect(typeof rowsBox !== 'string' && rowsBox.type === 'Box' ? rowsBox.props?.marginTop : undefined).toBe(0)
  const rows = typeof rowsBox !== 'string' && 'children' in rowsBox ? (rowsBox.children ?? []) : []

  return [textOf(own), ...rows.map(textOf)]
}

// 엔진의 줄을 지켰는지 확인하고 그 아래 상태 줄만 돌려준다.
async function bar(
  $: Engine,
  options: { columns?: number; surface?: RenderSurface } = {},
): Promise<string[]> {
  const [own, ...rows] = await footer($, options)
  expect(own).toBe(ENGINE_LINE)

  return rows
}

function textOf(node: RenderElement | string): string {
  if (typeof node === 'string') return node
  const children: readonly (RenderElement | string)[] = 'children' in node ? (node.children ?? []) : []

  return children.map(textOf).join('')
}

const textOfRow = (row: readonly Span[]) => row.map(part => part.text).join('')

describe('status line under the prompt', () => {
  test('draws model, context and used limits as bars; effort from the next request', async ($, on) => {
    const { clock, fetches } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bar($, { surface })).toEqual([OPUS_ROW])
    }
    expect(fetches).toHaveLength(0)

    await step($, { model: 'claude-opus-5-5', effort: 'max' })
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Opus 5.5  ●●●●● max  │  C ')

    // 서브에이전트의 요청은 메인의 effort를 바꾸지 않는다.
    await step($, { model: 'claude-haiku-5-5', effort: 'low', agentId: 'sub-1' })
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Opus 5.5  ●●●●● max  │')
  })

  test('the /effort output row updates effort before the next request', async ($, on) => {
    const { clock } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text: '<local-command-stdout>Set effort level to high (this session only): Deep reasoning</local-command-stdout>',
          },
        ],
      },
      door: 'command',
      origin: { kind: 'composer' },
      uuid: 'row-effort',
    })
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Opus 5.5  ●●●○○ high  │')
  })

  test('before the first request effort comes from the settings', async ($, on) => {
    const { clock } = setUp(on, {
      model: 'claude-opus-5-5',
      settings: { effortLevel: 'low', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } },
    })

    await $.session.start(START)
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Opus 5.5  ●●●○○ high  │')
  })

  test('the effort environment variable wins over the settings', async ($, on) => {
    const { clock } = setUp(on, {
      model: 'claude-opus-5-5',
      settings: { effortLevel: 'low' },
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' },
    })

    await $.session.start(START)
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Opus 5.5  ●●○○○ medium  │')
  })

  test('a model that takes no effort shows none; the countdowns move with the clock', async ($, on) => {
    const { clock, world } = setUp(on, { model: 'claude-haiku-5-5' })

    await $.session.start(START)
    await step($, { model: world.model })
    await clock.settle()
    expect((await bar($))[0]).toBe(`✻ Haiku 5.5  │  C ━━──────── 23%  46k/200k  │  ${LIMITS}`)

    await clock.advance(60 * MINUTE)
    expect((await bar($))[0]).toEndWith('28%  ↻1h13m   W ━━━━────── 42%  ↻3d')
  })

  test('on Fable it adds the used Fable weekly limit from the usage endpoint', async ($, on) => {
    const { clock, fetches, world } = setUp(on, {
      model: 'claude-fable-5-1',
      answers: [{ status: 200, text: usageBody(60) }, { status: 200, text: usageBody(75) }],
    })

    await $.session.start(START)
    await clock.settle()
    expect(fetches).toEqual([{ url: USAGE_URL, auth: 'auth_test', beta: 'oauth-2025-04-20' }])
    expect((await bar($))[0]).toEndWith(`${LIMITS}   Fable ━━━━━━──── 60%`)

    // 쓰는 동안은 5분마다 다시 읽는다.
    await $.session.measure({
      context: world.usage.context,
      rateLimits: HEADER_LIMITS,
      changed: ['context'],
    })
    await clock.advance(4 * MINUTE)
    expect(fetches).toHaveLength(1)
    await clock.advance(MINUTE)
    expect(fetches).toHaveLength(2)
    expect((await bar($))[0]).toEndWith('Fable ━━━━━━━━── 75%')
  })

  test('a 429 keeps Fable at ? and waits out retry-after', async ($, on) => {
    const { clock, fetches } = setUp(on, {
      model: 'claude-fable-5-1',
      answers: [{ status: 429, text: '', headers: { 'retry-after': '600' } }],
    })

    await $.session.start(START)
    await clock.settle()
    expect((await bar($))[0]).toEndWith('Fable ────────── ?')

    await clock.advance(9 * MINUTE)
    expect(fetches).toHaveLength(1)
    await clock.advance(MINUTE)
    expect(fetches).toHaveLength(2)
    expect((await bar($))[0]).toEndWith('Fable ━━━━━━──── 60%')
  })

  test('switching to Fable resets effort and reads the Fable limit', async ($, on) => {
    const { clock, fetches, world } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await step($, { model: world.model, effort: 'max' })
    await clock.settle()
    expect(fetches).toHaveLength(0)

    world.model = 'claude-fable-5-1'
    await $.classic.PostModelSwitch({
      from_model: 'claude-opus-5-5',
      to_model: 'claude-fable-5-1',
      requested_model: 'fable',
      source: 'command',
      context_tokens: 46_000,
      prompt_cache_warm: true,
      cache_ttl: '1h',
      estimated_cache_write_usd: 0.5,
      pricing: 'catalog',
    })
    await clock.settle()
    expect(fetches).toHaveLength(1)
    const [row] = await bar($)
    expect(row).toStartWith('✻ Fable 5.1  effort ?  │')
    expect(row).toEndWith('Fable ━━━━━━──── 60%')
  })

  test('a fresh session reads 5h / weekly from the endpoint until a response reports them', async ($, on) => {
    const { clock, fetches } = setUp(on, { model: 'claude-opus-5-5', usage: usageOf([]) })

    await $.session.start(START)
    await clock.settle()
    expect(fetches).toHaveLength(1)
    expect(await bar($)).toEqual([`✻ Opus 5.5  effort ?  │  C ────────── —  —/200k  │  ${LIMITS}`])
  })

  test('an API-key session shows no plan limits and never calls the endpoint', async ($, on) => {
    const { clock, fetches } = setUp(on, {
      model: 'claude-fable-5-1',
      usage: usageOf([]),
      auth: { handle: 'auth_key', kind: 'api-key' },
    })

    await $.session.start(START)
    await clock.settle()
    await clock.advance(60 * MINUTE)
    expect(fetches).toHaveLength(0)
    expect(await bar($)).toEqual(['✻ Fable 5.1  effort ?  │  C ────────── —  —/200k'])
  })

  test('before the first reading only the engine line is drawn', async ($, on) => {
    setUp(on, { model: 'claude-opus-5-5' })

    expect(await footer($)).toEqual([ENGINE_LINE])
  })

  test('a narrow terminal wraps the bar into two rows under the engine line', async ($, on) => {
    const { clock } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await clock.settle()
    expect(await bar($, { columns: 80 })).toEqual([
      '✻ Opus 5.5  effort ?  │  C ━━──────── 23%  46k/200k',
      LIMITS,
    ])
  })
})

const SNAPSHOT: StatusbarSnapshot = {
  model: 'claude-fable-5-1',
  effort: { kind: 'level', level: 'max' },
  context: { tokens: 120_000, window: 200_000, percent: 60 },
  fiveHour: { percentUsed: 92, resetsAt: FIVE_RESET },
  sevenDay: { percentUsed: 42, resetsAt: WEEK_RESET },
  fable: { kind: 'reading', window: { percentUsed: 80, resetsAt: '2026-10-16T09:00:00Z' } },
  now: NOW,
}

describe('effort', () => {
  const styleOf = (level: string, frame?: number) =>
    effortSpans({ kind: 'level', level }, frame).filter(part => part.text.trim() !== '')

  test('low, medium and high wear the /effort picker colors', () => {
    for (const [level, color] of [['low', 'warning'], ['medium', 'success'], ['high', 'permission']]) {
      const parts = styleOf(level ?? '')
      const lit = parts.filter(part => part.text === '●' || /^[a-z]$/.test(part.text))
      expect(lit.every(part => part.style?.color === color && part.style?.bold === true)).toBe(true)
      expect(parts.find(part => part.text.startsWith('○'))?.style?.color).toBe('inactive')
    }
  })

  test('xhigh shimmers one character at a time, still when motion is reduced', () => {
    const lit = (frame?: number) =>
      styleOf('xhigh', frame)
        .filter(part => part.text !== '○')
        .map(part => part.style?.color === '#d0b4ff')
    expect(lit(0)).toEqual([true, false, false, false, false, false, false, false, false])
    expect(lit(5)).toEqual([false, false, false, false, false, true, false, false, false])
    expect(lit(undefined).some(Boolean)).toBe(false)
  })

  test('max runs a rainbow that shifts with the frame', () => {
    const colors = (frame?: number) => styleOf('max', frame).map(part => part.style?.color)
    expect(colors(0).slice(0, 3)).toEqual(['rainbow_red', 'rainbow_orange', 'rainbow_yellow'])
    expect(colors(2).slice(0, 2)).toEqual(['rainbow_yellow', 'rainbow_green'])
    expect(colors(undefined)[0]).toBe('rainbow_red')
  })

  test('xhigh and max redraw every 100ms, unless motion is reduced', async ($, on) => {
    const { clock, redraws } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await step($, { model: 'claude-opus-5-5', effort: 'max' })
    await clock.settle()
    const before = redraws.count
    await clock.advance(300)
    expect(redraws.count - before).toBe(3)

    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    await clock.settle()
    const stopped = redraws.count
    await clock.advance(300)
    expect(redraws.count).toBe(stopped)
  })

  test('reduced motion draws effort without redrawing', async ($, on) => {
    const { clock, redraws } = setUp(on, { model: 'claude-opus-5-5', isReducedMotion: true })

    await $.session.start(START)
    await step($, { model: 'claude-opus-5-5', effort: 'xhigh' })
    await clock.settle()
    const before = redraws.count
    await clock.advance(300)
    expect(redraws.count).toBe(before)
  })
})

describe('layout', () => {
  test('bar colors follow what is left and a critical limit gets a mark', () => {
    const [row = []] = layoutRows(SNAPSHOT, 200)
    const colorAfter = (label: string) =>
      row[row.findIndex(part => part.text === `${label} `) + 1]?.style?.color

    expect(colorAfter('C')).toBe('#fab219')
    expect(colorAfter('S')).toBe('#d03b3b')
    expect(colorAfter('W')).toBe('#0ca30c')
    expect(colorAfter('Fable')).toBe('#ec835a')
    expect(row.filter(part => part.text === ' !')).toHaveLength(1)
    expect(textOfRow(row)).toContain('S ━━━━━━━━━─ 92% !  ↻2h13m')
    expect(textOfRow(row)).toContain('Fable ━━━━━━━━── 80%  ↻3d')
  })

  test('status steps on what is left', () => {
    expect([100, 51, 50, 26, 25, 11, 10, 0].map(statusOf)).toEqual([
      'good',
      'good',
      'warning',
      'warning',
      'serious',
      'serious',
      'critical',
      'critical',
    ])
  })

  test('it narrows bars, then wraps to two rows, then stacks', () => {
    for (const columns of [200, 140, 100, 80, 60, 40, 30]) {
      const rows = layoutRows(SNAPSHOT, columns)
      const widest = Math.max(...rows.map(row => displayWidth(textOfRow(row))))
      expect(widest <= columns || columns === 30).toBe(true)
    }
    expect(layoutRows(SNAPSHOT, 200)).toHaveLength(1)
    expect(layoutRows(SNAPSHOT, 100)).toHaveLength(2)
    expect(layoutRows(SNAPSHOT, 40).length).toBeGreaterThan(2)
  })
})

describe('formatting', () => {
  test('model names', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(prettyModel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
    expect(prettyModel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(prettyModel('claude-3-7-sonnet-20250219')).toBe('Sonnet 3.7')
    expect(prettyModel('opus')).toBe('opus')
  })

  test('reset countdowns: minutes for 5h, hours under a day for weekly', () => {
    expect(resetIn('2026-10-12T15:54:00Z', NOW)).toBe('3h54m')
    expect(resetIn('2026-10-13T11:12:00Z', NOW, 'hours')).toBe('23h')
    expect(resetIn('2026-10-13T12:00:00Z', NOW, 'hours')).toBe('1d')
    expect(resetIn('2026-10-18T09:00:00Z', NOW, 'hours')).toBe('5d')
    expect(resetIn('2026-10-12T12:45:00Z', NOW, 'hours')).toBe('45m')
    expect(resetIn('2026-10-12T12:00:30Z', NOW)).toBe('1m')
    expect(resetIn('2026-10-12T11:59:00Z', NOW)).toBe('곧')
    expect(resetIn(undefined, NOW)).toBeUndefined()
  })

  test('token counts and display width', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(46_400)).toBe('46k')
    expect(formatTokens(518_000)).toBe('518k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(displayWidth('주간 ━━')).toBe(7)
  })

  test('effort from the /effort output', () => {
    expect(effortFrom('Set effort level to max (this session only): Maximum')).toBe('max')
    expect(
      effortFrom("Effort 'max' exceeds the cap for Haiku set by your settings; set to 'high' instead"),
    ).toBe('high')
    expect(effortFrom("Theme set to 'dark' instead")).toBeUndefined()
    expect(effortFrom('Effort picker closed')).toBeUndefined()
    expect(effortFrom(undefined)).toBeUndefined()
  })

  test('the Fable row of limits[]', () => {
    expect(fableOf(undefined)).toEqual({ kind: 'absent' })
    expect(fableOf([{ kind: 'weekly', percent: 10, scope: null }])).toEqual({ kind: 'absent' })
    expect(
      fableOf([
        { kind: 'weekly_scoped', percent: 12.5, resets_at: WEEK_RESET, scope: { model: { display_name: 'Fable 5.1' } } },
      ]),
    ).toEqual({ kind: 'reading', window: { percentUsed: 12.5, resetsAt: WEEK_RESET } })
  })
})
