import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  SPADE_HOST_EVENTS,
  SPADE_HOST_GLOBAL,
  spadeHostChannel,
  type EnvelopedMethod,
  type IpcEnvelope,
  type SpadeHostBridge,
  type SpadeHostMethod
} from '../shared/ipc'

// Passes arguments through untouched: the main process validates everything it receives.
function request<Value>(method: Exclude<SpadeHostMethod, EnvelopedMethod>, ...args: unknown[]): Promise<Value> {
  return ipcRenderer.invoke(spadeHostChannel(method), ...args) as Promise<Value>
}

async function unwrap<Value>(method: EnvelopedMethod, ...args: unknown[]): Promise<Value> {
  const envelope = (await ipcRenderer.invoke(spadeHostChannel(method), ...args)) as IpcEnvelope<Value>
  if (envelope.ok) return envelope.value
  // Only the message survives the context bridge, so it carries the code.
  throw new Error(`${envelope.error.code}: ${envelope.error.message}`)
}

function listen<Payload>(channel: string): (listener: (payload: Payload) => void) => () => void {
  return (listener) => {
    const receive = (_event: IpcRendererEvent, payload: Payload): void => listener(payload)
    ipcRenderer.on(channel, receive)
    return () => {
      ipcRenderer.removeListener(channel, receive)
    }
  }
}

const bridge: SpadeHostBridge = {
  app: {
    getState: () => unwrap('app.getState'),
    onState: listen(SPADE_HOST_EVENTS.appState),
    updateSettings: (patch) => request('app.updateSettings', patch)
  },
  projects: {
    open: () => request('projects.open'),
    select: (projectId) => request('projects.select', projectId),
    rename: (projectId, name) => request('projects.rename', projectId, name),
    changeRoot: (projectId) => request('projects.changeRoot', projectId),
    remove: (projectId) => request('projects.remove', projectId)
  },
  canvas: {
    get: (projectId) => unwrap('canvas.get', projectId),
    onChanged: listen(SPADE_HOST_EVENTS.canvasChanged),
    execute: (projectId, command) => request('canvas.execute', projectId, command)
  },
  agents: {
    listProviders: () => request('agents.listProviders'),
    getRuntimes: (projectId) => unwrap('agents.getRuntimes', projectId),
    onRuntime: listen(SPADE_HOST_EVENTS.agentRuntime),
    getTimeline: (nodeId, query) => request('agents.getTimeline', nodeId, query),
    onTimelineChanged: listen(SPADE_HOST_EVENTS.agentTimelineChanged),
    prompt: (nodeId, input) => request('agents.prompt', nodeId, input),
    interrupt: (nodeId) => request('agents.interrupt', nodeId),
    respondToPermission: (nodeId, requestId, behavior) =>
      request('agents.respondToPermission', nodeId, requestId, behavior),
    openProviderSubagent: (nodeId, subagentId) => request('agents.openProviderSubagent', nodeId, subagentId),
    respondToAgentPermission: (agentId, requestId, behavior) =>
      request('agents.respondToAgentPermission', agentId, requestId, behavior),
    setMode: (agentId, modeId) => request('agents.setMode', agentId, modeId),
    expandChild: (ownerNodeId, agentId) => request('agents.expandChild', ownerNodeId, agentId),
    refreshConnection: () => request('agents.refreshConnection')
  },
  files: {
    inspectPath: (projectId, path, options) => unwrap('files.inspectPath', projectId, path, options),
    reveal: (projectId, path) => request('files.reveal', projectId, path),
    openExternal: (url) => request('files.openExternal', url),
    copyText: (text) => request('files.copyText', text),
    pickImage: (projectId) => unwrap('files.pickImage', projectId),
    describeImage: (projectId, source, options) => request('files.describeImage', projectId, source, options),
    importImage: (input) => request('files.importImage', input),
    onImageChanged: listen(SPADE_HOST_EVENTS.imageChanged)
  }
}

contextBridge.exposeInMainWorld(SPADE_HOST_GLOBAL, bridge)
