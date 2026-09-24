import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  bindCheckoutStatus,
  checkoutStatusForSelection,
  type CheckoutStatus,
  type SelectedCheckoutStatus
} from '../../shared/checkout'
import type { PrototypeCommand } from '../../shared/commands'
import type { GitHubIssue, GitHubPullRequest } from '../../shared/github'
import type {
  P3IntegrationRequest,
  P3IntegrationSuccess
} from '../../shared/integration'
import type {
  NormalizedConversationEvent,
  PaseoNodeRuntime,
  PrototypeLedger,
  PrototypeNode,
  WorkItemStatus
} from '../../shared/model'
import {
  nodePresentationSize,
  projectActivitySidebar,
  projectGroupHull
} from '../../shared/projection'

type HullData = Record<string, unknown> & {
  id: string
  name: string
  kind: 'group' | 'work-item'
  status: WorkItemStatus | null
  focused: boolean
}
type PlaceholderData = Record<string, unknown> & {
  node: Extract<PrototypeNode, { kind: 'agent' | 'workspace' }>
}
type GitHubIssueData = Record<string, unknown> & {
  issue: GitHubIssue
  onOpen: () => void
}
type GitHubPullRequestData = Record<string, unknown> & {
  nodeId: string
  pullRequest: GitHubPullRequest
  onOpen: () => void
  onRefresh: () => void
}
type HullNode = Node<HullData, 'hull'>
type PlaceholderNode = Node<PlaceholderData, 'placeholder'>
type GitHubIssueFlowNode = Node<GitHubIssueData, 'github-issue'>
type GitHubPullRequestFlowNode = Node<GitHubPullRequestData, 'github-pull-request'>
type P3FlowNode = HullNode | PlaceholderNode | GitHubIssueFlowNode | GitHubPullRequestFlowNode

type NodeActions = {
  openGitHub(repository: string, resource: 'issues' | 'pull', number: number): void
  refreshPullRequest(nodeId: string): void
}

function GroupHull({ data }: NodeProps<HullNode>): React.JSX.Element {
  return (
    <section className="group-hull" data-kind={data.kind} data-focused={String(data.focused)}>
      <header className="group-hull__chrome">
        <span>{data.kind === 'work-item' ? 'WORKITEM' : 'GROUP'} · {data.id}</span>
        <strong>{data.name}</strong>
        {data.status && <small className={`status status--${data.status}`}>{data.status.toUpperCase()}</small>}
      </header>
    </section>
  )
}

function NodeFrame({
  icon,
  title,
  subtitle,
  className = '',
  resourceState,
  paseoType,
  children
}: {
  icon: string
  title: string
  subtitle: string
  className?: string
  resourceState?: string
  paseoType?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <article
      className={`generic-node ${className}`.trim()}
      data-paseo-type={paseoType}
      data-resource-state={resourceState}
    >
      <Handle type="target" position={Position.Left} />
      <header className="generic-node__chrome">
        <span>{icon}</span>
        <div>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
        {resourceState && (
          <em className={`resource-state resource-state--${resourceState}`}>{resourceState}</em>
        )}
      </header>
      <div className="generic-node__body">{children}</div>
      <Handle type="source" position={Position.Right} />
    </article>
  )
}

function GenericNode({ data }: NodeProps<PlaceholderNode>): React.JSX.Element {
  const { node } = data
  return (
    <NodeFrame
      icon={node.kind === 'agent' ? 'A' : 'W'}
      title={node.title}
      subtitle={`${node.kind.toUpperCase()} · ${node.resourceRef.id}`}
      resourceState={node.paseo?.state}
      paseoType={node.paseo?.type ?? 'placeholder'}
    >
      {node.paseo ? <PaseoResource runtime={node.paseo} /> : (
        <>
          <span>Semantic work item</span>
          <b>{node.workItemId ?? 'None · visual containment only'}</b>
        </>
      )}
    </NodeFrame>
  )
}

