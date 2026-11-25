// Every persistence failure the caller is expected to handle carries a stable `code` it can
// forward across IPC as `{ code, message }`.

export class InvalidIdError extends Error {
  readonly code = 'invalid-id'

  constructor(
    readonly kind: string,
    readonly id: string
  ) {
    super(`Invalid ${kind} id ${JSON.stringify(id)}: ids must match [A-Za-z0-9_-]{1,128} and not be a reserved device name.`)
    this.name = 'InvalidIdError'
  }
}

// Thrown by a save; nothing was written.
export class InvalidRecordError extends Error {
  readonly code = 'invalid-record'

  constructor(
    readonly what: string,
    readonly reason: string
  ) {
    super(`Refusing to persist malformed ${what}: ${reason}`)
    this.name = 'InvalidRecordError'
  }
}

// Thrown by a load. The unreadable file has already been moved to `backupPath`, so loading again
// yields the defaults; the caller decides whether to continue from them.
export class CorruptDataError extends Error {
  readonly code = 'corrupt-data'

  constructor(
    readonly filePath: string,
    readonly backupPath: string,
    readonly reason: string
  ) {
    super(`${filePath} is unreadable (${reason}); it was moved to ${backupPath}.`)
    this.name = 'CorruptDataError'
  }
}

// The file was left in place untouched, and this store refuses to overwrite it.
export class UnsupportedVersionError extends Error {
  readonly code = 'unsupported-version'

  constructor(
    readonly filePath: string,
    readonly foundVersion: number,
    readonly supportedVersion: number
  ) {
    super(
      foundVersion > supportedVersion
        ? `${filePath} was written by a newer SPADE (format ${foundVersion}; this version supports ${supportedVersion}). It was left untouched.`
        : `${filePath} uses format ${foundVersion}, which this SPADE cannot migrate to ${supportedVersion}. It was left untouched.`
    )
    this.name = 'UnsupportedVersionError'
  }
}

export type AssetRejectionReason = 'unsupported-type' | 'empty' | 'too-large'

export class AssetRejectedError extends Error {
  readonly code = 'asset-rejected'

  constructor(
    readonly reason: AssetRejectionReason,
    message: string
  ) {
    super(message)
    this.name = 'AssetRejectedError'
  }
}
