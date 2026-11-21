import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageConfig } from '@shared/builtinEntities'
import type { ImageInfo } from '@shared/ipc'
import { isSamePath, resolveProjectPath } from '@shared/paths'
import { nodeHeader } from '../../canvas/nodeFocus'
import type { EntityBodyProps, NodeStatus } from '../types'
import { ImageLightbox } from './ImageLightbox'
import { copyImagePath, registerImageBody, revealImage } from './imageRequests'
import './image.css'

type Problem = { code: string; message: string }

const MISSING = 'image-missing'
// A network path outside the project root: the main process touches it only for an explicit request.
const NETWORK = 'network-path'

// Why the image cannot be opened at full size, or null when it can.
function fullSizeUnavailable(image: ImageInfo | null, problem: Problem | null, isFile: boolean): string | null {
  if (problem?.code === MISSING) return isFile ? 'file not found' : 'image not found'
  if (problem?.code === NETWORK) return 'image not loaded'
  if (problem) return 'image cannot be shown'
  return image ? null : 'image not loaded'
}

function statusOf(image: ImageInfo | null, problem: Problem | null): NodeStatus | null {
  if (problem?.code === NETWORK) return { label: 'Not loaded', tone: 'neutral', description: 'A network image loads only when you ask.' }
  if (problem) {
    return problem.code === MISSING
      ? { label: 'Missing', tone: 'warning', description: problem.message }
      : { label: 'Unreadable', tone: 'danger', description: problem.message }
  }
  if (image && image.width !== null && image.height !== null) {
    return { label: `${image.width}×${image.height}`, tone: 'neutral', description: 'Image size in pixels' }
  }
  return null
}

export function ImageBody({ node, config, project, active, detail, host }: EntityBodyProps<ImageConfig>): React.JSX.Element {
  const { source } = config
  const path = source.kind === 'path' ? resolveProjectPath(project.rootPath, source.path) : null
  const sourceKey = source.kind === 'path' ? `path:${path}` : `asset:${source.assetId}`
  const [image, setImage] = useState<ImageInfo | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  // Open, with the control that opened it (null from the node menu, whose entry is gone by then).
  const [fullSize, setFullSize] = useState<{ opener: HTMLElement | null } | null>(null)
  const sequence = useRef(0)
  const latestSource = useRef(source)
  latestSource.current = source

  // Only the newest description wins; a change event can overtake an activation's request. `explicit`: the
  // user clicked to load this very image, which may reach another machine.
  const describe = useCallback(async (explicit = false) => {
    const request = ++sequence.current
    let next: { image: ImageInfo } | { problem: Problem }
    try {
      const result = explicit
        ? await window.spadeHost.files.describeImage(project.id, latestSource.current, { explicit: true })
        : await window.spadeHost.files.describeImage(project.id, latestSource.current)
      next = result.ok ? { image: result.image } : { problem: result.error }
    } catch (error) {
      next = { problem: { code: 'image-unreadable', message: error instanceof Error ? error.message : String(error) } }
    }
    if (request !== sequence.current) return
    if ('image' in next) {
      setImage(next.image)
      setProblem(null)
    } else {
      setImage(null)
      setProblem(next.problem)
    }
  }, [project.id])

  useEffect(() => {
    void describe()
  }, [describe, sourceKey])

  // The main process watches the file once described; a new revision means a new URL.
  useEffect(() => {
    if (path === null) return
    return window.spadeHost.files.onImageChanged((event) => {
      if (isSamePath(event.path, path)) void describe()
    })
  }, [describe, path])

  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) void describe()
    wasActive.current = active
  }, [active, describe])

  const unavailable = fullSizeUnavailable(image, problem, path !== null)
  useEffect(
    () =>
      registerImageBody(node.id, {
        reload: () => void describe(),
        openFullSize: () => setFullSize({ opener: null }),
        fullSizeUnavailable: unavailable
      }),
    [node.id, describe, unavailable]
  )
  const notify = (message: string): void => host.notify(message)

  const status = statusOf(image, problem)
  const statusKey = status ? `${status.label}|${status.tone}|${status.description}` : ''
  useEffect(() => {
    host.setStatus(status)
    // The key captures every field of the status.
  }, [statusKey, host])
  useEffect(() => () => host.setStatus(null), [host])

  const alt = config.caption ?? node.title
  const location = path ?? `SPADE asset ${source.kind === 'asset' ? source.assetId : ''}`
  return (
    <figure className="image-node" data-testid="image-node">
      <div className="image-node__frame">
        {image && !problem ? (
          <img
            className="image-node__image"
            data-testid="image-view"
            src={image.url}
            alt={alt}
            width={image.width ?? undefined}
            height={image.height ?? undefined}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setProblem({ code: 'image-unreadable', message: 'The file could not be decoded as an image.' })}
          />
        ) : null}
        {problem?.code === NETWORK ? (
          <div className="image-node__problem" role="status" data-testid="image-network">
            <p className="image-node__problem-title image-node__problem-title--neutral">Network image — not loaded</p>
            <p className="mono image-node__problem-path">{location}</p>
            <p className="image-node__problem-reason">This file is on another machine. SPADE opens it only when you ask.</p>
            {detail === 'full' ? (
              <button type="button" className="cr-button" onClick={() => void describe(true)}>
                Load
              </button>
            ) : null}
          </div>
        ) : problem ? (
          <div className="image-node__problem" role="status" data-testid="image-problem">
            <p className="image-node__problem-title">
              {problem.code === MISSING ? (path ? 'File not found' : 'Image not found') : 'This image cannot be shown'}
            </p>
            <p className="mono image-node__problem-path">{location}</p>
            {problem.code === MISSING ? null : <p className="image-node__problem-reason">{problem.message}</p>}
            {detail === 'full' ? (
              <button type="button" className="cr-button" onClick={() => void describe()}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {!image && !problem ? (
          <div className="image-node__loading" role="status">
            Loading image…
          </div>
        ) : null}
        {active && detail === 'full' ? (
          <div className="image-node__toolbar" role="toolbar" aria-label="Image">
            {path ? (
              <>
                <button type="button" className="cr-button cr-button--ghost image-node__action" onClick={() => void revealImage(project.id, path, notify)}>
                  Reveal
                </button>
                <button type="button" className="cr-button cr-button--ghost image-node__action" onClick={() => void copyImagePath(path, notify)}>
                  Copy path
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="cr-button cr-button--ghost image-node__action"
              disabled={unavailable !== null}
              onClick={(event) => setFullSize({ opener: event.currentTarget })}
            >
              Full size
            </button>
            <button type="button" className="cr-button cr-button--ghost image-node__action" onClick={() => void describe()}>
              Reload
            </button>
          </div>
        ) : null}
      </div>
      {config.caption ? (
        <figcaption className="image-node__caption" title={config.caption}>
          {config.caption}
        </figcaption>
      ) : null}
      {fullSize && image && !problem ? (
        <ImageLightbox
          title={node.title}
          alt={alt}
          image={image}
          onClose={() => setFullSize(null)}
          returnFocusTo={() => (fullSize.opener?.isConnected ? fullSize.opener : nodeHeader(node.id))}
        />
      ) : null}
    </figure>
  )
}
