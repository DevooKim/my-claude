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
  ToolCallInput,
  ToolCallResult,
  TurnStepInput,
} from 'claude-code'

import type {
  StatusbarEffort,
  StatusbarFable,
  StatusbarGit,
  StatusbarGitOperation,
  StatusbarSnapshot,
  StatusbarTodo,
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
// git은 파일을 바꾸는 도구가 끝날 때마다, 그리고 바깥(다른 터미널)에서 바꾼 것도 잡도록 주기적으로 읽는다.
const GIT_TICK_MS = 15_000
const GIT_TIMEOUT_MS = 10_000
// 끝나면 git 상태를 다시 읽는 도구와 할 일 목록을 바꾸는 도구.
const WATCHED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'EnterWorktree',
  'ExitWorktree',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
] as const
const TODO_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const TODO_STATUSES = ['pending', 'in_progress', 'completed']
// git 디렉터리에 남는 표시 파일로 진행 중인 작업을 알아본다.
const GIT_OPERATIONS: readonly (readonly [string, StatusbarGitOperation])[] = [
  ['rebase-merge', 'rebasing'],
  ['rebase-apply', 'rebasing'],
  ['MERGE_HEAD', 'merging'],
  ['CHERRY_PICK_HEAD', 'cherry-picking'],
  ['REVERT_HEAD', 'reverting'],
  ['BISECT_LOG', 'bisecting'],
]

// 글자와 장식은 사용자의 테마(라이트·다크)를 따르는 테마 키로 쓴다.
const BRAND = 'claude'
const MUTED = 'inactive'
const FAINT = 'subtle'
// 한 글자 라벨이 서로 구분되도록 각자 테마 색을 입힌다. 그 밖의 라벨은 MUTED.
const LABEL_COLORS: Readonly<Record<string, string>> = {
  C: 'claude',
  S: 'suggestion',
  W: 'planMode',
  T: 'success',
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
// git 줄은 셸 프롬프트(starship)와 같은 모양·색으로 그린다: 경로는 굵은 하늘색, 브랜치는 굵은
// 회색, 상태는 노란색으로 붙여 쓴다(=충돌 $스태시 ×삭제 »이름 바꿈 !수정 +스테이징 ?추적 안 함
// ⇡앞섬 ⇣뒤처짐). yellow·gray·green은 터미널 팔레트의 그 색이다.
const PATH_COLOR = '#57C7FF'
const BRANCH_COLOR = 'gray'
const COMMIT_COLOR = 'green'
const GIT_STATUS_COLOR = 'yellow'
const MIN_BRANCH_COLUMNS = 12
// 할 일 줄: 할 일 하나에 점 하나(끝냄·진행 중·남음).
const MAX_TODO_DOTS = 10

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
  git: StatusbarGit | undefined
  gitTicker: Timer | undefined
  gitQueue: Promise<void>
  isGitQueued: boolean
  todos: StatusbarTodo[]
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

// 할 일 줄도 넓은 것부터: 진행 중 항목을 40칸 → 24칸 → 12칸까지 줄이다가 개수만 남긴다.
const TODO_TEXT_COLUMNS = [40, 24, 12, 0]

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
    git: undefined,
    gitTicker: undefined,
    gitQueue: Promise.resolve(),
    isGitQueued: false,
    todos: [],
  }

  on('session.start', async ($, e, next) => {
    state.isLive = e.isInteractive
    if (state.isLive) {
      // 0.1.0이 고정해 둔 한 줄짜리 상태줄을 걷어 낸다.
      $.ui.status(undefined)
      await restore($, state)
      if (state.effort.kind === 'unknown') state.effort = await configuredEffort($)
      if (state.todos.length === 0) state.todos = await replayedTodos($)
      state.isReducedMotion = await prefersReducedMotion($)
      startLive($, state)
    }

    return next(e)
  })

  // /clear와 /resume은 다른 대화로 넘어가므로 할 일 목록도 비운다(다시 세울 때 새 대화에서 읽는다).
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') state.todos = []

    return next(e)
  }).catch(($, e, next) => next(e))

  // 도구의 결과는 손대지 않고 그대로 돌려준다: 끝난 뒤에 할 일과 git 상태만 따라 읽는다.
  on('tool.call', { tool: WATCHED_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    if (state.isLive) noteTool($, state, e, result)

    return result
  }).catch(($, e, next) => next(e))

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

  // /effort·/model(선택 창 포함)의 결과 줄은 대화에 명령 출력으로 쌓인다: 다음 요청 전에
  // 바로 반영한다. 사용자 플러그인의 classic.PostModelSwitch는 기본 보안 플러그인이
  // 건너뛰므로 모델 전환도 이 줄로 알아챈다.
  on('session.append', { door: ['command', 'notice'] }, ($, e, next) => {
    const text = textOfBlocks(e.message.content)
    const level = effortFrom(text)
    if (isModelSwitch(text)) {
      $.clock.after(0, () => void switchModel($, state, undefined, level))
    } else if (level !== undefined) {
      noteEffort($, state, { kind: 'level', level })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    await switchModel($, state, e.to_model)

    return next(e)
  }).catch(($, e, next) => next(e))

  // 프롬프트 아래 힌트 줄. 엔진의 그림(next)을 그대로 품으면 엔진은 자기 줄(모드·
  // 단축키 힌트·필)을 살려 두고, 이 트리는 그 아래 줄에 그린다.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const own = await next(e)
    const snapshot = await read($, snapshotAtom)
    if (snapshot === null) {
      // /clear는 새 세션 id로 넘어가며 세션의 $.state를 비우지만 session.start는 다시
      // 부르지 않고, 사용자 플러그인의 classic.SessionStart는 기본 보안 플러그인이 건너뛴다.
      // 그래서 이미 쓴 스냅숏이 비어 읽히면 그리기 밖(타이머)에서 다시 세운다.
      if (state.isLive && state.published !== undefined) {
        state.published = undefined
        state.todos = []
        $.clock.after(0, () => {
          startLive($, state)
          void replayedTodos($).then(todos => {
            if (todos.length === 0) return
            state.todos = todos
            schedule($, state)
          })
        })
      }

      return own
    }
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(MIN_COLUMNS, (e.viewport?.columns ?? FALLBACK_COLUMNS) - FOOTER_INSET)
    const now = await $.clock.now()
    const frame = state.isReducedMotion ? undefined : Math.floor(now / FRAME_MS)

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
  if (previous.git !== undefined) state.git = previous.git
  if (previous.todos !== undefined) state.todos = previous.todos
}

