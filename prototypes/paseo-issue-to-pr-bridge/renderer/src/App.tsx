import { useCallback, useEffect, useMemo, useState } from 'react'
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
import type { PrototypeCommand } from '../../shared/commands'
import type {
  NormalizedConversationEvent,
  PaseoNodeRuntime,
  PrototypeLedger,
  PrototypeNode,
  WorkItemStatus
} from '../../shared/model'
import { projectActivitySidebar, projectGroupHull } from '../../shared/projection'

type HullData = Record<string, unknown> & {
  id: string
  name: string
  kind: 'group' | 'work-item'
  status: WorkItemStatus | null
  focused: boolean
}
type PlaceholderData = Record<string, unknown> & {
  node: PrototypeNode
}
type HullNode = Node<HullData, 'hull'>
type PlaceholderNode = Node<PlaceholderData, 'placeholder'>
type P3FlowNode = HullNode | PlaceholderNode

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

function GenericNode({ data }: NodeProps<PlaceholderNode>): React.JSX.Element {
  const { node } = data
  return (
    <article
      className="generic-node"
      data-paseo-type={node.paseo?.type ?? 'placeholder'}
      data-resource-state={node.paseo?.state ?? 'placeholder'}
    >
      <Handle type="target" position={Position.Left} />
      <header className="generic-node__chrome">
        <span>{node.kind === 'agent' ? 'A' : 'W'}</span>
        <div>
          <strong>{node.title}</strong>
          <small>{node.kind.toUpperCase()} · {node.resourceRef.id}</small>
        </div>
        {node.paseo && <em className={`resource-state resource-state--${node.paseo.state}`}>{node.paseo.state}</em>}
      </header>
      <div className="generic-node__body">
        {node.paseo ? <PaseoResource runtime={node.paseo} /> : (
          <>
            <span>Semantic work item</span>
            <b>{node.workItemId ?? 'None · visual containment only'}</b>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </article>
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

const nodeTypes = { hull: GroupHull, placeholder: GenericNode } satisfies NodeTypes

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

function toFlowNodes(ledger: PrototypeLedger, focusedGroupId: string | null): P3FlowNode[] {
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
  const placeholders: PlaceholderNode[] = ledger.nodes
    .filter((node): node is Extract<PrototypeNode, { kind: 'agent' | 'workspace' }> =>
      node.kind === 'agent' || node.kind === 'workspace'
    )
    .map((node) => ({
      id: node.id,
      type: 'placeholder',
      position: node.position,
      dragHandle: '.generic-node__chrome',
      style: { width: 220, height: 116, zIndex: 2 },
      data: { node }
    }))
  return [...hulls, ...placeholders]
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

  useEffect(() => {
    const unsubscribe = window.spadeP3.subscribe(setLedger)
    void window.spadeP3.snapshot().then(setLedger).catch((reason: unknown) => setError(String(reason)))
    return unsubscribe
  }, [])

  useEffect(() => {
    if (ledger) setFlowNodes(toFlowNodes(ledger, focusedGroupId))
  }, [focusedGroupId, ledger])

  useEffect(() => {
    if (!ledger?.nodes.length) return
    if (!fromNodeId) setFromNodeId(ledger.nodes[0].id)
    if (!toNodeId) setToNodeId(ledger.nodes[Math.min(1, ledger.nodes.length - 1)].id)
  }, [fromNodeId, ledger, toNodeId])

  const run = useCallback(async (command: PrototypeCommand): Promise<void> => {
    setError('')
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

  if (!ledger) {
    return <main className="loading-shell">Loading P3 prototype…</main>
  }

  return (
    <main className="p3-shell">
      <header className="p3-header">
        <div>
          <p>SPADE EXPERIMENT P3</p>
          <h1>P3 generic work shell</h1>
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

        {error && <p className="command-error" role="alert">{error}</p>}
      </aside>
    </main>
  )
}
