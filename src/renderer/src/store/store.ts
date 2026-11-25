import type { AgentRuntime } from '@shared/agents'
import type { CanvasCommand, CanvasCommandResponse } from '@shared/commands'
import type { AppSettings, Canvas } from '@shared/domain'
import type { AppState, Failure, Result, SpadeHostBridge } from '@shared/ipc'
import { runTransitions } from '../entities/agent/children'
import { shareCanvas, shareRecords } from './sharing'

// The renderer's view of SPADE's records. The main process is authoritative: everything here is a copy
// refreshed by the bridge's pushes, and nothing is written back except through bridge calls.

export type Notice = {
  id: string
  message: string
  // A problem SPADE worked around at startup, an action that failed, or a short-lived confirmation.
  kind: 'problem' | 'failure' | 'info'
  // An info notice may offer one follow-up, e.g. Undo; running it dismisses the notice.
  action?: { label: string; run(): void }
}

// How long an info notice stays before it dismisses itself.
export const INFO_NOTICE_MS = 8_000

// Renderer-only choices that last until the app quits.
export type SessionPreferences = { minimap: boolean }

export type StoreState = {
  app: AppState | null
  // Set when the initial app state could not be read.
  startupError: string | null
  // Canvases loaded so far, by project id. Kept current by canvas pushes.
  canvases: ReadonlyMap<string, Canvas>
  // Agent runtimes by node id, across every project.
  runtimes: ReadonlyMap<string, AgentRuntime>
  // Collapsed Paseo children (by agent id) seen finishing a run that the user has not looked at yet.
  finishedAgents: ReadonlySet<string>
  notices: readonly Notice[]
  session: SessionPreferences
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class SpadeStore {
  private state: StoreState = {
    app: null,
    startupError: null,
    canvases: new Map(),
    runtimes: new Map(),
    finishedAgents: new Set(),
    notices: [],
    session: { minimap: true }
  }
  private readonly listeners = new Set<() => void>()
  private readonly loadingCanvases = new Set<string>()
  // Projects whose canvas was pushed while a read was in flight; the push is newer than the read.
  private readonly pushedWhileLoading = new Set<string>()
  private readonly runtimeProjects = new Set<string>()
  private readonly dismissedProblems = new Set<string>()
  private noticeCounter = 0

  constructor(private readonly host: SpadeHostBridge) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): StoreState => this.state

  // Subscribes to the bridge and reads the initial state. Returns the unsubscribe function.
  start(): () => void {
    const unsubscribe = [
      this.host.app.onState((app) => this.receiveAppState(app)),
      this.host.canvas.onChanged((canvas) => this.receiveCanvas(canvas)),
      this.host.agents.onRuntime((runtime) => this.receiveRuntime(runtime))
    ]
    this.host.app.getState().then(
      (app) => this.receiveAppState(app),
      (error: unknown) => this.update({ startupError: describe(error) })
    )
    return () => unsubscribe.forEach((stop) => stop())
  }

  // --- Projects ---

  async openProject(): Promise<void> {
    const response = await this.host.projects.open()
    if (!response.ok) this.fail('Could not open the project', response)
  }

  async selectProject(projectId: string): Promise<void> {
    // The canvas read starts at once so the switch does not wait for the state push.
    void this.loadCanvas(projectId)
    const response = await this.host.projects.select(projectId)
    if (!response.ok) this.fail('Could not switch projects', response)
  }

  async renameProject(projectId: string, name: string): Promise<boolean> {
    const response = await this.host.projects.rename(projectId, name)
    if (!response.ok) this.fail('Could not rename the project', response)
    return response.ok
  }

  async changeProjectRoot(projectId: string): Promise<void> {
    const response = await this.host.projects.changeRoot(projectId)
    if (!response.ok) this.fail('Could not change the project root', response)
  }

  async removeProject(projectId: string): Promise<void> {
    const response = await this.host.projects.remove(projectId)
    if (!response.ok) this.fail('Could not remove the project', response)
  }

  // --- Canvases ---

  async loadCanvas(projectId: string): Promise<void> {
    if (this.state.canvases.has(projectId) || this.loadingCanvases.has(projectId)) return
    this.loadingCanvases.add(projectId)
    this.pushedWhileLoading.delete(projectId)
    try {
      const canvas = await this.host.canvas.get(projectId)
      if (!this.pushedWhileLoading.has(projectId) && this.hasProject(projectId)) this.setCanvas(canvas)
    } catch (error) {
      this.notify(`Could not load the canvas: ${describe(error)}`)
    } finally {
      this.loadingCanvases.delete(projectId)
    }
  }

  // Every failure becomes a visible notice; callers may still inspect the response.
  async execute(projectId: string, command: CanvasCommand): Promise<CanvasCommandResponse> {
    let response: CanvasCommandResponse
    try {
      response = await this.host.canvas.execute(projectId, command)
    } catch (error) {
      response = { ok: false, error: { code: 'internal', message: describe(error) } }
    }
    if (!response.ok) this.notify(response.error.message)
    return response
  }

  // --- Notices ---

  notify(message: string): void {
    this.noticeCounter += 1
    this.update({ notices: [...this.state.notices, { id: `failure-${this.noticeCounter}`, message, kind: 'failure' }] })
  }

  // A transient confirmation. Returns its id.
  inform(message: string, action?: Notice['action']): string {
    this.noticeCounter += 1
    const id = `info-${this.noticeCounter}`
    this.update({ notices: [...this.state.notices, { id, message, kind: 'info', ...(action ? { action } : {}) }] })
    setTimeout(() => this.dismissNotice(id), INFO_NOTICE_MS)
    return id
  }

  dismissNotice(id: string): void {
    if (id.startsWith('problem:')) this.dismissedProblems.add(id)
    this.update({ notices: this.state.notices.filter((notice) => notice.id !== id) })
  }

  // --- Agents ---

  // The user has seen that this agent finished its run.
  acknowledgeFinished(agentId: string): void {
    if (!this.state.finishedAgents.has(agentId)) return
    const finishedAgents = new Set(this.state.finishedAgents)
    finishedAgents.delete(agentId)
    this.update({ finishedAgents })
  }

  // --- Settings and session ---

  async updateSettings(patch: Partial<AppSettings>): Promise<boolean> {
    let response: Result
    try {
      response = await this.host.app.updateSettings(patch)
    } catch (error) {
      response = { ok: false, error: { code: 'internal', message: describe(error) } }
    }
    if (!response.ok) this.fail('Could not save the settings', response)
    return response.ok
  }

  setSession(patch: Partial<SessionPreferences>): void {
    this.update({ session: { ...this.state.session, ...patch } })
  }

  // --- Internals ---

  private receiveAppState(pushed: AppState): void {
    // Unchanged projects keep their identity, so a state push does not re-render every canvas node.
    const app = this.state.app ? { ...pushed, projects: shareRecords(this.state.app.projects, pushed.projects) } : pushed
    const known = new Set(app.projects.map((project) => project.id))
    const canvases = new Map([...this.state.canvases].filter(([id]) => known.has(id)))
    const runtimes = new Map([...this.state.runtimes].filter(([, runtime]) => known.has(runtime.projectId)))
    const problems: Notice[] = app.problems
      .map((problem) => ({
        id: `problem:${problem.code}:${problem.projectId ?? 'app'}:${problem.message}`,
        message: problem.message,
        kind: 'problem' as const
      }))
      .filter((notice) => !this.dismissedProblems.has(notice.id))
    const failures = this.state.notices.filter((notice) => notice.kind !== 'problem')
    this.update({ app, canvases, runtimes, notices: [...problems, ...failures] })

    if (app.selectedProjectId !== null) void this.loadCanvas(app.selectedProjectId)
    for (const project of app.projects) this.loadRuntimes(project.id)
  }

  private receiveCanvas(canvas: Canvas): void {
    if (this.loadingCanvases.has(canvas.projectId)) this.pushedWhileLoading.add(canvas.projectId)
    if (this.state.app && !this.hasProject(canvas.projectId)) return
    this.setCanvas(canvas)
  }

  private receiveRuntime(runtime: AgentRuntime): void {
    const previous = this.state.runtimes.get(runtime.nodeId)
    const runtimes = new Map(this.state.runtimes)
    runtimes.set(runtime.nodeId, runtime)
    const { finished, resumed } = runTransitions(previous?.children ?? [], runtime.children)
    if (finished.length === 0 && !resumed.some((agentId) => this.state.finishedAgents.has(agentId))) {
      this.update({ runtimes })
      return
    }
    const finishedAgents = new Set(this.state.finishedAgents)
    for (const agentId of finished) finishedAgents.add(agentId)
    for (const agentId of resumed) finishedAgents.delete(agentId)
    this.update({ runtimes, finishedAgents })
  }

  private loadRuntimes(projectId: string): void {
    if (this.runtimeProjects.has(projectId)) return
    this.runtimeProjects.add(projectId)
    this.host.agents.getRuntimes(projectId).then(
      (list) => {
        const runtimes = new Map(this.state.runtimes)
        // A pushed runtime is at least as new as the listed one.
        for (const runtime of list) if (!runtimes.has(runtime.nodeId)) runtimes.set(runtime.nodeId, runtime)
        this.update({ runtimes })
      },
      () => this.runtimeProjects.delete(projectId)
    )
  }

  private hasProject(projectId: string): boolean {
    return this.state.app?.projects.some((project) => project.id === projectId) ?? true
  }

  private setCanvas(pushed: Canvas): void {
    const previous = this.state.canvases.get(pushed.projectId)
    const canvas = shareCanvas(previous, pushed)
    if (canvas === previous) return
    const canvases = new Map(this.state.canvases)
    canvases.set(canvas.projectId, canvas)
    this.update({ canvases })
  }

  private fail(what: string, failure: Failure): void {
    this.notify(`${what}: ${failure.error.message}`)
  }

  private update(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
