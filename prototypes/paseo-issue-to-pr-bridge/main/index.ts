import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent
} from 'electron'
import { PrototypeCommandService } from './commandService'
import { LedgerStore } from './ledgerStore'
import { createConfiguredPaseoAdapter } from './paseoComposition'
import { registerSnapshotPublication } from './snapshotPublication'
import {
  applyPrototypeCommand,
  createInitialLedger,
  type PrototypeCommand
} from '../shared/commands'
import {
  isPrototypeCommand,
  P3_COMMAND_CHANNEL,
  P3_SNAPSHOT_CHANNEL,
  P3_SNAPSHOT_EVENT_CHANNEL
} from '../shared/ipc'
import type { PrototypeLedger } from '../shared/model'

function createSeedLedger(): PrototypeLedger {
  let ledger = createInitialLedger('project-p3', 'P3 bridge prototype')
  const commands: PrototypeCommand[] = [
    {
      type: 'create-work-item',
      name: 'Issue 17 · Generic shell',
      task: 'Build the workflow-agnostic P3 shell',
      sourceRef: { provider: 'placeholder', kind: 'task', id: 'spade-17', revision: null }
    },
    { type: 'create-group', name: 'Visual cluster' },
    {
      type: 'spawn-placeholder',
      targetGroup: 'work-item-1',
      nodeKind: 'agent',
      title: 'Root placeholder agent',
      resourceRef: { provider: 'placeholder', kind: 'agent', id: 'agent-root', revision: 'seed-v1' }
    },
    {
      type: 'attach-placeholder',
      targetGroup: 'group-2',
      nodeKind: 'workspace',
      title: 'Detached placeholder workspace',
      resourceRef: { provider: 'placeholder', kind: 'workspace', id: 'workspace-root', revision: null }
    },
    {
      type: 'connect-nodes',
      fromNodeId: 'node-3',
      toNodeId: 'node-4',
      relation: 'connected'
    }
  ]
  for (const command of commands) ledger = applyPrototypeCommand(ledger, command).ledger
  return ledger
}

function registerIpc(window: BrowserWindow, service: PrototypeCommandService): () => void {
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents) throw new Error('Unauthorized P3 prototype IPC sender.')
  }

  ipcMain.handle(P3_SNAPSHOT_CHANNEL, (event) => {
    authorize(event)
    return service.snapshot()
  })
  ipcMain.handle(P3_COMMAND_CHANNEL, async (event, value: unknown) => {
    authorize(event)
    if (!isPrototypeCommand(value)) throw new Error('Invalid P3 prototype command.')
    return service.execute(value)
  })

  return () => {
    ipcMain.removeHandler(P3_SNAPSHOT_CHANNEL)
    ipcMain.removeHandler(P3_COMMAND_CHANNEL)
  }
}

function createWindow(service: PrototypeCommandService): void {
  const window = new BrowserWindow({
    title: 'SPADE · P3 generic work shell',
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const unregisterIpc = registerIpc(window, service)
  const unregisterSnapshots = registerSnapshotPublication(service, {
    isDestroyed: () => window.isDestroyed(),
    send: (snapshot) => window.webContents.send(P3_SNAPSHOT_EVENT_CHANNEL, snapshot)
  })
  window.once('closed', () => {
    unregisterIpc()
    unregisterSnapshots()
  })
  window.once('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

let service: PrototypeCommandService | null = null
let closing = false

void app.whenReady().then(async () => {
  const ledgerPath = process.env.SPADE_P3_LEDGER_PATH ?? join(app.getPath('userData'), 'p3-ledger.json')
  service = new PrototypeCommandService(
    new LedgerStore(ledgerPath),
    createConfiguredPaseoAdapter(process.env)
  )
  await service.initialize(createSeedLedger())
  createWindow(service)
})

app.on('before-quit', (event) => {
  if (!service || closing) return
  event.preventDefault()
  closing = true
  void service.close().finally(() => app.quit())
})

app.on('window-all-closed', () => app.quit())
