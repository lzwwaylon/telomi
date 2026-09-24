import type { ActivityItem, ResponseContent, TodoItem } from '@/features/goals/data/types'

export interface AssistantTurn {
  type: 'assistant'
  turnId: string
  activities: ActivityItem[]
  response?: ResponseContent
  intent?: string
  isStreaming: boolean
  isComplete: boolean
  timestamp: number
  todos?: TodoItem[]
  /** The report this turn published; the Runtime stamps it on the reply, whichever entry point published. */
  report?: PublishedReport
}

export interface PublishedReport {
  runId: string
  title: string
}

export type TurnPhase = 'pending' | 'tool_active' | 'awaiting' | 'streaming' | 'complete'

export function deriveTurnPhase(turn: AssistantTurn): TurnPhase {
  if (turn.isComplete) return 'complete'
  if (turn.response?.isStreaming) return 'streaming'
  if (turn.activities.some(activity => activity.type === 'tool' && activity.status === 'running')) {
    return 'tool_active'
  }
  return turn.activities.length > 0 ? 'awaiting' : 'pending'
}

export function shouldShowThinkingIndicator(phase: TurnPhase): boolean {
  return phase === 'pending' || phase === 'awaiting'
}

export function computeLastChildSet(activities: ActivityItem[]): Set<string> {
  const lastByParent = new Map<string | undefined, string>()
  for (const activity of activities) {
    if (activity.depth && activity.depth > 0) lastByParent.set(activity.parentId, activity.id)
  }
  return new Set(lastByParent.values())
}

export { formatDuration } from "@/shared/lib/format";

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  const whole = Math.floor(count)
  if (whole < 1000) return whole.toString()
  const thousands = whole / 1000
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`
}

interface TaskOutputData {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}

export interface ActivityGroup {
  type: 'group'
  parent: ActivityItem
  children: ActivityItem[]
  taskOutputData?: TaskOutputData
}

export function isActivityGroup(item: ActivityItem | ActivityGroup): item is ActivityGroup {
  return item.type === 'group' && 'parent' in item && 'children' in item
}

function extractTaskOutputData(activity: ActivityItem): TaskOutputData | undefined {
  if (!activity.content) return undefined
  try {
    const parsed = JSON.parse(activity.content)
    const data: TaskOutputData = {}
    if (typeof parsed.duration_ms === 'number') data.durationMs = parsed.duration_ms
    if (typeof parsed.usage?.input_tokens === 'number') data.inputTokens = parsed.usage.input_tokens
    if (typeof parsed.usage?.output_tokens === 'number') data.outputTokens = parsed.usage.output_tokens
    return Object.keys(data).length > 0 ? data : undefined
  } catch {
    return undefined
  }
}

export function groupActivitiesByParent(
  activities: ActivityItem[]
): (ActivityItem | ActivityGroup)[] {
  const taskToolUseIds = new Set<string>()
  for (const activity of activities) {
    if (activity.toolName === 'Task' && activity.toolUseId) {
      taskToolUseIds.add(activity.toolUseId)
    }
  }

  const childrenByParent = new Map<string, ActivityItem[]>()
  for (const activity of activities) {
    if (!activity.parentId || !taskToolUseIds.has(activity.parentId)) continue
    const children = childrenByParent.get(activity.parentId) ?? []
    children.push(activity)
    childrenByParent.set(activity.parentId, children)
  }

  const childIds = new Set(
    [...childrenByParent.values()].flatMap(children => children.map(child => child.id))
  )
  const taskOutputByAgentId = new Map<string, TaskOutputData>()
  for (const activity of activities) {
    if (activity.toolName !== 'TaskOutput' || activity.status !== 'completed') continue
    const taskId = activity.toolInput?.task_id as string | undefined
    const data = extractTaskOutputData(activity)
    if (taskId && data) taskOutputByAgentId.set(taskId, data)
  }

  const taskToAgentId = new Map<string, string>()
  for (const activity of activities) {
    if (
      activity.toolName !== 'Task'
      || (activity.status !== 'completed' && activity.status !== 'backgrounded')
      || !activity.content
      || !activity.toolUseId
    ) continue
    const agentId = activity.content.match(/agentId:\s*([a-zA-Z0-9_-]+)/)?.[1]
    if (agentId) taskToAgentId.set(activity.toolUseId, agentId)
  }

  const result: (ActivityItem | ActivityGroup)[] = []
  for (const activity of activities) {
    if (childIds.has(activity.id) || activity.toolName === 'TaskOutput') continue
    if (activity.toolName !== 'Task') {
      result.push(activity)
      continue
    }
    const agentId = activity.toolUseId ? taskToAgentId.get(activity.toolUseId) : undefined
    result.push({
      type: 'group',
      parent: activity,
      children: activity.toolUseId
        ? (childrenByParent.get(activity.toolUseId) ?? []).sort((a, b) => a.timestamp - b.timestamp)
        : [],
      ...(agentId && taskOutputByAgentId.has(agentId)
        ? { taskOutputData: taskOutputByAgentId.get(agentId) }
        : {}),
    })
  }
  return result
}
