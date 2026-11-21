import type { Size } from '../../shared/domain'
import type { ImageDimensions } from './imageFormat'

// Plan §8: the default image node keeps the image's aspect ratio with its longest side at 560, but never
// lets the shortest side fall below 240; for extreme aspect ratios the minimum wins over the ratio.
export const IMAGE_NODE_LONGEST_SIDE = 560
export const IMAGE_NODE_MIN_SHORTEST_SIDE = 240

export function fitImageNodeSize(image: ImageDimensions): Size | null {
  const { width, height } = image
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const shortest = Math.max(
    IMAGE_NODE_MIN_SHORTEST_SIDE,
    Math.round((IMAGE_NODE_LONGEST_SIDE * Math.min(width, height)) / Math.max(width, height))
  )
  return width >= height
    ? { width: IMAGE_NODE_LONGEST_SIDE, height: shortest }
    : { width: shortest, height: IMAGE_NODE_LONGEST_SIDE }
}