// 타이머를 새로 걸고 스냅숏을 다시 쓴다. 몇 번 불러도 같은 모습이 된다.
function startLive($: EngineInterface, state: State): void {
  state.ticker?.cancel()
  state.ticker = $.clock.every(TICK_MS, () => void refresh($, state))
  state.gitTicker?.cancel()
  state.gitTicker = $.clock.every(GIT_TICK_MS, () => void refreshGit($, state))
  state.animator?.cancel()
  state.animator = undefined
  syncAnimation($, state)
  state.published = undefined
  schedule($, state)
  $.clock.after(0, () => void refreshGit($, state))
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

// 바뀐 모델의 effort는 설정에서 다시 짐작한다. 같은 줄이 effort도 정했으면 그 값을 쓴다.
async function switchModel(
  $: EngineInterface,
  state: State,
  model?: string,
  level?: string,
): Promise<void> {
  try {
    const current = model ?? (await $.session.model())
    state.effort = level === undefined ? await configuredEffort($, current) : { kind: 'level', level }
    if (isFable(current)) state.isFableRequested = true
    syncAnimation($, state)
    schedule($, state)
  } catch (error) {
    $.ui.log(`statusbar: model switch not noted: ${describe(error)}`, { to: 'debug' })
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
  const [model, usage, now, current] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.clock.now(),
    read($, snapshotAtom),
  ])
  const snapshot = snapshotOf(state, model, usage, now)
  // 카운트다운은 분 단위라 같은 분 안에서는 다시 쓰지 않는다. 다만 /clear로 스냅숏이
  // 비었으면 같은 값이라도 다시 쓴다(신호보다 비우기가 늦어도 다음 갱신이 되살린다).
  const key = JSON.stringify({ ...snapshot, now: Math.floor(now / 60_000) })
  if (key !== state.published || current === null) {
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

  const { git } = state

  return {
    model,
    effort: state.effort,
    context: contextOf(usage.context),
    now,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(state.hasPlan ? { fable: state.fable } : {}),
    ...(Number.isFinite(state.lastFetchedAt) ? { fableFetchedAt: state.lastFetchedAt } : {}),
    ...(git ? { git } : {}),
    ...(state.todos.length > 0 ? { todos: state.todos } : {}),
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

function refreshGit($: EngineInterface, state: State): Promise<void> {
  if (!state.isLive) return Promise.resolve()
  if (state.isGitQueued) return state.gitQueue
  state.isGitQueued = true
  state.gitQueue = state.gitQueue.then(() => {
    state.isGitQueued = false

    return runGitRefresh($, state)
  })

  return state.gitQueue
}

async function runGitRefresh($: EngineInterface, state: State): Promise<void> {
  try {
    state.git = await readGit($)
    schedule($, state)
  } catch (error) {
    // 잠깐의 실패(시간 초과 등)로 줄이 깜빡이지 않도록 마지막 값을 둔다.
    $.ui.log(`statusbar: git status not read: ${describe(error)}`, { to: 'debug' })
  }
}

// 저장소 밖이거나 git이 상태를 못 읽으면 undefined: git 줄을 그리지 않는다. 다른 git 명령과
// index.lock을 다투지 않도록 선택적 잠금을 끄고 읽는다.
async function readGit($: EngineInterface): Promise<StatusbarGit | undefined> {
  const repo = await $.session.repo()
  if (repo === null) return undefined
  const [status, paths] = await Promise.all([
    readStatus($),
    runGit($, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']).catch(
      () => undefined,
    ),
  ])
  if (status === undefined) return undefined
  const [gitDir = '', commonDir = '', top = ''] = (paths ?? '').split('\n')
  // 연결된 워크트리는 자기 git 디렉터리가 공용 디렉터리와 다르다.
  const isWorktree = gitDir !== '' && commonDir !== '' && top !== '' && gitDir !== commonDir
  const operation = gitDir === '' ? undefined : await operationIn($, gitDir)

  return {
    project: baseName(repo.root),
    ...(isWorktree ? { worktree: baseName(top) } : {}),
    ...(operation !== undefined ? { operation } : {}),
    ...gitStatusOf(status),
  }
}

// 스태시 수(--show-stash)는 git 2.35부터라 그 전 git이면 빼고 다시 읽는다.
async function readStatus($: EngineInterface): Promise<string | undefined> {
  const args = ['status', '--porcelain=v2', '--branch']

  return (await runGit($, [...args, '--show-stash'])) ?? (await runGit($, args))
}

async function runGit($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['git', '--no-optional-locks', ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
  })

  return exitCode === 0 ? stdout : undefined
}

// 워크트리의 git 디렉터리는 작업 폴더 밖이라 파일 접근이 막힐 수 있다: 그때는 진행 중 표시만 뺀다.
async function operationIn($: EngineInterface, gitDir: string): Promise<StatusbarGitOperation | undefined> {
  try {
    const found = await Promise.all(GIT_OPERATIONS.map(([marker]) => $.fs.exists(`${gitDir}/${marker}`)))

    return GIT_OPERATIONS.find((_, index) => found[index] === true)?.[1]
  } catch {
    return undefined
  }
}

// `git status --porcelain=v2 --branch --show-stash`를 starship의 git_status처럼 센다. 각 항목의 XY는
// 스테이징(X)과 작업 트리(Y)의 상태다.
export function gitStatusOf(text: string): Omit<StatusbarGit, 'project' | 'worktree' | 'operation'> {
  const changes = { conflicted: 0, stashed: 0, deleted: 0, renamed: 0, modified: 0, staged: 0, untracked: 0 }
  let oid = ''
  let head = ''
  let upstream: StatusbarGit['upstream']
  for (const line of text.split('\n')) {
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
    const stash = /^# stash (\d+)$/.exec(line)
    const xy = line.slice(2, 4)
    if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length)
    else if (ab) upstream = { ahead: Number(ab[1]), behind: Number(ab[2]) }
    else if (stash) changes.stashed = Number(stash[1])
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line.startsWith('2 ')) changes.renamed += 1
      if (xy.includes('D')) changes.deleted += 1
      if (xy[1] === 'M' || xy[1] === 'A') changes.modified += 1
      if (xy[0] === 'M' || xy[0] === 'A' || xy[0] === 'T') changes.staged += 1
    } else if (line.startsWith('u ')) changes.conflicted += 1
    else if (line.startsWith('? ')) changes.untracked += 1
  }
  const isDetached = head === '(detached)' || head === ''

  return {
    ...(isDetached ? { commit: oid.slice(0, 7) } : { branch: head }),
    ...(upstream ? { upstream } : {}),
    changes,
  }
}

