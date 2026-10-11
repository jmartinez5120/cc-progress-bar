export type ItemStatus = 'pending' | 'in_progress' | 'completed'

export type WorkItem = { id: string; label: string; status: ItemStatus }

export type AgentRun = {
  id: string
  label: string
  type: string
  parentId?: string
  status: 'running' | 'done' | 'failed'
}

export type Progress = {
  phase: 'idle' | 'working' | 'done' | 'aborted'
  /** The TodoWrite list, replaced whole on every write. */
  todos: WorkItem[]
  /** TaskCreate/TaskUpdate tasks, keyed by the task id. */
  tasks: WorkItem[]
  agents: AgentRun[]
  tools: number
  durationMs?: number
  /** When the person's prompt that began this task was submitted. */
  startedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { progress: Progress; isHidden: boolean }
  }
}
