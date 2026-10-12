import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type {
  AgentInfo,
  On,
  RenderElement,
  RenderSurface,
  SessionAuthorization,
  SessionMessage,
  SessionRateLimit,
  SessionUsage,
  TurnStepInput,
} from 'claude-code'

import type { StatusbarGit, StatusbarSnapshot } from '../types'
import {
  agentLabel,
  applyTodoTool,
  displayWidth,
  effortFrom,
  effortSpans,
  fableOf,
  fitText,
  formatElapsed,
  formatTokens,
  gitStatusOf,
  gitStatusText,
  layoutRows,
  prettyModel,
  pullRequestOf,
  remoteOwner,
  resetIn,
  statusOf,
  todoProgress,
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

const ROOT = '/work/my-claude'
const REMOTE = 'https://github.com/DevooKim/my-claude.git'
const PR_URL = 'https://github.com/DevooKim/my-claude/pull/12'
const DRAFT_URL = 'https://github.com/DevooKim/my-claude/pull/7'
const OID = '1234567890abcdef1234567890abcdef12345678'
const porcelain = (...lines: string[]) => `${lines.join('\n')}\n`
// 스테이징 2(M., MM), 수정 2(.M, MM), 추적 안 함 3, upstream보다 2 앞서고 1 뒤처짐.
const FEATURE_STATUS = porcelain(
  `# branch.oid ${OID}`,
  '# branch.head feature/bar',
  '# branch.upstream origin/feature/bar',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 aaa bbb hooks/register.tsx',
  '1 .M N... 100644 100644 100644 aaa bbb README.md',
  '1 MM N... 100644 100644 100644 aaa bbb types/index.d.ts',
  '? notes.md',
  '? scratch/',
  '? todo.txt',
)
const GH_LIST = ['gh', 'pr', 'list', '--head']
const GH_FIELDS = ['--state', 'all', '--limit', '20', '--json', 'number,url,state,isDraft,headRepositoryOwner']
// gh pr list의 한 줄. 소유자가 다르면 같은 이름의 브랜치로 남의 포크에서 연 PR이다.
const prRow = (number: number, url: string, state: string, isDraft = false, login = 'DevooKim') => ({
  number,
  url,
  state,
  isDraft,
  headRepositoryOwner: { id: `U_${login}`, login },
})

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

// 세션이 선 저장소: git status의 출력, rev-parse의 세 경로, git 디렉터리에 있는 표시 파일.
type Repo = { root: string; remote: string | null; status: string; paths?: string; markers?: string[] }

type World = {
  model: string
  usage: SessionUsage
  auth: SessionAuthorization
  answers: Answer[]
  isReducedMotion: boolean
  settings: Record<string, unknown>
  env: Record<string, string>
  repo?: Repo
  isFsRefused: boolean
  isBashFailing: boolean
  prs: unknown[]
  agents: AgentInfo[]
  messages: SessionMessage[]
  bash: Record<string, unknown>
}

function setUp(on: On, initial: Partial<World> & Pick<World, 'model'>) {
  const world: World = {
    usage: usageOf(HEADER_LIMITS, 46_000),
    auth: { handle: 'auth_test', kind: 'bearer' },
    answers: [],
    isReducedMotion: false,
    settings: {},
    env: {},
    isFsRefused: false,
    isBashFailing: false,
    prs: [],
    agents: [],
    messages: [],
    bash: { stdout: '', stderr: '', interrupted: false },
    ...initial,
  }
  const fetches: { url: string; auth?: string; beta?: string }[] = []
  const clock = mock.clock(on, { now: NOW })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.PostModelSwitch', () => ({}))
  // /clear가 세션의 상태를 비운 모습: 플러그인이 다시 쓸 때까지 스냅숏은 비어 읽힌다.
  const session = { isWiped: false, wipe: () => void (session.isWiped = true) }
  on('state.get', { plugin: 'statusbar', key: 'snapshot' }, async ($, e, next) => {
    const held = await next(e)

    return session.isWiped && held.value !== undefined ? { value: { ...held.value, value: undefined } } : held
  })
  on('state.set', { plugin: 'statusbar', key: 'snapshot' }, ($, e, next) => {
    session.isWiped = false

    return next(e)
  })
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

  // git과 gh: 저장소 밖이면 git은 128로 끝난다.
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const ran = (exitCode: number, stdout: string, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    const [command, ...args] = e.argv
    const { repo } = world
    if (command === 'gh') return ran(0, JSON.stringify(world.prs))
    if (command === 'open') return ran(0, '')
    if (command !== 'git' || repo === undefined) return ran(128, '', 'fatal: not a git repository')
    if (args.includes('status')) return ran(0, repo.status)

    return ran(0, repo.paths ?? `${repo.root}/.git\n${repo.root}/.git\n${repo.root}\n`)
  })
  on('session.repo', () => ({
    value: world.repo === undefined ? null : { root: world.repo.root, remote: world.repo.remote, internal: false, name: null },
  }))
  // 작업 폴더 밖(워크트리의 git 디렉터리)을 막는 파일 가드가 있는 세션.
  on('fs.exists', ($, e) =>
    world.isFsRefused
      ? { deny: 'outside the workspace' }
      : { value: (world.repo?.markers ?? []).some(marker => e.path.endsWith(`/${marker}`)) },
  )
  on('agent.list', () => ({ value: world.agents }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: world.agents.at(-1)?.id ?? 'agent-0' }))
  on('session.messages', () => ({ value: world.messages }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  // 도구는 엔진이 답하듯 기록을 돌려준다. TaskCreate는 1부터 id를 매긴다.
  const tasks = { count: 0 }
  on('tool.call', ($, e) => {
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: e.todos } }
    if (e.tool === 'TaskCreate') {
      tasks.count += 1

      return { result: { task: { id: String(tasks.count), subject: e.subject } } }
    }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }

    if (world.isBashFailing) return { isError: true as const, result: 'GraphQL: Something went wrong', text: 'GraphQL: Something went wrong' }

    return { result: world.bash }
  })

  return { world, fetches, clock, redraws, session, runs }
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

