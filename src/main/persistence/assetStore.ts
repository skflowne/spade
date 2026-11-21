import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { AssetRejectedError } from './errors'
import { nodeFileOperations, writeFileAtomically, type PersistenceFileOperations } from './fileOperations'
import { isSafeId } from './safeId'

export const ASSET_SIZE_LIMIT_BYTES = 50 * 1024 * 1024

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}
const EXTENSIONS = Object.values(EXTENSION_BY_MIME_TYPE)

export type AssetStoreOptions = {
  // SPADE's application-data directory; assets live in its `assets/` subdirectory.
  directory: string
  files?: PersistenceFileOperations
}

// Images SPADE had to keep its own copy of, such as pasted images. Content-addressed: the id is a
// hash of the type and bytes, so importing the same image twice yields one file.
export class AssetStore {
  readonly directory: string
  private readonly files: PersistenceFileOperations

  constructor(options: AssetStoreOptions) {
    this.directory = join(resolve(options.directory), 'assets')
    this.files = options.files ?? nodeFileOperations
  }

  // Rejects with AssetRejectedError before writing anything when the input is not an acceptable image.
  async import(input: { data: Uint8Array | ArrayBuffer; mimeType: string }): Promise<{ assetId: string }> {
    const mimeType = input.mimeType.split(';')[0].trim().toLowerCase()
    const extension = EXTENSION_BY_MIME_TYPE[mimeType]
    if (!extension) {
      throw new AssetRejectedError(
        'unsupported-type',
        `Unsupported image type ${JSON.stringify(input.mimeType)}: only PNG, JPEG, GIF, WebP, and SVG are stored.`
      )
    }
    const data = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data)
    if (data.byteLength === 0) throw new AssetRejectedError('empty', 'The image is empty.')
    if (data.byteLength > ASSET_SIZE_LIMIT_BYTES) {
      throw new AssetRejectedError('too-large', `The image exceeds the ${ASSET_SIZE_LIMIT_BYTES / (1024 * 1024)} MB limit.`)
    }

    const assetId = createHash('sha256').update(mimeType).update('\0').update(data).digest('hex')
    const path = join(this.directory, `${assetId}.${extension}`)
    if (!(await this.files.exists(path))) await writeFileAtomically(this.files, path, data)
    return { assetId }
  }

  // Absolute path of the stored file, or null for an unknown or unsafe id.
  async resolve(assetId: string): Promise<string | null> {
    if (!isSafeId(assetId)) return null
    for (const extension of EXTENSIONS) {
      const path = join(this.directory, `${assetId}.${extension}`)
      if (await this.files.exists(path)) return path
    }
    return null
  }
}
