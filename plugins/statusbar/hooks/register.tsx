import { atom, read, update } from 'claude-code'
import type {
  ApiContentBlock,
  EngineInterface,
  HttpResponse,
  Register,
  SessionContextUsage,
  SessionRateLimit,
  SessionUsage,
  Timer,
  TurnStepInput,
} from 'claude-code'

import type {
  StatusbarEffort,
  StatusbarFable,
  StatusbarSnapshot,
  StatusbarWindow,
} from '../types'

// 5시간·주간 한도와 컨텍스트는 엔진이 마지막 응답에서 읽은 값($.session.usage)을 쓴다.
// Fable 주간 한도는 플러그인에 넘어오지 않으므로 /usage가 읽는 claude.ai 사용량
// 엔드포인트의 limits[]에서 가져온다(Fable 모델일 때만).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const TICK_MS = 60_000
const FETCH_FLOOR_MS = 60_000
const FABLE_ACTIVE_REFRESH_MS = 5 * 60_000
const FABLE_IDLE_REFRESH_MS = 30 * 60_000
const BACKOFF_MS = 5 * 60_000
const BACKOFF_CAP_MS = 60 * 60_000
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// 글자와 장식은 사용자의 테마(라이트·다크)를 따르는 테마 키로 쓴다.
const BRAND = 'claude'
const MUTED = 'inactive'
const FAINT = 'subtle'
// 한 글자 라벨이 서로 구분되도록 각자 테마 색을 입힌다. 그 밖의 라벨은 MUTED.
const LABEL_COLORS: Readonly<Record<string, string>> = {
  C: 'claude',
  S: 'suggestion',
  W: 'planMode',
}
// 바의 색은 남은 비율의 단계: 라이트·다크 양쪽에서 검증된 고정 상태 색이다.
const STATUS_COLORS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const
// 채운 칸과 빈 칸은 굵기가 달라서 색이 안 보이는 터미널에서도 양이 읽힌다.
const FILLED = '━'
const TRACK = '─'
// effort 5단계(low…max)를 채워진 원과 빈 원으로 보인다.
const EFFORT_ON = '●'
const EFFORT_OFF = '○'
// /effort 선택 창과 같은 색: high까지는 단색, xhigh는 반짝임, max는 흐르는 무지개.
const EFFORT_COLORS: Readonly<Record<string, string>> = {
  low: 'warning',
  medium: 'success',
  high: 'permission',
}
const SHIMMER_BASE = 'autoAccept'
const SHIMMER_HIGHLIGHT = '#d0b4ff'
const RAINBOW = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]
const FRAME_MS = 100
// 힌트 줄은 화면 너비만 알려 주므로 좌우 여백을 빼고 배치한다.
const FOOTER_INSET = 4
const FALLBACK_COLUMNS = 120
const MIN_COLUMNS = 20
// 엔진의 힌트 줄과 상태 줄 사이의 빈 줄 수.
const ROW_GAP = 0

const snapshotAtom = atom({ plugin: 'statusbar', key: 'snapshot' } as const, null, {
  shape: 'v1',
})

type Seed = { fiveHour?: StatusbarWindow; sevenDay?: StatusbarWindow }
type Json = Record<string, unknown>

type State = {
  effort: StatusbarEffort
  fable: StatusbarFable
  seed: Seed
  hasPlan: boolean
  isLive: boolean
  isUsedSinceFetch: boolean
  isFableRequested: boolean
  isFetching: boolean
  lastAttemptAt: number
  lastFetchedAt: number
  retryAt: number
  failures: number
  published: string | undefined
  ticker: Timer | undefined
  animator: Timer | undefined
  isReducedMotion: boolean
  queue: Promise<void>
  isQueued: boolean
}

// 애니메이션의 현재 칸. 움직임을 줄인 설정이면 undefined로 멈춘 모습을 그린다.
type Frame = number | undefined

export type SpanStyle = { color?: string; dimColor?: boolean; bold?: boolean }
export type Span = { text: string; style?: SpanStyle }