// 프롬프트 아래 힌트 줄을 플러그인을 거쳐 그린 트리.
async function drawn(
  $: Engine,
  options: { columns?: number; surface?: RenderSurface } = {},
): Promise<RenderElement> {
  const ui = await $.ui.mount({
    plugin: 'statusbar',
    surface: options.surface ?? 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: ENGINE_LINE },
    viewport: { columns: (options.columns ?? 160) + 4, rows: 40, isFullscreen: true },
  })
  const tree = await ui.drawn()
  await ui.unmount()

  return tree
}

// 그린 트리의 버튼마다 주소(key)와 글자.
async function buttonsOf(
  $: Engine,
  options: { surface?: RenderSurface } = {},
): Promise<{ key: string; text: string }[]> {
  const found: { key: string; text: string }[] = []
  const walk = (node: RenderElement | string): void => {
    if (typeof node === 'string') return
    if (node.type === 'Button') found.push({ key: String(node.props.key), text: textOf(node) })
    for (const child of 'children' in node ? (node.children ?? []) : []) walk(child)
  }
  walk(await drawn($, options))

  return found
}

// 힌트 줄을 그린 채로 버튼 하나를 누른다.
async function press($: Engine, key: string): Promise<void> {
  const ui = await $.ui.mount({
    plugin: 'statusbar',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: ENGINE_LINE },
    viewport: { columns: 164, rows: 40, isFullscreen: true },
  })
  await ui.press({ key })
  await ui.unmount()
}