function noteTool($: EngineInterface, state: State, e: ToolCallInput, result: ToolCallResult): void {
  try {
    if (result.deny !== undefined || result.isError === true) return
    const tool = String(e.tool)
    // TodoWrite는 에이전트마다 따로 목록을 두므로 메인의 것만, 작업(Task*)은 함께 쓰는 목록이라 모두 읽는다.
    if (TODO_TOOLS.has(tool) && (tool !== 'TodoWrite' || e.agentId === undefined)) {
      const todos = applyTodoTool(state.todos, tool, toolInputOf(e), result.result)
      if (JSON.stringify(todos) !== JSON.stringify(state.todos)) {
        state.todos = todos
        schedule($, state)
      }

      return
    }
    if (result.isReadOnly !== true) $.clock.after(0, () => void refreshGit($, state))
  } catch (error) {
    $.ui.log(`statusbar: tool result not noted: ${describe(error)}`, { to: 'debug' })
  }
}

// tool.call의 입력은 도구 인자를 tool·tool_use_id 옆에 펼쳐 둔 값이다.
function toolInputOf(e: ToolCallInput): Json {
  const input: unknown = e

  return isRecord(input) ? input : {}
}

// 할 일 도구 하나의 결과를 목록에 반영한다. TodoWrite는 목록 전체를, TaskList는 작업 전체를 준다.
export function applyTodoTool(
  todos: readonly StatusbarTodo[],
  tool: string,
  input: Json,
  result: unknown,
): StatusbarTodo[] {
  const record = isRecord(result) ? result : {}
  switch (tool) {
    case 'TodoWrite':
      return (Array.isArray(input.todos) ? input.todos : []).flatMap(item =>
        isRecord(item) && typeof item.content === 'string' && isTodoStatus(item.status)
          ? [todoOf(undefined, item.content, item.status, item.activeForm)]
          : [],
      )
    case 'TaskCreate': {
      const task = isRecord(record.task) ? record.task : undefined
      if (task === undefined || typeof task.id !== 'string') return [...todos]
      const subject = typeof task.subject === 'string' ? task.subject : String(input.subject ?? '')

      return [...todos.filter(todo => todo.id !== task.id), todoOf(task.id, subject, 'pending', input.activeForm)]
    }
    case 'TaskUpdate': {
      const { taskId, status } = input
      if (record.success !== true || typeof taskId !== 'string') return [...todos]
      if (status === 'deleted') return todos.filter(todo => todo.id !== taskId)

      return todos.map(todo =>
        todo.id === taskId
          ? todoOf(
              todo.id,
              typeof input.subject === 'string' ? input.subject : todo.subject,
              isTodoStatus(status) ? status : todo.status,
              typeof input.activeForm === 'string' ? input.activeForm : todo.activeForm,
            )
          : todo,
      )
    }
    case 'TaskList':
      if (!Array.isArray(record.tasks)) return [...todos]

      return record.tasks.flatMap(task =>
        isRecord(task) && typeof task.id === 'string' && typeof task.subject === 'string' && isTodoStatus(task.status)
          ? [todoOf(task.id, task.subject, task.status, todos.find(todo => todo.id === task.id)?.activeForm)]
          : [],
      )
    case 'TaskGet': {
      const task = isRecord(record.task) ? record.task : undefined
      if (task === undefined || typeof task.id !== 'string' || !isTodoStatus(task.status)) return [...todos]
      const known = todos.find(todo => todo.id === task.id)
      const subject = typeof task.subject === 'string' ? task.subject : (known?.subject ?? '')
      const fresh = todoOf(task.id, subject, task.status, known?.activeForm)

      return known === undefined ? [...todos, fresh] : todos.map(todo => (todo === known ? fresh : todo))
    }
    default:
      return [...todos]
  }
}

