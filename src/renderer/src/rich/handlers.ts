import type { Artifact } from '../../../shared/artifacts'
import type { SpadeAnnotateInput, SpadeSubmitInput } from '../../../shared/richBlocks'

// Host callbacks for rich content. Components never reach the host bridge themselves; the
// conversation renderer supplies these and decides which actions each artifact offers.
export type ArtifactHandler = (artifact: Artifact, anchor: HTMLElement) => void
// Maps an image path or URL to a loadable URL (e.g. spade-image:), or null when unavailable.
export type ImageResolver = (src: string) => Promise<string | null>
// The returned promise settles the agent script's `window.spade.submit/annotate` promise.
export type SubmitHandler = (input: SpadeSubmitInput) => Promise<void> | void
export type AnnotateHandler = (input: SpadeAnnotateInput) => Promise<void> | void

export type RichContentHandlers = {
  onArtifact: ArtifactHandler
  resolveImage: ImageResolver
  onSubmit: SubmitHandler
  onAnnotate: AnnotateHandler
}