// 프롬프트 아래 힌트 줄을 그려 줄마다의 글자를 돌려준다: 첫 줄은 엔진의 줄.
async function footer(
  $: Engine,
  options: { columns?: number; surface?: RenderSurface } = {},
): Promise<string[]> {
  const tree = await drawn($, options)
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

  test('after /clear empties the session state the bar is drawn again at once', async ($, on) => {
    const { clock, session } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    await clock.settle()
    const before = await bar($)

    // /clear: 세션의 상태가 비고 아무 신호 없이 힌트 줄만 다시 그려진다. 값은 그대로다.
    session.wipe()
    expect(await footer($)).toEqual([ENGINE_LINE])
    await clock.settle()
    expect(await bar($)).toEqual(before)
    expect(before[0]).toStartWith('✻ Opus 5.5  ●●●○○ high  │')
  })

  test('an emptied snapshot is written again by the next refresh in the same minute', async ($, on) => {
    const { clock, session, world } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW])

    session.wipe()
    await $.session.measure({ context: world.usage.context, rateLimits: HEADER_LIMITS, changed: ['context'] })
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW])
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

  test('the /model output row switches the model at once', async ($, on) => {
    const { clock, world } = setUp(on, {
      model: 'claude-opus-5-5',
      settings: { modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'medium' } } },
    })

    await $.session.start(START)
    await step($, { model: world.model, effort: 'max' })
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Opus 5.5  ●●●●● max  │')

    // classic.PostModelSwitch 없이 /model의 결과 줄만 온다.
    world.model = 'claude-sonnet-5-5'
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text: '<local-command-stdout>Set model to `Sonnet 5.5` and saved as your default for new sessions</local-command-stdout>',
          },
        ],
      },
      door: 'command',
      origin: { kind: 'composer' },
      uuid: 'row-model',
    })
    await clock.settle()
    expect((await bar($))[0]).toStartWith('✻ Sonnet 5.5  ●●○○○ medium  │')
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

describe('git row', () => {
  test('project, branch, changes and upstream, then the PR as a link to its page', async ($, on) => {
    const { clock, runs } = setUp(on, {
      model: 'claude-opus-5-5',
      repo: { root: ROOT, remote: REMOTE, status: FEATURE_STATUS },
      // 더 최근의 첫 줄은 남의 포크에서 같은 이름의 브랜치로 연 PR이다.
      prs: [prRow(40, 'https://github.com/DevooKim/my-claude/pull/40', 'OPEN', false, 'stranger'), prRow(12, PR_URL, 'OPEN')],
    })

    await $.session.start(START)
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bar($, { surface })).toEqual([OPUS_ROW, 'my-claude · feature/bar · !2+2?3⇡2⇣1 · PR #12'])
      expect(await buttonsOf($, { surface })).toEqual([{ key: `open:${PR_URL}`, text: 'PR #12' }])
    }
    // git은 선택적 잠금 없이 읽어 모델의 git 명령과 index.lock을 다투지 않는다.
    expect(runs.filter(argv => argv[0] === 'git').every(argv => argv[1] === '--no-optional-locks')).toBe(true)
    expect(runs.filter(argv => argv[0] === 'gh')).toEqual([[...GH_LIST, 'feature/bar', ...GH_FIELDS]])
  })

  test('a file guard that refuses the git directory only drops the operation mark', async ($, on) => {
    const { clock } = setUp(on, {
      model: 'claude-opus-5-5',
      isFsRefused: true,
      repo: {
        root: ROOT,
        remote: REMOTE,
        status: porcelain(`# branch.oid ${OID}`, '# branch.head worktree-fix-bar'),
        paths: `${ROOT}/.git/worktrees/fix-bar\n${ROOT}/.git\n${ROOT}/.claude/worktrees/fix-bar\n`,
        markers: ['MERGE_HEAD'],
      },
    })

    await $.session.start(START)
    await clock.settle()
    expect((await bar($))[1]).toBe('my-claude/fix-bar · worktree-fix-bar')
  })

  test('a linked worktree, a rebase on a detached HEAD and a conflict; no PR lookup', async ($, on) => {
    const { clock, runs } = setUp(on, {
      model: 'claude-opus-5-5',
      repo: {
        root: ROOT,
        remote: REMOTE,
        status: porcelain(
          `# branch.oid ${OID}`,
          '# branch.head (detached)',
          'u UU N... 100644 100644 100644 100644 aaa bbb ccc hooks/register.tsx',
        ),
        paths: `${ROOT}/.git/worktrees/fix-bar\n${ROOT}/.git\n${ROOT}/.claude/worktrees/fix-bar\n`,
        markers: ['rebase-merge'],
      },
    })

    await $.session.start(START)
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW, 'my-claude/fix-bar · (1234567) (REBASING) · =1'])
    expect(runs.some(argv => argv[0] === 'gh')).toBe(false)
  })

  test('without an upstream it says so; a PR command asks gh again at once, then every 5 minutes', async ($, on) => {
    const repo: Repo = { root: ROOT, remote: REMOTE, status: porcelain(`# branch.oid ${OID}`, '# branch.head topic') }
    const { clock, runs, world } = setUp(on, { model: 'claude-opus-5-5', repo })
    const asked = () => runs.filter(argv => argv[0] === 'gh').length

    await $.session.start(START)
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW, 'my-claude · topic'])
    expect(asked()).toBe(1)

    // 모델이 푸시하고 초안 PR을 연다: Bash의 기록이 그 PR 명령을 알린다.
    repo.status = porcelain(`# branch.oid ${OID}`, '# branch.head topic', '# branch.upstream origin/topic', '# branch.ab +0 -0')
    world.prs = [prRow(7, DRAFT_URL, 'OPEN', true)]
    world.bash = {
      stdout: '',
      stderr: '',
      interrupted: false,
      gitOperation: { pr: { number: 7, url: DRAFT_URL, action: 'created' } },
    }
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --fill', description: 'Open a draft PR' })
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW, 'my-claude · topic · PR #7 draft'])
    expect(await buttonsOf($)).toEqual([{ key: `open:${DRAFT_URL}`, text: 'PR #7 draft' }])
    // 누르면 기본 브라우저로 PR 페이지를 연다.
    await press($, `open:${DRAFT_URL}`)
    expect(runs.at(-1)).toEqual(['open', DRAFT_URL])
    expect(asked()).toBe(2)

    await clock.advance(4 * MINUTE)
    expect(asked()).toBe(2)
    await clock.advance(MINUTE)
    expect(asked()).toBe(3)
  })

  test('a PR command that fails after GitHub made the PR still asks gh again', async ($, on) => {
    const repo: Repo = { root: ROOT, remote: REMOTE, status: porcelain(`# branch.oid ${OID}`, '# branch.head topic') }
    const { clock, runs, world } = setUp(on, { model: 'claude-opus-5-5', repo })
    const asked = () => runs.filter(argv => argv[0] === 'gh').length

    await $.session.start(START)
    await clock.settle()
    expect(asked()).toBe(1)

    world.prs = [prRow(1, PR_URL, 'OPEN')]
    world.isBashFailing = true
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x --body-file -', description: 'Open a PR' })
    await clock.settle()
    expect(asked()).toBe(2)
    expect(await bar($)).toEqual([OPUS_ROW, 'my-claude · topic · PR #1'])
  })

  test('a change from another terminal shows on the next poll', async ($, on) => {
    const repo: Repo = { root: ROOT, remote: null, status: porcelain(`# branch.oid ${OID}`, '# branch.head main') }
    const { clock, runs } = setUp(on, { model: 'claude-opus-5-5', repo })

    await $.session.start(START)
    await clock.settle()
    expect((await bar($))[1]).toBe('my-claude · main')

    repo.status = porcelain(`# branch.oid ${OID}`, '# branch.head main', '? new-file.ts')
    await clock.advance(15_000)
    expect((await bar($))[1]).toBe('my-claude · main · ?1')
    // 원격이 없으면 PR을 묻지 않는다.
    expect(runs.some(argv => argv[0] === 'gh')).toBe(false)
  })
})

