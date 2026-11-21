import { CanvasCommandError, type CanvasCommandResponse } from '../../shared/commands'
import type { Failure } from '../../shared/ipc'

// Lower-case kebab codes are SPADE's own stable codes; anything else (Node's ENOENT, a bare Error) is internal.
const STABLE_CODE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export const INTERNAL_FAILURE_MESSAGE = 'SPADE hit an unexpected error; the details are in its log.'

// Never forwards a stack trace or an unknown error's message to the renderer.
export function toFailure(error: unknown): Failure {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && STABLE_CODE.test(code)) {
    return { ok: false, error: { code, message: (error as Error).message } }
  }
  return internalFailure(error)
}

export function toCommandFailure(error: unknown): Extract<CanvasCommandResponse, { ok: false }> {
  if (error instanceof CanvasCommandError) return { ok: false, error: { code: error.code, message: error.message } }
  return internalFailure(error)
}

function internalFailure(error: unknown): { ok: false; error: { code: 'internal'; message: string } } {
  console.error('A SPADE host request failed unexpectedly', error)
  return { ok: false, error: { code: 'internal', message: INTERNAL_FAILURE_MESSAGE } }
}
