import { unwatchFile, watchFile, type Stats, type WatchFileOptions } from 'node:fs'
import { stat } from 'node:fs/promises'
import { openImageFile, type OpenedImage } from './imageFile'

export type FileWatchListener = (current: Stats, previous: Stats) => void

// Every filesystem call the file service makes on a path it was given. Injectable, so tests can prove
// which paths are touched (a network path outside the project never is without the user's approval).
export type FileSystemReads = {
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
  openImage(path: string, prefixBytes: number): Promise<OpenedImage>
  watchFile(path: string, options: WatchFileOptions & { bigint?: false }, listener: FileWatchListener): void
  unwatchFile(path: string, listener: FileWatchListener): void
}

export const nodeFileSystem: FileSystemReads = {
  stat: (path) => stat(path),
  openImage: openImageFile,
  watchFile: (path, options, listener) => void watchFile(path, options, listener),
  unwatchFile: (path, listener) => unwatchFile(path, listener)
}
