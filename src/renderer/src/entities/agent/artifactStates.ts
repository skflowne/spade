import type { Artifact } from '../../../../shared/artifacts'
import type { ArtifactStateSource, ArtifactView } from '../../rich'
import { presentArtifact, type ArtifactState } from './artifactActions'
import type { PathCheck, PathChecks } from './pathChecks'

const DESCRIPTIONS: Partial<Record<ArtifactState, string>> = {
  missing: 'Not found',
  unchecked: 'Network path, not checked',
  unknown: 'Could not be checked'
}

// The conversation's ArtifactStateSource for the rich components: each path artifact shows its PathChecks
// result, and is checked lazily once it is on screen.
export class ConversationArtifacts implements ArtifactStateSource {
  private readonly views = new Map<string, { check: PathCheck; view: ArtifactView }>()
  private readonly shown = new Map<Element, Artifact>()
  private readonly visible = new Set<Element>()
  private observer: IntersectionObserver | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly checks: PathChecks) {}

  readonly subscribe = (listener: () => void): (() => void) => this.checks.subscribe(listener)

  readonly get = (artifact: Artifact): ArtifactView | null => {
    if (artifact.kind !== 'path') return null
    const check = this.checks.get(artifact.value)
    if (!check) return null
    const cached = this.views.get(artifact.value)
    if (cached?.check === check) return cached.view
    const presentation = presentArtifact(artifact, check.status === 'failed' ? 'failed' : check.info)
    const view: ArtifactView = {
      state: presentation.state,
      disabled: presentation.state === 'missing',
      quiet: presentation.quiet,
      description: DESCRIPTIONS[presentation.state] ?? null
    }
    this.views.set(artifact.value, { check, view })
    return view
  }

  readonly observe = (element: Element, artifact: Artifact): (() => void) => {
    if (artifact.kind !== 'path') return () => {}
    this.shown.set(element, artifact)
    this.intersections().observe(element)
    return () => {
      this.shown.delete(element)
      this.visible.delete(element)
      this.observer?.unobserve(element)
    }
  }

  // The conversation changed: paths found missing (or not checkable) are checked again, at once for those on
  // screen and otherwise when they scroll into view. Results too recent to expire are checked once they are
  // old enough, so the last change of a conversation is never missed.
  recheck(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const wait = this.checks.expireNegatives()
    for (const element of this.visible) this.checkShown(element)
    if (wait !== null) this.timer = setTimeout(() => this.recheck(), wait)
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.observer?.disconnect()
    this.observer = null
  }

  private checkShown(element: Element): void {
    const artifact = this.shown.get(element)
    if (artifact) void this.checks.check(artifact.value)
  }

  // Shared by every artifact of the conversation; the implicit root also accounts for the scrolling
  // conversation and the canvas clipping it.
  private intersections(): IntersectionObserver {
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          this.visible.add(entry.target)
          this.checkShown(entry.target)
        } else {
          this.visible.delete(entry.target)
        }
      }
    })
    return this.observer
  }
}
