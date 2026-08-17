export const NATIVE_OVERLAY_CHANNEL = 'spade-p2:native-overlay'

export type NativeOverlayBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type NativeOverlayCommand = {
  sequence: number
  visible: boolean
  bounds?: NativeOverlayBounds
}
