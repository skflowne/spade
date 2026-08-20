import { contextBridge, ipcRenderer } from 'electron'
import { NATIVE_OVERLAY_CHANNEL, type NativeOverlayCommand } from '../shared/nativeOverlay'

contextBridge.exposeInMainWorld('spadePrototype', {
  nativeOverlay: {
    update(command: NativeOverlayCommand): void {
      ipcRenderer.send(NATIVE_OVERLAY_CHANNEL, command)
    }
  }
})
