import { randomUUID } from 'node:crypto'
import type { MainEntityAdapter, WorkspaceGateway, WorkspaceGatewayEvent } from '../contracts'
import {
  CorruptDataError,
  UnsupportedVersionError,
  createDefaultAppIndex,
  type AppDataStore,
  type AppIndex
} from '../persistence'
import { applyCanvasCommand } from '../../shared/canvasReducer'
import { parseCanvasCommand } from '../../shared/commandValidation'
import { CanvasCommandError, type CanvasCommand, type CanvasCommandOutcome } from '../../shared/commands'
import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Actor,
  type AppSettings,
  type Canvas,
  type CanvasNode,
  type Project,
  type ResourceRef
} from '../../shared/domain'
import type { EntityRegistry } from '../../shared/entities'
import type { AppProblem } from '../../shared/ipc'
import { isAbsolutePath, isSamePath, pathBaseName } from '../../shared/paths'
import { RecordValidationError, parseAppSettings } from '../../shared/recordValidation'
import { describe, isCreationCommand, mergeCreateResult, preflightCreation } from './entityCreation'
import { WorkspaceError } from './errors'

export type WorkspaceGatewayOptions = {
  store: AppDataStore
  entities: EntityRegistry
  now?: () => Date
  // Ids for projects, nodes, edges, and activity entries. Project ids must be safe file names.
  createId?: () => string
}

type NodeMatch = { projectId: string; node: CanvasNode }

