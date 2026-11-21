import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { createServices, prepareServices, type Services } from './composition'
import { SpadeWorkspaceGateway } from './gateway'
import { registerSpadeHostIpc } from './ipc'
import { AppDataStore, AssetStore } from './persistence'
import { createBuiltinEntityRegistry } from '../shared/builtinEntities'

type Running = { gateway: SpadeWorkspaceGateway; services: Services }

let running: Running | null = null
let mainWindow: BrowserWindow | null = null
let shutdown: 'none' | 'pending' | 'done' = 'none'

async function start(): Promise<void> {
  // Everything SPADE persists lives under userData, which Chromium's --user-data-dir switch relocates.
  const dataDirectory = join(app.getPath('userData'), 'data')
  const gateway = await SpadeWorkspaceGateway.open({
    store: new AppDataStore({ directory: dataDirectory }),
    entities: createBuiltinEntityRegistry()
  })
  const services = createServices({ gateway, assets: new AssetStore({ directory: dataDirectory }), dataDirectory })
  running = { gateway, services }

  await services.files.start()
  mainWindow = openWindow(running)
  services.agents.start().catch((error: unknown) => console.error('The agent service failed to start', error))
}

function openWindow({ gateway, services }: Running): BrowserWindow {
  const window = new BrowserWindow({
    title: 'SPADE',
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  const unregister = registerSpadeHostIpc({
    contents: window.webContents,
    gateway,
    agents: services.agents,
    files: services.files,
    appVersion: app.getVersion(),
    async pickDirectory() {
      const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
    }
  })
  window.once('closed', () => {
    unregister()
    if (mainWindow === window) mainWindow = null
  })

  // The preload's bridge must only ever serve SPADE's own page.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return window
}

async function stop({ gateway, services }: Running): Promise<void> {
  const stopped = await Promise.allSettled([services.agents.stop(), services.files.stop()])
  for (const outcome of stopped) {
    if (outcome.status === 'rejected') console.error('A service failed to stop', outcome.reason)
  }
  await gateway.flush().catch((error: unknown) => console.error('SPADE could not finish writing its records', error))
}

// The lock lives in the userData directory, so isolated data directories run side by side.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  prepareServices()

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('before-quit', (event) => {
    if (!running || shutdown === 'done') return
    event.preventDefault()
    if (shutdown === 'pending') return
    shutdown = 'pending'
    void stop(running).finally(() => {
      shutdown = 'done'
      app.quit()
    })
  })

  app.on('window-all-closed', () => app.quit())

  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error('SPADE failed to start', error)
      app.exit(1)
    })
}
