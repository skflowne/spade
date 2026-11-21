import { app, BrowserWindow, clipboard, dialog, protocol, session, shell, type CustomScheme } from 'electron'
import { WEB_PAGE_PARTITION } from '../../shared/builtinEntities'
import type { FileServiceHost } from './host'
import { IMAGE_PROTOCOL_SCHEME } from './imageProtocol'

// The only module that binds the file service to Electron. Keep it free of decisions.

// Standard so the URL parses with a host and path; secure so it loads from any renderer origin.
// No fetch, CORS, or CSP-bypass privileges: it exists only for <img>.
export const IMAGE_PROTOCOL_CUSTOM_SCHEME: CustomScheme = {
  scheme: IMAGE_PROTOCOL_SCHEME,
  privileges: { standard: true, secure: true }
}

// Must run before app ready. Electron accepts only one registerSchemesAsPrivileged call per process,
// so a composition root registering other schemes too should pass IMAGE_PROTOCOL_CUSTOM_SCHEME in its own call.
export function registerFileServiceSchemes(): void {
  protocol.registerSchemesAsPrivileged([IMAGE_PROTOCOL_CUSTOM_SCHEME])
}

export function createElectronFileServiceHost(): FileServiceHost {
  return {
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path),
    openExternal: (url) => shell.openExternal(url),
    writeClipboardText: (text) => clipboard.writeText(text),
    async showOpenImageDialog({ defaultPath, extensions }) {
      const options: Electron.OpenDialogOptions = {
        title: 'Open image',
        defaultPath,
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: [...extensions] }]
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    handleImageProtocol(handler) {
      protocol.handle(IMAGE_PROTOCOL_SCHEME, handler)
      return () => protocol.unhandle(IMAGE_PROTOCOL_SCHEME)
    },
    guestWebviews: () => ({
      onWebContentsCreated(listener) {
        const forward = (_event: Electron.Event, contents: Electron.WebContents) => listener(contents)
        app.on('web-contents-created', forward)
        return () => app.off('web-contents-created', forward)
      },
      session: session.fromPartition(WEB_PAGE_PARTITION)
    })
  }
}
