import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  CORE_RECORD_VERSIONS,
  type Project
} from '../shared/domain'

const shellProject: Project = {
  version: CORE_RECORD_VERSIONS.project,
  id: 'gade',
  name: 'GADE',
  canvasId: 'foundation'
}

function verifySmokeState(window: BrowserWindow): void {
  void window.webContents
    .executeJavaScript(`(() => {
      const canvas = document.querySelector('.react-flow')
      if (!(canvas instanceof HTMLElement)) return { canvasFound: false }

      const bounds = canvas.getBoundingClientRect()
      const style = getComputedStyle(canvas)
      return {
        canvasFound: true,
        width: bounds.width,
        height: bounds.height,
        visible: style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      }
    })()`)
    .then((canvas) => {
      const result = {
        windowCount: BrowserWindow.getAllWindows().length,
        windowVisible: window.isVisible(),
        ...canvas
      }

      if (result.windowCount !== 1 || !result.windowVisible || !result.canvasFound || !result.visible) {
        throw new Error(`Invalid shell state: ${JSON.stringify(result)}`)
      }

      console.log(`GADE_SMOKE_OK ${JSON.stringify(result)}`)
      app.quit()
    })
    .catch((error: unknown) => {
      console.error('GADE_SMOKE_FAILED', error)
      process.exitCode = 1
      app.quit()
    })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: shellProject.name
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.env.GADE_SMOKE_TEST === '1') {
    window.webContents.once('did-finish-load', () => verifySmokeState(window))
  }
}

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
