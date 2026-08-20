import { useEffect, useRef, useState } from 'react'
import { PrototypeNodeFrame } from './PrototypeNodeFrame'
import type { NativeOverlayBounds } from '../../shared/nativeOverlay'

function sameBounds(left: NativeOverlayBounds | null, right: NativeOverlayBounds): boolean {
  return !!left &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
}

export function NativeOverlayNode(): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)
  const [visible, setVisible] = useState(false)
  const [bounds, setBounds] = useState<NativeOverlayBounds | null>(null)

  useEffect(() => {
    if (!visible) {
      window.spadePrototype.nativeOverlay.update({ sequence: ++sequence.current, visible: false })
      return
    }

    let frame = 0
    let lastBounds: NativeOverlayBounds | null = null
    const synchronize = (): void => {
      const rectangle = surfaceRef.current?.getBoundingClientRect()
      if (rectangle) {
        const nextBounds = {
          x: Math.round(rectangle.x),
          y: Math.round(rectangle.y),
          width: Math.round(rectangle.width),
          height: Math.round(rectangle.height)
        }

        if (nextBounds.width > 0 && nextBounds.height > 0 && !sameBounds(lastBounds, nextBounds)) {
          lastBounds = nextBounds
          setBounds(nextBounds)
          window.spadePrototype.nativeOverlay.update({
            sequence: ++sequence.current,
            visible: true,
            bounds: nextBounds
          })
        }
      }
      frame = requestAnimationFrame(synchronize)
    }

    frame = requestAnimationFrame(synchronize)
    return () => {
      cancelAnimationFrame(frame)
      window.spadePrototype.nativeOverlay.update({ sequence: ++sequence.current, visible: false })
    }
  }, [visible])

  return (
    <PrototypeNodeFrame title="Native comparison" kind="WebContentsView · rectangular overlay" resizable>
      <div className="native-toolbar">
        <button type="button" onClick={() => setVisible((current) => !current)}>
          {visible ? 'Dispose native view' : 'Show native view'}
        </button>
        <output>{bounds ? `${bounds.x}, ${bounds.y} · ${bounds.width}×${bounds.height}` : 'not synchronized'}</output>
      </div>
      <div ref={surfaceRef} className="native-overlay-surface">
        <p>{visible ? 'Native GitHub view covers this rectangle.' : 'Native overlay is hidden.'}</p>
        <small>
          It follows rectangular window bounds, but not rounded clipping, CSS stacking, or DOM pointer routing.
        </small>
      </div>
    </PrototypeNodeFrame>
  )
}
