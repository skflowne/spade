import { useCallback } from 'react'
import type { AgentConfig } from '@shared/builtinEntities'
import { useAgentRuntime } from '../../store/hooks'
import type { EntityDrawerProps } from '../types'
import { ChildAgents } from './ChildAgents'
import { openSubagentNode, Subagents } from './Subagents'

// The agent node's side drawer: the agents it owns, Paseo children and provider sub-agents, a section per kind.
// The node body stays the conversation.
export function AgentsPane({ node, host, close }: EntityDrawerProps<AgentConfig>): React.JSX.Element {
  const runtime = useAgentRuntime(node.id)
  const openSubagent = useCallback((subagentId: string) => openSubagentNode(node.id, subagentId, host), [node.id, host])
  const children = runtime?.children ?? []
  const subagents = runtime?.providerSubagents ?? []
  return (
    <section className="agents-pane" aria-label={`Agents of ${node.title}`}>
      <header className="agents-pane__header">
        <h3 className="agents-pane__title">Agents</h3>
        <button type="button" className="cr-icon-button" aria-label="Close the agents pane" title="Close" onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="agents-pane__content">
        <ChildAgents ownerNodeId={node.id} children={children} host={host} />
        <Subagents subagents={subagents} onOpen={openSubagent} />
        {children.length === 0 && subagents.length === 0 ? <p className="agents-pane__empty">This agent owns no other agent.</p> : null}
      </div>
    </section>
  )
}
