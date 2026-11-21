import { useEffect, useState } from 'react'
import type { Artifact } from '../../../shared/artifacts'
import type { ArtifactHandler, ImageResolver } from './handlers'
import './rich.css'

type RichImageProps = {
  // An image path, an http(s) URL, or a data: URL (used as is, without asking the resolver).
  src: string
  alt: string
  title?: string | null
  // null for images with no actions (e.g. data: URLs); the thumbnail is then not clickable.
  artifact: Artifact | null
  resolveImage: ImageResolver
  onArtifact: ArtifactHandler
}

type Resolution = { src: string; url: string | null }

// An inline thumbnail with bounded height. Unresolvable or broken images render disabled.
export function RichImage({ src, alt, title, artifact, resolveImage, onArtifact }: RichImageProps): React.JSX.Element {
  const isData = /^data:image\//i.test(src)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  useEffect(() => {
    if (isData) return
    let active = true
    resolveImage(src).then(
      (url) => active && setResolution({ src, url }),
      () => active && setResolution({ src, url: null })
    )
    return () => {
      active = false
    }
  }, [isData, resolveImage, src])

  const url = isData ? src : resolution?.src === src ? resolution.url : undefined
  const label = alt || title || src

  if (url === undefined) {
    return <span className="rich-image rich-image--pending" role="img" aria-label={`Loading ${label}`} />
  }

  if (url === null || failedUrl === url) {
    return (
      <span className="rich-image rich-image--missing" title={src}>
        Image unavailable: {label}
      </span>
    )
  }

  const image = <img src={url} alt={alt} title={title ?? undefined} loading="lazy" draggable={false} onError={() => setFailedUrl(url)} />

  if (!artifact) return <span className="rich-image">{image}</span>

  return (
    <button
      type="button"
      className="rich-image rich-image--interactive"
      data-artifact-kind="image"
      aria-label={`Image: ${label}`}
      onClick={(event) => onArtifact(artifact, event.currentTarget)}
    >
      {image}
    </button>
  )
}
