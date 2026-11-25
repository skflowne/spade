import { useEffect, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { realTimer, type Timer } from './timer'

// Below this pause the canvas is still zooming.
const ZOOM_SETTLE_MS = 150
// A zoom this far (as a ratio) from the applied one is applied at once, so a long zoom gesture still
// updates the page a few times on the way.
const ZOOM_STEP = 1.25

type ZoomSettlerOptions = {
  initial: number
  apply(zoom: number): void
  timer?: Timer
}

// Follows the canvas zoom for a live page without work on every frame: re-rendering the guest at a new
// backing size and page zoom is costly, and the page looks the same in between (only less crisp).
export class ZoomSettler {
  private applied: number
  private cancel: (() => void) | null = null
  private readonly timer: Timer

  constructor(private readonly options: ZoomSettlerOptions) {
    this.applied = options.initial
    this.timer = options.timer ?? realTimer
  }

  update(zoom: number): void {
    this.cancel?.()
    this.cancel = null
    if (zoom === this.applied) return
    const ratio = zoom > this.applied ? zoom / this.applied : this.applied / zoom
    if (ratio >= ZOOM_STEP) this.set(zoom)
    else this.cancel = this.timer.schedule(() => this.set(zoom), ZOOM_SETTLE_MS)
  }

  dispose(): void {
    this.cancel?.()
    this.cancel = null
  }

  private set(zoom: number): void {
    this.cancel = null
    this.applied = zoom
    this.options.apply(zoom)
  }
}

// The canvas zoom a live guest should render at. Subscribes to the canvas only while `enabled`, so a page
// without a guest (preview, paused, collapsed) does nothing while the canvas zooms.
export function useSettledZoom(enabled: boolean): number {
  const store = useStoreApi()
  const [zoom, setZoom] = useState(() => store.getState().transform[2])
  useEffect(() => {
    if (!enabled) return
    const current = store.getState().transform[2]
    const settler = new ZoomSettler({ initial: current, apply: setZoom })
    setZoom(current)
    const unsubscribe = store.subscribe((state) => settler.update(state.transform[2]))
    return () => {
      unsubscribe()
      settler.dispose()
    }
  }, [enabled, store])
  return zoom
}