// The production WorkspaceGateway, plus the project and selection operations only the app shell uses.
// Every change to SPADE's records runs in one queue, strictly in arrival order; the store stays the
// durable source and this class keeps what it has loaded or written.
export class SpadeWorkspaceGateway implements WorkspaceGateway {
  private readonly store: AppDataStore
  private readonly entities: EntityRegistry
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly adapters = new Map<string, MainEntityAdapter>()
  private readonly listeners = new Set<(event: WorkspaceGatewayEvent) => void>()
  private readonly canvases = new Map<string, Promise<Canvas>>()
  private readonly loadProblems: AppProblem[] = []
  private index: AppIndex = createDefaultAppIndex()
  // Set when the stored index must never be overwritten.
  private indexRefusal: UnsupportedVersionError | null = null
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(options: WorkspaceGatewayOptions) {
    this.store = options.store
    this.entities = options.entities
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  static async open(options: WorkspaceGatewayOptions): Promise<SpadeWorkspaceGateway> {
    const gateway = new SpadeWorkspaceGateway(options)
    try {
      gateway.index = await gateway.store.loadIndex()
    } catch (error) {
      if (error instanceof CorruptDataError) {
        gateway.loadProblems.push(problem(error, null))
      } else if (error instanceof UnsupportedVersionError) {
        gateway.indexRefusal = error
        gateway.loadProblems.push(problem(error, null))
      } else {
        throw error
      }
    }
    return gateway
  }

  listProjects(): Project[] {
    return this.index.projects
  }

  getProject(projectId: string): Project | null {
    return this.index.projects.find((project) => project.id === projectId) ?? null
  }

  selectedProjectId(): string | null {
    return this.index.selectedProjectId
  }

  getSettings(): AppSettings {
    return this.index.settings
  }

  problems(): AppProblem[] {
    return [...this.loadProblems]
  }

  subscribe(listener: (event: WorkspaceGatewayEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  registerEntityAdapter(adapter: MainEntityAdapter): void {
    if (!this.entities.has(adapter.type)) throw new Error(`No entity type ${adapter.type} for this adapter`)
    if (this.adapters.has(adapter.type)) throw new Error(`An entity adapter for ${adapter.type} is already registered`)
    this.adapters.set(adapter.type, adapter)
  }

  // Selects the project as well. A root that is already a project yields that project instead.
  createProject(rootPath: string, name?: string): Promise<{ project: Project; created: boolean }> {
    return this.serialized(async () => {
      if (typeof rootPath !== 'string' || !isAbsolutePath(rootPath)) {
        throw new WorkspaceError('invalid-argument', 'A project root must be an absolute directory path')
      }
      const existing = this.index.projects.find((project) => isSamePath(project.rootPath, rootPath))
      if (existing) {
        if (this.index.selectedProjectId !== existing.id) {
          await this.saveIndex({ ...this.index, selectedProjectId: existing.id }, 'projects-changed')
        }
        return { project: existing, created: false }
      }

      const project: Project = {
        version: DOMAIN_RECORD_VERSION,
        id: this.createId(),
        name: name === undefined ? pathBaseName(rootPath) || rootPath : requireName(name),
        rootPath,
        createdAt: this.now().toISOString()
      }
      this.assertIndexWritable()
      const canvas = createEmptyCanvas(project.id)
      await this.store.saveCanvas(canvas)
      this.canvases.set(project.id, Promise.resolve(canvas))
      await this.saveIndex(
        { ...this.index, projects: [...this.index.projects, project], selectedProjectId: project.id },
        'projects-changed'
      )
      return { project, created: true }
    })
  }

  renameProject(projectId: string, name: string): Promise<Project> {
    return this.serialized(() => this.replaceProject(projectId, (project) => ({ ...project, name: requireName(name) })))
  }

  // Identity is the project id, so the canvas is unaffected.
  changeProjectRoot(projectId: string, rootPath: string): Promise<Project> {
    return this.serialized(() =>
      this.replaceProject(projectId, (project) => {
        if (typeof rootPath !== 'string' || !isAbsolutePath(rootPath)) {
          throw new WorkspaceError('invalid-argument', 'A project root must be an absolute directory path')
        }
        const owner = this.index.projects.find(
          (candidate) => candidate.id !== project.id && isSamePath(candidate.rootPath, rootPath)
        )
        if (owner) throw new WorkspaceError('root-in-use', `"${owner.name}" already uses ${rootPath} as its root`)
        return { ...project, rootPath }
      })
    )
  }

  // Removes SPADE's records only. A canvas this version could not read is left on disk untouched.
  removeProject(projectId: string): Promise<void> {
    return this.serialized(async () => {
      this.requireProject(projectId)
      const projects = this.index.projects.filter((project) => project.id !== projectId)
      const selectedProjectId =
        this.index.selectedProjectId === projectId ? (projects[0]?.id ?? null) : this.index.selectedProjectId
      const unreadable = this.loadProblems.some(
        (entry) => entry.projectId === projectId && entry.code === 'unsupported-version'
      )
      await this.saveIndex({ ...this.index, projects, selectedProjectId }, null)
      this.canvases.delete(projectId)
      for (let index = this.loadProblems.length - 1; index >= 0; index -= 1) {
        if (this.loadProblems[index].projectId === projectId) this.loadProblems.splice(index, 1)
      }
      if (!unreadable) await this.store.deleteCanvas(projectId)
      this.publish({ type: 'projects-changed' })
    })
  }

  selectProject(projectId: string): Promise<void> {
    return this.serialized(async () => {
      this.requireProject(projectId)
      if (this.index.selectedProjectId === projectId) return
      await this.saveIndex({ ...this.index, selectedProjectId: projectId }, 'projects-changed')
    })
  }

  updateSettings(patch: Partial<AppSettings>): Promise<void> {
    return this.serialized(async () => {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new WorkspaceError('invalid-argument', 'Settings must be an object')
      }
      const settings = { ...this.index.settings, ...patch }
      try {
        parseAppSettings(settings)
      } catch (error) {
        if (error instanceof RecordValidationError) throw new WorkspaceError('invalid-argument', error.message)
        throw error
      }
      await this.saveIndex({ ...this.index, settings }, 'settings-changed')
    })
  }

  // Rejects with CanvasCommandError: unknown-project, or canvas-unavailable when the stored canvas is unreadable.
  getCanvas(projectId: string): Promise<Canvas> {
    if (typeof projectId !== 'string' || !this.getProject(projectId)) {
      return Promise.reject(new CanvasCommandError('unknown-project', `Unknown project: ${String(projectId)}`))
    }
    return this.loadCanvas(projectId)
  }

  async execute(projectId: string, untrusted: CanvasCommand, actor: Actor): Promise<CanvasCommandOutcome> {
    let command = parseCanvasCommand(untrusted)
    let nodeId: string | undefined

    if (isCreationCommand(command) && !command.node.resourceRef) {
      const adapter = this.adapters.get(command.node.entityType)
      if (adapter) {
        const project = this.requireCanvasProject(projectId)
        const { config, sourceNode } = preflightCreation(await this.loadCanvas(projectId), command, this.entities)
        nodeId = this.createId()
        let seed
        try {
          const result = await adapter.create({ nodeId, config, project, sourceNode, actor, title: command.node.title })
          seed = mergeCreateResult(command.node, result)
        } catch (error) {
          throw new CanvasCommandError('entity-create-failed', `Could not create the ${adapter.type}: ${describe(error)}`)
        }
        try {
          command = parseCanvasCommand({ ...command, node: seed })
        } catch (error) {
          throw new CanvasCommandError('entity-create-failed', `The ${adapter.type} adapter returned ${describe(error)}`)
        }
      }
    }

    const applied = command
    return this.serialized(async () => {
      this.requireCanvasProject(projectId)
      const canvas = await this.loadCanvas(projectId)
      const result = applyCanvasCommand(canvas, applied, {
        actor,
        now: this.now().toISOString(),
        createId: this.createId,
        entities: this.entities,
        nodeId
      })
      if (result.canvas !== canvas) {
        await this.store.saveCanvas(result.canvas)
        this.canvases.set(projectId, Promise.resolve(result.canvas))
        this.publish({ type: 'canvas-changed', canvas: result.canvas, command: applied, actor })
      }
      return result.outcome
    })
  }

  findNodeByResource(ref: ResourceRef): Promise<NodeMatch | null> {
    return this.findAcrossProjects(
      (node) =>
        node.resourceRef !== null &&
        node.resourceRef.provider === ref.provider &&
        node.resourceRef.kind === ref.kind &&
        node.resourceRef.id === ref.id
    )
  }

  findNode(nodeId: string): Promise<NodeMatch | null> {
    return this.findAcrossProjects((node) => node.id === nodeId)
  }

  // Resolves once every change queued so far is applied and written. Call before quitting.
  async flush(): Promise<void> {
    await this.serialized(async () => undefined)
    await this.store.flush()
  }

  private async findAcrossProjects(matches: (node: CanvasNode) => boolean): Promise<NodeMatch | null> {
    for (const project of this.index.projects) {
      const canvas = await this.loadCanvas(project.id).catch(() => null)
      const node = canvas?.nodes.find(matches)
      if (node) return { projectId: project.id, node }
    }
    return null
  }

  private loadCanvas(projectId: string): Promise<Canvas> {
    const cached = this.canvases.get(projectId)
    if (cached) return cached
    const loading = this.readCanvas(projectId)
    this.canvases.set(projectId, loading)
    loading.catch(() => {
      // Unreadable canvases stay refused; anything else may be transient and is read again next time.
      if (this.canvases.get(projectId) === loading && !this.isUnreadable(projectId)) this.canvases.delete(projectId)
    })
    return loading
  }

  private async readCanvas(projectId: string): Promise<Canvas> {
    try {
      return await this.store.loadCanvas(projectId)
    } catch (error) {
      if (error instanceof CorruptDataError) {
        this.addProblem(problem(error, projectId))
        return createEmptyCanvas(projectId)
      }
      if (error instanceof UnsupportedVersionError) {
        this.addProblem(problem(error, projectId))
        throw unavailable(error)
      }
      throw error
    }
  }

  private isUnreadable(projectId: string): boolean {
    return this.loadProblems.some((entry) => entry.projectId === projectId && entry.code === 'unsupported-version')
  }

  private addProblem(entry: AppProblem): void {
    this.loadProblems.push(entry)
    // Problems are part of the app state the shell publishes on this event.
    this.publish({ type: 'projects-changed' })
  }

  private requireProject(projectId: string): Project {
    const project = typeof projectId === 'string' ? this.getProject(projectId) : null
    if (!project) throw new WorkspaceError('unknown-project', `Unknown project: ${String(projectId)}`)
    return project
  }

  private requireCanvasProject(projectId: string): Project {
    const project = typeof projectId === 'string' ? this.getProject(projectId) : null
    if (!project) throw new CanvasCommandError('unknown-project', `Unknown project: ${String(projectId)}`)
    return project
  }

  private async replaceProject(projectId: string, change: (project: Project) => Project): Promise<Project> {
    const next = change(this.requireProject(projectId))
    const projects = this.index.projects.map((project) => (project.id === projectId ? next : project))
    await this.saveIndex({ ...this.index, projects }, 'projects-changed')
    return next
  }

  // Memory follows the disk: the index changes only once the write succeeded.
  private async saveIndex(next: AppIndex, event: 'projects-changed' | 'settings-changed' | null): Promise<void> {
    this.assertIndexWritable()
    await this.store.saveIndex(next)
    this.index = next
    if (event) this.publish({ type: event })
  }

  private assertIndexWritable(): void {
    if (this.indexRefusal) {
      throw new WorkspaceError('records-read-only', `SPADE's records are read-only: ${this.indexRefusal.message}`)
    }
  }

  private serialized<Value>(task: () => Promise<Value>): Promise<Value> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private publish(event: WorkspaceGatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('A workspace gateway listener failed', error)
      }
    }
  }
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new WorkspaceError('invalid-argument', 'A project name must be a non-empty string')
  }
  return name.trim()
}

function problem(error: CorruptDataError | UnsupportedVersionError, projectId: string | null): AppProblem {
  return { code: error.code, message: error.message, projectId }
}

function unavailable(error: UnsupportedVersionError): CanvasCommandError {
  return new CanvasCommandError('canvas-unavailable', error.message)
}
