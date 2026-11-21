import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConfig } from '@shared/builtinEntities'
import { DEFAULT_CONVERSATION_EXPANSION } from '@shared/domain'
import type { AnnotateHandler, SubmitHandler } from '../../rich'
import { useAgentRuntime, useAppState, useSpadeStore } from '../../store/hooks'
import type { EntityBodyProps } from '../types'
import { AnnotationStore } from './annotations'
import { ArtifactLayer } from './ArtifactLayer'
import { Composer } from './Composer'
import { ConversationContext, type ConversationServices } from './ConversationContext'
import { ConversationView } from './ConversationView'
import { effectiveExpansion, type ExpansionOverride } from './expansion'
import { ExpansionControl } from './ExpansionControl'
import { Permissions } from './Permissions'
import { agentStatusOf, lastAssistantExcerpt, promptBlockReason, runtimeIdentity } from './status'
import { Subagents } from './Subagents'
import { formatSubmission } from './submission'
import { useTimeline } from './useTimeline'

const PREVIEW_PAGE_LIMIT = 12
const PREVIEW_EXCERPT_LIMIT = 280

export function AgentBody(props: EntityBodyProps<AgentConfig>): React.JSX.Element {
  return props.detail === 'preview' ? <AgentPreview {...props} /> : <AgentConversation {...props} />
}

// Level-of-detail rendering: status and the last answer, from one small page.
function AgentPreview({ node }: EntityBodyProps<AgentConfig>): React.JSX.Element {
  const runtime = useAgentRuntime(node.id)
  const timeline = useTimeline(node.id, runtime?.resourceState ?? null, PREVIEW_PAGE_LIMIT)
  const excerpt = timeline.state ? lastAssistantExcerpt(timeline.state.items, PREVIEW_EXCERPT_LIMIT) : null
  return (
    <div className="agent-preview" data-testid="agent-preview">
      <p className="agent-preview__status">{runtime ? agentStatusOf(runtime).description : (node.cachedPresentation?.summary ?? 'No status yet')}</p>
      <p className="agent-preview__excerpt">{excerpt ?? 'No answer yet.'}</p>
    </div>
  )
}

