import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  type Event as ElectronEvent,
  type IpcMainEvent,
  type Rectangle,
  type WebContents,
  WebContentsView
} from 'electron'
import { GITHUB_ISSUE_URL } from '../shared/constants'
import {
  NATIVE_OVERLAY_CHANNEL,
  type NativeOverlayBounds,
  type NativeOverlayCommand
} from '../shared/nativeOverlay'

function configurePopupPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/')) {
      void contents.loadURL(url)
    }
    return { action: 'deny' }
  })
}

function isBounds(value: unknown): value is NativeOverlayBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Partial<NativeOverlayBounds>
  return (
    Object.keys(value).every((key) => ['x', 'y', 'width', 'height'].includes(key)) &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    Number(bounds.width) > 0 &&
    Number(bounds.height) > 0
  )
}

function isCommand(value: unknown): value is NativeOverlayCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Partial<NativeOverlayCommand>
  return (
    Object.keys(value).every((key) => ['sequence', 'visible', 'bounds'].includes(key)) &&
    Number.isSafeInteger(command.sequence) &&
    Number(command.sequence) > 0 &&
    typeof command.visible === 'boolean' &&
    (command.visible ? isBounds(command.bounds) : command.bounds === undefined)
  )
}

function synchronizedBounds(window: BrowserWindow, bounds: NativeOverlayBounds): Rectangle | null {
  const content = window.getContentBounds()
  const rounded = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
  const intersectsWindow =
    rounded.x + rounded.width > 0 &&
    rounded.y + rounded.height > 0 &&
    rounded.x < content.width &&
    rounded.y < content.height

  return intersectsWindow ? rounded : null
}

function attachNativeOverlayController(window: BrowserWindow): () => void {
  let view: WebContentsView | null = null
  let lastSequence = 0

  const disposeView = (): void => {
    if (!view) return
    window.contentView.removeChildView(view)
    view.webContents.close()
    view = null
  }

  const reset = (): void => {
    disposeView()
    lastSequence = 0
  }

  const ensureView = (): WebContentsView => {
    if (view) return view

    view = new WebContentsView({
      webPreferences: {
        partition: 'persist:spade-p2-native-overlay',
        sandbox: true
      }
    })
    configurePopupPolicy(view.webContents)
    window.contentView.addChildView(view)
    void view.webContents.loadURL(GITHUB_ISSUE_URL)
    return view
  }

  const receive = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || !isCommand(value) || value.sequence <= lastSequence) {
      return
    }

    lastSequence = value.sequence
    if (!value.visible) {
      disposeView()
      return
    }

    const bounds = synchronizedBounds(window, value.bounds!)
    if (!bounds) {
      disposeView()
      return
    }

    ensureView().setBounds(bounds)
  }

  const handleNavigation = (
    _event: ElectronEvent,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame) reset()
  }

  ipcMain.on(NATIVE_OVERLAY_CHANNEL, receive)
  window.webContents.on('render-process-gone', reset)
  window.webContents.on('did-start-navigation', handleNavigation)

  return () => {
    ipcMain.removeListener(NATIVE_OVERLAY_CHANNEL, receive)
    window.webContents.removeListener('render-process-gone', reset)
    window.webContents.removeListener('did-start-navigation', handleNavigation)
    disposeView()
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    title: 'SPADE · P2 composition prototype',
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  const disposeNativeOverlay = attachNativeOverlayController(window)
  window.webContents.on('did-attach-webview', (_event, guest) => configurePopupPolicy(guest))
  window.once('closed', disposeNativeOverlay)
  window.once('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(createWindow)

app.on('window-all-closed', () => app.quit())
