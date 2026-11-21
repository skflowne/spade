import { isImagePath } from '../../shared/paths'

// Pure, dependency-free recognition of the supported image formats from a bounded prefix of their bytes.

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg'
export type ImageDimensions = { width: number; height: number }

export const IMAGE_MIME_TYPES: Record<ImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

// Bytes read for recognition. SVG roots and raster headers sit well inside this.
export const IMAGE_SNIFF_BYTES = 64 * 1024
// Bytes read for dimensions. A JPEG frame header follows its metadata segments (EXIF, ICC, XMP), which can be large.
export const IMAGE_HEADER_BYTES = 512 * 1024

export function imageTypeOfPath(path: string): ImageType | null {
  if (!isImagePath(path)) return null
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : (extension as ImageType)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + expected.length && expected.every((value, index) => bytes[offset + index] === value)
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return bytes.length < offset + length ? '' : String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function svgText(bytes: Uint8Array): string {
  // The decoder drops a leading byte-order mark.
  return new TextDecoder('utf-8').decode(bytes.subarray(0, IMAGE_SNIFF_BYTES))
}

const SVG_ROOT = /<svg(?=[\s/>])([^>]*)>/i

function svgRootAttributes(bytes: Uint8Array): string | null {
  const source = svgText(bytes)
  if (!source.trimStart().startsWith('<')) return null
  const match = SVG_ROOT.exec(source.replace(/<!--[\s\S]*?-->/g, ''))
  return match ? match[1] : null
}

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  const gif = asciiAt(bytes, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif'
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'webp'
  if (svgRootAttributes(bytes) !== null) return 'svg'
  return null
}

// The type to serve a file as, or null to refuse it. A mislabelled raster image is still a raster image,
// but SVG markup is only ever accepted from a `.svg` file.
export function acceptedImageType(declared: ImageType, sniffed: ImageType | null): ImageType | null {
  if (sniffed === null) return null
  if (sniffed === 'svg') return declared === 'svg' ? 'svg' : null
  return sniffed
}

function dimensions(width: number, height: number): ImageDimensions | null {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || asciiAt(bytes, 12, 4) !== 'IHDR') return null
  const data = view(bytes)
  return dimensions(data.getUint32(16), data.getUint32(20))
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null
  const data = view(bytes)
  return dimensions(data.getUint16(6, true), data.getUint16(8, true))
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  const data = view(bytes)
  switch (asciiAt(bytes, 12, 4)) {
    case 'VP8 ':
      if (bytes.length < 30 || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null
      return dimensions(data.getUint16(26, true) & 0x3fff, data.getUint16(28, true) & 0x3fff)
    case 'VP8L': {
      if (bytes.length < 25 || bytes[20] !== 0x2f) return null
      const bits = data.getUint32(21, true)
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    case 'VP8X': {
      if (bytes.length < 30) return null
      const u24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
      return dimensions(u24(24) + 1, u24(27) + 1)
    }
    default:
      return null
  }
}

// EXIF orientation from an APP1 segment, or null when absent or malformed.
function exifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  if (asciiAt(bytes, start, 6) !== 'Exif\0\0') return null
  const tiff = start + 6
  const order = asciiAt(bytes, tiff, 2)
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  const data = view(bytes)
  const limit = Math.min(end, bytes.length)
  if (tiff + 8 > limit) return null
  const ifd = tiff + data.getUint32(tiff + 4, little)
  if (ifd + 2 > limit) return null
  const count = data.getUint16(ifd, little)
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > limit) return null
    if (data.getUint16(entry, little) === 0x0112) return data.getUint16(entry + 8, little)
  }
  return null
}

function isStartOfFrame(marker: number): boolean {
  // C4 (Huffman tables), C8 (reserved), and CC (arithmetic conditioning) share the range but are not frames.
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  const data = view(bytes)
  let orientation = 1
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2
      continue
    }
    // Scan data or end of image before any frame header.
    if (marker === 0xda || marker === 0xd9) return null
    const length = data.getUint16(offset + 2)
    if (length < 2) return null
    const segment = offset + 4
    const end = offset + 2 + length
    if (marker === 0xe1) orientation = exifOrientation(bytes, segment, end) ?? orientation
    if (isStartOfFrame(marker)) {
      if (segment + 5 > bytes.length) return null
      const height = data.getUint16(segment + 1)
      const width = data.getUint16(segment + 3)
      // Orientations 5–8 rotate by a quarter turn; the browser displays the image with sides swapped.
      return orientation >= 5 && orientation <= 8 ? dimensions(height, width) : dimensions(width, height)
    }
    offset = end
  }
  return null
}

function svgLength(value: string | undefined): number | null {
  if (value === undefined) return null
  const match = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(value)
  if (!match) return null
  const length = Number(match[1])
  return length > 0 ? length : null
}

function svgDimensions(bytes: Uint8Array): ImageDimensions | null {
  const root = svgRootAttributes(bytes)
  if (root === null) return null
  const attributes = new Map<string, string>()
  for (const match of root.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes.set(match[1], match[2] ?? match[3])
  }
  const width = svgLength(attributes.get('width'))
  const height = svgLength(attributes.get('height'))
  if (width !== null && height !== null) return dimensions(width, height)

  const box = (attributes.get('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value)) || box[2] <= 0 || box[3] <= 0) return null
  const [, , boxWidth, boxHeight] = box
  if (width !== null) return dimensions(width, (width * boxHeight) / boxWidth)
  if (height !== null) return dimensions((height * boxWidth) / boxHeight, height)
  return dimensions(boxWidth, boxHeight)
}

// Displayed pixel size from the start of the file, or null when the header does not say.
export function readImageDimensions(bytes: Uint8Array, type: ImageType): ImageDimensions | null {
  switch (type) {
    case 'png':
      return pngDimensions(bytes)
    case 'gif':
      return gifDimensions(bytes)
    case 'webp':
      return webpDimensions(bytes)
    case 'jpeg':
      return jpegDimensions(bytes)
    case 'svg':
      return svgDimensions(bytes)
  }
}