type Variant = { rows: 'one' | 'two' | 'stack'; bar: number; extras: boolean }
type ResetStyle = 'minutes' | 'hours'

// 넓은 것부터 시도해 줄 너비에 맞는 첫 배치를 쓴다: 한 줄 → 두 줄 → 항목별 줄.
const VARIANTS: readonly Variant[] = [
  { rows: 'one', bar: 10, extras: true },
  { rows: 'one', bar: 8, extras: true },
  { rows: 'one', bar: 6, extras: true },
  { rows: 'two', bar: 10, extras: true },
  { rows: 'two', bar: 8, extras: true },
  { rows: 'two', bar: 6, extras: true },
  { rows: 'two', bar: 6, extras: false },
  { rows: 'stack', bar: 8, extras: true },
  { rows: 'stack', bar: 5, extras: false },
]

export const register: Register = on => {
  const state: State = {
    effort: { kind: 'unknown' },
    fable: { kind: 'unknown' },
    seed: {},
    hasPlan: true,
    isLive: true,
    isUsedSinceFetch: false,
    isFableRequested: false,
    isFetching: false,
    lastAttemptAt: Number.NEGATIVE_INFINITY,
    lastFetchedAt: Number.NEGATIVE_INFINITY,
    retryAt: 0,
    failures: 0,
    published: undefined,
    ticker: undefined,
    animator: undefined,
    isReducedMotion: false,
    queue: Promise.resolve(),
    isQueued: false,
  }

  on('session.start', async ($, e, next) => {
    state.isLive = e.isInteractive
    if (state.isLive) {
      // 0.1.0이 고정해 둔 한 줄짜리 상태줄을 걷어 낸다.
      $.ui.status(undefined)
      await restore($, state)
      if (state.effort.kind === 'unknown') state.effort = await configuredEffort($)
      state.isReducedMotion = await prefersReducedMotion($)
      state.ticker?.cancel()
      state.ticker = $.clock.every(TICK_MS, () => void refresh($, state))
      syncAnimation($, state)
      schedule($, state)
    }

    return next(e)
  })

  on('session.measure', ($, e, next) => {
    state.isUsedSinceFetch = true
    schedule($, state)

    return next(e)
  }).catch(($, e, next) => next(e))

  // 메인 스레드의 모델 요청마다 실제로 보내는 effort를 읽는다. 응답 스트림은 손대지 않고
  // 그대로 넘기며, 이 앞에서는 아무것도 기다리지 않는다.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) noteStepEffort($, state, e.effort)

    return yield* next(e)
  })

  // /effort(선택 창 포함)의 결과 줄은 대화에 명령 출력으로 쌓인다: 다음 요청 전에 바로 반영한다.
  on('session.append', { door: ['command', 'notice'] }, ($, e, next) => {
    const level = effortFrom(textOfBlocks(e.message.content))
    if (level !== undefined) noteEffort($, state, { kind: 'level', level })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    state.effort = await configuredEffort($, e.to_model)
    if (isFable(e.to_model)) state.isFableRequested = true
    syncAnimation($, state)
    schedule($, state)

    return next(e)
  }).catch(($, e, next) => next(e))

  // 프롬프트 아래 힌트 줄. 엔진의 그림(next)을 그대로 품으면 엔진은 자기 줄(모드·
  // 단축키 힌트·필)을 살려 두고, 이 트리는 그 아래 줄에 그린다.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const own = await next(e)
    const snapshot = await read($, snapshotAtom)
    if (snapshot === null) return own
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(MIN_COLUMNS, (e.viewport?.columns ?? FALLBACK_COLUMNS) - FOOTER_INSET)
    const frame = state.isReducedMotion ? undefined : Math.floor((await $.clock.now()) / FRAME_MS)

    // 엔진의 힌트 줄 아래 ROW_GAP 줄을 띄우고 상태 줄을 그린다.
    return (
      <Box flexDirection="column">
        {own}
        <Box flexDirection="column" marginTop={ROW_GAP}>
          {layoutRows(snapshot, columns, frame).map(row => (
            <Text wrap="truncate-end">
              {row.map(part =>
                part.style === undefined ? part.text : <Text {...part.style}>{part.text}</Text>,
              )}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

async function restore($: EngineInterface, state: State): Promise<void> {
  // 다시 불러와도 effort와 Fable 값을 잃지 않도록 마지막 스냅숏에서 되살린다.
  const previous = await read($, snapshotAtom)
  if (previous === null) return
  state.effort = previous.effort
  if (previous.fable !== undefined) state.fable = previous.fable
  if (previous.fableFetchedAt !== undefined) state.lastFetchedAt = previous.fableFetchedAt
}

// 첫 요청 전에는 보낼 effort를 알 길이 없으므로 엔진이 읽는 설정에서 미리 짐작한다:
// 환경 변수 → 모델별 설정(modelSettings) → effortLevel. 첫 요청이 실제 값으로 고친다.
async function configuredEffort($: EngineInterface, model?: string): Promise<StatusbarEffort> {
  try {
    const [fromEnv, settings, current] = await Promise.all([
      $.env.get('CLAUDE_CODE_EFFORT_LEVEL'),
      $.settings.read(),
      model === undefined ? $.session.model() : Promise.resolve(model),
    ])
    const modelSettings = isRecord(settings.modelSettings) ? settings.modelSettings[current] : undefined
    const perModel = isRecord(modelSettings) ? modelSettings.effortLevel : undefined
    const level = [fromEnv, perModel, settings.effortLevel].find(
      (value): value is string => typeof value === 'string' && EFFORT_LEVELS.includes(value),
    )

    return level === undefined ? { kind: 'unknown' } : { kind: 'level', level }
  } catch (error) {
    $.ui.log(`statusbar: effort setting not read: ${describe(error)}`, { to: 'debug' })

    return { kind: 'unknown' }
  }
}

function noteStepEffort($: EngineInterface, state: State, effort: TurnStepInput['effort']): void {
  try {
    noteEffort($, state, effort === undefined ? { kind: 'none' } : { kind: 'level', level: String(effort) })
  } catch (error) {
    // 상태 줄의 실패가 모델 응답 스트림에 번지지 않게 여기서 끊는다.
    $.ui.log(`statusbar: effort not noted: ${describe(error)}`, { to: 'debug' })
  }
}

function noteEffort($: EngineInterface, state: State, effort: StatusbarEffort): void {
  if (JSON.stringify(effort) === JSON.stringify(state.effort)) return
  state.effort = effort
  syncAnimation($, state)
  schedule($, state)
}

// xhigh·max일 때만 100ms마다 힌트 줄을 다시 그려 반짝임과 무지개를 흐르게 한다.
function syncAnimation($: EngineInterface, state: State): void {
  const { effort } = state
  const isAnimated = effort.kind === 'level' && (effort.level === 'xhigh' || effort.level === 'max')
  const shouldRun = state.isLive && !state.isReducedMotion && isAnimated
  if (shouldRun && state.animator === undefined) {
    state.animator = $.clock.every(FRAME_MS, () => $.ui.invalidate('ui.render'))
  }
  if (!shouldRun && state.animator !== undefined) {
    state.animator.cancel()
    state.animator = undefined
  }
}

async function prefersReducedMotion($: EngineInterface): Promise<boolean> {
  try {
    const settings: Record<string, unknown> = await $.settings.read()

    return settings.prefersReducedMotion === true
  } catch {
    return false
  }
}

function schedule($: EngineInterface, state: State): void {
  if (state.isLive) $.clock.after(0, () => void refresh($, state))
}

function refresh($: EngineInterface, state: State): Promise<void> {
  if (state.isQueued) return state.queue
  state.isQueued = true
  state.queue = state.queue.then(() => {
    state.isQueued = false

    return runRefresh($, state)
  })

  return state.queue
}

async function runRefresh($: EngineInterface, state: State): Promise<void> {
  try {
    const { model, usage, now } = await publish($, state)
    if (isFetchDue(state, model, usage, now)) {
      void fetchPlanUsage($, state, now).then(() => refresh($, state))
    }
  } catch (error) {
    $.ui.log(`statusbar: refresh failed: ${describe(error)}`, { to: 'debug' })
  }
}

async function publish($: EngineInterface, state: State) {
  const [model, usage, now] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.clock.now(),
  ])
  const snapshot = snapshotOf(state, model, usage, now)
  // 카운트다운은 분 단위라 같은 분 안에서는 다시 쓰지 않는다.
  const key = JSON.stringify({ ...snapshot, now: Math.floor(now / 60_000) })
  if (key !== state.published) {
    state.published = key
    await update($, snapshotAtom, () => snapshot)
  }

  return { model, usage, now }
}

function snapshotOf(
  state: State,
  model: string,
  usage: SessionUsage,
  now: number,
): StatusbarSnapshot {
  const fiveHour = pickWindow(usage.rateLimits, 'five_hour') ?? state.seed.fiveHour
  const sevenDay = pickWindow(usage.rateLimits, 'seven_day') ?? state.seed.sevenDay

  return {
    model,
    effort: state.effort,
    context: contextOf(usage.context),
    now,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(state.hasPlan ? { fable: state.fable } : {}),
    ...(Number.isFinite(state.lastFetchedAt) ? { fableFetchedAt: state.lastFetchedAt } : {}),
  }
}

function isFetchDue(state: State, model: string, usage: SessionUsage, now: number): boolean {
  if (!state.hasPlan || state.isFetching || now < state.retryAt) return false
  if (now - state.lastAttemptAt < FETCH_FLOOR_MS) return false
  // 새 세션은 첫 응답 전까지 헤더 값이 없으니 한 번 채워 둔다.
  const hasNoReading = state.lastFetchedAt === Number.NEGATIVE_INFINITY
  if (!isFable(model)) return usage.rateLimits.length === 0 && hasNoReading
  if (state.isFableRequested || state.fable.kind === 'unknown') return true
  const { fable } = state
  const resetsAt = fable.kind === 'reading' ? Date.parse(fable.window.resetsAt ?? '') : Number.NaN
  if (now >= resetsAt && state.lastFetchedAt < resetsAt) return true
  const age = now - state.lastFetchedAt

  return (state.isUsedSinceFetch && age >= FABLE_ACTIVE_REFRESH_MS) || age >= FABLE_IDLE_REFRESH_MS
}

async function fetchPlanUsage($: EngineInterface, state: State, now: number): Promise<void> {
  state.isFetching = true
  state.isFableRequested = false
  state.lastAttemptAt = now
  try {
    // 핸들은 발급 시점의 토큰을 담으므로 토큰이 갱신된 뒤의 401을 피하려고 매번 받는다.
    const auth = await $.session.authorize()
    if (auth === null || auth.kind !== 'bearer') {
      state.hasPlan = false
      $.ui.log('statusbar: no claude.ai login, so no plan limits to read', { to: 'debug' })
      return
    }
    const response = await $.http.fetch(USAGE_URL, {
      headers: { 'anthropic-beta': OAUTH_BETA },
      auth: auth.handle,
    })
    if (!response.ok) {
      state.failures += 1
      state.retryAt = now + backoffAfter(response, state.failures)
      $.ui.log(`statusbar: usage answered ${response.status}, next try at ${state.retryAt}`, {
        to: 'debug',
      })
      return
    }
    const body: unknown = JSON.parse(response.text)
    if (!isRecord(body)) throw new Error('the usage answer is not an object')
    state.seed = seedOf(body)
    state.fable = fableOf(body.limits)
    state.lastFetchedAt = now
    state.isUsedSinceFetch = false
    state.failures = 0
    state.retryAt = 0
    $.ui.log(`statusbar: usage ${summarize(body)}`, { to: 'debug' })
  } catch (error) {
    state.failures += 1
    state.retryAt = now + Math.min(BACKOFF_MS * 2 ** (state.failures - 1), BACKOFF_CAP_MS)
    $.ui.log(`statusbar: usage fetch failed: ${describe(error)}`, { to: 'debug' })
  } finally {
    state.isFetching = false
  }
}

export function layoutRows(snapshot: StatusbarSnapshot, columns: number, frame?: Frame): Span[][] {
  let rows: Span[][] = []
  for (const variant of VARIANTS) {
    rows = composeRows(snapshot, variant, frame)
    if (rows.every(row => widthOf(row) <= columns)) return rows
  }

  return rows
}

function composeRows(snapshot: StatusbarSnapshot, variant: Variant, frame: Frame): Span[][] {
  const head = headSpans(snapshot, frame)
  const context = contextMeter(snapshot, variant)
  const limits = limitMeters(snapshot, variant)
  const separator = [span('  '), span('│', { color: FAINT }), span('  ')]
  const joined = joinSpans(limits, [span('   ')])
  const rows =
    variant.rows === 'one'
      ? [joinSpans(limits.length > 0 ? [head, context, joined] : [head, context], separator)]
      : variant.rows === 'two'
        ? [joinSpans([head, context], separator), joined]
        : [head, context, ...limits]

  return rows.map(row => row.filter(part => part.text !== '')).filter(row => row.length > 0)
}

function headSpans(snapshot: StatusbarSnapshot, frame: Frame): Span[] {
  return [
    span('✻ ', { color: BRAND }),
    span(prettyModel(snapshot.model), { bold: true }),
    ...effortSpans(snapshot.effort, frame),
  ]
}

// 채워진 원과 이름에 단계 색을 입히고, 빈 원은 흐리게 둔다. 효과는 두 부분을 이어서 흐른다.
export function effortSpans(effort: StatusbarEffort, frame?: Frame): Span[] {
  if (effort.kind === 'none') return []
  if (effort.kind === 'unknown') return [span('  effort ?', { color: MUTED })]
  const lit = EFFORT_LEVELS.indexOf(effort.level) + 1
  if (lit === 0) return [span(`  ${effort.level}`)]
  const filled = EFFORT_ON.repeat(lit)
  const off = EFFORT_OFF.repeat(EFFORT_LEVELS.length - lit)
  const paint = painterFor(effort.level, filled.length + effort.level.length, frame)
  const painted = (text: string, offset: number) =>
    [...text].map((char, index) => span(char, paint(offset + index)))

  return [
    span('  '),
    ...painted(filled, 0),
    ...(off === '' ? [] : [span(off, { color: MUTED })]),
    span(' '),
    ...painted(effort.level, filled.length),
  ]
}

// 선택 창과 같은 규칙: xhigh는 (frame % (길이+4))번째 글자만 밝게, max는 글자마다 (위치+frame)번째 무지개색.
function painterFor(level: string, length: number, frame: Frame): (index: number) => SpanStyle {
  if (level === 'max') {
    const shift = frame ?? 0

    return index => ({ color: RAINBOW[(index + shift) % RAINBOW.length] ?? SHIMMER_BASE, bold: true })
  }
  if (level === 'xhigh') {
    const lit = frame === undefined ? -1 : frame % (length + 4)

    return index => ({ color: index === lit ? SHIMMER_HIGHLIGHT : SHIMMER_BASE, bold: true })
  }
  const color = EFFORT_COLORS[level] ?? BRAND

  return () => ({ color, bold: true })
}

function contextMeter(snapshot: StatusbarSnapshot, variant: Variant): Span[] {
  const { tokens, window, percent } = snapshot.context
  const size = window > 0 ? formatTokens(window) : '?'
  if (tokens === undefined) return meter('C', 0, MUTED, '—', `—/${size}`, variant)
  const used = Math.round(percent ?? (window > 0 ? (tokens / window) * 100 : 0))

  return usageMeter('C', used, `${formatTokens(tokens)}/${size}`, variant)
}

function limitMeters(snapshot: StatusbarSnapshot, variant: Variant): Span[][] {
  const { fiveHour, sevenDay, fable, now } = snapshot
  const meters: Span[][] = []
  if (fiveHour) meters.push(windowMeter('S', fiveHour, now, variant, 'minutes'))
  if (sevenDay) meters.push(windowMeter('W', sevenDay, now, variant, 'hours'))
  if (fable && isFable(snapshot.model)) {
    if (fable.kind === 'unknown') meters.push(meter('Fable', 0, MUTED, '?', undefined, variant))
    if (fable.kind === 'absent') meters.push(meter('Fable', 0, MUTED, '—', undefined, variant))
    if (fable.kind === 'reading') {
      // 주간 한도와 같은 시각에 초기화되면 카운트다운은 주간 쪽에만 보인다.
      const hasOwnReset = !isSameInstant(fable.window.resetsAt, sevenDay?.resetsAt)
      meters.push(windowMeter('Fable', fable.window, now, variant, hasOwnReset ? 'hours' : undefined))
    }
  }

  return meters
}

function windowMeter(
  label: string,
  window: StatusbarWindow,
  now: number,
  variant: Variant,
  resetStyle: ResetStyle | undefined,
): Span[] {
  const reset = resetStyle === undefined ? undefined : resetIn(window.resetsAt, now, resetStyle)

  return usageMeter(label, Math.round(window.percentUsed), reset && `↻${reset}`, variant)
}

// 반올림한 사용률 하나에서 숫자·채움·색·경고 표시를 모두 끌어내 서로 어긋나지 않게 한다.
function usageMeter(label: string, used: number, extra: string | undefined, variant: Variant): Span[] {
  const status = statusOf(Math.max(0, 100 - used))

  return meter(label, used / 100, STATUS_COLORS[status], `${used}%`, extra, variant, status === 'critical')
}

// 남은 비율로 고르는 상태 단계: 50% 이하 주의, 25% 이하 경고, 10% 이하 위험.
export function statusOf(remaining: number): keyof typeof STATUS_COLORS {
  if (remaining <= 10) return 'critical'
  if (remaining <= 25) return 'serious'
  if (remaining <= 50) return 'warning'

  return 'good'
}

function meter(
  label: string,
  ratio: number,
  color: string,
  value: string,
  extra: string | undefined,
  variant: Variant,
  isCritical = false,
): Span[] {
  const width = variant.bar
  const filled = ratio <= 0 ? 0 : Math.min(width, Math.max(1, Math.round(ratio * width)))

  return [
    span(`${label} `, { color: LABEL_COLORS[label] ?? MUTED }),
    span(FILLED.repeat(filled), { color }),
    span(TRACK.repeat(width - filled), { color, dimColor: true }),
    span(` ${value}`, { bold: true }),
    ...(isCritical ? [span(' !', { color: STATUS_COLORS.critical, bold: true })] : []),
    ...(extra !== undefined && variant.extras ? [span(`  ${extra}`, { color: MUTED })] : []),
  ]
}

function span(text: string, style?: SpanStyle): Span {
  return style === undefined ? { text } : { text, style }
}

function joinSpans(groups: readonly Span[][], separator: readonly Span[]): Span[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [...separator, ...group]))
}

