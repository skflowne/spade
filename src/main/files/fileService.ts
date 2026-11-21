import type { AssetStore } from '../persistence'
import type { EntityCreateResult, FileService, MainEntityAdapter } from '../contracts'
import {
  IMAGE_ENTITY,
  WEB_PAGE_ENTITY,
  imageEntity,
  webPageEntity,
  type ImageConfig,
  type ImageSource
} from '../../shared/builtinEntities'
import type { Project } from '../../shared/domain'
import type { ImageInfo, PathAccessOptions, PathInfo, PathKind } from '../../shared/ipc'
import {
  IMAGE_EXTENSIONS,
  isImagePath,
  isNetworkPath,
  needsNetworkApproval,
  pathBaseName,
  pathKey,
  resolveProjectPath,
  splitLineSuffix
} from '../../shared/paths'
import { FileServiceError } from './errors'
import { nodeFileSystem, type FileSystemReads } from './fileSystem'
import type { FileServiceHost } from './host'
import { probeImageFile } from './imageFile'
import { imageTypeOfPath, type ImageDimensions } from './imageFormat'
import { buildImageUrl, createImageRequestHandler } from './imageProtocol'
import { fitImageNodeSize } from './imageSizing'
import { ImageWatcher, type ImageWatcherOptions } from './imageWatcher'
import { installWebviewPolicy, parseWebUrl } from './webviewPolicy'

export type FileServiceOptions = {
  host: FileServiceHost
  assetStore: Pick<AssetStore, 'import' | 'resolve'>
  watch?: ImageWatcherOptions
  fileSystem?: FileSystemReads
}

type ImageChangedEvent = { type: 'image-changed'; path: string }

async function kindOf(fileSystem: FileSystemReads, path: string): Promise<PathKind> {
  try {
    const stats = await fileSystem.stat(path)
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'missing'
  } catch {
    return 'missing'
  }
}

// The absolute path a conversation path names, without its :line suffix; null for blank input.
function locate(project: Project, input: string): { absolutePath: string; line: number | null } | null {
  if (typeof input !== 'string' || input.trim() === '') return null
  const { path, line } = splitLineSuffix(input)
  return { absolutePath: resolveProjectPath(project.rootPath, path), line }
}

function parseImageConfig(value: unknown): ImageConfig {
  try {
    return imageEntity.parseConfig(value)
  } catch (error) {
    throw new FileServiceError('invalid-config', `Invalid image config: ${(error as Error).message}`)
  }
}

function requireImagePath(path: string): void {
  if (imageTypeOfPath(path) === null) {
    throw new FileServiceError('unsupported-image', `${path} is not a PNG, JPEG, GIF, WebP, or SVG image.`)
  }
}

async function requireAssetPath(assetStore: FileServiceOptions['assetStore'], assetId: string): Promise<string> {
  const path = await assetStore.resolve(assetId)
  if (path === null) throw new FileServiceError('image-missing', `Asset ${JSON.stringify(assetId)} does not exist.`)
  return path
}

function fittedSize(dimensions: ImageDimensions | null): Pick<EntityCreateResult, 'size'> {
  const size = dimensions === null ? null : fitImageNodeSize(dimensions)
  return size === null ? {} : { size }
}