function AgentConversation({ node, config, project, host }: EntityBodyProps<AgentConfig>): React.JSX.Element {
  const runtime = useAgentRuntime(node.id)
  const app = useAppState()
  const store = useSpadeStore()
  const timeline = useTimeline(node.id, runtime?.resourceState ?? null)
  const global = app?.settings.conversationExpansion ?? DEFAULT_CONVERSATION_EXPANSION
  const override = useOverride(config.expansion)
  const expansion = useMemo(() => effectiveExpansion(global, override.value), [global, override.value])
  const blocked = promptBlockReason(node, runtime)
  const [annotations] = useState(() => new AnnotationStore())
  const latest = useRef({ blocked, nodeId: node.id })
  latest.current = { blocked, nodeId: node.id }
  const notify = useCallback((message: string) => store.notify(message), [store])

  const prompt = useCallback(async (text: string, contextNodeIds?: string[]): Promise<string | null> => {
    const result = await window.spadeHost.agents
      .prompt(latest.current.nodeId, contextNodeIds && contextNodeIds.length > 0 ? { text, contextNodeIds } : { text })
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    return result.ok ? null : result.error.message
  }, [])

  const handlers = useRef(new Map<string, { onSubmit: SubmitHandler; onAnnotate: AnnotateHandler }>())
  const answerHandlers = useCallback(
    (answerKey: string, title: string | null) => {
      let entry = handlers.current.get(answerKey)
      if (!entry) {
        entry = {
          // Settles the answer script's promise: resolves once the agent accepted the prompt.
          async onSubmit(input) {
            const reason = latest.current.blocked
            if (reason) throw new Error(reason)
            const sent = annotations.get(answerKey)
            const problem = await prompt(formatSubmission({ title, ...input, annotations: sent }))
            if (problem !== null) throw new Error(problem)
            annotations.clear(answerKey, sent)
          },
          onAnnotate(input) {
            annotations.add(answerKey, input)
          }
        }
        handlers.current.set(answerKey, entry)
      }
      return entry
    },
    [annotations, prompt]
  )

  const openSubagent = useCallback(
    async (subagentId: string): Promise<void> => {
      const result = await window.spadeHost.agents
        .openProviderSubagent(latest.current.nodeId, subagentId)
        .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
      if (result.ok) host.focusNode(result.nodeId)
      else notify(`Could not open the sub-agent: ${result.error.message}`)
    },
    [host, notify]
  )

  const subagentList = runtime?.providerSubagents
  const subagentIds = useMemo(() => new Set((subagentList ?? []).map((subagent) => subagent.id)), [subagentList])

  const services = useMemo<ConversationServices>(
    () => ({ expansion, annotations, answerHandlers, submitBlocked: blocked, subagentIds, openSubagent }),
    [expansion, annotations, answerHandlers, blocked, subagentIds, openSubagent]
  )

  const setOverride = (value: ExpansionOverride | undefined): void => {
    override.set(value)
    // updateNode replaces the whole config.
    const next: AgentConfig = { ...config, expansion: value }
    if (value === undefined) delete next.expansion
    void host.execute({ type: 'updateNode', nodeId: node.id, patch: { config: next } }).then((response) => {
      if (!response.ok) override.set(null)
    })
  }

  const interrupt = async (): Promise<void> => {
    const result = await window.spadeHost.agents
      .interrupt(node.id)
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    if (!result.ok) notify(`Could not interrupt the agent: ${result.error.message}`)
  }

  const running = runtime?.activity === 'running' || runtime?.activity === 'starting'
  const items = timeline.state?.items ?? []

  return (
    <ArtifactLayer projectId={project.id} nodeId={node.id} host={host} notify={notify}>
      <ConversationContext.Provider value={services}>
        <div className="agent-body">
          <div className="agent-toolbar">
            <span className="agent-toolbar__identity mono" title={runtime?.cwd ?? project.rootPath}>
              {runtimeIdentity(runtime ?? config) || config.provider}
            </span>
            <ExpansionControl global={global} override={override.value} onChange={setOverride} />
          </div>
          <StateBanner
            nodeHasAgent={node.resourceRef !== null}
            resourceState={runtime?.resourceState ?? null}
            hasRuntime={runtime !== null}
            error={timeline.error}
            onRetry={timeline.reload}
          />
          {subagentList ? <Subagents subagents={subagentList} onOpen={openSubagent} /> : null}
          <ConversationView
            items={items}
            hasOlder={timeline.state?.olderCursor != null}
            loadingOlder={timeline.loadingOlder}
            onLoadOlder={timeline.loadOlder}
            empty={
              <p className="agent-empty">
                {timeline.state === null
                  ? timeline.error
                    ? (node.cachedPresentation?.summary ?? 'The conversation could not be loaded.')
                    : 'Loading the conversation…'
                  : 'No messages yet.'}
              </p>
            }
          />
          <Permissions nodeId={node.id} requests={runtime?.pendingPermissions ?? []} blocked={blocked} />
          <Composer
            nodeId={node.id}
            blocked={blocked}
            running={running}
            send={(text, contextNodeIds) => prompt(text, contextNodeIds)}
            interrupt={interrupt}
          />
        </div>
      </ConversationContext.Provider>
    </ArtifactLayer>
  )
}

// The override as last chosen here, until the node's record catches up: quick successive changes build
// on each other instead of on a stale record.
function useOverride(stored: ExpansionOverride | undefined): {
  value: ExpansionOverride | undefined
  set(value: ExpansionOverride | undefined | null): void
} {
  const [local, setLocal] = useState<{ value: ExpansionOverride | undefined } | null>(null)
  useEffect(() => {
    if (local !== null && JSON.stringify(local.value) === JSON.stringify(stored)) setLocal(null)
  }, [local, stored])
  return {
    value: local === null ? stored : local.value,
    set: (value) => setLocal(value === null ? null : { value })
  }
}

function StateBanner(props: {
  nodeHasAgent: boolean
  resourceState: 'live' | 'stale' | 'missing' | null
  hasRuntime: boolean
  error: string | null
  onRetry(): void
}): React.JSX.Element | null {
  if (props.resourceState === 'missing') {
    return (
      <p className="agent-banner agent-banner--danger" role="status" data-testid="agent-state">
        Paseo no longer has this agent. The node and its children stay on the canvas.
      </p>
    )
  }
  if (props.resourceState === 'stale') {
    return (
      <p className="agent-banner agent-banner--warning" role="status" data-testid="agent-state">
        Paseo unreachable. Showing the last loaded conversation.
      </p>
    )
  }
  if (props.nodeHasAgent && !props.hasRuntime) {
    return (
      <p className="agent-banner" role="status" data-testid="agent-state">
        Waiting for the agent’s state from Paseo…
      </p>
    )
  }
  if (props.error) {
    return (
      <p className="agent-banner agent-banner--warning" role="status" data-testid="agent-state">
        <span>Could not load the conversation: {props.error}</span>
        <button type="button" className="cr-button cr-button--ghost" onClick={props.onRetry}>
          Retry
        </button>
      </p>
    )
  }
  return null
}
