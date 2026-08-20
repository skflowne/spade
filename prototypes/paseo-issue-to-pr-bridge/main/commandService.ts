import {
  applyPrototypeCommand,
  createInitialLedger,
  isPaseoCommand,
  resolveGroup,
  type PaseoCommand,
  type PrototypeCommand
} from '../shared/commands'
import {
  putPaseoResourceNode,
  reconcilePaseoWorkItem,
  type PaseoAgentSnapshot,
  type PaseoWorkspaceSnapshot
} from '../shared/paseoReconciliation'
import {
  type PaseoConnectionState,
  type PaseoNodeRuntime,
  type PaseoWorkItemBinding,
  type PrototypeLedger,
  type PrototypeNode
} from '../shared/model'
import type {
  PaseoAdapterNotification,
  PaseoSnapshotReferences,
  SpadePaseoAdapter
} from './SpadePaseoAdapter'

export type PrototypeLedgerStore = {
  load(): Promise<PrototypeLedger | null>
  save(ledger: PrototypeLedger): Promise<void>
}

export type PaseoAdapterPort = Pick<
  SpadePaseoAdapter,
  | 'url'
  | 'subscribe'
  | 'connect'
  | 'close'
  | 'pollConnectionState'
  | 'openProjectCheckout'
  | 'createWorkspace'
  | 'attachWorkspace'
  | 'spawnAgent'
  | 'attachAgent'
  | 'fetchAuthoritative'
>

export class PrototypeCommandService {
  private ledger: PrototypeLedger | null = null
  private executionQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(ledger: PrototypeLedger) => void>()
  private unsubscribeAdapter: (() => void) | null = null
  private acceptAdapterNotifications = false
  private refreshQueued = false

  constructor(
    private readonly store: PrototypeLedgerStore,
    private readonly adapter?: PaseoAdapterPort
  ) {}

  async initialize(seed?: PrototypeLedger): Promise<PrototypeLedger> {
    const stored = await this.store.load()
    const initial = stored ?? seed ?? createInitialLedger('project-p3', 'P3 prototype')
    await this.store.save(initial)
    this.ledger = initial

    if (this.adapter) {
      this.unsubscribeAdapter = this.adapter.subscribe((notification) => {
        if (this.acceptAdapterNotifications) this.handleAdapterNotification(notification)
      })
      try {
        await this.adapter.connect()
        const connection = this.adapter.pollConnectionState()
        this.ledger = setConnectionState(this.snapshot(), connection, this.adapter.url, null)
        if (connection === 'connected') this.ledger = await this.refreshAllBindings(this.ledger)
        await this.store.save(this.ledger)
      } catch (error) {
        this.ledger = setConnectionState(
          this.snapshot(),
          'error',
          this.adapter.url,
          errorMessage(error)
        )
        await this.store.save(this.ledger)
      }
      this.acceptAdapterNotifications = true
    }

    return this.snapshot()
  }

  snapshot(): PrototypeLedger {
    if (!this.ledger) throw new Error('Prototype command service is not initialized.')
    return structuredClone(this.ledger)
  }

