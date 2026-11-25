export type FileServiceErrorCode =
  // reveal: nothing exists at the path.
  | 'path-missing'
  // reveal: Explorer refused to open the directory.
  | 'reveal-failed'
  // openExternal: not an http or https URL.
  | 'invalid-url'
  // A malformed image source, or an entity config an adapter cannot use.
  | 'invalid-config'
  // The path does not name a supported image type (PNG, JPEG, GIF, WebP, SVG).
  | 'unsupported-image'
  // The image file or asset does not exist.
  | 'image-missing'
  // The image exists but cannot be read, or its content is not an image of a supported type.
  | 'image-unreadable'
  // describeImage: a network path outside the project root that the user has not approved this session.
  | 'network-path'

// Carries a stable `code` the IPC layer forwards as `{ code, message }`.
export class FileServiceError extends Error {
  constructor(
    readonly code: FileServiceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'FileServiceError'
  }
}
