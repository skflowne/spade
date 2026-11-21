import { useState } from 'react'
import { AGENT_ENTITY, type AgentConfig } from '@shared/builtinEntities'
import { useAgentRuntime } from '../../store/hooks'
import { DetailList, TextField } from '../../ui/fields'
import { StatusBadge } from '../../ui/StatusBadge'
import { defineEntityRenderer } from '../registry'
import type { EntityBodyProps, EntityCreateFormProps, EntityStatusProps, NodeStatusTone } from '../types'

// Minimal placeholder: the agent conversation slice replaces this file wholesale.

function AgentBody({ config }: EntityBodyProps<AgentConfig>): React.JSX.Element {
  return (
    <div className="entity-summary">
      <DetailList
        rows={[
          ['Provider', config.provider],
          ['Model', config.model ?? 'Provider default'],
          ['Mode', config.mode ?? 'Provider default'],
          ['Prompt', config.prompt ?? 'None']
        ]}
      />
    </div>
  )
}

const ACTIVITY_TONE: Record<string, NodeStatusTone> = {
  starting: 'info',
  running: 'info',
  attention: 'warning',
  error: 'danger',
  idle: 'success'
}

function AgentStatus({ node }: EntityStatusProps<AgentConfig>): React.JSX.Element | null {
  const runtime = useAgentRuntime(node.id)
  if (!runtime) return null
  return (
    <StatusBadge
      status={{ label: runtime.activity, tone: ACTIVITY_TONE[runtime.activity] ?? 'neutral', description: runtime.status }}
    />
  )
}

function AgentCreateForm({ formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  const [prompt, setPrompt] = useState('')
  const optional = (value: string): string | null => (value.trim() ? value.trim() : null)
  return (
    <form
      id={formId}
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({
          entityType: AGENT_ENTITY,
          config: { provider: provider.trim(), model: optional(model), mode: optional(mode), prompt: optional(prompt) },
          ...(title.trim() ? { title: title.trim() } : {})
        })
      }}
    >
      <TextField label="Title" value={title} onChange={setTitle} autoFocus />
      <TextField label="Provider" value={provider} onChange={setProvider} required placeholder="claude" monospace />
      <TextField label="Model" value={model} onChange={setModel} monospace />
      <TextField label="Mode" value={mode} onChange={setMode} monospace />
      <TextField label="Prompt" value={prompt} onChange={setPrompt} multiline />
    </form>
  )
}

export const agentRenderer = defineEntityRenderer<AgentConfig>({
  type: AGENT_ENTITY,
  icon: 'A',
  Body: AgentBody,
  Status: AgentStatus,
  CreateForm: AgentCreateForm
})
