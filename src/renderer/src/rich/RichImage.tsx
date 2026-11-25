import { useEffect, useRef, useState } from 'react'
import type { Artifact } from '../../../shared/artifacts'
import { useArtifactObserver, useArtifactView } from './artifactState'
import type { ArtifactHandler, ImageResolution, ImageResolver } from './handlers'
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

type Resolution = { src: string; result: ImageResolution }

// An inline thumbnail with bounded height. Unresolvable or broken images render disabled; an image on another
// machine waits for the user to load it. An unavailable image is resolved again when the host's view of its
// path changes (ArtifactStateContext), e.g. once the file it names was created.
export function RichImage({ src, alt, title, artifact, resolveImage, onArtifact }: RichImageProps): React.JSX.Element {
  const isData = /^data:image\//i.test(src)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // The source the user asked to load although it is on another machine.
  const [requested, setRequested] = useState<string | null>(null)
  const explicit = requested === src
  const pathState = useArtifactView(artifact)?.state ?? null
  const placeholder = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (isData) return
    let active = true
    resolveImage(src, explicit ? { explicit: true } : undefined).then(
      (result) => active && setResolution({ src, result }),
      () => active && setResolution({ src, result: { kind: 'unavailable' } })
    )
    return () => {
      active = false
    }
  }, [isData, resolveImage, src, explicit, pathState])

  const result: ImageResolution | undefined = isData
    ? { kind: 'ready', url: src }
    : resolution?.src === src
      ? resolution.result
      : undefined
  const unavailable = result?.kind === 'unavailable' || (result?.kind === 'ready' && failedUrl === result.url)
  useArtifactObserver(placeholder, artifact, unavailable)
  const label = alt || title || src

  if (result === undefined) {
    return <span className="rich-image rich-image--pending" role="img" aria-label={`Loading ${label}`} />
  }

  if (result.kind === 'network') {
    return (
      <span className="rich-image rich-image--network" title={src}>
        <span className="rich-image__note">Network image: {label}</span>
        <button type="button" className="rich-block__action" onClick={() => setRequested(src)}>
          Load
        </button>
      </span>
    )
  }

  if (result.kind === 'unavailable' || unavailable) {
    return (
      <span ref={placeholder} className="rich-image rich-image--missing" title={src}>
        Image unavailable: {label}
      </span>
    )
  }

  const url = result.url
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
