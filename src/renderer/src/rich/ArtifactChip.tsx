import { useMemo, useRef, type ReactNode } from 'react'
import { detectArtifacts, type Artifact } from '../../../shared/artifacts'
import { artifactViewAttributes, useArtifactObserver, useArtifactView } from './artifactState'
import type { ArtifactHandler } from './handlers'
import './rich.css'

type ArtifactChipProps = {
  artifact: Artifact
  // The source text, shown as written (including any :line:col suffix).
  text: string
  onArtifact: ArtifactHandler
}

export function ArtifactChip({ artifact, text, onArtifact }: ArtifactChipProps): React.JSX.Element {
  const kind = artifact.isImage ? 'image' : artifact.kind
  return (
    <ArtifactButton artifact={artifact} className={`rich-artifact rich-artifact--${kind}`} title={describe(artifact)} onArtifact={onArtifact}>
      {text}
    </ArtifactButton>
  )
}

// A button that shows an artifact with the host's view of it (ArtifactStateContext) and reports to the host
// when it is on screen. Used for chips and for Markdown links.
export function ArtifactButton(props: {
  artifact: Artifact
  className: string
  title: string
  onArtifact: ArtifactHandler
  children: ReactNode
}): React.JSX.Element {
  const { artifact, onArtifact } = props
  const ref = useRef<HTMLButtonElement>(null)
  const view = useArtifactView(artifact)
  useArtifactObserver(ref, artifact)
  return (
    <button
      ref={ref}
      type="button"
      className={props.className}
      data-artifact-kind={artifact.isImage ? 'image' : artifact.kind}
      title={props.title}
      {...artifactViewAttributes(view)}
      onClick={(event) => onArtifact(artifact, event.currentTarget)}
    >
      {props.children}
    </button>
  )
}

type ArtifactTextProps = {
  text: string
  onArtifact: ArtifactHandler
}

// Plain text (tool output, user messages) with detected artifacts turned into chips.
export function ArtifactText({ text, onArtifact }: ArtifactTextProps): React.JSX.Element {
  const segments = useMemo(() => detectArtifacts(text), [text])
  return (
    <>
      {segments.map((segment) =>
        segment.type === 'artifact' ? (
          <ArtifactChip key={segment.start} artifact={segment.artifact} text={segment.text} onArtifact={onArtifact} />
        ) : (
          segment.text
        )
      )}
    </>
  )
}

function describe(artifact: Artifact): string {
  const location =
    artifact.line === null ? '' : artifact.column === null ? ` (line ${artifact.line})` : ` (line ${artifact.line}, column ${artifact.column})`
  const label = artifact.kind === 'url' ? 'Link' : artifact.isImage ? 'Image' : 'Path'
  return `${label}: ${artifact.value}${location}`
}
