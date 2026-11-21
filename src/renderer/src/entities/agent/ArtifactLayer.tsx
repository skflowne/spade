import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IMAGE_ENTITY, WEB_PAGE_ENTITY } from '@shared/builtinEntities'
import { decodeFileUrl, type Artifact } from '@shared/artifacts'
import type { NodeSeed } from '@shared/commands'
import type { Result } from '@shared/ipc'
import { ArtifactStateContext, type ArtifactHandler, type ImageResolution, type ImageResolver } from '../../rich'
import { Dialog } from '../../ui/Dialog'
import type { EntityHost } from '../types'
import { ARTIFACT_ACTION_LABELS, decodeImageDataUrl, presentArtifact, type ArtifactActionId, type ArtifactState } from './artifactActions'
import { ConversationArtifacts } from './artifactStates'
import { PathChecks, type PathCheck } from './pathChecks'
import { Popover } from './Popover'

// Rich conversation artifacts (plan §7.1): one actions popover for every path, image, and link in the
// conversation, a lightbox for images, and the conversation's path existence checks (pathChecks.ts), which the
// rich components show through ArtifactStateContext. Every action is a bridge command; the renderer never
// decides to launch anything, and nothing passive touches a network path outside the project.

export type ArtifactServices = {
  onArtifact: ArtifactHandler
  resolveImage: ImageResolver
  // An image the agent produced inline (a data: URL), which has no path.
  openInlineImage(url: string, anchor: HTMLElement): void
}

const ArtifactContext = createContext<ArtifactServices | null>(null)

export function useArtifacts(): ArtifactServices {
  const services = useContext(ArtifactContext)
  if (!services) throw new Error('Artifact actions are only available inside an agent conversation')
  return services
}

type Target = { kind: 'artifact'; artifact: Artifact } | { kind: 'inline-image'; url: string }
type Open = { target: Target; anchor: HTMLElement }

type ArtifactLayerProps = {
  projectId: string
  projectRoot: string
  nodeId: string
  host: EntityHost
  // Changes whenever the conversation does: paths found missing may exist now.
  revision: unknown
  children: ReactNode
}

export function ArtifactLayer({ projectId, projectRoot, nodeId, host, revision, children }: ArtifactLayerProps): React.JSX.Element {
  const checks = useMemo(
    () =>
      new PathChecks({
        projectRoot,
        now: () => Date.now(),
        inspect: (path, explicit) => window.spadeHost.files.inspectPath(projectId, path, explicit ? { explicit: true } : undefined)
      }),
    [projectId, projectRoot]
  )
  const states = useMemo(() => new ConversationArtifacts(checks), [checks])
  useEffect(() => () => states.dispose(), [states])
  useEffect(() => states.recheck(), [states, revision])

  const resolveImage = useImageResolver(projectId, checks)
  const [open, setOpen] = useState<Open | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)

  const services = useMemo<ArtifactServices>(
    () => ({
      onArtifact(artifact, anchor) {
        const show = (): void => setOpen({ target: { kind: 'artifact', artifact }, anchor })
        const known = artifact.kind === 'path' ? checks.get(artifact.value) : undefined
        if (!known || !isNegative(known)) {
          show()
          return
        }
        // Found missing, or not checkable, earlier: it may exist now. Still missing, it offers nothing.
        void checks.check(artifact.value, { refresh: true }).then((result) => {
          if (result.status === 'done' && result.info.kind === 'missing') return
          if (anchor.isConnected) show()
        })
      },
      resolveImage,
      openInlineImage(url, anchor) {
        setOpen({ target: { kind: 'inline-image', url }, anchor })
      }
    }),
    [checks, resolveImage]
  )

  const spawn = (seed: NodeSeed, sourceArtifact: { kind: string; value: string }): void => {
    void host.requestSpawn({ seed, origin: 'artifact', sourceNodeId: nodeId, sourceArtifact })
  }

  return (
    <ArtifactContext.Provider value={services}>
      <ArtifactStateContext.Provider value={states}>{children}</ArtifactStateContext.Provider>
      {open ? (
        <ArtifactPopover
          key={`${open.target.kind}:${open.target.kind === 'artifact' ? open.target.artifact.value : open.target.url}`}
          open={open}
          projectId={projectId}
          services={services}
          checks={checks}
          onClose={() => setOpen(null)}
          onEnlarge={(url, label) => setLightbox({ url, label })}
          onSpawn={spawn}
          notify={host.notify}
        />
      ) : null}
      {lightbox
        ? createPortal(
            // React events bubble through portals; a click in the lightbox must not reach the node behind it.
            <div className="agent-lightbox" onClick={(event) => event.stopPropagation()}>
              <Dialog
                open
                wide
                title={lightbox.label}
                onCancel={() => setLightbox(null)}
                footer={
                  <button type="button" className="cr-button" onClick={() => setLightbox(null)}>
                    Close
                  </button>
                }
              >
                <img className="agent-lightbox__image" src={lightbox.url} alt={lightbox.label} />
              </Dialog>
            </div>,
            document.body
          )
        : null}
    </ArtifactContext.Provider>
  )
}

