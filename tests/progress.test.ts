import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

const TODOS: Todo[] = [
  { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
  { content: 'Write fix', status: 'in_progress', activeForm: 'Writing fix' },
  { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
]

test('todos and spawned agents drive the bar, and the turn end fills it', async ($, on) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'fix the bug', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'u1', todos: TODOS })
  await $.agent.spawn({
    tool_use_id: 'u2',
    prompt: 'look around',
    description: 'find the bug',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-bar', surface, ...BAND })
    // 1 + 0.5 + 0 (todos) + 0.5 (running agent) over 4 units
    expect(await ui.find({ type: 'Text', text: / 50%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1/3 tasks · 0/1 agents · 1 tool' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Writing fix/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore · find the bug/ })).toBeDefined()
  }

  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'x', agentId: 'agent-1', reason: 'answer' })
  const mid = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await mid.find({ type: 'Text', text: / 63%$/ })).toBeDefined()

  await $.turn.complete({ answer: 'fixed', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const end = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await end.find({ type: 'Text', text: /100%$/ })).toBeDefined()
  expect(await end.find({ type: 'Text', text: /1m5s/ })).toBeDefined()
})

test('leaves the band to the engine before any work', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine band') as RenderElement
  })
  const ui = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '%' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('a background agent notification continues the task instead of resetting it', async ($, on) => {
  mock.clock(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'bg-1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  const spawn = {
    tool_use_id: 'u1',
    prompt: 'map it',
    description: 'map the repo',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: true,
    fork: false,
  } as const

  await $.prompt.submit({ text: 'map the repos', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'map the repos', turnId: 't1' })
  await $.agent.spawn(spawn)
  await $.turn.complete({ answer: 'started', durationMs: 500, isAborted: false, turnId: 't1', reason: 'answer' })

  const waiting = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await waiting.find({ type: 'Text', text: /waiting on 1 background agent/ })).toBeDefined()

  await $.turn.complete({ answer: 'report', durationMs: 900, isAborted: false, turnId: 'x', agentId: 'bg-1', reason: 'answer' })

  // The hand-back arrives as a prompt of its own and starts a follow-up turn.
  await $.prompt.submit({ text: 'agent finished', wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: '', turnId: 't2' })

  const followUp = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await followUp.find({ type: 'Text', text: / 99%$/ })).toBeDefined()
  expect(await followUp.find({ type: 'Text', text: /1\/1 agents/ })).toBeDefined()

  await $.turn.complete({ answer: 'summary', durationMs: 700, isAborted: false, turnId: 't2', reason: 'answer' })
  const end = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await end.find({ type: 'Text', text: /100%$/ })).toBeDefined()

  // The person's next prompt is a new task: the finished agent is dropped.
  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'next thing', turnId: 't3' })
  const fresh = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await fresh.find({ type: 'Text', text: /agents/ })).toBeUndefined()
})

test('the bar spans the band and follows its width', async ($, on) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'go', turnId: 't1' })

  for (const bodyColumns of [60, 140]) {
    const ui = await $.ui.mount({
      plugin: 'progress-bar',
      surface: 'terminal',
      ...BAND,
      props: { ...BAND.props, bodyColumns },
    })
    const row = await ui.findAll({ type: 'Text' })
    const cells = row.slice(0, 4).reduce((sum, el) => sum + [...el.text].length, 0)
    expect(cells).toBe(bodyColumns)
  }
})

test('with nothing countable the bar estimates from activity, then fills at the end', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  const before = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await before.find({ type: 'Text', text: /…$/ })).toBeDefined()

  for (let i = 0; i < 7; i += 1) {
    await $.tool.call({ tool: 'Read', tool_use_id: `r${i}`, file_path: '/tmp/x' })
  }

  // 0.9 × (1 − e^(−7/12)) ≈ 40%, marked as an estimate.
  const mid = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await mid.find({ type: 'Text', text: /~40%$/ })).toBeDefined()

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  const end = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', ...BAND })
  expect(await end.find({ type: 'Text', text: / 100%$/ })).toBeDefined()
})