function widthOf(row: readonly Span[]): number {
  return row.reduce((sum, part) => sum + displayWidth(part.text), 0)
}

// 한글·한자·전각 문자는 터미널에서 두 칸을 차지한다.
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += isWide ? 2 : 1
  }

  return width
}

// 5시간 창은 분까지(3h54m), 주간 창은 하루 이상이면 일만(5d), 하루 미만이면 시간만(23h) 보인다.
export function resetIn(
  resetsAt: string | undefined,
  now: number,
  style: ResetStyle = 'minutes',
): string | undefined {
  if (resetsAt === undefined) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  if (at <= now) return '곧'
  const minutes = Math.ceil((at - now) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return style === 'hours' ? `${days}d` : `${days}d${hours}h`
  if (hours === 0) return `${minutes}m`

  return style === 'hours' ? `${hours}h` : `${hours}h${minutes % 60}m`
}

function isSameInstant(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false

  return Math.abs(Date.parse(a) - Date.parse(b)) < 60_000
}

export function formatTokens(count: number): string {
  if (count >= 999_500) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`

  return String(count)
}

export function prettyModel(id: string): string {
  const base = id.replace(/\[[^\]]*\]$/, '')
  const named = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base)
  if (named) return `${capitalize(named[1])} ${version(named[2], named[3])}`
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(base)
  if (legacy) return `${capitalize(legacy[3])} ${version(legacy[1], legacy[2])}`

  return base === '' ? '?' : base
}

export function isFable(model: string): boolean {
  return /fable/i.test(model)
}

// /effort가 남기는 두 문장: "Set effort level to max", 상한에 걸리면 "...; set to 'high' instead".
export function effortFrom(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const match =
    /\beffort '[a-z]+' exceeds the cap\b[^;]*; set to '([a-z]+)' instead/i.exec(text) ??
    /\bset effort level to ([a-z]+)/i.exec(text)
  const level = match?.[1]?.toLowerCase()

  return level !== undefined && EFFORT_LEVELS.includes(level) ? level : undefined
}

function textOfBlocks(blocks: readonly ApiContentBlock[]): string {
  return blocks
    .map(block => {
      const text: unknown = 'text' in block ? block.text : undefined

      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}

export function fableOf(limits: unknown): StatusbarFable {
  const rows = Array.isArray(limits) ? limits.filter(isRecord) : []
  const isFableRow = (row: Json) => {
    const name = modelNameOf(row)

    return name !== undefined && isFable(name) && typeof row.percent === 'number'
  }
  const row = rows.find(one => one.kind === 'weekly_scoped' && isFableRow(one)) ?? rows.find(isFableRow)
  if (row === undefined || typeof row.percent !== 'number') return { kind: 'absent' }

  return { kind: 'reading', window: windowFrom(row.percent, row.resets_at) }
}

function seedOf(body: Json): Seed {
  const fiveHour = windowOf(body.five_hour)
  const sevenDay = windowOf(body.seven_day)

  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
}

function pickWindow(
  rateLimits: readonly SessionRateLimit[],
  kind: string,
): StatusbarWindow | undefined {
  const found = rateLimits.find(limit => limit.kind === kind)

  return found && windowFrom(found.percentUsed, found.resetsAt)
}

function windowOf(raw: unknown): StatusbarWindow | undefined {
  if (!isRecord(raw) || typeof raw.utilization !== 'number') return undefined

  return windowFrom(raw.utilization, raw.resets_at)
}

function windowFrom(percentUsed: number, resetsAt: unknown): StatusbarWindow {
  return typeof resetsAt === 'string' ? { percentUsed, resetsAt } : { percentUsed }
}

function contextOf(context: SessionContextUsage): StatusbarSnapshot['context'] {
  return {
    window: context.window,
    ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
    ...(context.percent !== undefined ? { percent: context.percent } : {}),
  }
}

function backoffAfter(response: HttpResponse, failures: number): number {
  const retryAfterMs = Number(response.headers['retry-after']) * 1000
  const wait =
    Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.max(retryAfterMs, FETCH_FLOOR_MS)
      : BACKOFF_MS * 2 ** (failures - 1)

  return Math.min(wait, BACKOFF_CAP_MS)
}

function summarize(body: Json): string {
  const rows = Array.isArray(body.limits) ? body.limits.filter(isRecord) : []
  const described = rows.map(row => {
    const name = modelNameOf(row)

    return `${String(row.kind)}/${String(row.group)}${name ? `(${name})` : ''}=${String(row.percent)}`
  })
  const five = windowOf(body.five_hour)?.percentUsed
  const seven = windowOf(body.seven_day)?.percentUsed

  return `5h=${five ?? '-'} 7d=${seven ?? '-'} limits=[${described.join(', ')}]`
}

function modelNameOf(row: Json): string | undefined {
  const scope = row.scope
  const model = isRecord(scope) ? scope.model : undefined
  const name = isRecord(model) ? model.display_name : undefined

  return typeof name === 'string' ? name : undefined
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capitalize(word = ''): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function version(major = '', minor?: string): string {
  return minor === undefined ? major : `${major}.${minor}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
