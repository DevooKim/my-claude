import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, TurnUsage } from 'claude-code'

import { cacheRow, cacheStatusOf } from '../hooks/register'
import type { Span } from '../hooks/register'

const usage = (input: number, read: number, created: number): TurnUsage => ({
  model: 'claude-opus-5-5',
  input_tokens: input,
  output_tokens: 10,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: created,
})

// 엔진 쪽: 응답 하나를 stop 조각으로 끝내고, 아래에서는 OTHER_ROW를 그리는 다른 띠가 있다고 둔다.
const OTHER_ROW = 'timer 3s'
function setUp(on: On, answer: { usage: TurnUsage | null }) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: answer.usage }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: answer.usage }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{OTHER_ROW}</Text>
  })
}

async function step($: Engine, agentId?: string): Promise<void> {
  const stream = $.turn.step({
    turnId: 'turn-1',
    index: 0,
    messageCount: 1,
    model: 'claude-opus-5-5',
    ...(agentId !== undefined ? { agentId } : {}),
  })
  let chunk = await stream.next()
  while (chunk.done !== true) chunk = await stream.next()
}

async function band($: Engine, hasSurvey = false): Promise<string[]> {
  const ui = await $.ui.mount({
    plugin: 'prompt-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey, maxRows: 10, bodyColumns: 80 },
    viewport: { columns: 85, rows: 40, isFullscreen: true },
  })
  const tree = await ui.drawn()
  await ui.unmount()

  return linesOf(tree)
}

function linesOf(node: RenderElement | string): string[] {
  if (typeof node === 'string') return [node]
  const children: readonly (RenderElement | string)[] = 'children' in node ? (node.children ?? []) : []
  if (node.type === 'Box' && node.props?.flexDirection === 'column') return children.flatMap(linesOf)

  return [children.map(child => linesOf(child).join('')).join('')]
}

const textOf = (row: readonly Span[]) => row.map(part => part.text).join('')

describe('cache', () => {
  test('the last main-thread response sets the row, stacked above the other bands', async ($, on) => {
    setUp(on, { usage: usage(1_000, 90_000, 9_000) })
    expect(await band($)).toEqual([OTHER_ROW])

    await step($)
    expect(await band($)).toEqual(['Cache ◕ 90%  90k/100k', OTHER_ROW])
  })

  test('a subagent response or one without usage changes nothing', async ($, on) => {
    setUp(on, { usage: usage(1_000, 90_000, 9_000) })
    await step($, 'agent-1')
    expect(await band($)).toEqual([OTHER_ROW])
  })

  test('a survey holds the band', async ($, on) => {
    setUp(on, { usage: usage(1_000, 90_000, 9_000) })
    await step($)
    expect(await band($, true)).toEqual([OTHER_ROW])
  })

  test('the row is pushed to the right edge of the band body', async ($, on) => {
    setUp(on, { usage: usage(1_000, 90_000, 9_000) })
    await step($)
    const ui = await $.ui.mount({
      plugin: 'prompt-band',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, maxRows: 10, bodyColumns: 80 },
      viewport: { columns: 85, rows: 40, isFullscreen: true },
    })
    const tree = await ui.drawn()
    await ui.unmount()
    const [row] = 'children' in tree ? (tree.children ?? []) : []
    expect(typeof row !== 'string' && row?.props).toMatchObject({ justifyContent: 'flex-end', width: 80 })
  })

  test('pie in 25% steps rounded down, number to 1%, color on the hit rate', () => {
    expect(textOf(cacheRow({ read: 99_600, total: 100_000 }))).toBe('Cache ● 100%  100k/100k')
    expect(textOf(cacheRow({ read: 37_000, total: 100_000 }))).toBe('Cache ◔ 37%  37k/100k')
    expect(textOf(cacheRow({ read: 0, total: 100_000 }))).toBe('Cache ○ 0%  0/100k')
    expect([100, 90, 89, 70, 69, 40, 39, 0].map(cacheStatusOf)).toEqual([
      'good',
      'good',
      'warning',
      'warning',
      'serious',
      'serious',
      'critical',
      'critical',
    ])
    const half = cacheRow({ read: 50_000, total: 100_000 })
    expect(half.filter(part => part.style?.color === '#ec835a').map(part => part.text)).toEqual(['◑', ' 50%'])
  })
})
