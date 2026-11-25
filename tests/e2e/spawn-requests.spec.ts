import { expect, test } from '@playwright/test'
import { SpawnRequests, type SpawnEntry } from '../../src/renderer/src/canvas/spawn/spawnRequests'
import type { CanvasCommandResponse } from '../../src/shared/commands'

type Deferred = { promise: Promise<CanvasCommandResponse>; finish(response: CanvasCommandResponse): void }

function deferred(): Deferred {
  let finish!: (response: CanvasCommandResponse) => void
  const promise = new Promise<CanvasCommandResponse>((resolve) => (finish = resolve))
  return { promise, finish }
}

function harness() {
  const shown: Array<SpawnEntry<string> | null> = []
  const focused: string[] = []
  const requests = new SpawnRequests<string>({ show: (entry) => shown.push(entry), focusCreated: (nodeId) => focused.push(nodeId) })
  const outcome = (entry: SpawnEntry<string>): Promise<string | null | 'pending'> =>
    Promise.race([entry.result, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10))])
  return { requests, shown, focused, outcome }
}

test.describe('spawn requests', () => {
  test('close the dialog, focus the created node, and answer the request that created it', async () => {
    const { requests, shown, focused, outcome } = harness()
    const entry = requests.open('note')
    expect(shown).toEqual([entry])
    await requests.create(entry, async () => ({ ok: true, nodeId: 'n1' }))
    expect(shown.at(-1)).toBeNull()
    expect(focused).toEqual(['n1'])
    expect(await outcome(entry)).toBe('n1')
  })

  test('answer null when the user cancels before creating, or when a newer request replaces the dialog', async () => {
    const { requests, outcome } = harness()
    const cancelled = requests.open('first')
    requests.dismiss(cancelled)
    expect(await outcome(cancelled)).toBeNull()
    const replaced = requests.open('second')
    requests.open('third')
    expect(await outcome(replaced)).toBeNull()
  })

  test('keep a failed creation open for another try', async () => {
    const { requests, shown, focused, outcome } = harness()
    const entry = requests.open('note')
    await requests.create(entry, async () => ({ ok: false, error: { code: 'internal', message: 'No' } }))
    expect(shown.at(-1)).toBe(entry)
    expect(focused).toEqual([])
    expect(await outcome(entry)).toBe('pending')
  })

  test('let a creation closed mid-way finish without touching a later dialog, its request, or the view', async () => {
    const { requests, shown, focused, outcome } = harness()
    const slow = requests.open('agent')
    const pending = deferred()
    const created = requests.create(slow, () => pending.promise)
    requests.dismiss(slow)
    expect(shown.at(-1)).toBeNull()
    // Still being created: the request has no answer yet.
    expect(await outcome(slow)).toBe('pending')

    const later = requests.open('note')
    pending.finish({ ok: true, nodeId: 'slow-node' })
    await created
    expect(shown.at(-1)).toBe(later)
    expect(requests.current).toBe(later)
    expect(focused).toEqual([])
    expect(await outcome(slow)).toBe('slow-node')
    expect(await outcome(later)).toBe('pending')

    await requests.create(later, async () => ({ ok: true, nodeId: 'later-node' }))
    expect(focused).toEqual(['later-node'])
    expect(await outcome(later)).toBe('later-node')
  })

  test('answer null for a creation closed mid-way that then fails', async () => {
    const { requests, outcome } = harness()
    const entry = requests.open('agent')
    const pending = deferred()
    const created = requests.create(entry, () => pending.promise)
    requests.open('note')
    pending.finish({ ok: false, error: { code: 'entity-create-failed', message: 'No' } })
    await created
    expect(await outcome(entry)).toBeNull()
  })
})
