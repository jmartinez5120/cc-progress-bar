import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentRun, Progress, WorkItem } from '../types'

const EMPTY: Progress = { phase: 'idle', todos: [], tasks: [], agents: [], tools: 0 }

const progress = atom({ plugin: 'progress-bar', key: 'progress' } as const, EMPTY)
const isHidden = atom({ plugin: 'progress-bar', key: 'isHidden' } as const, false)

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const MAX_AGENT_ROWS = 4
// The percentage at the bar's right end (` 100%`) and the bar's two caps.
const PERCENT_CELLS = 5
const CAP_CELLS = 2
// Estimated mode: ~45% after 7 tool calls, ~75% after 20, capped at 90%.
const ESTIMATE_CAP = 0.9
const ESTIMATE_PACE = 12
const LIVE_AGENT = new Set(['pending', 'running', 'waiting'])
const ENDED_AGENT = new Set(['completed', 'failed', 'killed'])
const NEW_TASK_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

// An in-flight item counts as half done, so the bar moves when work starts,
// not only when it finishes.
const ITEM_WEIGHT = { pending: 0, in_progress: 0.5, completed: 1 } as const
const AGENT_WEIGHT = { running: 0.5, done: 1, failed: 1 } as const

/** Done fraction in [0, 1], or null before any work at all. */
const fraction = (p: Progress): number | null => {
  const items = [...p.todos, ...p.tasks]
  const units = items.length + p.agents.length

  if (units === 0) {
    if (p.phase === 'done') {
      return 1
    }

    // Nothing countable (no todo list, no agents): estimate from activity,
    // fast at first and flattening out, never past ESTIMATE_CAP.
    return p.tools === 0 ? null : ESTIMATE_CAP * (1 - Math.exp(-p.tools / ESTIMATE_PACE))
  }

  const done =
    items.reduce((sum, item) => sum + ITEM_WEIGHT[item.status], 0) +
    p.agents.reduce((sum, agent) => sum + AGENT_WEIGHT[agent.status], 0)

  if (p.phase === 'done' && !p.agents.some(a => a.status === 'running')) {
    return 1
  }

  // Everything ticked off but the turn still running: hold at 99%.
  return Math.min(done / units, 0.99)
}

const isEstimate = (p: Progress) =>
  p.todos.length + p.tasks.length + p.agents.length === 0 && p.phase !== 'done'

/** The filled run (with its partial eighth) and the empty track after it. */
const bar = (ratio: number, width: number) => {
  const cells = ratio * width
  const full = Math.floor(cells)
  const part = EIGHTHS[Math.floor((cells - full) * 8)] ?? ''

  return {
    filled: '█'.repeat(full) + part,
    track: '░'.repeat(Math.max(0, width - full - (part ? 1 : 0))),
  }
}

const depthOf = (agent: AgentRun, all: AgentRun[]) => {
  let depth = 0
  let parentId = agent.parentId

  while (parentId !== undefined && depth < 5) {
    depth += 1
    parentId = all.find(a => a.id === parentId)?.parentId
  }

  return depth
}

