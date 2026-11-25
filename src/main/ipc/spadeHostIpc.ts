import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { AgentService, FileService } from '../contracts'
import { WorkspaceError, type SpadeWorkspaceGateway } from '../gateway'
import { CanvasCommandError, type CanvasCommandResponse } from '../../shared/commands'
import type { Actor, Project } from '../../shared/domain'
import {
  SPADE_HOST_EVENTS,
  spadeHostChannel,
  type AppState,
  type EnvelopedMethod,
  type IpcEnvelope,
  type Result,
  type SpadeHostBridge,
  type SpadeHostMethod
} from '../../shared/ipc'
import * as args from './arguments'
import { toCommandFailure, toFailure } from './failures'

export type SpadeHostIpcOptions = {
  // The app window's contents: the only sender allowed to call, and the receiver of every push.
  contents: WebContents
  gateway: SpadeWorkspaceGateway
  agents: AgentService
  files: FileService
  appVersion: string
  // Native folder picker; null when the user cancels.
  pickDirectory(): Promise<string | null>
}

type BridgeFunction<Method extends SpadeHostMethod> = Method extends `${infer Namespace}.${infer Name}`
  ? Namespace extends keyof SpadeHostBridge
    ? Name extends keyof SpadeHostBridge[Namespace]
      ? SpadeHostBridge[Namespace][Name]
      : never
    : never
  : never

type BridgeValue<Method extends SpadeHostMethod> =
  BridgeFunction<Method> extends (...parameters: never[]) => Promise<infer Value> ? Value : never

// What crosses IPC for each method: the bridge's own result, or an envelope around it.
type Wire<Method extends SpadeHostMethod> = Method extends EnvelopedMethod
  ? IpcEnvelope<BridgeValue<Method>>
  : BridgeValue<Method>

type Handlers = { [Method in SpadeHostMethod]: (...parameters: unknown[]) => Promise<Wire<Method>> }

// Renderer requests are always the user's.
const USER: Actor = { kind: 'user' }

