import { useCallback, useEffect, useId, useState } from 'react'
import type { AgentProviderInfo } from '@shared/agents'
import { AGENT_ENTITY, type AgentConfig } from '@shared/builtinEntities'
import type { AgentDefaults } from '@shared/domain'
import { useAppState } from '../../store/hooks'
import { TextField } from '../../ui/fields'
import type { EntityCreateFormProps } from '../types'

type Providers = { status: 'loading' } | { status: 'ready'; providers: AgentProviderInfo[] } | { status: 'failed'; message: string }

type Choice = { provider: string; model: string; mode: string }

// The defaults when they name an available provider, else the first available provider's own defaults.
function initialChoice(providers: AgentProviderInfo[], defaults: AgentDefaults | null): Choice | null {
  const saved = defaults ? providers.find((provider) => provider.available && provider.id === defaults.provider) : undefined
  const provider = saved ?? providers.find((candidate) => candidate.available)
  if (!provider) return null
  return choiceFor(provider, saved ? defaults : null)
}

function choiceFor(provider: AgentProviderInfo, defaults: AgentDefaults | null): Choice {
  const model =
    (defaults && provider.models.some((candidate) => candidate.id === defaults.model) ? defaults.model : null) ??
    provider.models.find((candidate) => candidate.isDefault)?.id ??
    provider.models[0]?.id ??
    ''
  const mode =
    (defaults?.mode && provider.modes.some((candidate) => candidate.id === defaults.mode) ? defaults.mode : null) ??
    provider.defaultModeId ??
    provider.modes[0]?.id ??
    ''
  return { provider: provider.id, model, mode }
}

export function AgentCreateForm({ project, formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  const app = useAppState()
  const defaults = app?.settings.agentDefaults ?? null
  const paseo = app?.paseo
  const [providers, setProviders] = useState<Providers>({ status: 'loading' })
  const [choice, setChoice] = useState<Choice | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const ids = { provider: useId(), model: useId(), mode: useId(), hint: useId() }

  const load = useCallback(async (): Promise<void> => {
    setProviders({ status: 'loading' })
    const result = await window.spadeHost.agents
      .listProviders()
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    if (!result.ok) {
      setProviders({ status: 'failed', message: result.error.message })
      return
    }
    setProviders({ status: 'ready', providers: result.providers })
    // The defaults apply once, when the providers first arrive; a retry keeps the user's choice.
    setChoice((current) => current ?? initialChoice(result.providers, defaults))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const list = providers.status === 'ready' ? providers.providers : []
  const provider = list.find((candidate) => candidate.id === choice?.provider) ?? null

  const submit = (): void => {
    if (!choice || !provider?.available || !prompt.trim()) return
    const config: AgentConfig = {
      provider: choice.provider,
      model: choice.model || null,
      mode: choice.mode || null,
      prompt
    }
    void window.spadeHost.app.updateSettings({
      agentDefaults: { provider: choice.provider, model: choice.model, mode: choice.mode || null }
    })
    onSubmit({ entityType: AGENT_ENTITY, config, ...(title.trim() ? { title: title.trim() } : {}) })
  }

  return (
    <form
      id={formId}
      className="entity-form agent-create"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {providers.status === 'failed' ? (
        <div className="agent-create__problem" role="alert">
          <p>
            {paseo?.state === 'disabled'
              ? 'Paseo is disabled for this session, so agents cannot be started.'
              : `Paseo is not reachable${paseo ? ` at ${paseo.url}` : ''}: ${providers.message}`}
          </p>
          <button type="button" className="cr-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {providers.status === 'ready' && !list.some((candidate) => candidate.available) ? (
        <div className="agent-create__problem" role="alert">
          <p>No agent provider is available in Paseo.</p>
          <button type="button" className="cr-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="agent-create__row">
        <div className="cr-field">
          <label htmlFor={ids.provider}>Provider</label>
          <select
            id={ids.provider}
            className="cr-input"
            required
            value={choice?.provider ?? ''}
            disabled={providers.status !== 'ready'}
            onChange={(event) => {
              const next = list.find((candidate) => candidate.id === event.target.value)
              if (next) setChoice(choiceFor(next, defaults?.provider === next.id ? defaults : null))
            }}
          >
            {providers.status === 'loading' ? <option value="">Loading providers…</option> : null}
            {choice === null && providers.status !== 'loading' ? <option value="">No provider</option> : null}
            {list.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                {candidate.available ? candidate.label : `${candidate.label} — ${candidate.error ?? candidate.status}`}
              </option>
            ))}
          </select>
        </div>
        <div className="cr-field">
          <label htmlFor={ids.model}>Model</label>
          <select
            id={ids.model}
            className="cr-input"
            value={choice?.model ?? ''}
            disabled={!provider || provider.models.length === 0}
            onChange={(event) => choice && setChoice({ ...choice, model: event.target.value })}
          >
            {provider && provider.models.length === 0 ? <option value="">Provider default</option> : null}
            {provider?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
        <div className="cr-field">
          <label htmlFor={ids.mode}>Mode</label>
          <select
            id={ids.mode}
            className="cr-input"
            value={choice?.mode ?? ''}
            disabled={!provider || provider.modes.length === 0}
            onChange={(event) => choice && setChoice({ ...choice, mode: event.target.value })}
          >
            {provider && provider.modes.length === 0 ? <option value="">Provider default</option> : null}
            {provider?.modes.map((mode) => (
              <option key={mode.id} value={mode.id} title={mode.description}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <TextField
        label="Prompt"
        value={prompt}
        onChange={setPrompt}
        multiline
        required
        autoFocus
        hint={
          <>
            Starts in the project root: <span className="mono">{project.rootPath}</span>
          </>
        }
      />
      <TextField label="Title" value={title} onChange={setTitle} placeholder="From the prompt" />
    </form>
  )
}