function todoOf(id: string | undefined, subject: string, status: StatusbarTodo['status'], activeForm: unknown): StatusbarTodo {
  return {
    ...(id !== undefined ? { id } : {}),
    subject,
    status,
    ...(typeof activeForm === 'string' && activeForm !== '' ? { activeForm } : {}),
  }
}

function isTodoStatus(value: unknown): value is StatusbarTodo['status'] {
  return typeof value === 'string' && TODO_STATUSES.includes(value)
}

// 이어 붙인 세션은 상태가 비어 있으므로 대화에 남은 할 일 도구 호출을 차례로 다시 적용한다.
async function replayedTodos($: EngineInterface): Promise<StatusbarTodo[]> {
  try {
    let todos: StatusbarTodo[] = []
    for (const message of await $.session.messages()) {
      for (const use of message.toolUses) {
        if (TODO_TOOLS.has(use.tool) && use.isError !== true) {
          todos = applyTodoTool(todos, use.tool, use.input, use.result)
        }
      }
    }

    return todos
  } catch (error) {
    $.ui.log(`statusbar: todos not replayed: ${describe(error)}`, { to: 'debug' })

    return []
  }
}

// 사용량 줄(좁으면 여러 줄) 아래에 git 줄, 그 아래에 할 일 줄을 둔다. 뒤의 두 줄은
// 보일 것이 있을 때만 그린다.
export function layoutRows(snapshot: StatusbarSnapshot, columns: number, frame?: Frame): Span[][] {
  return [...usageRows(snapshot, columns, frame), ...gitRows(snapshot.git, columns), ...todoRows(snapshot, columns)]
}