  subscribe(listener: (ledger: PrototypeLedger) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  execute(command: PrototypeCommand): Promise<PrototypeLedger> {
    return this.enqueue(async () => {
      const current = this.snapshot()
      const next = isPaseoCommand(command)
        ? await this.executePaseoCommand(current, command)
        : applyPrototypeCommand(current, command).ledger
      await this.persistAndPublish(next)
      return this.snapshot()
    })
  }

  async close(): Promise<void> {
    this.acceptAdapterNotifications = false
    this.unsubscribeAdapter?.()
    this.unsubscribeAdapter = null
    await this.adapter?.close()
  }

  private executePaseoCommand(
    ledger: PrototypeLedger,
    command: PaseoCommand
  ): Promise<PrototypeLedger> {
    if (!this.adapter) throw new Error('The Paseo adapter is not configured.')

    return this.executePaseoOperation(ledger, async () => {
      switch (command.type) {
        case 'select-project-checkout': {
          const workItemId = requireWorkItem(ledger, command.targetGroup)
          const workspace = await this.adapter!.openProjectCheckout(command.cwd)
          return putWorkspace(ledger, workItemId, workspace)
        }
        case 'create-workspace': {
          const workItemId = requireWorkItem(ledger, command.targetGroup)
          const workspace = await this.adapter!.createWorkspace(command.cwd, command.title)
          return putWorkspace(ledger, workItemId, workspace)
        }
        case 'attach-workspace': {
          const workItemId = requireWorkItem(ledger, command.targetGroup)
          const workspace = await this.adapter!.attachWorkspace(command.workspaceId)
          if (!workspace) throw new Error(`Paseo workspace ${command.workspaceId} is missing.`)
          return putWorkspace(ledger, workItemId, workspace)
        }
        case 'spawn-agent': {
          const workItemId = requireWorkItem(ledger, command.targetGroup)
          const agent = await this.adapter!.spawnAgent({
            workspaceId: command.workspaceId,
            cwd: command.cwd,
            provider: command.provider,
            model: command.model,
            prompt: command.prompt,
            title: command.title
          })
          return this.bindAndRefresh(putManagedAgent(ledger, workItemId, agent), workItemId, agent.id)
        }
        case 'attach-agent': {
          const workItemId = requireWorkItem(ledger, command.targetGroup)
          const agent = await this.adapter!.attachAgent(command.agentId)
          if (!agent) throw new Error(`Paseo agent ${command.agentId} is missing.`)
          return this.bindAndRefresh(putManagedAgent(ledger, workItemId, agent), workItemId, agent.id)
        }
        case 'refresh-paseo': {
          const binding = requireBinding(ledger, command.workItemId)
          return this.refreshBinding(ledger, binding)
        }
      }
    })
  }

  private async executePaseoOperation(
    ledger: PrototypeLedger,
    operation: () => Promise<PrototypeLedger>
  ): Promise<PrototypeLedger> {
    try {
      return await operation()
    } catch (error) {
      const failed = setConnectionState(
        ledger,
        'error',
        this.adapter?.url ?? ledger.paseo.daemonUrl,
        errorMessage(error)
      )
      await this.persistAndPublish(failed)
      throw error
    }
  }

  private async bindAndRefresh(
    ledger: PrototypeLedger,
    workItemId: string,
    rootAgentId: string
  ): Promise<PrototypeLedger> {
    const binding = { workItemId, rootAgentId }
    const bound = {
      ...ledger,
      paseo: {
        ...ledger.paseo,
        bindings: [
          ...ledger.paseo.bindings.filter((candidate) => candidate.workItemId !== workItemId),
          binding
        ]
      }
    }
    return this.refreshBinding(bound, binding)
  }

  private async refreshAllBindings(ledger: PrototypeLedger): Promise<PrototypeLedger> {
    let next = await this.refreshUnboundResources(ledger)
    for (const binding of ledger.paseo.bindings) next = await this.refreshBinding(next, binding)
    return next
  }

  private async refreshUnboundResources(ledger: PrototypeLedger): Promise<PrototypeLedger> {
    if (!this.adapter) return ledger
    const boundWorkItemIds = new Set(ledger.paseo.bindings.map(({ workItemId }) => workItemId))
    let next = ledger
    for (const original of ledger.nodes) {
      if (!original.paseo || (original.workItemId && boundWorkItemIds.has(original.workItemId))) continue

      if (original.paseo.type === 'managed-agent') {
        const agent = await this.adapter.attachAgent(original.resourceRef.id)
        next = updateExistingPaseoNode(
          next,
          original.id,
          agent ? managedAgentRuntime(agent, original.paseo.timeline) : { ...original.paseo, state: 'missing' }
        )
      } else if (original.paseo.type === 'workspace') {
        const workspace = await this.adapter.attachWorkspace(original.resourceRef.id)
        next = updateExistingPaseoNode(
          next,
          original.id,
          workspace ? workspaceRuntime(workspace) : { ...original.paseo, state: 'missing' }
        )
      } else {
        next = updateExistingPaseoNode(next, original.id, { ...original.paseo, state: 'missing' })
      }
    }
    return next
  }

  private async refreshBinding(
    ledger: PrototypeLedger,
    binding: PaseoWorkItemBinding
  ): Promise<PrototypeLedger> {
    if (!this.adapter) return ledger
    const references = paseoReferences(ledger, binding.workItemId)
    const authoritative = await this.adapter.fetchAuthoritative(binding.rootAgentId, references)
    return reconcilePaseoWorkItem(ledger, binding.workItemId, authoritative)
  }

  private handleAdapterNotification(notification: PaseoAdapterNotification): void {
    if (notification.type === 'connection') {
      void this.enqueue(async () => {
        let next = setConnectionState(
          this.snapshot(),
          notification.state,
          this.adapter?.url ?? null,
          notification.error
        )
        if (notification.state === 'connected') {
          try {
            next = await this.refreshAllBindings(next)
          } catch (error) {
            next = setConnectionState(next, 'error', this.adapter?.url ?? null, errorMessage(error))
          }
        }
        await this.persistAndPublish(next)
        return undefined
      })
      return
    }

    this.queueAuthoritativeRefresh()
  }

  private queueAuthoritativeRefresh(): void {
    if (this.refreshQueued) return
    this.refreshQueued = true
    void this.enqueue(async () => {
      this.refreshQueued = false
      const current = this.snapshot()
      if (current.paseo.connection !== 'connected') return undefined
      try {
        await this.persistAndPublish(await this.refreshAllBindings(current))
      } catch (error) {
        await this.persistAndPublish(
          setConnectionState(current, 'error', this.adapter?.url ?? null, errorMessage(error))
        )
      }
      return undefined
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.executionQueue.then(operation)
    this.executionQueue = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  private async persistAndPublish(ledger: PrototypeLedger): Promise<void> {
    await this.store.save(ledger)
    this.ledger = ledger
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function requireWorkItem(ledger: PrototypeLedger, reference: string): string {
  const group = resolveGroup(ledger, reference)
  if (group.kind !== 'work-item') throw new Error(`Group “${reference}” is not a WorkItem.`)
  return group.id
}

function requireBinding(ledger: PrototypeLedger, workItemId: string): PaseoWorkItemBinding {
  const binding = ledger.paseo.bindings.find((candidate) => candidate.workItemId === workItemId)
  if (!binding) throw new Error(`WorkItem ${workItemId} has no root Paseo agent.`)
  return binding
}

function paseoReferences(ledger: PrototypeLedger, workItemId: string): PaseoSnapshotReferences {
  const nodes = ledger.nodes.filter((node) => node.workItemId === workItemId && node.resourceRef.provider === 'paseo')
  return {
    agentIds: nodes
      .filter(({ paseo }) => paseo?.type === 'managed-agent')
      .map(({ resourceRef }) => resourceRef.id),
    workspaceIds: nodes
      .filter(({ paseo }) => paseo?.type === 'workspace')
      .map(({ resourceRef }) => resourceRef.id)
  }
}

function putManagedAgent(
  ledger: PrototypeLedger,
  workItemId: string,
  agent: PaseoAgentSnapshot
): PrototypeLedger {
  const runtime = managedAgentRuntime(agent, [])
  return putPaseoResourceNode(
    ledger,
    workItemId,
    'agent',
    agent.title ?? `Agent ${agent.id}`,
    { provider: 'paseo', kind: 'agent', id: agent.id, revision: agent.updatedAt },
    runtime
  ).ledger
}

function putWorkspace(
  ledger: PrototypeLedger,
  workItemId: string,
  workspace: PaseoWorkspaceSnapshot
): PrototypeLedger {
  return putPaseoResourceNode(
    ledger,
    workItemId,
    'workspace',
    workspace.name,
    { provider: 'paseo', kind: 'workspace', id: workspace.id, revision: workspace.updatedAt },
    workspaceRuntime(workspace)
  ).ledger
}

function managedAgentRuntime(
  agent: PaseoAgentSnapshot,
  timeline: Extract<PaseoNodeRuntime, { type: 'managed-agent' }>['timeline']
): Extract<PaseoNodeRuntime, { type: 'managed-agent' }> {
  return {
    type: 'managed-agent',
    state: 'connected',
    parentAgentId: agent.parentAgentId,
    workspaceId: agent.workspaceId,
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    cwd: agent.cwd,
    timeline
  }
}

function workspaceRuntime(
  workspace: PaseoWorkspaceSnapshot
): Extract<PaseoNodeRuntime, { type: 'workspace' }> {
  return {
    type: 'workspace',
    state: 'connected',
    projectId: workspace.projectId,
    directory: workspace.directory,
    branch: workspace.branch,
    status: workspace.status
  }
}

function updateExistingPaseoNode(
  ledger: PrototypeLedger,
  nodeId: string,
  paseo: PaseoNodeRuntime
): PrototypeLedger {
  return {
    ...ledger,
    nodes: ledger.nodes.map((node) => (node.id === nodeId ? { ...node, paseo } : node))
  }
}

function setConnectionState(
  ledger: PrototypeLedger,
  connection: PaseoConnectionState,
  daemonUrl: string | null,
  error: string | null
): PrototypeLedger {
  return {
    ...ledger,
    paseo: { ...ledger.paseo, connection, daemonUrl, error },
    nodes: ledger.nodes.map((node): PrototypeNode => {
      if (!node.paseo) return node
      const state = connection === 'connected' ? node.paseo.state : connection
      return { ...node, paseo: { ...node.paseo, state } }
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