// Registers one handler per bridge method and pushes app, canvas, agent, and image events to the window.
// Returns the function that undoes both.
export function registerSpadeHostIpc(options: SpadeHostIpcOptions): () => void {
  const { contents, gateway, agents, files } = options

  const appState = (): AppState => ({
    projects: gateway.listProjects(),
    selectedProjectId: gateway.selectedProjectId(),
    settings: gateway.getSettings(),
    paseo: agents.connection(),
    appVersion: options.appVersion,
    problems: gateway.problems()
  })

  const project = (projectId: unknown): Project => {
    const found = gateway.getProject(args.id(projectId, 'projectId'))
    if (!found) throw new WorkspaceError('unknown-project', `Unknown project: ${String(projectId)}`)
    return found
  }

  const handlers: Handlers = {
    'app.getState': () => envelope(async () => appState()),
    'app.updateSettings': (patch) => result(() => gateway.updateSettings(args.settingsPatch(patch))),

    'projects.open': async () => {
      try {
        const rootPath = await options.pickDirectory()
        if (rootPath === null) return { ok: true, cancelled: true }
        const { project: opened } = await gateway.createProject(rootPath)
        return { ok: true, project: opened }
      } catch (error) {
        return toFailure(error)
      }
    },
    'projects.select': (projectId) => result(() => gateway.selectProject(args.id(projectId, 'projectId'))),
    'projects.rename': (projectId, name) =>
      result(() => gateway.renameProject(args.id(projectId, 'projectId'), args.text(name, 'name')).then(() => {})),
    'projects.changeRoot': async (projectId) => {
      try {
        const { id } = project(projectId)
        const rootPath = await options.pickDirectory()
        if (rootPath === null) return { ok: true, cancelled: true }
        return { ok: true, project: await gateway.changeProjectRoot(id, rootPath) }
      } catch (error) {
        return toFailure(error)
      }
    },
    'projects.remove': (projectId) => result(() => gateway.removeProject(args.id(projectId, 'projectId'))),

    'canvas.get': (projectId) => envelope(() => gateway.getCanvas(args.id(projectId, 'projectId'))),
    'canvas.execute': async (projectId, command): Promise<CanvasCommandResponse> => {
      try {
        if (typeof projectId !== 'string' || projectId.length === 0) {
          throw new CanvasCommandError('invalid-command', 'projectId must be a non-empty string')
        }
        return { ok: true, ...(await gateway.execute(projectId, command as never, USER)) }
      } catch (error) {
        return toCommandFailure(error)
      }
    },

    'agents.listProviders': () => result(async () => ({ providers: await agents.listProviders() })),
    'agents.getRuntimes': (projectId) => envelope(async () => agents.runtimes(project(projectId).id)),
    'agents.getTimeline': (nodeId, query) =>
      result(async () => ({ page: await agents.timeline(args.id(nodeId, 'nodeId'), args.timelineQuery(query)) })),
    'agents.prompt': (nodeId, input) =>
      result(() => agents.prompt(args.id(nodeId, 'nodeId'), args.promptInput(input), USER)),
    'agents.interrupt': (nodeId) => result(() => agents.interrupt(args.id(nodeId, 'nodeId'))),
    'agents.respondToPermission': (nodeId, requestId, behavior) =>
      result(() =>
        agents.respondToPermission(
          args.id(nodeId, 'nodeId'),
          args.id(requestId, 'requestId'),
          args.permissionBehavior(behavior)
        )
      ),
    'agents.openProviderSubagent': (nodeId, subagentId) =>
      result(() => agents.openProviderSubagent(args.id(nodeId, 'nodeId'), args.id(subagentId, 'subagentId'), USER)),
    'agents.respondToAgentPermission': (agentId, requestId, behavior) =>
      result(() =>
        agents.respondToAgentPermission(
          args.id(agentId, 'agentId'),
          args.id(requestId, 'requestId'),
          args.permissionBehavior(behavior)
        )
      ),
    'agents.setMode': (agentId, modeId) =>
      result(() => agents.setAgentMode(args.id(agentId, 'agentId'), args.id(modeId, 'modeId'))),
    'agents.expandChild': (ownerNodeId, agentId) =>
      result(() => agents.expandChildAgent(args.id(ownerNodeId, 'ownerNodeId'), args.id(agentId, 'agentId'), USER)),
    'agents.refreshConnection': () => result(async () => ({ connection: await agents.refreshConnection() })),

    'files.inspectPath': (projectId, path, options) =>
      envelope(() => files.inspectPath(project(projectId), args.text(path, 'path'), args.pathAccess(options))),
    'files.reveal': (projectId, path) => result(() => files.reveal(project(projectId), args.text(path, 'path'))),
    'files.openExternal': (url) => result(() => files.openExternal(args.webUrl(url))),
    'files.copyText': (text) =>
      result(async () => files.copyText(args.text(text, 'text', { allowEmpty: true }))),
    'files.pickImage': (projectId) => envelope(() => files.pickImage(project(projectId))),
    'files.describeImage': (projectId, source, options) =>
      result(async () => ({
        image: await files.describeImage(project(projectId), args.imageSource(source), args.pathAccess(options))
      })),
    'files.importImage': (input) => result(() => files.importImage(args.imageData(input)))
  }

  const isAppWindow = (event: IpcMainInvokeEvent): boolean =>
    event.sender === contents && event.senderFrame !== null && event.senderFrame === contents.mainFrame

  const methods = Object.keys(handlers) as SpadeHostMethod[]
  for (const method of methods) {
    const handler = handlers[method] as (...parameters: unknown[]) => Promise<unknown>
    ipcMain.handle(spadeHostChannel(method), (event, ...parameters: unknown[]) => {
      if (!isAppWindow(event)) {
        return { ok: false, error: { code: 'unauthorized', message: 'Only the SPADE window may call the host.' } }
      }
      return handler(...parameters)
    })
  }

  const send = (channel: string, payload: unknown): void => {
    if (!contents.isDestroyed()) contents.send(channel, payload)
  }
  const unsubscribers = [
    gateway.subscribe((event) => {
      if (event.type === 'canvas-changed') send(SPADE_HOST_EVENTS.canvasChanged, event.canvas)
      else send(SPADE_HOST_EVENTS.appState, appState())
    }),
    agents.subscribe((event) => {
      if (event.type === 'connection') send(SPADE_HOST_EVENTS.appState, appState())
      else if (event.type === 'runtime') send(SPADE_HOST_EVENTS.agentRuntime, event.runtime)
      else send(SPADE_HOST_EVENTS.agentTimelineChanged, { nodeId: event.nodeId })
    }),
    files.subscribe((event) => send(SPADE_HOST_EVENTS.imageChanged, { path: event.path }))
  ]

  return () => {
    for (const method of methods) ipcMain.removeHandler(spadeHostChannel(method))
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

async function result<Value extends object>(task: () => Promise<Value | void>): Promise<Result<Value>> {
  try {
    const value = await task()
    return { ok: true, ...(value ?? {}) } as Result<Value>
  } catch (error) {
    return toFailure(error)
  }
}

async function envelope<Value>(task: () => Promise<Value>): Promise<IpcEnvelope<Value>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    return toFailure(error)
  }
}