function usageRows(snapshot: StatusbarSnapshot, columns: number, frame: Frame): Span[][] {
  let rows: Span[][] = []
  for (const variant of VARIANTS) {
    rows = composeRows(snapshot, variant, frame)
    if (rows.every(row => widthOf(row) <= columns)) return rows
  }

  return rows
}

// 셸 프롬프트처럼 이어 쓰고 · 로 나눈다: 프로젝트[/워크트리] · 브랜치 (진행 중 작업) · 상태.
// 넘치면 브랜치 이름을 줄인다.
function gitRows(git: StatusbarGit | undefined, columns: number): Span[][] {
  if (git === undefined) return []
  const full = gitSpans(git)
  const overflow = widthOf(full) - columns
  if (overflow <= 0) return [full]
  const head = git.branch ?? git.commit ?? '?'

  return [gitSpans(git, Math.max(MIN_BRANCH_COLUMNS, displayWidth(head) - overflow))]
}

function gitSpans(git: StatusbarGit, branchColumns = Number.POSITIVE_INFINITY): Span[] {
  const place = git.worktree === undefined ? git.project : `${git.project}/${git.worktree}`
  const status = gitStatusText(git)
  const groups = [
    [span(place, { color: PATH_COLOR, bold: true })],
    [
      // HEAD가 떨어지면 starship의 git_commit처럼 (커밋)을 브랜치 자리에 둔다.
      git.branch === undefined
        ? span(`(${git.commit ?? '?'})`, { color: COMMIT_COLOR, bold: true })
        : span(fitText(git.branch, branchColumns), { color: BRANCH_COLOR, bold: true }),
      ...(git.operation === undefined
        ? []
        : [span(` (${git.operation.toUpperCase()})`, { color: GIT_STATUS_COLOR, bold: true })]),
    ],
    status === '' ? [] : [span(status, { color: GIT_STATUS_COLOR })],
  ]

  return joinSpans(
    groups.filter(group => group.length > 0),
    [span(' '), span('·', { color: FAINT }), span(' ')],
  )
}

