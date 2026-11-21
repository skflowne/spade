import type { Artifact } from '../../../shared/artifacts'
import type { SpadeAnnotateInput, SpadeSubmitInput } from '../../../shared/richBlocks'

// Host callbacks for rich content. Components never reach the host bridge themselves; the
// conversation renderer supplies these and decides which actions each artifact offers.
export type ArtifactHandler = (artifact: Artifact, anchor: HTMLElement) => void
// 'network': an image on another machine, loaded only when the user asks for it.
export type ImageResolution = { kind: 'ready'; url: string } | { kind: 'unavailable' } | { kind: 'network' }
// Maps an image path or URL to a loadable URL (e.g. spade-image:). `explicit`: the user asked for this very
// image. Never rejects.
export type ImageResolver = (src: string, options?: { explicit?: boolean }) => Promise<ImageResolution>
// The returned promise settles the agent script's `window.spade.submit/annotate` promise.
export type SubmitHandler = (input: SpadeSubmitInput) => Promise<void> | void
export type AnnotateHandler = (input: SpadeAnnotateInput) => Promise<void> | void

export type RichContentHandlers = {
  onArtifact: ArtifactHandler
  resolveImage: ImageResolver
  onSubmit: SubmitHandler
  onAnnotate: AnnotateHandler
  // Escape pressed inside a live HTML answer that the answer did not handle.
  onEscape?: () => void
}
