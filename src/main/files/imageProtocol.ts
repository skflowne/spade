import { Readable } from 'node:stream'
import { isSafeId } from '../persistence'
import { isAbsolutePath, isImagePath, isNetworkPath } from '../../shared/paths'
import { FileServiceError } from './errors'
import { IMAGE_MIME_TYPES, IMAGE_SNIFF_BYTES } from './imageFormat'
import { openImageFile, type OpenedImage } from './imageFile'

// Read-only scheme through which the sandboxed renderer shows local images in <img>:
//   spade-image://file/<encodeURIComponent(absolute path)>?v=<revision>
//   spade-image://asset/<asset id>?v=<revision>
// The whole path is one encoded segment, so URL normalization can never rewrite it.
export const IMAGE_PROTOCOL_SCHEME = 'spade-image'

export type ImageLocation = { kind: 'file'; path: string } | { kind: 'asset'; assetId: string }

// Sent with every image. As <img> content an SVG cannot run scripts; this also keeps it inert if it is
// ever loaded as a document.
const IMAGE_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"

export function buildImageUrl(location: ImageLocation, revision: string): string {
  const target =
    location.kind === 'file'
      ? `file/${encodeURIComponent(location.path)}`
      : `asset/${encodeURIComponent(location.assetId)}`
  return `${IMAGE_PROTOCOL_SCHEME}://${target}?v=${encodeURIComponent(revision)}`
}

// An absolute image path without `.` or `..` segments. The segment rule also excludes the `\\.\` device namespace.
function isServablePath(path: string): boolean {
  return (
    isAbsolutePath(path) &&
    !path.includes('\0') &&
    !path.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..') &&
    isImagePath(path)
  )
}

export function parseImageUrl(raw: string): ImageLocation | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${IMAGE_PROTOCOL_SCHEME}:`) return null
  const segment = url.pathname.slice(1)
  if (!url.pathname.startsWith('/') || segment.length === 0 || segment.includes('/')) return null
  let value: string
  try {
    value = decodeURIComponent(segment)
  } catch {
    return null
  }
  if (url.hostname === 'asset') return isSafeId(value) ? { kind: 'asset', assetId: value } : null
  if (url.hostname === 'file') return isServablePath(value) ? { kind: 'file', path: value } : null
  return null
}

function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers }
  })
}

export type ImageRequestHandlerOptions = {
  resolveAsset(assetId: string): Promise<string | null>
  // Whether a file path may be opened. By default no network path is: the file service allows only those
  // the user approved or that lie inside an open project.
  allowsFile?(path: string): boolean
  openImage?: typeof openImageFile
}

export function createImageRequestHandler(options: ImageRequestHandlerOptions): (request: Request) => Promise<Response> {
  const allowsFile = options.allowsFile ?? ((path: string) => !isNetworkPath(path))
  const openImage = options.openImage ?? openImageFile
  return async (request) => {
    if (request.method !== 'GET') return refuse(405, 'Images are read-only.', { Allow: 'GET' })
    const location = parseImageUrl(request.url)
    if (location === null) return refuse(400, 'Not an image URL.')
    if (location.kind === 'file' && !allowsFile(location.path)) return refuse(403, 'This network path is not approved.')
    const path = location.kind === 'file' ? location.path : await options.resolveAsset(location.assetId)
    if (path === null) return refuse(404, 'Unknown asset.')

    let image: OpenedImage
    try {
      image = await openImage(path, IMAGE_SNIFF_BYTES)
    } catch (error) {
      if (!(error instanceof FileServiceError)) throw error
      return error.code === 'image-missing' ? refuse(404, 'Image not found.') : refuse(415, 'Not a supported image.')
    }

    // Bounded to the size just checked, so a file growing during the read cannot exceed Content-Length.
    const body = image.handle.createReadStream({ start: 0, end: image.size - 1, autoClose: true })
    return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'Content-Type': IMAGE_MIME_TYPES[image.type],
        'Content-Length': String(image.size),
        'Content-Security-Policy': IMAGE_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache'
      }
    })
  }
}