// starship의 $all_status$ahead_behind와 같은 순서·기호로 붙여 쓴다. 깨끗하고 upstream과 같으면 빈 글자.
export function gitStatusText(git: Pick<StatusbarGit, 'changes' | 'upstream'>): string {
  const { conflicted, stashed, deleted, renamed, modified, staged, untracked } = git.changes
  const marks: readonly [number, string][] = [
    [conflicted, '='],
    [stashed, '$'],
    [deleted, '×'],
    [renamed, '»'],
    [modified, '!'],
    [staged, '+'],
    [untracked, '?'],
  ]
  const ahead = git.upstream?.ahead ?? 0
  const behind = git.upstream?.behind ?? 0

  return [
    ...marks.filter(([count]) => count > 0).map(([count, mark]) => `${mark}${count}`),
    ...(ahead > 0 ? [`⇡${ahead}`] : []),
    ...(behind > 0 ? [`⇣${behind}`] : []),
  ].join('')
}

// 할 일 줄: 다 끝냈거나 비었으면 그리지 않는다. 넘치면 진행 중 항목 글자를 줄인다.
function todoRows(snapshot: StatusbarSnapshot, columns: number): Span[][] {
  const todos = todoProgress(snapshot.todos)
  if (todos === undefined) return []
  let row: Span[] = []
  for (const textColumns of TODO_TEXT_COLUMNS) {
    row = todoSpans(todos, textColumns)
    if (widthOf(row) <= columns) return [row]
  }

  return [row]
}

// 사용량 줄의 미터처럼 라벨 T를 붙이고, 할 일 하나를 점 하나로 그린다: 끝냄 초록, 진행 중 주황, 남음 빈 점.
function todoSpans(todos: TodoProgress, textColumns: number): Span[] {

  return [
    span('T ', { color: LABEL_COLORS.T ?? MUTED }),
    ...todoDots(todos),
    span(` ${todos.done}/${todos.total}`, { bold: true }),
    ...(textColumns > 0 && todos.current !== undefined ? [span(`  ${fitText(todos.current, textColumns)}`)] : []),
  ]
}

// 할 일이 MAX_TODO_DOTS개를 넘으면 그 개수의 점에 비율로 나눠 담는다.
function todoDots({ done, active, total }: TodoProgress): Span[] {
  const width = Math.min(total, MAX_TODO_DOTS)
  const doneDots = Math.min(width, Math.round((done * width) / total))
  const activeDots = active === 0 ? 0 : Math.min(width - doneDots, Math.max(1, Math.round((active * width) / total)))
  const pendingDots = width - doneDots - activeDots

  return [
    ...(doneDots > 0 ? [span(EFFORT_ON.repeat(doneDots), { color: STATUS_COLORS.good })] : []),
    ...(activeDots > 0 ? [span(EFFORT_ON.repeat(activeDots), { color: BRAND })] : []),
    ...(pendingDots > 0 ? [span(EFFORT_OFF.repeat(pendingDots), { color: MUTED })] : []),
  ]
}

type TodoProgress = { done: number; active: number; total: number; current?: string }

// 다 끝냈거나 비었으면 undefined: 엔진처럼 목록을 감춘다. 진행 중인 항목은 activeForm으로 부른다.
export function todoProgress(todos: readonly StatusbarTodo[] | undefined): TodoProgress | undefined {
  if (todos === undefined || todos.length === 0) return undefined
  const done = todos.filter(todo => todo.status === 'completed').length
  if (done === todos.length) return undefined
  const running = todos.filter(todo => todo.status === 'in_progress')
  const current = running[0]

  return {
    done,
    active: running.length,
    total: todos.length,
    ...(current ? { current: current.activeForm ?? current.subject } : {}),
  }
}

// 너비(칸)에 맞게 자르고 끝에 …을 붙인다. 한글은 두 칸으로 센다.
export function fitText(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text
  if (columns < 1) return ''
  let kept = ''
  let width = 0
  for (const char of text) {
    const next = width + displayWidth(char)
    if (next > columns - 1) break
    kept += char
    width = next
  }

  return `${kept}…`
}

function composeRows(snapshot: StatusbarSnapshot, variant: Variant, frame: Frame): Span[][] {
  const head = headSpans(snapshot, frame)
  const context = contextMeter(snapshot, variant)
  const limits = limitMeters(snapshot, variant)
  const separator = [span(' '), span('·', { color: FAINT }), span(' ')]
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

// /model이 남기는 문장: "Set model to `Sonnet 5.5` and saved as your default for new sessions".
export function isModelSwitch(text: string): boolean {
  return /\bset model to\b/i.test(text)
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

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
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