function PaseoResource({ runtime }: { runtime: PaseoNodeRuntime }): React.JSX.Element {
  if (runtime.type === 'workspace') {
    return (
      <dl className="resource-facts">
        <div><dt>Type</dt><dd>WORKSPACE</dd></div>
        <div><dt>Status</dt><dd>{runtime.status}</dd></div>
        <div><dt>Directory</dt><dd>{runtime.directory ?? 'Unavailable'}</dd></div>
        <div><dt>Branch</dt><dd>{runtime.branch ?? 'Unavailable'}</dd></div>
      </dl>
    )
  }

  return (
    <>
      <dl className="resource-facts">
        <div><dt>Type</dt><dd>{runtime.type === 'managed-agent' ? 'MANAGED AGENT' : 'PROVIDER SUBAGENT'}</dd></div>
        <div><dt>Provider</dt><dd>{runtime.provider}{runtime.type === 'managed-agent' && runtime.model ? ` · ${runtime.model}` : ''}</dd></div>
        <div><dt>Status</dt><dd>{runtime.status}</dd></div>
        {runtime.type === 'managed-agent' && <div><dt>Workspace</dt><dd>{runtime.workspaceId ?? 'None'}</dd></div>}
        <div><dt>Cwd</dt><dd>{runtime.cwd ?? 'Unavailable'}</dd></div>
      </dl>
      <section className="conversation" aria-label="Normalized conversation">
        {runtime.timeline.length === 0 ? <span>No timeline events</span> : runtime.timeline.map((event) => (
          <ConversationEvent event={event} key={event.id} />
        ))}
      </section>
    </>
  )
}

function ConversationEvent({ event }: { event: NormalizedConversationEvent }): React.JSX.Element {
  const [expanded, setExpanded] = useState(event.initialExpanded)
  return (
    <details
      className="conversation-event"
      open={expanded}
      onToggle={(toggleEvent) => setExpanded(toggleEvent.currentTarget.open)}
    >
      <summary><b>{event.kind}</b><span>{event.summary}</span></summary>
      <pre>{event.detail}</pre>
    </details>
  )
}

function GitHubIssueNode({ data }: NodeProps<GitHubIssueFlowNode>): React.JSX.Element {
  const { issue } = data
  return (
    <NodeFrame
      icon="#"
      title={issue.title}
      subtitle={`${issue.repository}#${issue.number}`}
      className="github-node"
    >
      <div className="github-node__meta">
        <strong className={`github-state github-state--${issue.state.toLowerCase()}`}>{issue.state}</strong>
        <time dateTime={issue.updatedAt}>Updated {formatTimestamp(issue.updatedAt)}</time>
      </div>
      {issue.labels.length > 0 && (
        <div className="github-labels" aria-label="Issue labels">
          {issue.labels.map((label) => <span key={label}>{label}</span>)}
        </div>
      )}
      <p>{issue.body || 'No issue description.'}</p>
      <button type="button" onClick={data.onOpen}>Open on GitHub</button>
    </NodeFrame>
  )
}

