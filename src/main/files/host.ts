import type { WebviewPolicyTarget } from './webviewPolicy'

// The Electron capabilities the file service uses. `electronHost.ts` binds them to Electron; tests fake them.
export type FileServiceHost = {
  // Selects the file in Explorer; never opens it.
  showItemInFolder(path: string): void
  // Resolves with an error message, or '' on success. The file service only passes directories.
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  writeClipboardText(text: string): void
  // A native open-file dialog limited to `extensions`; the chosen path, or null when cancelled.
  showOpenImageDialog(options: { defaultPath: string; extensions: readonly string[] }): Promise<string | null>
  // Serves the image scheme; returns a function that stops serving it.
  handleImageProtocol(handler: (request: Request) => Promise<Response>): () => void
  // Only called once the app is ready.
  guestWebviews(): WebviewPolicyTarget
}
