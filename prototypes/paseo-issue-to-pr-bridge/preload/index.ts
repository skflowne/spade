import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PrototypeCommand } from '../shared/commands'
import type { P3IntegrationRequest, P3IntegrationResult } from '../shared/integration'
import {
  P3_COMMAND_CHANNEL,
  P3_INTEGRATION_CHANNEL,
  P3_SNAPSHOT_CHANNEL,
  P3_SNAPSHOT_EVENT_CHANNEL,
  type P3PrototypeBridge
} from '../shared/ipc'
import type { PrototypeLedger } from '../shared/model'

const bridge: P3PrototypeBridge = {
  snapshot: () => ipcRenderer.invoke(P3_SNAPSHOT_CHANNEL) as Promise<PrototypeLedger>,
  execute: (command: PrototypeCommand) =>
    ipcRenderer.invoke(P3_COMMAND_CHANNEL, command) as Promise<PrototypeLedger>,
  integrate: (request: P3IntegrationRequest) =>
    ipcRenderer.invoke(P3_INTEGRATION_CHANNEL, request) as Promise<P3IntegrationResult>,
  subscribe(listener: (ledger: PrototypeLedger) => void): () => void {
    const receive = (_event: IpcRendererEvent, ledger: PrototypeLedger): void => listener(ledger)
    ipcRenderer.on(P3_SNAPSHOT_EVENT_CHANNEL, receive)
    return () => ipcRenderer.removeListener(P3_SNAPSHOT_EVENT_CHANNEL, receive)
  }
}

contextBridge.exposeInMainWorld('spadeP3', bridge)
