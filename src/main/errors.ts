// SPADE's services mark the failures a caller may act on with a stable lower-case kebab `code`
// (CanvasCommandError, AgentServiceError, FileServiceError, …). Node's ENOENT or a bare Error has none.
const STABLE_CODE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function stableErrorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && STABLE_CODE.test(code) ? code : null
}