function GitHubPullRequestNode({ data }: NodeProps<GitHubPullRequestFlowNode>): React.JSX.Element {
  const { pullRequest } = data
  const checks = summarizeChecks(pullRequest)
  const activity = recentPullRequestActivity(pullRequest)
  return (
    <NodeFrame
      icon="PR"
      title={pullRequest.title}
      subtitle={`${pullRequest.repository}#${pullRequest.number} · ${pullRequest.author}`}
      className="github-node github-node--pr"
    >
      <div className="github-node__meta">
        <strong className={`github-state github-state--${pullRequest.state.toLowerCase()}`}>
          {pullRequest.state}
        </strong>
        <time dateTime={pullRequest.updatedAt}>Updated {formatTimestamp(pullRequest.updatedAt)}</time>
      </div>
      <dl className="github-facts">
        <div><dt>Branches</dt><dd>{pullRequest.baseBranch} ← {pullRequest.headBranch}</dd></div>
        <div><dt>Revision</dt><dd>{pullRequest.latestRevision.slice(0, 12)}</dd></div>
        <div><dt>Checks</dt><dd>{checks}</dd></div>
        <div>
          <dt>Activity</dt>
          <dd>
            {pullRequest.reviews.length} reviews · {pullRequest.comments.length} comments ·{' '}
            {pullRequest.reviewComments.length} inline
          </dd>
        </div>
      </dl>
      {activity.length > 0 && (
        <ul className="github-activity" aria-label="Pull request review and comment activity">
          {activity.map((item) => (
            <li key={item.id}>
              <span>{item.kind}</span>
              <b>{item.author}</b>
              <small>{item.detail}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="button" onClick={data.onRefresh}>Refresh PR</button>
        <button type="button" onClick={data.onOpen}>Open on GitHub</button>
      </div>
    </NodeFrame>
  )
}

const nodeTypes = {
  hull: GroupHull,
  placeholder: GenericNode,
  'github-issue': GitHubIssueNode,
  'github-pull-request': GitHubPullRequestNode
} satisfies NodeTypes

type FocusTarget = { position: { x: number; y: number }; size: { width: number; height: number } }

function FocusController({ target }: { target: FocusTarget | null }): null {
  const flow = useReactFlow()

  useEffect(() => {
    if (target) {
      void flow.setCenter(
        target.position.x + target.size.width / 2,
        target.position.y + target.size.height / 2,
        { zoom: 1, duration: 0 }
      )
    }
  }, [flow, target])

  return null
}

function toFlowNodes(
  ledger: PrototypeLedger,
  focusedGroupId: string | null,
  actions: NodeActions
): P3FlowNode[] {
  const hulls: HullNode[] = ledger.groups.map((group) => {
    const projection = projectGroupHull(group, ledger.nodes)
    return {
      id: `hull:${group.id}`,
      type: 'hull',
      position: projection.geometry.position,
      selectable: false,
      draggable: false,
      style: {
        width: projection.geometry.size.width,
        height: projection.geometry.size.height,
        zIndex: -1
      },
      data: {
        id: projection.id,
        name: projection.name,
        kind: projection.kind,
        status: projection.status,
        focused: focusedGroupId === projection.id
      }
    }
  })
  const resources = ledger.nodes.map((node): P3FlowNode => {
    const size = nodePresentationSize(node)
    if (node.kind === 'github-issue') {
      return {
        id: node.id,
        type: 'github-issue',
        position: node.position,
        dragHandle: '.generic-node__chrome',
        style: { width: size.width, zIndex: 2 },
        data: {
          issue: node.issue,
          onOpen: () => actions.openGitHub(node.issue.repository, 'issues', node.issue.number)
        }
      }
    }
    if (node.kind === 'github-pull-request') {
      return {
        id: node.id,
        type: 'github-pull-request',
        position: node.position,
        dragHandle: '.generic-node__chrome',
        style: { width: size.width, zIndex: 2 },
        data: {
          nodeId: node.id,
          pullRequest: node.pullRequest,
          onOpen: () => actions.openGitHub(
            node.pullRequest.repository,
            'pull',
            node.pullRequest.number
          ),
          onRefresh: () => actions.refreshPullRequest(node.id)
        }
      }
    }
    return {
      id: node.id,
      type: 'placeholder',
      position: node.position,
      dragHandle: '.generic-node__chrome',
      style: { width: size.width, zIndex: 2 },
      data: { node }
    }
  })
  return [...hulls, ...resources]
}

function toFlowEdges(ledger: PrototypeLedger): Edge[] {
  return ledger.edges.map((edge) => ({
    id: edge.id,
    source: edge.fromNodeId,
    target: edge.toNodeId,
    label: edge.relation,
    type: 'smoothstep'
  }))
}

export function App(): React.JSX.Element {
  const [ledger, setLedger] = useState<PrototypeLedger | null>(null)
  const [flowNodes, setFlowNodes] = useState<P3FlowNode[]>([])
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [groupName, setGroupName] = useState('')
  const [task, setTask] = useState('')
  const [targetGroup, setTargetGroup] = useState('Issue 17 · Generic shell')
  const [placeholderTitle, setPlaceholderTitle] = useState('')
  const [externalId, setExternalId] = useState('')
  const [fromNodeId, setFromNodeId] = useState('')
  const [toNodeId, setToNodeId] = useState('')
  const [paseoCwd, setPaseoCwd] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workItemId, setWorkItemId] = useState('work-item-1')
  const [repository, setRepository] = useState('skflowne/spade-fixture')
  const [issueNumber, setIssueNumber] = useState('1')
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null)
  const [workspaceNodeId, setWorkspaceNodeId] = useState('')
  const workspaceNodeIdRef = useRef('')
  const [checkoutStatus, setCheckoutStatus] = useState<SelectedCheckoutStatus | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [pullRequestTitle, setPullRequestTitle] = useState('')
  const [pullRequestBody, setPullRequestBody] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')

  useEffect(() => {
    const unsubscribe = window.spadeP3.subscribe(setLedger)
    void window.spadeP3.snapshot().then(setLedger).catch((reason: unknown) => setError(String(reason)))
    return unsubscribe
  }, [])

  const integrate = useCallback(async (
    request: P3IntegrationRequest
  ): Promise<P3IntegrationSuccess | null> => {
    setError('')
    setNotice('')
    try {
      const result = await window.spadeP3.integrate(request)
      if (!result.ok) {
        setError(`${result.error.kind}: ${result.error.message}`)
        return null
      }
      if ('ledger' in result.value) setLedger(result.value.ledger)
      return result.value
    } catch (reason) {
      setError(String(reason))
      return null
    }
  }, [])

  const openGitHub = useCallback((
    targetRepository: string,
    resource: 'issues' | 'pull',
    number: number
  ): void => {
    void integrate({
      type: 'open-github-resource',
      repository: targetRepository,
      resource,
      number
    })
  }, [integrate])

  const refreshPullRequest = useCallback((nodeId: string): void => {
    void integrate({ type: 'github-pull-request-refresh', nodeId })
  }, [integrate])

  const nodeActions = useMemo<NodeActions>(() => ({ openGitHub, refreshPullRequest }), [
    openGitHub,
    refreshPullRequest
  ])

  useEffect(() => {
    if (ledger) setFlowNodes(toFlowNodes(ledger, focusedGroupId, nodeActions))
  }, [focusedGroupId, ledger, nodeActions])

  useEffect(() => {
    if (!ledger?.nodes.length) return
    if (!fromNodeId) setFromNodeId(ledger.nodes[0].id)
    if (!toNodeId) setToNodeId(ledger.nodes[Math.min(1, ledger.nodes.length - 1)].id)
    const workspaces = ledger.nodes.filter((node) => node.kind === 'workspace')
    if (!workspaces.some(({ id }) => id === workspaceNodeId)) {
      const nextWorkspaceNodeId = workspaces[0]?.id ?? ''
      workspaceNodeIdRef.current = nextWorkspaceNodeId
      setWorkspaceNodeId(nextWorkspaceNodeId)
      setCheckoutStatus(null)
    }
  }, [fromNodeId, ledger, toNodeId, workspaceNodeId])

  const run = useCallback(async (command: PrototypeCommand): Promise<void> => {
    setError('')
    setNotice('')
    try {
      setLedger(await window.spadeP3.execute(command))
    } catch (reason) {
      setError(String(reason))
    }
  }, [])

  const onNodesChange = useCallback((changes: NodeChange<P3FlowNode>[]) => {
    setFlowNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const sidebarItems = useMemo(
    () => projectActivitySidebar(ledger?.groups ?? []),
    [ledger?.groups]
  )
  const edges = useMemo(() => (ledger ? toFlowEdges(ledger) : []), [ledger])
  const focusTarget = useMemo(() => {
    if (!ledger || !focusedGroupId) return null
    const group = ledger.groups.find(({ id }) => id === focusedGroupId)
    return group ? projectGroupHull(group, ledger.nodes).geometry : null
  }, [focusedGroupId, ledger])
  const workspaceNodes = useMemo(
    () => ledger?.nodes.filter((node) => node.kind === 'workspace') ?? [],
    [ledger?.nodes]
  )
  const visibleCheckoutStatus = checkoutStatusForSelection(checkoutStatus, workspaceNodeId)

  if (!ledger) {
    return <main className="loading-shell">Loading P3 prototype…</main>
  }

  const loadIssue = async (): Promise<void> => {
    const response = await integrate({
      type: 'github-issue-detail',
      repository,
      number: Number(issueNumber)
    })
    if (response?.type === 'github-issue-detail') setSelectedIssue(response.issue)
  }

  const createIssueWorkItem = async (): Promise<void> => {
    const response = await integrate({
      type: 'github-issue-create-work-item',
      repository,
      number: Number(issueNumber)
    })
    if (response?.type === 'github-issue-create-work-item') {
      setNotice('Issue linked to one native WorkItem.')
    }
  }

  const refreshCheckout = async (): Promise<void> => {
    const requestedWorkspaceNodeId = workspaceNodeIdRef.current
    const response = await integrate({
      type: 'checkout-status',
      workspaceNodeId: requestedWorkspaceNodeId
    })
    if (response?.type === 'checkout-status') {
      setCheckoutStatus(bindCheckoutStatus(
        requestedWorkspaceNodeId,
        workspaceNodeIdRef.current,
        response.status
      ))
    }
  }

  const commitCheckout = async (): Promise<void> => {
    const response = await integrate({
      type: 'checkout-commit',
      workspaceNodeId,
      message: commitMessage
    })
    if (response?.type === 'checkout-commit') {
      await refreshCheckout()
      setNotice(response.result
        ? `Committed ${response.result.revision.slice(0, 12)}.`
        : 'Committed checkout; resulting revision is unavailable.')
      if (response.warning) setError(`partial: commit succeeded, but refresh failed: ${response.warning.message}`)
    }
  }

  const pushCheckout = async (): Promise<void> => {
    const response = await integrate({ type: 'checkout-push', workspaceNodeId })
    if (response?.type === 'checkout-push') {
      setNotice(response.result
        ? `Pushed ${response.result.remote ? `${response.result.remote}/` : ''}${response.result.branch}.`
        : 'Pushed checkout; resulting remote branch is unavailable.')
      if (response.warning) setError(`partial: push succeeded, but refresh failed: ${response.warning.message}`)
    }
  }

  const createPullRequest = async (): Promise<void> => {
    const response = await integrate({
      type: 'checkout-create-pull-request',
      workspaceNodeId,
      input: {
        title: pullRequestTitle,
        body: pullRequestBody,
        ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {})
      }
    })
    if (response?.type === 'checkout-create-pull-request') {
      setNotice(`Created or linked PR ${response.pullRequest.repository}#${response.pullRequest.number}.`)
      if (response.warning) {
        setError(`partial: PR exists, but native refresh failed: ${response.warning.message}`)
      }
    }
  }

  const refreshPullRequestStatus = async (): Promise<void> => {
    const response = await integrate({ type: 'checkout-pull-request-status', workspaceNodeId })
    if (response?.type === 'checkout-pull-request-status') {
      setNotice(response.status.pullRequest
        ? `Linked PR ${response.status.pullRequest.repository}#${response.status.pullRequest.number} is ${response.status.state}.`
        : 'No pull request is linked to this checkout.')
      if (response.warning) setError(`partial: PR status loaded, but native refresh failed: ${response.warning.message}`)
    }
  }

  return (
    <main className="p3-shell">
      <header className="p3-header">
        <div>
          <p>SPADE EXPERIMENT P3</p>
          <h1>P3 native GitHub work shell</h1>
        </div>
        <span data-testid="paseo-connection">
          PASEO · {ledger.paseo.connection.toUpperCase()}
          {ledger.paseo.daemonUrl ? ` · ${ledger.paseo.daemonUrl}` : ''}
        </span>
      </header>

      <aside className="activity-sidebar">
        <div className="activity-sidebar__heading">
          <span>ACTIVITY</span>
          <strong>{ledger.project.name}</strong>
        </div>
        <nav aria-label="Work item activity">
          {sidebarItems.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-label={`Focus ${item.title}`}
              aria-pressed={focusedGroupId === item.id}
              onClick={() => setFocusedGroupId(item.id)}
            >
              <span>{item.title}</span>
              <small className={`status status--${item.status}`}>{item.status.toUpperCase()}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <section className="project-container" data-testid="project-container">
          <header>
            <span>PROJECT · {ledger.project.id}</span>
            <strong>{ledger.project.name}</strong>
          </header>
          <div className="canvas" aria-label="P3 global canvas">
            <ReactFlow
              nodes={flowNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              nodesConnectable={false}
              minZoom={0.35}
              maxZoom={1.5}
              fitView
              fitViewOptions={{ padding: 0.16 }}
            >
              <Background gap={20} size={1} />
              <Controls />
              <FocusController target={focusTarget} />
            </ReactFlow>
          </div>
        </section>
      </section>

      <aside className="command-panel" aria-label="Prototype commands">
        <section className="paseo-status-panel">
          <h2>Paseo state</h2>
          {ledger.paseo.error && <p className="connection-error">{ledger.paseo.error}</p>}
          <ul data-testid="paseo-capabilities">
            {ledger.paseo.capabilities.map((capability) => (
              <li key={capability.name} data-state={capability.state}>
                <b>{capability.name}</b> · {capability.state.toUpperCase()}
                {capability.detail && <small>{capability.detail}</small>}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Paseo bridge</h2>
          <label>
            Target WorkItem or group
            <input value={targetGroup} onChange={(event) => setTargetGroup(event.target.value)} />
          </label>
          <label>
            Checkout / agent cwd
            <input value={paseoCwd} onChange={(event) => setPaseoCwd(event.target.value)} />
          </label>
          <label>
            Opaque workspace ID
            <input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} />
          </label>
          <label>
            Opaque agent ID
            <input value={agentId} onChange={(event) => setAgentId(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => void run({ type: 'select-project-checkout', targetGroup, cwd: paseoCwd })}>
              Select checkout
            </button>
            <button type="button" onClick={() => void run({ type: 'create-workspace', targetGroup, cwd: paseoCwd })}>
              Create workspace
            </button>
            <button type="button" onClick={() => void run({ type: 'attach-workspace', targetGroup, workspaceId })}>
              Attach Paseo workspace
            </button>
            <button type="button" onClick={() => void run({ type: 'attach-agent', targetGroup, agentId })}>
              Attach root
            </button>
          </div>
          <label>
            Provider
            <input value={provider} onChange={(event) => setProvider(event.target.value)} />
          </label>
          <label>
            Model
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <label>
            Caller prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button
            type="button"
            className="primary"
            onClick={() => void run({
              type: 'spawn-agent',
              targetGroup,
              ...(workspaceId ? { workspaceId } : {}),
              cwd: paseoCwd,
              provider,
              model,
              prompt
            })}
          >
            Spawn root agent
          </button>
          <label>
            Bound WorkItem ID
            <input value={workItemId} onChange={(event) => setWorkItemId(event.target.value)} />
          </label>
          <button type="button" onClick={() => void run({ type: 'refresh-paseo', workItemId })}>
            Refresh authoritative snapshot
          </button>
        </section>

        <section>
          <h2>GitHub issue</h2>
          <label>
            Repository
            <input value={repository} onChange={(event) => setRepository(event.target.value)} />
          </label>
          <label>
            Issue number
            <input
              type="number"
              min="1"
              value={issueNumber}
              onChange={(event) => setIssueNumber(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => void loadIssue()}>Load issue</button>
            <button type="button" className="primary" onClick={() => void createIssueWorkItem()}>
              Create WorkItem
            </button>
          </div>
          {selectedIssue && (
            <article className="issue-selection" aria-label="Selected GitHub issue">
              <small>{selectedIssue.repository}#{selectedIssue.number} · {selectedIssue.state}</small>
              <strong>{selectedIssue.title}</strong>
              <p>{selectedIssue.body}</p>
              <button
                type="button"
                onClick={() => openGitHub(selectedIssue.repository, 'issues', selectedIssue.number)}
              >
                Open on GitHub
              </button>
            </article>
          )}
        </section>

        <section>
          <h2>Selected checkout</h2>
          <label htmlFor="workspace-node">Workspace</label>
          <select
            id="workspace-node"
            value={workspaceNodeId}
            onChange={(event) => {
              workspaceNodeIdRef.current = event.target.value
              setWorkspaceNodeId(event.target.value)
              setCheckoutStatus(null)
            }}
          >
            {workspaceNodes.map((node) => (
              <option key={node.id} value={node.id}>{node.title} · {node.resourceRef.id}</option>
            ))}
          </select>
          <button type="button" onClick={() => void refreshCheckout()}>Refresh checkout</button>
          {visibleCheckoutStatus && <CheckoutSummary status={visibleCheckoutStatus} />}
          <label>
            Commit message
            <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => void commitCheckout()}>Commit</button>
            <button type="button" onClick={() => void pushCheckout()}>Push</button>
          </div>
          <label>
            Pull request title
            <input value={pullRequestTitle} onChange={(event) => setPullRequestTitle(event.target.value)} />
          </label>
          <label>
            Pull request body
            <textarea value={pullRequestBody} onChange={(event) => setPullRequestBody(event.target.value)} />
          </label>
          <label>
            Base branch
            <input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => void createPullRequest()}>
              Create/link PR
            </button>
            <button type="button" onClick={() => void refreshPullRequestStatus()}>
              Refresh PR status
            </button>
          </div>
        </section>

        <section>
          <h2>Create containers</h2>
          <label>
            New group name
            <input value={groupName} onChange={(event) => setGroupName(event.target.value)} />
          </label>
          <label>
            Work item task
            <input value={task} onChange={(event) => setTask(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => void run({ type: 'create-group', name: groupName })}>
              Create Group
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void run({ type: 'create-work-item', name: groupName, task })}
            >
              Create WorkItem
            </button>
          </div>
        </section>

        <section>
          <h2>Place resources</h2>
          <label>
            Target group
            <input value={targetGroup} onChange={(event) => setTargetGroup(event.target.value)} />
          </label>
          <label>
            Placeholder title
            <input value={placeholderTitle} onChange={(event) => setPlaceholderTitle(event.target.value)} />
          </label>
          <label>
            External placeholder ID
            <input value={externalId} onChange={(event) => setExternalId(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() => void run({
                type: 'spawn-placeholder',
                targetGroup,
                nodeKind: 'agent',
                title: placeholderTitle,
                resourceRef: { provider: 'placeholder', kind: 'agent', id: externalId, revision: null }
              })}
            >
              Spawn agent
            </button>
            <button
              type="button"
              onClick={() => void run({
                type: 'attach-placeholder',
                targetGroup,
                nodeKind: 'workspace',
                title: placeholderTitle,
                resourceRef: { provider: 'placeholder', kind: 'workspace', id: externalId, revision: null }
              })}
            >
              Attach workspace
            </button>
          </div>
        </section>

        <section>
          <h2>Connect existing nodes</h2>
          <label htmlFor="from-node">From node</label>
          <select
            id="from-node"
            value={fromNodeId}
            onChange={(event) => setFromNodeId(event.target.value)}
          >
            {ledger.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select>
          <label htmlFor="to-node">To node</label>
          <select
            id="to-node"
            value={toNodeId}
            onChange={(event) => setToNodeId(event.target.value)}
          >
            {ledger.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select>
          <button
            type="button"
            onClick={() => void run({ type: 'connect-nodes', fromNodeId, toNodeId, relation: 'connected' })}
          >
            Connect nodes
          </button>
        </section>

        {notice && <p className="command-notice" role="status">{notice}</p>}
        {error && <p className="command-error" role="alert">{error}</p>}
      </aside>
    </main>
  )
}

function CheckoutSummary({ status }: { status: CheckoutStatus }): React.JSX.Element {
  return (
    <dl className="checkout-summary" aria-label="Checkout summary">
      <div><dt>Branch</dt><dd>{status.branch ?? 'Detached'}</dd></div>
      <div><dt>Revision</dt><dd>{status.headRevision?.slice(0, 12) ?? 'Unavailable'}</dd></div>
      <div><dt>Base</dt><dd>{status.baseRef ?? 'Not set'}</dd></div>
      <div><dt>Diff</dt><dd>{status.changedFiles} files · +{status.additions} −{status.deletions}</dd></div>
      <div>
        <dt>Working tree</dt>
        <dd>
          {checkoutCount(status.stagedFiles)} staged · {checkoutCount(status.unstagedFiles)} unstaged ·{' '}
          {checkoutCount(status.untrackedFiles)} untracked
        </dd>
      </div>
      <div><dt>Conflicts</dt><dd>{checkoutCount(status.conflicts)}</dd></div>
    </dl>
  )
}

function checkoutCount(value: number | null): string {
  return value === null ? 'Unavailable' : String(value)
}

function summarizeChecks(pullRequest: GitHubPullRequest): string {
  if (pullRequest.checks.length === 0) return 'No checks'
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const check of pullRequest.checks) counts[check.state] += 1
  return `${counts.passed} passed · ${counts.failed} failed · ${counts.pending} pending · ${counts.skipped} skipped`
}

function recentPullRequestActivity(pullRequest: GitHubPullRequest): Array<{
  id: string
  kind: string
  author: string
  detail: string
  timestamp: string
}> {
  return [
    ...pullRequest.reviews.map((review, index) => ({
      id: `review:${index}:${review.submittedAt}`,
      kind: 'REVIEW',
      author: review.author,
      detail: review.state,
      timestamp: review.submittedAt
    })),
    ...pullRequest.comments.map((comment, index) => ({
      id: `comment:${index}:${comment.createdAt}`,
      kind: 'COMMENT',
      author: comment.author,
      detail: comment.body || 'No text',
      timestamp: comment.createdAt
    })),
    ...pullRequest.reviewComments.map((comment, index) => ({
      id: `inline:${index}:${comment.createdAt}`,
      kind: 'INLINE',
      author: comment.author,
      detail: `${comment.path}: ${comment.body || 'No text'}`,
      timestamp: comment.createdAt
    }))
  ].sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, 3)
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString()
}