describe('agents and todos row', () => {
  const TODOS = [
    { content: 'Parse git status', status: 'completed', activeForm: 'Parsing git status' },
    { content: 'Draw the git row', status: 'in_progress', activeForm: 'Drawing the git row' },
    { content: 'Update README', status: 'pending', activeForm: 'Updating README' },
  ] as const

  test('TodoWrite shows done/total and what runs now; it leaves once all are done', async ($, on) => {
    const { clock } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await clock.settle()
    await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW, 'T ●●○ 1/3  Drawing the git row'])

    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.map(todo => ({ ...todo, status: 'completed' as const })) })
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW])
  })

  test('tasks follow TaskCreate and TaskUpdate, deletions included', async ($, on) => {
    const { clock } = setUp(on, { model: 'claude-opus-5-5' })
    const last = async () => (await bar($)).at(-1)

    await $.session.start(START)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Read git', description: 'porcelain v2', activeForm: 'git 상태 읽는 중' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the row', description: 'spans' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    await clock.settle()
    expect(await last()).toBe('T ●○ 0/2  git 상태 읽는 중')

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
    await clock.settle()
    expect(await last()).toBe('T ●● 1/2  Draw the row')

    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW])
  })

  test('a /clear drops the todos', async ($, on) => {
    const { clock, session } = setUp(on, { model: 'claude-opus-5-5' })

    await $.session.start(START)
    await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
    await clock.settle()
    expect(await bar($)).toHaveLength(2)

    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    session.wipe()
    expect(await footer($)).toEqual([ENGINE_LINE])
    await clock.settle()
    expect(await bar($)).toEqual([OPUS_ROW])
  })

  test('a resumed session picks its todos up from the transcript', async ($, on) => {
    const { clock } = setUp(on, {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', text: 'Add a git row', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'toolu_1', tool: 'TodoWrite', input: { todos: [...TODOS] }, result: {} }],
        },
      ],
    })

    await $.session.start(START)
    await clock.settle()
    expect((await bar($)).at(-1)).toBe('T ●●○ 1/3  Drawing the git row')
  })

  test('a running agent shows with its elapsed time beside the todos and leaves when done', async ($, on) => {
    const { clock, world } = setUp(on, { model: 'claude-opus-5-5', isReducedMotion: true })
    const explorer: AgentInfo = { id: 'agent-1', description: 'Find the auth code', type: 'Explore', status: 'running' }

    await $.session.start(START)
    await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
    await clock.settle()
    world.agents = [explorer]
    await $.agent.spawn({
      tool_use_id: 'toolu_2',
      prompt: 'Find where auth happens',
      description: explorer.description,
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    })
    await clock.settle()
    expect((await bar($)).at(-1)).toBe('● Explore · Find the auth code 0s  │  T ●●○ 1/3  Drawing the git row')

    await clock.advance(72_000)
    expect((await bar($)).at(-1)).toBe('● Explore · Find the auth code 1m12s  │  T ●●○ 1/3  Drawing the git row')

    world.agents = [{ ...explorer, status: 'completed' }]
    await clock.advance(1000)
    expect((await bar($)).at(-1)).toBe('T ●●○ 1/3  Drawing the git row')
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

  const NONE = { conflicted: 0, stashed: 0, deleted: 0, renamed: 0, modified: 0, staged: 0, untracked: 0 }
  const GIT: StatusbarGit = {
    project: 'my-claude',
    worktree: 'fix-bar',
    branch: 'feature/statusbar-git-row-with-pull-request-link',
    upstream: { ahead: 3, behind: 0 },
    changes: { ...NONE, staged: 1, modified: 2 },
    pr: { number: 12, url: PR_URL, state: 'merged' },
  }
  const gitRowOf = (columns: number, git: StatusbarGit = GIT) => layoutRows({ ...SNAPSHOT, git }, columns).at(-1) ?? []

  test('the git row reads like the starship prompt and shortens the branch when narrow', () => {
    const wide = gitRowOf(200)
    expect(textOfRow(wide)).toBe('my-claude/fix-bar · feature/statusbar-git-row-with-pull-request-link · !2+1⇡3 · PR #12 merged')
    // 프롬프트와 같은 색: 경로 하늘색, 브랜치 회색, 상태 노랑. PR 번호는 상태 색에 밑줄 친 링크.
    const styleOf = (text: string) => wide.find(part => part.text === text)?.style
    expect(styleOf('my-claude/fix-bar')).toEqual({ color: '#57C7FF', bold: true })
    expect(styleOf('feature/statusbar-git-row-with-pull-request-link')).toEqual({ color: 'gray', bold: true })
    expect(styleOf('!2+1⇡3')).toEqual({ color: 'yellow' })
    expect(styleOf('#12')).toEqual({ color: 'merged', bold: true, underline: true })
    expect(wide.filter(part => part.href === PR_URL).map(part => part.text)).toEqual(['PR ', '#12', ' merged'])
    expect(textOfRow(gitRowOf(90))).toBe('my-claude/fix-bar · feature/statusbar-git-row-with-pull-request-link · !2+1⇡3 · PR #12')
    for (const columns of [70, 60, 50]) {
      const row = textOfRow(gitRowOf(columns))
      expect(displayWidth(row)).toBe(columns)
      expect(row).toStartWith('my-claude/fix-bar · feature/')
      expect(row).toEndWith('… · !2+1⇡3 · PR #12')
    }
    // 깨끗하고 upstream과 같으면 경로와 브랜치만, HEAD가 떨어지면 (커밋).
    expect(textOfRow(gitRowOf(200, { project: 'my-claude', branch: 'main', upstream: { ahead: 0, behind: 0 }, changes: NONE }))).toBe(
      'my-claude · main',
    )
    const detached = gitRowOf(200, { project: 'my-claude', commit: '1234567', changes: NONE })
    expect(textOfRow(detached)).toBe('my-claude · (1234567)')
    expect(detached.at(-1)?.style).toEqual({ color: 'green', bold: true })
  })

  test('the status marks follow starship: =$×»!+? then ⇡⇣, written together', () => {
    expect(
      gitStatusText({
        changes: { conflicted: 1, stashed: 2, deleted: 3, renamed: 4, modified: 5, staged: 6, untracked: 7 },
        upstream: { ahead: 1, behind: 2 },
      }),
    ).toBe('=1$2×3»4!5+6?7⇡1⇣2')
    expect(gitStatusText({ changes: NONE, upstream: { ahead: 0, behind: 4 } })).toBe('⇣4')
    expect(gitStatusText({ changes: NONE })).toBe('')
  })

  test('the agents and todos row drops descriptions, then counts what runs', () => {
    const snapshot: StatusbarSnapshot = {
      ...SNAPSHOT,
      agents: [
        { id: 'a', label: 'Explore', description: 'Find where the auth tokens are refreshed', startedAt: NOW - 72_000 },
        { id: 'b', label: 'general-purpose', description: 'Fix the failing parser tests', startedAt: NOW - 5000 },
      ],
      todos: [
        { id: '1', subject: 'Read git', status: 'completed' },
        { id: '2', subject: 'Draw', activeForm: '상태 줄에 git 줄을 그리는 중', status: 'in_progress' },
        { id: '3', subject: 'Test', status: 'pending' },
      ],
    }
    const activity = (columns: number) => textOfRow(layoutRows(snapshot, columns).at(-1) ?? [])

    expect(activity(200)).toBe(
      '● Explore · Find where the auth tokens are refreshed 1m12s   ● general-purpose · Fix the failing parser tests 5s  │  T ●●○ 1/3  상태 줄에 git 줄을 그리는 중',
    )
    expect(activity(100)).toBe('● Explore 1m12s   ● general-purpose 5s  │  T ●●○ 1/3  상태 줄에 git 줄을 그리…')
    expect(activity(50)).toBe('● 2 agents  │  T ●●○ 1/3  상태 줄에 git 줄을 그리…')
    expect(activity(24)).toBe('● 2 agents  │  T ●●○ 1/3')
    // 점은 1초마다 커졌다 작아진다(움직임을 줄이면 멈춘다).
    const glyph = (frame?: number) => layoutRows(snapshot, 200, frame).at(-1)?.[0]?.text
    expect([glyph(0), glyph(10), glyph(25), glyph(undefined)]).toEqual(['● ', '• ', '· ', '● '])
  })

  test('todo dots: one per todo in done, running and left colors; past ten they share ten dots', () => {
    const todosOf = (done: number, running: number, left: number): StatusbarSnapshot['todos'] => [
      ...Array.from({ length: done }, (_, index) => ({ subject: `done ${index}`, status: 'completed' as const })),
      ...Array.from({ length: running }, (_, index) => ({ subject: `run ${index}`, status: 'in_progress' as const })),
      ...Array.from({ length: left }, (_, index) => ({ subject: `left ${index}`, status: 'pending' as const })),
    ]
    const dots = (done: number, running: number, left: number) =>
      (layoutRows({ ...SNAPSHOT, todos: todosOf(done, running, left) }, 200).at(-1) ?? [])
        .filter(part => /^[●○]+$/.test(part.text))
        .map(part => [part.text, part.style?.color])

    expect(dots(2, 1, 3)).toEqual([
      ['●●', '#0ca30c'],
      ['●', 'claude'],
      ['○○○', 'inactive'],
    ])
    expect(dots(5, 1, 6)).toEqual([
      ['●●●●', '#0ca30c'],
      ['●', 'claude'],
      ['○○○○○', 'inactive'],
    ])
    expect(textOfRow(layoutRows({ ...SNAPSHOT, todos: todosOf(5, 1, 6) }, 200).at(-1) ?? [])).toBe(
      'T ●●●●●○○○○○ 5/12  run 0',
    )
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

  test('git status --porcelain=v2 --branch --show-stash, counted as starship does', () => {
    const none = { conflicted: 0, stashed: 0, deleted: 0, renamed: 0, modified: 0, staged: 0, untracked: 0 }
    expect(gitStatusOf(FEATURE_STATUS)).toEqual({
      branch: 'feature/bar',
      upstream: { ahead: 2, behind: 1 },
      changes: { ...none, modified: 2, staged: 2, untracked: 3 },
    })
    // 첫 커밋 전, 사라진 upstream(ab 없음), 스태시 2개, 이름 바꿈(2), 지움(D가 어느 쪽이든), 새로 추가(A.).
    expect(
      gitStatusOf(
        porcelain(
          '# branch.oid (initial)',
          '# branch.head main',
          '# branch.upstream origin/gone',
          '# stash 2',
          '2 R. N... 1 2 3 a b R100 new\told',
          '1 D. N... 1 2 3 a b gone.ts',
          '1 .D N... 1 2 3 a b lost.ts',
          '1 A. N... 1 2 3 a b added.ts',
        ),
      ),
    ).toEqual({ branch: 'main', changes: { ...none, stashed: 2, deleted: 2, renamed: 1, staged: 1 } })
    expect(gitStatusOf(porcelain(`# branch.oid ${OID}`, '# branch.head (detached)'))).toEqual({
      commit: '1234567',
      changes: none,
    })
  })

  test('the PR of gh pr list: the newest whose head is the origin owner', () => {
    expect(pullRequestOf([], 'DevooKim')).toBeUndefined()
    expect(pullRequestOf([prRow(3, PR_URL, 'OPEN')], 'devookim')).toEqual({ number: 3, url: PR_URL, state: 'open' })
    expect(pullRequestOf([prRow(9, PR_URL, 'OPEN', false, 'stranger')], 'DevooKim')).toBeUndefined()
    expect(pullRequestOf([prRow(3, PR_URL, 'OPEN', true)], 'DevooKim')?.state).toBe('draft')
    expect(pullRequestOf([prRow(3, PR_URL, 'MERGED')], 'DevooKim')?.state).toBe('merged')
    expect(pullRequestOf([prRow(3, PR_URL, 'CLOSED')], 'DevooKim')?.state).toBe('closed')
  })

  test('the owner of the origin remote', () => {
    expect(remoteOwner(REMOTE)).toBe('DevooKim')
    expect(remoteOwner('git@github.com:DevooKim/my-claude.git')).toBe('DevooKim')
    expect(remoteOwner('ssh://git@github.com/DevooKim/my-claude')).toBe('DevooKim')
    expect(remoteOwner('https://ghe.example.com/team/app/')).toBe('team')
    expect(remoteOwner(null)).toBeUndefined()
  })

  test('TaskList replaces the list and keeps what TaskCreate said', () => {
    const created = applyTodoTool([], 'TaskCreate', { subject: 'A', activeForm: 'Doing A' }, { task: { id: '1', subject: 'A' } })
    const listed = applyTodoTool(created, 'TaskList', {}, {
      tasks: [
        { id: '1', subject: 'A', status: 'in_progress', blockedBy: [] },
        { id: '2', subject: 'B', status: 'pending', blockedBy: [] },
      ],
    })
    expect(todoProgress(listed)).toEqual({ done: 0, active: 1, total: 2, current: 'Doing A' })
    expect(todoProgress([])).toBeUndefined()
    expect(applyTodoTool(listed, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: false })).toEqual(listed)
  })

  test('agent labels, elapsed time and fitted text', () => {
    expect(agentLabel({ type: 'humanize-korean:humanize-monolith' })).toBe('humanize-monolith')
    expect(agentLabel({ type: 'teammate', name: 'scout', teammateId: 'scout@team' })).toBe('scout')
    expect(agentLabel({ type: 'Explore', name: 'agent-a1b2' })).toBe('Explore')
    expect([0, 59_999, 72_000, 3_780_000].map(formatElapsed)).toEqual(['0s', '59s', '1m12s', '1h3m'])
    expect(fitText('feature/long-name', 8)).toBe('feature…')
    expect(fitText('테스트 실행 중', 7)).toBe('테스트…')
    expect(fitText('short', 8)).toBe('short')
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
