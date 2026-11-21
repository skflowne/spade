import { useMemo } from 'react'
import { detectArtifacts, type Artifact } from '../../../shared/artifacts'
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
    <button
      type="button"
      className={`rich-artifact rich-artifact--${kind}`}
      data-artifact-kind={kind}
      title={describe(artifact)}
      onClick={(event) => onArtifact(artifact, event.currentTarget)}
    >
      {text}
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
