export type WorkspaceErrorCode =
  | 'unknown-project'
  | 'invalid-argument'
  // Another project already has this root directory.
  | 'root-in-use'
  // The app index was written by a SPADE this version cannot safely overwrite.
  | 'records-read-only'

// Project and settings failures. Canvas commands fail with CanvasCommandError instead.
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}
