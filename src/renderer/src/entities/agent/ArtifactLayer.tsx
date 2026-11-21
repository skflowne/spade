import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IMAGE_ENTITY, WEB_PAGE_ENTITY } from '@shared/builtinEntities'
import type { Artifact } from '@shared/artifacts'
import type { NodeSeed } from '@shared/commands'
import type { PathInfo, Result } from '@shared/ipc'
import type { ArtifactHandler, ImageResolver } from '../../rich'
import { Dialog } from '../../ui/Dialog'
import type { EntityHost } from '../types'
import { ARTIFACT_ACTION_LABELS, decodeImageDataUrl, presentArtifact, type ArtifactActionId } from './artifactActions'
import { Popover } from './Popover'

// Rich conversation artifacts (plan §7.1): one actions popover for every path, image, and link in the
// conversation, a lightbox for images, and a per-conversation cache of path existence checks.
// Every action is a bridge command; the renderer never decides to launch anything.

export type ArtifactServices = {
  onArtifact: ArtifactHandler
  resolveImage: ImageResolver
  // Lazy and cached for the conversation's lifetime; never rejects.
  inspect(path: string): Promise<PathInfo>
  known(path: string): PathInfo | undefined
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
  nodeId: string
  host: EntityHost
  children: ReactNode
}

export function ArtifactLayer({ projectId, nodeId, host, children }: ArtifactLayerProps): React.JSX.Element {
  const inspections = useRef(new Map<string, Promise<PathInfo>>())
  const results = useRef(new Map<string, PathInfo>())
  const images = useRef(new Map<string, Promise<string | null>>())
  const [open, setOpen] = useState<Open | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)

  const inspect = useCallback(
    (path: string): Promise<PathInfo> => {
      let pending = inspections.current.get(path)
      if (!pending) {
        pending = window.spadeHost.files.inspectPath(projectId, path).then(
          (info) => {
            results.current.set(path, info)
            return info
          },
          (): PathInfo => {
            const info: PathInfo = { input: path, absolutePath: '', kind: 'missing', isImage: false, line: null }
            results.current.set(path, info)
            return info
          }
        )
        inspections.current.set(path, pending)
      }
      return pending
    },
    [projectId]
  )

  const resolveImage = useCallback<ImageResolver>(
    (src) => {
      if (/^data:image\//i.test(src)) return Promise.resolve(src)
      // Remote images are not loaded into the app (its content policy allows only local images).
      if (/^https?:/i.test(src)) return Promise.resolve(null)
      let pending = images.current.get(src)
      if (!pending) {
        pending = window.spadeHost.files.describeImage(projectId, { kind: 'path', path: imagePath(src) }).then(
          (result) => (result.ok ? result.image.url : null),
          () => null
        )
        images.current.set(src, pending)
      }
      return pending
    },
    [projectId]
  )

  const services = useMemo<ArtifactServices>(
    () => ({
      onArtifact(artifact, anchor) {
        // A path known to be missing is shown disabled and offers nothing.
        if (artifact.kind === 'path' && results.current.get(artifact.value)?.kind === 'missing') return
        setOpen({ target: { kind: 'artifact', artifact }, anchor })
      },
      resolveImage,
      inspect,
      known: (path) => results.current.get(path),
      openInlineImage(url, anchor) {
        setOpen({ target: { kind: 'inline-image', url }, anchor })
      }
    }),
    [inspect, resolveImage]
  )

  const spawn = (seed: NodeSeed, sourceArtifact: { kind: string; value: string }): void => {
    void host.requestSpawn({ seed, origin: 'artifact', sourceNodeId: nodeId, sourceArtifact })
  }

  return (
    <ArtifactContext.Provider value={services}>
      {children}
      {open ? (
        <ArtifactPopover
          key={`${open.target.kind}:${open.target.kind === 'artifact' ? open.target.artifact.value : open.target.url}`}
          open={open}
          projectId={projectId}
          services={services}
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

function imagePath(src: string): string {
  if (!/^file:/i.test(src)) return src
  try {
    const decoded = decodeURIComponent(src.replace(/^file:\/\//i, ''))
    return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return src
  }
}

type ArtifactPopoverProps = {
  open: Open
  projectId: string
  services: ArtifactServices
  onClose(): void
  onEnlarge(url: string, label: string): void
  onSpawn(seed: NodeSeed, sourceArtifact: { kind: string; value: string }): void
  notify(message: string): void
}

const STATE_NOTES = {
  checking: 'Checking…',
  file: 'File',
  image: 'File',
  folder: 'Folder',
  missing: 'Not found',
  url: null
} as const

function ArtifactPopover({ open, projectId, services, onClose, onEnlarge, onSpawn, notify }: ArtifactPopoverProps): React.JSX.Element {
  const { target, anchor } = open
  const artifact = target.kind === 'artifact' ? target.artifact : null
  const isPath = artifact?.kind === 'path'
  const [info, setInfo] = useState<PathInfo | undefined>(() => (isPath ? services.known(artifact.value) : undefined))
  const [thumbnail, setThumbnail] = useState<string | null>(target.kind === 'inline-image' ? target.url : null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!artifact || artifact.kind !== 'path') return
    let active = true
    void services.inspect(artifact.value).then((result) => active && setInfo(result))
    return () => {
      active = false
    }
  }, [artifact, services])

  const presentation = artifact
    ? presentArtifact(artifact, info)
    : { state: 'image' as const, quiet: false, actions: ['enlarge', 'spawn-image'] as ArtifactActionId[] }

  useEffect(() => {
    if (presentation.state !== 'image' || !info) return
    let active = true
    void services.resolveImage(info.absolutePath).then((url) => active && setThumbnail(url))
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

  const run = (action: ArtifactActionId): void => {
    const path = info && info.kind !== 'missing' ? info.absolutePath : (artifact?.value ?? '')
    switch (action) {
      case 'reveal':
      case 'open-folder':
        void finish(bridge.reveal(projectId, path))
        return
      case 'copy-path':
        void finish(bridge.copyText(path))
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
          onSpawn({ entityType: IMAGE_ENTITY, config: { source: { kind: 'path', path } } }, { kind: 'image', value })
        }
        return
    }
  }

  const disabledFor = (action: ArtifactActionId): boolean =>
    busy || (action === 'enlarge' && !thumbnail) || (action === 'spawn-image' && target.kind === 'artifact' && !info)

  return (
    <Popover anchor={anchor} label={`${label} actions`} onClose={onClose} className="agent-artifact-popover">
      <header className="agent-artifact-popover__header">
        <span className="agent-artifact-popover__kind">{label}</span>
        {STATE_NOTES[presentation.state] ? (
          <span className={`agent-artifact-popover__state agent-artifact-popover__state--${presentation.state}`}>
            {STATE_NOTES[presentation.state]}
          </span>
        ) : null}
      </header>
      <p className="agent-artifact-popover__value mono" title={value}>
        {value}
        {location}
      </p>
      {presentation.state === 'missing' ? (
        <p className="agent-artifact-popover__hint">This path does not exist in the project.</p>
      ) : null}
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
