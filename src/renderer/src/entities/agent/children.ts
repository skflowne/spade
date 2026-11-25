import type { AgentModeInfo, ChildAgentInfo } from '../../../../shared/agents'

// Paseo children as their owner's node lists them. Kept free of renderer imports so it is testable alone.

// Collapsed children and, under each, its own children, depth first. An expanded child is left out with
// everything under it: its own node shows its state.
export function collapsedDescendants(children: readonly ChildAgentInfo[]): ChildAgentInfo[] {
  const found: ChildAgentInfo[] = []
  const visit = (list: readonly ChildAgentInfo[]): void => {
    for (const child of list) {
      if (child.nodeId !== null) continue
      found.push(child)
      visit(child.children)
    }
  }
  visit(children)
  return found
}

export type ChildAttention = { permissions: number; errors: number; finished: number }

// What waits on the user among the collapsed descendants; `finished` holds the agents whose finished run
// the user has not seen yet.
export function childAttention(children: readonly ChildAgentInfo[], finished: ReadonlySet<string>): ChildAttention {
  const attention: ChildAttention = { permissions: 0, errors: 0, finished: 0 }
  for (const child of collapsedDescendants(children)) {
    attention.permissions += child.pendingPermissions.length
    if (child.activity === 'error') attention.errors += 1
    if (finished.has(child.agentId)) attention.finished += 1
  }
  return attention
}

export function needsUser(attention: ChildAttention): boolean {
  return attention.permissions > 0 || attention.errors > 0 || attention.finished > 0
}

const RUNNING = new Set(['running', 'starting'])
const STOPPED = new Set(['idle', 'closed'])

// Collapsed agents that stopped running between two listings of an owner's children (`finished`), and those
// that run again (`resumed`). An error is its own signal and is not a finished run.
export function runTransitions(
  previous: readonly ChildAgentInfo[],
  next: readonly ChildAgentInfo[]
): { finished: string[]; resumed: string[] } {
  const before = new Map(collapsedDescendants(previous).map((child) => [child.agentId, child.activity]))
  const finished: string[] = []
  const resumed: string[] = []
  for (const child of collapsedDescendants(next)) {
    const was = before.get(child.agentId)
    if (was !== undefined && RUNNING.has(was) && STOPPED.has(child.activity)) finished.push(child.agentId)
    else if (RUNNING.has(child.activity) && (was === undefined || !RUNNING.has(was))) resumed.push(child.agentId)
  }
  return { finished, resumed }
}

export function childTitle(child: Pick<ChildAgentInfo, 'title' | 'agentId'>): string {
  return child.title ?? `Agent ${child.agentId}`
}

// Modes are opaque provider ids; the provider's label when it lists the mode.
export function modeLabel(modeId: string, modes: readonly AgentModeInfo[] | null): string {
  return modes?.find((mode) => mode.id === modeId)?.label ?? modeId
}
