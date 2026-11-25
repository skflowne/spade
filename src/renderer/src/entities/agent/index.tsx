import { AGENT_ENTITY, type AgentConfig } from '@shared/builtinEntities'
import type { Canvas } from '@shared/domain'
import { defineEntityRenderer } from '../registry'
import type { EntityMenuAction, EntityMenuContext } from '../types'
import { AgentBody } from './AgentBody'
import { AgentCreateForm } from './AgentCreateForm'
import { AgentStatus } from './AgentStatus'
import { agentNodeHandles } from './nodeHandles'
import { promptBlockReason } from './status'
import './agent.css'

// The agent conversation entity (plan §7.1): spawn form, header status, conversation, composer,
// permissions, provider sub-agents, and rich conversation artifacts.

// The agent node this node was expanded from (a Paseo child or a provider sub-agent), or null.
function ownerOf(canvas: Canvas, nodeId: string): string | null {
  const edge = canvas.edges.find((candidate) => candidate.relation === 'child' && candidate.toNodeId === nodeId)
  if (!edge || edge.origin !== 'delegated') return null
  return canvas.nodes.some((candidate) => candidate.id === edge.fromNodeId && candidate.entityType === AGENT_ENTITY) ? edge.fromNodeId : null
}

function menuActions({ node, host }: EntityMenuContext<AgentConfig>): EntityMenuAction[] {
  const handle = agentNodeHandles.get(node.id)
  const runtime = handle?.runtime ?? null
  const notify = handle?.notify ?? ((message: string) => console.error(message))
  const actions: EntityMenuAction[] = []
  if (runtime && (runtime.activity === 'running' || runtime.activity === 'starting')) {
    actions.push({
      id: 'interrupt',
      label: 'Interrupt',
      disabled: promptBlockReason(node, runtime) !== null,
      onSelect: () => {
        void window.spadeHost.agents.interrupt(node.id).then((result) => {
          if (!result.ok) notify(`Could not interrupt the agent: ${result.error.message}`)
        })
      }
    })
  }
  if (handle && ownerOf(handle.getCanvas(), node.id) !== null) {
    // Removing the node returns the agent to its owner's list; the agent itself keeps running in Paseo.
    actions.push({
      id: 'collapse-into-owner',
      label: 'Collapse into owner',
      onSelect: () => void host.execute({ type: 'removeNode', nodeId: node.id })
    })
  }
  const agentId = runtime?.agentId ?? node.resourceRef?.id
  if (agentId) {
    actions.push({
      id: 'copy-agent-id',
      label: 'Copy agent id',
      onSelect: () => {
        void window.spadeHost.files.copyText(agentId).then((result) => {
          if (!result.ok) notify(`Could not copy the agent id: ${result.error.message}`)
        })
      }
    })
  }
  return actions
}

export const agentRenderer = defineEntityRenderer<AgentConfig>({
  type: AGENT_ENTITY,
  icon: 'A',
  Body: AgentBody,
  Status: AgentStatus,
  CreateForm: AgentCreateForm,
  menuActions
})
