import { open, type FileHandle } from 'node:fs/promises'
import { FileServiceError } from './errors'
import {
  IMAGE_HEADER_BYTES,
  acceptedImageType,
  imageTypeOfPath,
  readImageDimensions,
  sniffImageType,
  type ImageDimensions,
  type ImageType
} from './imageFormat'

export type OpenedImage = {
  // Owned by the caller, who must close it.
  handle: FileHandle
  type: ImageType
  size: number
  // Changes whenever the file is rewritten or replaced.
  revision: string
  // The first bytes of the file, at most the requested prefix length.
  prefix: Uint8Array
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function openFailure(path: string, error: unknown): FileServiceError {
  const code = errnoCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileServiceError('image-missing', `${path} does not exist.`)
  if (code === 'EISDIR') return new FileServiceError('image-missing', `${path} is a directory, not an image.`)
  return new FileServiceError('image-unreadable', `${path} cannot be read (${code ?? String(error)}).`)
}

function revisionOf(stats: { mtimeMs: number; size: number; ino: number }): string {
  return [Math.trunc(stats.mtimeMs * 1000), stats.size, stats.ino].map((value) => value.toString(36)).join('-')
}

// Opens a supported image file read-only and checks its content against its name, reading at most
// `prefixBytes`. Checking and serving share one handle, so a file swapped after the check is never served.
export async function openImageFile(path: string, prefixBytes: number): Promise<OpenedImage> {
  const declared = imageTypeOfPath(path)
  if (declared === null) throw new FileServiceError('unsupported-image', `${path} is not a PNG, JPEG, GIF, WebP, or SVG image.`)

  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    throw openFailure(path, error)
  }

  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new FileServiceError('image-missing', `${path} is not a file.`)
    const buffer = new Uint8Array(Math.min(stats.size, prefixBytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead)
    const type = acceptedImageType(declared, sniffImageType(prefix))
    if (type === null) throw new FileServiceError('image-unreadable', `${path} is not a valid ${declared.toUpperCase()} image.`)
    return { handle, type, size: stats.size, revision: revisionOf(stats), prefix }
  } catch (error) {
    await handle.close()
    throw error instanceof FileServiceError ? error : openFailure(path, error)
  }
}

// Type, revision, and displayed size, from a bounded prefix: a large image is never loaded whole.
export async function probeImageFile(
  path: string,
  open: typeof openImageFile = openImageFile
): Promise<{ type: ImageType; revision: string; dimensions: ImageDimensions | null }> {
  const image = await open(path, IMAGE_HEADER_BYTES)
  await image.handle.close()
  return { type: image.type, revision: image.revision, dimensions: readImageDimensions(image.prefix, image.type) }
}
