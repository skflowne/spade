import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PASEO_PROVIDER_SUBAGENT_KIND, type AgentConfig } from '@shared/builtinEntities'
import type { PermissionBehavior } from '@shared/agents'
import { DEFAULT_CONVERSATION_EXPANSION } from '@shared/domain'
import { useCanvasActions } from '../../canvas/CanvasContext'
import { focusNodeHeader } from '../../canvas/nodeFocus'
import type { AnnotateHandler, SubmitHandler } from '../../rich'
import { useAgentRuntime, useAppState } from '../../store/hooks'
import type { EntityBodyProps } from '../types'
import { ArtifactLayer } from './ArtifactLayer'
import { ChildAgents } from './ChildAgents'
import { Composer } from './Composer'
import { ConversationContext, type ConversationServices } from './ConversationContext'
import { ConversationView } from './ConversationView'
import { conversationState } from './conversationState'
import { effectiveExpansion, type ExpansionOverride } from './expansion'
import { ExpansionControl } from './ExpansionControl'
import { ModeSelect } from './ModeSelect'
import { Permissions } from './Permissions'
import { agentStatusOf, lastAssistantExcerpt, promptBlockReason, runtimeIdentity } from './status'
import { Subagents } from './Subagents'
import { createAnswerSubmitter } from './submission'
import { useTimeline } from './useTimeline'

const PREVIEW_PAGE_LIMIT = 12
const PREVIEW_EXCERPT_LIMIT = 280

export function AgentBody(props: EntityBodyProps<AgentConfig>): React.JSX.Element {
  return props.detail === 'preview' ? <AgentPreview {...props} /> : <AgentConversation {...props} />
}

// Level-of-detail rendering: status and the last answer known. Reads one small page only when nothing is
// remembered for the node or the conversation changed since.
function AgentPreview({ node }: EntityBodyProps<AgentConfig>): React.JSX.Element {
  const runtime = useAgentRuntime(node.id)
  // Re-renders whenever the remembered pages change.
  useTimeline(node.id, runtime?.resourceState ?? null, PREVIEW_PAGE_LIMIT)
  const answer = conversationState(node.id).lastAnswer
  const excerpt = answer ? lastAssistantExcerpt([answer], PREVIEW_EXCERPT_LIMIT) : null
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
  const timeline = useTimeline(node.id, runtime?.resourceState ?? null)
  const global = app?.settings.conversationExpansion ?? DEFAULT_CONVERSATION_EXPANSION
  const override = useOverride(config.expansion)
  const expansion = useMemo(() => effectiveExpansion(global, override.value), [global, override.value])
  const blocked = promptBlockReason(node, runtime)
  const annotations = conversationState(node.id).annotations
  const latest = useRef({ blocked, nodeId: node.id })
  latest.current = { blocked, nodeId: node.id }
  const notify = useCallback((message: string) => host.notify(message), [host])

  const prompt = useCallback(async (text: string, contextNodeIds?: string[]): Promise<string | null> => {
    const result = await window.spadeHost.agents
      .prompt(latest.current.nodeId, contextNodeIds && contextNodeIds.length > 0 ? { text, contextNodeIds } : { text })
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    return result.ok ? null : result.error.message
  }, [])

  const [submitAnswer] = useState(() =>
    createAnswerSubmitter({ annotations, blocked: () => latest.current.blocked, prompt: (text) => prompt(text) })
  )
  const handlers = useRef(new Map<string, { onSubmit: SubmitHandler; onAnnotate: AnnotateHandler }>())
  const answerHandlers = useCallback(
    (answerKey: string, title: string | null) => {
      let entry = handlers.current.get(answerKey)
      if (!entry) {
        entry = {
          // Settles the answer script's promise: resolves once the agent accepted the prompt.
          onSubmit: (input) => submitAnswer(answerKey, title, input),
          onAnnotate(input) {
            annotations.add(answerKey, input)
          }
        }
        handlers.current.set(answerKey, entry)
      }
      return entry
    },
    [annotations, submitAnswer]
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

  const canvasActions = useCanvasActions()
  const leaveAnswer = useCallback(() => {
    canvasActions.setActiveNode(null)
    focusNodeHeader(latest.current.nodeId)
  }, [canvasActions])

  const subagentList = runtime?.providerSubagents
  const subagentIds = useMemo(() => new Set((subagentList ?? []).map((subagent) => subagent.id)), [subagentList])

  const services = useMemo<ConversationServices>(
    () => ({ expansion, annotations, answerHandlers, submitBlocked: blocked, subagentIds, openSubagent, leaveAnswer }),
    [expansion, annotations, answerHandlers, blocked, subagentIds, openSubagent, leaveAnswer]
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
  // Provider-native sub-agents have no mode in Paseo.
  const modeRuntime = runtime !== null && node.resourceRef?.kind !== PASEO_PROVIDER_SUBAGENT_KIND ? runtime : null
  const respondToPermission = useCallback(
    (requestId: string, behavior: PermissionBehavior) =>
      window.spadeHost.agents.respondToPermission(latest.current.nodeId, requestId, behavior),
    []
  )

  return (
    <ArtifactLayer projectId={project.id} projectRoot={project.rootPath} nodeId={node.id} host={host} revision={timeline.state}>
      <ConversationContext.Provider value={services}>
        <div className="agent-body">
          <div className="agent-toolbar">
            <span className="agent-toolbar__identity mono" title={runtime?.cwd ?? project.rootPath}>
              {runtimeIdentity(modeRuntime ? { ...modeRuntime, mode: null } : (runtime ?? config)) || config.provider}
            </span>
            {modeRuntime ? (
              <ModeSelect
                agentId={modeRuntime.agentId}
                provider={modeRuntime.provider}
                mode={modeRuntime.mode}
                label="Mode"
                blocked={blocked}
                notify={notify}
              />
            ) : null}
            <ExpansionControl global={global} override={override.value} onChange={setOverride} />
          </div>
          <StateBanner
            nodeHasAgent={node.resourceRef !== null}
            resourceState={runtime?.resourceState ?? null}
            hasRuntime={runtime !== null}
            error={timeline.error}
            onRetry={timeline.reload}
          />
          {runtime ? <ChildAgents ownerNodeId={node.id} children={runtime.children} host={host} /> : null}
          {subagentList ? <Subagents subagents={subagentList} onOpen={openSubagent} /> : null}
          <ConversationView
            nodeId={node.id}
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
          <Permissions requests={runtime?.pendingPermissions ?? []} respond={respondToPermission} blocked={blocked} />
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