export function createFileService(options: FileServiceOptions): FileService {
  const { host, assetStore } = options
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const listeners = new Set<(event: ImageChangedEvent) => void>()
  const watcher = new ImageWatcher(
    (path) => {
      for (const listener of listeners) {
        try {
          listener({ type: 'image-changed', path })
        } catch (error) {
          console.error('An image-changed listener failed', error)
        }
      }
    },
    options.watch,
    fileSystem
  )
  let stopServingImages: (() => void) | null = null
  let removeWebviewPolicy: (() => void) | null = null
  const probe = (path: string) => probeImageFile(path, fileSystem.openImage)

  // Touching a network path may open an SMB connection to another machine and send the user's credentials,
  // so one named in agent output is touched only once the user explicitly acted on it (then for the rest of
  // the session) or when it lies inside the open project. Keys are pathKey()s.
  const allowedNetworkPaths = new Set<string>()
  function mayTouch(project: Project, path: string, access: PathAccessOptions | undefined): boolean {
    if (!isNetworkPath(path)) return true
    // Remembered so the image protocol, which knows no project, serves what describeImage allowed.
    if (access?.explicit === true || !needsNetworkApproval(path, project.rootPath)) allowedNetworkPaths.add(pathKey(path))
    return allowedNetworkPaths.has(pathKey(path))
  }

  // Images and web pages have no external resource to track: the node's config (path, asset id, URL) is
  // the single source of truth, so their adapters return no resourceRef that could drift from it.
  const imageEntityAdapter: MainEntityAdapter = {
    type: IMAGE_ENTITY,
    async create(input) {
      const config = parseImageConfig(input.config)
      if (config.source.kind === 'asset') {
        const path = await requireAssetPath(assetStore, config.source.assetId)
        const dimensions = await probe(path).then((probed) => probed.dimensions, () => null)
        return {
          resourceRef: null,
          title: 'Image',
          config,
          ...fittedSize(dimensions)
        }
      }
      const path = resolveProjectPath(input.project.rootPath, config.source.path)
      requireImagePath(path)
      // A missing or unreadable file still makes a node (plan §7.2); it shows its state once rendered.
      // An unapproved network path is not touched at all, so its node gets the default size.
      const dimensions = mayTouch(input.project, path, undefined)
        ? await probe(path).then((probed) => probed.dimensions, () => null)
        : null
      return {
        resourceRef: null,
        title: pathBaseName(path),
        config: { ...config, source: { kind: 'path', path } },
        ...fittedSize(dimensions)
      }
    }
  }

  const webPageEntityAdapter: MainEntityAdapter = {
    type: WEB_PAGE_ENTITY,
    async create(input) {
      let url: URL | null
      try {
        url = parseWebUrl(webPageEntity.parseConfig(input.config).url)
      } catch {
        url = null
      }
      if (url === null) throw new FileServiceError('invalid-config', 'A web page needs an http or https URL.')
      return {
        resourceRef: null,
        title: url.host,
        config: { url: url.href }
      }
    }
  }

  return {
    imageEntityAdapter,
    webPageEntityAdapter,

    async start() {
      if (stopServingImages) return
      stopServingImages = host.handleImageProtocol(
        createImageRequestHandler({
          resolveAsset: (id) => assetStore.resolve(id),
          allowsFile: (path) => !isNetworkPath(path) || allowedNetworkPaths.has(pathKey(path)),
          openImage: fileSystem.openImage
        })
      )
      removeWebviewPolicy = installWebviewPolicy(host.guestWebviews())
    },

    // Final: watching does not resume after a stop.
    async stop() {
      stopServingImages?.()
      removeWebviewPolicy?.()
      stopServingImages = null
      removeWebviewPolicy = null
      watcher.close()
    },

    async inspectPath(project, input, access): Promise<PathInfo> {
      const location = locate(project, input)
      if (location === null) return { input, absolutePath: '', kind: 'missing', isImage: false, line: null }
      const kind = mayTouch(project, location.absolutePath, access) ? await kindOf(fileSystem, location.absolutePath) : 'unchecked'
      return {
        input,
        absolutePath: location.absolutePath,
        kind,
        isImage: kind === 'file' && isImagePath(location.absolutePath),
        line: location.line
      }
    },

    // Plan §7.1 invariant: files are only revealed, never launched. Revealing is always the user's explicit act.
    async reveal(project, input) {
      const location = locate(project, input)
      const kind =
        location !== null && mayTouch(project, location.absolutePath, { explicit: true })
          ? await kindOf(fileSystem, location.absolutePath)
          : 'missing'
      if (location === null || kind === 'missing') {
        throw new FileServiceError('path-missing', `${JSON.stringify(input)} does not exist.`)
      }
      if (kind === 'file') {
        host.showItemInFolder(location.absolutePath)
        return
      }
      const failure = await host.openPath(location.absolutePath)
      if (failure) throw new FileServiceError('reveal-failed', `Explorer could not open ${location.absolutePath}: ${failure}`)
    },

    async openExternal(value) {
      const url = parseWebUrl(value)
      if (url === null) throw new FileServiceError('invalid-url', `Only http and https links open in the browser: ${JSON.stringify(value)}`)
      await host.openExternal(url.href)
    },

    copyText(text) {
      host.writeClipboardText(text)
    },

    async pickImage(project) {
      const chosen = await host.showOpenImageDialog({ defaultPath: project.rootPath, extensions: [...IMAGE_EXTENSIONS] })
      if (chosen === null) return null
      requireImagePath(chosen)
      return chosen
    },

    async describeImage(project, value: ImageSource, access): Promise<ImageInfo> {
      const { source } = parseImageConfig({ source: value })
      let path: string
      if (source.kind === 'path') {
        path = resolveProjectPath(project.rootPath, source.path)
        requireImagePath(path)
        if (!mayTouch(project, path, access)) {
          throw new FileServiceError('network-path', `${path} is on another machine; SPADE loads it only when you ask for it.`)
        }
        // Watched even when missing, so the renderer hears when it appears.
        watcher.watch(path)
      } else {
        path = await requireAssetPath(assetStore, source.assetId)
      }
      const probed = await probe(path)
      const location = source.kind === 'path' ? { kind: 'file' as const, path } : { kind: 'asset' as const, assetId: source.assetId }
      return {
        url: buildImageUrl(location, probed.revision),
        width: probed.dimensions?.width ?? null,
        height: probed.dimensions?.height ?? null,
        revision: probed.revision
      }
    },

    importImage(input) {
      return assetStore.import(input)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