const seconds = (ms: number) =>
  ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`

const setTask = (tasks: WorkItem[], id: string, patch: Partial<WorkItem>) =>
  tasks.map(t => (t.id === id ? { ...t, ...patch } : t))

/**
 * Adds running agents this mod never saw start (spawned before it loaded,
 * or by a path that raised no agent.spawn) and settles ones that ended.
 */
const syncAgents = async ($: EngineInterface) => {
  const roster = await $.agent.list().catch(() => [] as readonly AgentInfo[])

  if (roster.length === 0) {
    return
  }

  await update($, progress, (p): Progress => {
    const known = new Set(p.agents.map(a => a.id))
    const ended = new Map(roster.filter(a => ENDED_AGENT.has(a.status)).map(a => [a.id, a.status]))
    const missed: AgentRun[] = roster
      .filter(a => LIVE_AGENT.has(a.status) && !known.has(a.id))
      .map(a => ({ id: a.id, label: a.description, type: a.type, parentId: a.parentId, status: 'running' }))

    if (missed.length === 0 && !p.agents.some(a => a.status === 'running' && ended.has(a.id))) {
      return p
    }

    return {
      ...p,
      agents: [
        ...p.agents.map(a =>
          a.status === 'running' && ended.has(a.id)
            ? { ...a, status: ended.get(a.id) === 'completed' ? ('done' as const) : ('failed' as const) }
            : a,
        ),
        ...missed,
      ],
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress-bar',
      description: 'Show or hide the task progress bar above the prompt',
    })

    return next(e)
  })

  on('command.run', { command: 'progress-bar' }, async $ => {
    const hidden = await update($, isHidden, was => !was)

    return { text: hidden ? 'Progress bar hidden.' : 'Progress bar shown.' }
  })

  // A person's prompt is a new task: drop finished work, keep what is still
  // open (an unfinished todo list, background agents still running). A
  // background agent's notification or hand-back continues the task instead.
  on('prompt.submit', async ($, e, next) => {
    if (NEW_TASK_ORIGINS.has(e.origin.kind) && e.turnId === undefined) {
      const startedAt = await $.clock.now().catch(() => undefined)
      await update($, progress, (p): Progress => ({
        phase: 'idle',
        todos: p.todos.every(t => t.status === 'completed') ? [] : p.todos,
        tasks: p.tasks.filter(t => t.status !== 'completed'),
        agents: p.agents.filter(a => a.status === 'running'),
        tools: 0,
        startedAt,
      }))
    }

    return next(e)
  })

  // Main loop only: a subagent's run raises no turn.start.
  on('turn.start', async ($, e, next) => {
    await update($, progress, (p): Progress => ({ ...p, phase: 'working', durationMs: undefined }))
    await syncAgents($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await update($, progress, (p): Progress => ({ ...p, tools: p.tools + 1 }))
    const ran = await next(e)
    await syncAgents($)

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, progress, (p): Progress => ({
        ...p,
        todos: e.todos.map((t, i) => ({
          id: String(i),
          label: t.status === 'in_progress' ? t.activeForm : t.content,
          status: t.status,
        })),
      }))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      const { id } = ran.result.task
      await update($, progress, (p): Progress => ({
        ...p,
        tasks: [...p.tasks.filter(t => t.id !== id), { id, label: e.subject, status: 'pending' }],
      }))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, progress, (p): Progress => ({
        ...p,
        tasks:
          e.status === 'deleted'
            ? p.tasks.filter(t => t.id !== e.taskId)
            : setTask(p.tasks, e.taskId, {
                ...(e.status && { status: e.status }),
                ...(e.subject && { label: e.subject }),
              }),
      }))
    }

    return ran
  })

  // Every subagent, nested ones included (parentAgentId), is one unit of work.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if ('agentId' in spawned && spawned.agentId) {
      const run: AgentRun = {
        id: spawned.agentId,
        label: e.description,
        type: e.subagentType,
        parentId: e.parentAgentId,
        status: 'running',
      }
      await update($, progress, (p): Progress => ({ ...p, agents: [...p.agents, run] }))
    }

    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    const now = await $.clock.now().catch(() => undefined)

    if (e.agentId !== undefined) {
      const status: AgentRun['status'] = e.reason === 'answer' ? 'done' : 'failed'
      await update($, progress, (p): Progress => ({
        ...p,
        agents: p.agents.map(a => (a.id === e.agentId ? { ...a, status } : a)),
      }))

      return answered
    }

    // An agent that was killed raises no turn.complete of its own: settle the
    // rest from the engine's roster.
    const roster = await $.agent.list().catch(() => [])
    const ended = new Map(
      roster.filter(a => ['completed', 'failed', 'killed'].includes(a.status)).map(a => [a.id, a.status]),
    )

    await update($, progress, (p): Progress => ({
      ...p,
      phase: e.isAborted ? 'aborted' : 'done',
      durationMs: p.startedAt === undefined || now === undefined ? e.durationMs : now - p.startedAt,
      agents: p.agents.map(a =>
        a.status === 'running' && ended.has(a.id)
          ? { ...a, status: ended.get(a.id) === 'completed' ? 'done' : 'failed' }
          : a,
      ),
    }))

    return answered
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, progress)

    if (e.props.hasSurvey || p.phase === 'idle' || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const ratio = fraction(p)
    // bodyColumns is the band's width; the engine redraws on every resize.
    const width = Math.max(10, e.props.bodyColumns - PERCENT_CELLS - CAP_CELLS)
    const { filled, track } = ratio === null ? { filled: '', track: '░'.repeat(width) } : bar(ratio, width)
    const items = [...p.todos, ...p.tasks]
    const running = p.agents.filter(a => a.status === 'running')
    const current = items.find(i => i.status === 'in_progress')
    const color = p.phase === 'aborted' ? 'warning' : ratio === 1 ? 'success' : 'claude'

    const meta = [
      items.length > 0 && `${items.filter(i => i.status === 'completed').length}/${items.length} tasks`,
      p.agents.length > 0 && `${p.agents.length - running.length}/${p.agents.length} agents`,
      `${p.tools} tool${p.tools === 1 ? '' : 's'}`,
      p.durationMs !== undefined && seconds(p.durationMs),
    ].filter(Boolean)

    const headline =
      p.phase === 'aborted'
        ? 'interrupted'
        : p.phase === 'done' && running.length > 0
          ? `waiting on ${running.length} background agent${running.length > 1 ? 's' : ''}`
          : p.phase === 'done'
            ? 'done'
            : (current?.label ?? (running.length > 0 ? 'agents working' : 'working'))

    const shown = [...running, ...p.agents.filter(a => a.status !== 'running')].slice(0, MAX_AGENT_ROWS)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color}>▕{filled}</Text>
          <Text dimColor>{track}</Text>
          <Text color={color}>▏</Text>
          <Text bold>{(ratio === null ? '…' : `${isEstimate(p) ? '~' : ''}${Math.round(ratio * 100)}%`).padStart(PERCENT_CELLS)}</Text>
        </Box>
        <Box>
          <Text wrap="truncate-end">
            {'  '}
            {headline}
          </Text>
          <Text dimColor wrap="truncate-end">
            {' · '}
            {meta.join(' · ')}
          </Text>
        </Box>
        {shown.map(agent => (
          <Text dimColor={agent.status !== 'running'} wrap="truncate-end">
            {'  '.repeat(depthOf(agent, p.agents) + 1)}⎿{' '}
            <Text color={agent.status === 'failed' ? 'error' : agent.status === 'done' ? 'success' : 'claude'}>
              {agent.status === 'running' ? '◐' : agent.status === 'done' ? '✓' : '✗'}
            </Text>{' '}
            {agent.type} · {agent.label}
          </Text>
        ))}
        {p.agents.length > shown.length && (
          <Text dimColor>
            {'    '}+{p.agents.length - shown.length} more agents
          </Text>
        )}
      </Box>
    )
  })
}
