import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  ASSET_SIZE_LIMIT_BYTES,
  AssetRejectedError,
  AssetStore,
  nodeFileOperations,
  type PersistenceFileOperations
} from '../../src/main/persistence'

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'spade-assets-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const imageBytes = {
  'image/png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  'image/jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 2]),
  'image/gif': new TextEncoder().encode('GIF89a-3'),
  'image/webp': new TextEncoder().encode('RIFF\0\0\0\0WEBP4'),
  'image/svg+xml': new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
}
const expectedExtension = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

test('each supported image type is stored under the assets directory and resolves to its bytes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AssetStore({ directory })

    for (const [mimeType, data] of Object.entries(imageBytes) as Array<[keyof typeof imageBytes, Uint8Array]>) {
      const { assetId } = await store.import({ data, mimeType })
      expect(assetId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)

      const path = await store.resolve(assetId)
      expect(path).not.toBeNull()
      expect(dirname(path as string)).toBe(join(directory, 'assets'))
      expect(extname(path as string)).toBe(expectedExtension[mimeType])
      expect(new Uint8Array(await readFile(path as string))).toEqual(data)
    }

    expect(await readdir(join(directory, 'assets'))).toHaveLength(Object.keys(imageBytes).length)
  })
})

test('an ArrayBuffer and a mime type with different case and parameters are accepted', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AssetStore({ directory })
    const data = imageBytes['image/svg+xml']
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)

    const { assetId } = await store.import({ data: buffer as ArrayBuffer, mimeType: 'Image/SVG+XML; charset=utf-8' })

    expect(new Uint8Array(await readFile((await store.resolve(assetId)) as string))).toEqual(data)
  })
})

test('importing the same image twice yields one asset', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AssetStore({ directory })

    const first = await store.import({ data: imageBytes['image/png'], mimeType: 'image/png' })
    const second = await store.import({ data: imageBytes['image/png'].slice(), mimeType: 'image/png' })

    expect(second.assetId).toBe(first.assetId)
    expect(await readdir(join(directory, 'assets'))).toHaveLength(1)
  })
})

test('unsupported types, empty data, and oversized images are rejected without writing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AssetStore({ directory })
    const rejected: Array<{ data: Uint8Array; mimeType: string; reason: string }> = [
      { data: imageBytes['image/png'], mimeType: 'text/html', reason: 'unsupported-type' },
      { data: imageBytes['image/png'], mimeType: 'application/octet-stream', reason: 'unsupported-type' },
      { data: imageBytes['image/png'], mimeType: 'image/bmp', reason: 'unsupported-type' },
      { data: imageBytes['image/png'], mimeType: '', reason: 'unsupported-type' },
      { data: new Uint8Array(0), mimeType: 'image/png', reason: 'empty' },
      { data: new Uint8Array(ASSET_SIZE_LIMIT_BYTES + 1), mimeType: 'image/png', reason: 'too-large' }
    ]

    for (const { data, mimeType, reason } of rejected) {
      const failure = await store.import({ data, mimeType }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AssetRejectedError)
      expect(failure).toMatchObject({ reason })
    }

    expect(ASSET_SIZE_LIMIT_BYTES).toBe(50 * 1024 * 1024)
    expect(await readdir(directory)).toEqual([])
  })
})

test('unknown and unsafe asset ids resolve to nothing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AssetStore({ directory })
    await store.import({ data: imageBytes['image/png'], mimeType: 'image/png' })

    for (const assetId of ['missing', '', '.', '..', '../index', 'a/b', 'a\\b', 'x.png', 'x'.repeat(129)]) {
      expect(await store.resolve(assetId)).toBeNull()
    }
  })
})

test('a failed asset write leaves no asset and no temporary file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const files: PersistenceFileOperations = {
      ...nodeFileOperations,
      rename: async () => {
        throw new Error('injected rename failure')
      }
    }

    await expect(
      new AssetStore({ directory, files }).import({ data: imageBytes['image/png'], mimeType: 'image/png' })
    ).rejects.toThrow('injected rename failure')

    expect(await readdir(join(directory, 'assets'))).toEqual([])
    const { assetId } = await new AssetStore({ directory }).import({ data: imageBytes['image/png'], mimeType: 'image/png' })
    expect(await new AssetStore({ directory, files }).resolve(assetId)).not.toBeNull()
  })
})
