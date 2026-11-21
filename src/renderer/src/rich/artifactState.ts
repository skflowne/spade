import { createContext, useContext, useEffect, useSyncExternalStore, type RefObject } from 'react'
import type { Artifact } from '../../../shared/artifacts'

// What the host knows about each artifact (e.g. whether a path exists), shown on the chips, links, and images
// that display it. Rich components never decide or check anything themselves: they render the host's view
// and report which artifacts are on screen, so the host can check them lazily.

export type ArtifactView = {
  // Rendered as `data-path-state`, e.g. 'file', 'missing', 'unchecked'.
  state: string
  // Shown disabled: activating it offers nothing (the host still receives the click).
  disabled: boolean
  // Most likely not an artifact at all: shown as plain text.
  quiet: boolean
  // Accessible description of the state, e.g. 'Not found'.
  description: string | null
}

export type ArtifactStateSource = {
  subscribe(listener: () => void): () => void
  // Null while nothing is known. Returns the same object for as long as the view does not change.
  get(artifact: Artifact): ArtifactView | null
  // `element` shows `artifact` (for as long as the returned cleanup is not called).
  observe(element: Element, artifact: Artifact): () => void
}

// Provided by the host around rich content. Without one, artifacts render without any state.
export const ArtifactStateContext = createContext<ArtifactStateSource | null>(null)

const NO_SOURCE: ArtifactStateSource = {
  subscribe: () => () => {},
  get: () => null,
  observe: () => () => {}
}

// The host's view of `artifact`, re-rendering when it changes. Follows the artifact when a reused element
// starts showing another one (e.g. a path completed by a streamed message).
export function useArtifactView(artifact: Artifact | null): ArtifactView | null {
  const source = useContext(ArtifactStateContext) ?? NO_SOURCE
  return useSyncExternalStore(source.subscribe, () => (artifact ? source.get(artifact) : null))
}

// Reports that the element behind `ref` shows `artifact`; `enabled` false stops reporting.
export function useArtifactObserver(ref: RefObject<Element | null>, artifact: Artifact | null, enabled = true): void {
  const source = useContext(ArtifactStateContext)
  const kind = artifact?.kind
  const value = artifact?.value
  useEffect(() => {
    const element = ref.current
    if (!source || !element || !artifact || !enabled) return
    return source.observe(element, artifact)
    // The artifact is identified by its kind and value; a new object for the same artifact changes nothing.
  }, [source, ref, kind, value, enabled])
}

// Attributes that show an artifact view on its element.
export function artifactViewAttributes(view: ArtifactView | null): Record<string, string | undefined> {
  return {
    'data-path-state': view?.state,
    'aria-disabled': view?.disabled ? 'true' : undefined,
    'aria-description': view?.description ?? undefined,
    'data-quiet': view?.quiet ? 'true' : undefined
  }
}
