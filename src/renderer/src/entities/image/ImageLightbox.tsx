import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageInfo } from '@shared/ipc'

type ImageLightboxProps = {
  title: string
  alt: string
  image: ImageInfo
  onClose(): void
}

// The image at its natural size, or fitted to the window. A modal <dialog> portalled out of the node: inside
// it, the canvas transform would not matter (top layer), but the inactive body's `inert` would.
export function ImageLightbox({ title, alt, image, onClose }: ImageLightboxProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [fit, setFit] = useState(true)

  useLayoutEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  return createPortal(
    <dialog
      ref={ref}
      className="cr-dialog image-lightbox"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      // React events bubble through portals; this click must not activate the node behind the dialog.
      onClick={(event) => event.stopPropagation()}
    >
      <header className="cr-dialog__header image-lightbox__header">
        <h2 id={titleId}>{title}</h2>
        {image.width !== null && image.height !== null ? (
          <span className="mono image-lightbox__size">
            {image.width}×{image.height}
          </span>
        ) : null}
      </header>
      <div className={fit ? 'image-lightbox__stage image-lightbox__stage--fit' : 'image-lightbox__stage'} tabIndex={0}>
        <img
          src={image.url}
          alt={alt}
          width={image.width ?? undefined}
          height={image.height ?? undefined}
          decoding="async"
          draggable={false}
        />
      </div>
      <footer className="cr-dialog__footer">
        <button type="button" className="cr-button cr-button--ghost" aria-pressed={fit} onClick={() => setFit(true)}>
          Fit
        </button>
        <button type="button" className="cr-button cr-button--ghost" aria-pressed={!fit} onClick={() => setFit(false)}>
          Actual size
        </button>
        <span className="image-lightbox__spacer" />
        <button type="button" className="cr-button cr-button--primary" onClick={onClose} autoFocus>
          Close
        </button>
      </footer>
    </dialog>,
    document.body
  )
}