function isNegative(check: PathCheck): boolean {
  return check.status === 'failed' || check.info.kind === 'missing'
}

// Images by source. Only loadable URLs are kept: an unavailable image may appear later, and a network image
// outside the project is described only once the user asked for it (which approves its path).
function useImageResolver(projectId: string, checks: PathChecks): ImageResolver {
  const cache = useMemo(() => ({ ready: new Map<string, string>(), pending: new Map<string, Promise<ImageResolution>>() }), [checks])
  return useCallback<ImageResolver>(
    (src, options) => {
      if (/^data:image\//i.test(src)) return Promise.resolve({ kind: 'ready', url: src })
      // Remote images are not loaded into the app (its content policy allows only local images).
      if (/^https?:/i.test(src)) return Promise.resolve({ kind: 'unavailable' })
      const ready = cache.ready.get(src)
      if (ready) return Promise.resolve({ kind: 'ready', url: ready })
      const path = /^file:/i.test(src) ? (decodeFileUrl(src) ?? src) : src
      const explicit = options?.explicit === true
      if (!explicit && !checks.mayTouch(path)) return Promise.resolve({ kind: 'network' })
      const pending = explicit ? undefined : cache.pending.get(src)
      if (pending) return pending
      const describe = window.spadeHost.files
        .describeImage(projectId, { kind: 'path', path }, explicit ? { explicit: true } : undefined)
        .then(
          (result): ImageResolution => {
            if (result.ok) {
              cache.ready.set(src, result.image.url)
              if (explicit) checks.approve(path)
              return { kind: 'ready', url: result.image.url }
            }
            return result.error.code === 'network-path' ? { kind: 'network' } : { kind: 'unavailable' }
          },
          (): ImageResolution => ({ kind: 'unavailable' })
        )
        .finally(() => {
          if (cache.pending.get(src) === describe) cache.pending.delete(src)
        })
      if (!explicit) cache.pending.set(src, describe)
      return describe
    },
    [projectId, checks, cache]
  )
}

type ArtifactPopoverProps = {
  open: Open
  projectId: string
  services: ArtifactServices
  checks: PathChecks
  onClose(): void
  onEnlarge(url: string, label: string): void
  onSpawn(seed: NodeSeed, sourceArtifact: { kind: string; value: string }): void
  notify(message: string): void
}

const STATE_NOTES: Record<ArtifactState, string | null> = {
  checking: 'Checking…',
  file: 'File',
  image: 'File',
  folder: 'Folder',
  missing: 'Not found',
  unchecked: 'Network path — not checked',
  unknown: 'Could not check',
  url: null
}

const STATE_HINTS: Partial<Record<ArtifactState, string>> = {
  missing: 'This path does not exist in the project.',
  unchecked: 'SPADE does not contact other machines on its own. Check this path to look it up.',
  unknown: 'SPADE could not check this path.'
}

function ArtifactPopover({ open, projectId, services, checks, onClose, onEnlarge, onSpawn, notify }: ArtifactPopoverProps): React.JSX.Element {
  const { target, anchor } = open
  const artifact = target.kind === 'artifact' ? target.artifact : null
  const path = artifact?.kind === 'path' ? artifact.value : null
  const check = useSyncExternalStore(checks.subscribe, () => (path === null ? undefined : checks.get(path)))
  const info = check?.status === 'done' ? check.info : undefined
  const [thumbnail, setThumbnail] = useState<string | null>(target.kind === 'inline-image' ? target.url : null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (path !== null) void checks.check(path)
  }, [path, checks])

  const presentation = artifact
    ? presentArtifact(artifact, check?.status === 'failed' ? 'failed' : info)
    : { state: 'image' as const, quiet: false, actions: ['enlarge', 'spawn-image'] as ArtifactActionId[] }

  useEffect(() => {
    if (presentation.state !== 'image' || !info) return
    let active = true
    void services.resolveImage(info.absolutePath).then((result) => active && setThumbnail(result.kind === 'ready' ? result.url : null))
    return () => {
      active = false
    }
  }, [presentation.state, info, services])

  const value = artifact ? artifact.value : 'Inline image'
  const location = artifact?.line ? `:${artifact.line}` : ''
  const label = artifact === null ? 'Image' : artifact.kind === 'url' ? 'Link' : artifact.isImage ? 'Image' : 'Path'
  const bridge = window.spadeHost.files

  const finish = async (task: Promise<Result>): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await task.catch((error: unknown): Result => ({
      ok: false,
      error: { code: 'failed', message: error instanceof Error ? error.message : String(error) }
    }))
    setBusy(false)
    if (result.ok) onClose()
    else setFailure(result.error.message)
  }

  // The user asked for this very path: the one check allowed to reach a network path outside the project.
  const checkExplicitly = async (path: string): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await checks.check(path, { explicit: true })
    setBusy(false)
    if (result.status === 'failed') setFailure('Could not check this path.')
  }

  const run = (action: ArtifactActionId): void => {
    const resolvedPath = info && info.kind !== 'missing' ? info.absolutePath : (artifact?.value ?? '')
    switch (action) {
      case 'check':
        if (path !== null) void checkExplicitly(path)
        return
      case 'reveal':
      case 'open-folder':
        void finish(bridge.reveal(projectId, resolvedPath))
        return
      case 'copy-path':
        void finish(bridge.copyText(resolvedPath))
        return
      case 'copy-url':
        void finish(bridge.copyText(value))
        return
      case 'open-browser':
        void finish(bridge.openExternal(value))
        return
      case 'enlarge':
        if (thumbnail) onEnlarge(thumbnail, artifact ? artifact.value : 'Inline image')
        onClose()
        return
      case 'spawn-webpage':
        onClose()
        onSpawn({ entityType: WEB_PAGE_ENTITY, config: { url: value } }, { kind: 'url', value })
        return
      case 'spawn-image':
        onClose()
        if (target.kind === 'inline-image') {
          void spawnInlineImage(target.url, onSpawn, notify)
        } else {
          onSpawn({ entityType: IMAGE_ENTITY, config: { source: { kind: 'path', path: resolvedPath } } }, { kind: 'image', value })
        }
        return
    }
  }

  const disabledFor = (action: ArtifactActionId): boolean =>
    busy || (action === 'enlarge' && !thumbnail) || (action === 'spawn-image' && target.kind === 'artifact' && !info)
  const note = STATE_NOTES[presentation.state]
  const hint = STATE_HINTS[presentation.state]

  return (
    <Popover anchor={anchor} label={`${label} actions`} onClose={onClose} className="agent-artifact-popover">
      <header className="agent-artifact-popover__header">
        <span className="agent-artifact-popover__kind">{label}</span>
        {note ? <span className={`agent-artifact-popover__state agent-artifact-popover__state--${presentation.state}`}>{note}</span> : null}
      </header>
      <p className="agent-artifact-popover__value mono" title={value}>
        {value}
        {location}
      </p>
      {hint ? <p className="agent-artifact-popover__hint">{hint}</p> : null}
      {thumbnail && presentation.state === 'image' ? (
        <img className="agent-artifact-popover__thumbnail" src={thumbnail} alt={`Preview of ${value}`} draggable={false} />
      ) : null}
      <div className="agent-artifact-popover__actions">
        {presentation.actions.map((action) => (
          <button
            key={action}
            type="button"
            className="cr-menu__item"
            disabled={disabledFor(action)}
            onClick={() => run(action)}
          >
            {ARTIFACT_ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      {failure ? (
        <p className="agent-artifact-popover__failure" role="alert">
          {failure}
        </p>
      ) : null}
    </Popover>
  )
}

// Inline images have no file: they are stored in SPADE's asset store before the Image node is created.
async function spawnInlineImage(
  url: string,
  onSpawn: ArtifactPopoverProps['onSpawn'],
  notify: (message: string) => void
): Promise<void> {
  const image = decodeImageDataUrl(url)
  if (!image) {
    notify('This image cannot be opened as a node.')
    return
  }
  const { mimeType, bytes } = image
  const result = await window.spadeHost.files
    .importImage({ data: bytes.slice().buffer, mimeType })
    .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: reason instanceof Error ? reason.message : String(reason) } }))
  if (!result.ok) {
    notify(`Could not store the image: ${result.error.message}`)
    return
  }
  onSpawn(
    { entityType: IMAGE_ENTITY, config: { source: { kind: 'asset', assetId: result.assetId } } },
    { kind: 'image', value: `asset:${result.assetId}` }
  )
}
