import { expect, test } from '@playwright/test'
import {
  activateGuest,
  admitGuest,
  createGuestBudget,
  releaseGuest,
  type GuestBudget
} from '../../src/renderer/src/entities/webpage/guestBudget'
import { LocatorPersistence, type LocatorTimer } from '../../src/renderer/src/entities/webpage/locatorPersistence'
import { normalizeWebAddress, sameWebAddress } from '../../src/renderer/src/entities/webpage/webAddress'

test.describe('web page addresses', () => {
  test('accepts http and https URLs as written', () => {
    expect(normalizeWebAddress('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(normalizeWebAddress('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/')
    expect(normalizeWebAddress('  HTTPS://Example.com  ')).toBe('https://example.com/')
  })

  test('prefixes https to a bare host', () => {
    expect(normalizeWebAddress('example.com')).toBe('https://example.com/')
    expect(normalizeWebAddress('example.com/docs?q=1')).toBe('https://example.com/docs?q=1')
  })

  test('prefixes http to a bare local dev-server address', () => {
    expect(normalizeWebAddress('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeWebAddress('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app')
    expect(normalizeWebAddress('[::1]:4000')).toBe('http://[::1]:4000/')
  })

  test('refuses everything that is not an http or https page', () => {
    for (const input of [
      '',
      '   ',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:someone@example.com',
      'about:blank',
      'data:text/html,hi',
      'ftp://example.com/',
      'https://',
      'not a url'
    ]) {
      expect(normalizeWebAddress(input), input).toBeNull()
    }
  })

  test('compares addresses after normalization', () => {
    expect(sameWebAddress('https://example.com', 'https://example.com/')).toBe(true)
    expect(sameWebAddress('https://EXAMPLE.com/a', 'https://example.com/a')).toBe(true)
    expect(sameWebAddress('https://example.com/a', 'https://example.com/b')).toBe(false)
    expect(sameWebAddress('https://example.com/a#x', 'https://example.com/a#y')).toBe(false)
  })
})

test.describe('live guest budget', () => {
  function admitAll(budget: GuestBudget, ids: string[]): { budget: GuestBudget; evicted: string[] } {
    let current = budget
    const evicted: string[] = []
    for (const id of ids) {
      const result = admitGuest(current, id)
      current = result.budget
      evicted.push(...result.evicted)
    }
    return { budget: current, evicted }
  }

  test('admits guests up to the limit without evicting', () => {
    const { budget, evicted } = admitAll(createGuestBudget(3), ['a', 'b', 'c'])
    expect(budget.live).toEqual(['a', 'b', 'c'])
    expect(evicted).toEqual([])
  })

  test('evicts the least recently active guest beyond the limit', () => {
    const { budget, evicted } = admitAll(createGuestBudget(3), ['a', 'b', 'c', 'd'])
    expect(budget.live).toEqual(['b', 'c', 'd'])
    expect(evicted).toEqual(['a'])
  })

  test('re-admitting a live guest makes it the most recent instead of duplicating it', () => {
    const { budget, evicted } = admitAll(createGuestBudget(3), ['a', 'b', 'c', 'a', 'd'])
    expect(budget.live).toEqual(['c', 'a', 'd'])
    expect(evicted).toEqual(['b'])
  })

  test('activation admits the guest and protects it from eviction', () => {
    let budget = admitAll(createGuestBudget(2), ['a', 'b']).budget
    const activated = activateGuest(budget, 'a')
    budget = activated.budget
    expect(budget.activeId).toBe('a')
    expect(budget.live).toEqual(['b', 'a'])

    const first = admitGuest(budget, 'c')
    expect(first.evicted).toEqual(['b'])
    const second = admitGuest(first.budget, 'd')
    expect(second.evicted).toEqual(['c'])
    expect(second.budget.live).toEqual(['a', 'd'])
  })

  test('activating a guest that is not live admits it', () => {
    const budget = admitAll(createGuestBudget(2), ['a', 'b']).budget
    const { budget: next, evicted } = activateGuest(budget, 'c')
    expect(next.live).toEqual(['b', 'c'])
    expect(evicted).toEqual(['a'])
  })

  test('clearing the active guest leaves it live but no longer protected', () => {
    let budget = activateGuest(createGuestBudget(1), 'a').budget
    budget = activateGuest(budget, null).budget
    expect(budget.activeId).toBeNull()
    expect(budget.live).toEqual(['a'])
    const { evicted } = admitGuest(budget, 'b')
    expect(evicted).toEqual(['a'])
  })

  test('released guests free their slot and lose protection', () => {
    let budget = activateGuest(admitAll(createGuestBudget(2), ['a', 'b']).budget, 'a').budget
    budget = releaseGuest(budget, 'a')
    expect(budget.live).toEqual(['b'])
    expect(budget.activeId).toBeNull()
    const { evicted } = admitAll(budget, ['c'])
    expect(evicted).toEqual([])
  })

  test('the limit defaults to twelve live guests per canvas', () => {
    const ids = Array.from({ length: 13 }, (_, index) => `n${index}`)
    const { budget, evicted } = admitAll(createGuestBudget(), ids)
    expect(budget.live).toHaveLength(12)
    expect(evicted).toEqual(['n0'])
  })
})

test.describe('durable page locator', () => {
  class ManualTimer implements LocatorTimer {
    private queue: Array<{ callback: () => void; cancelled: boolean }> = []

    schedule(callback: () => void): () => void {
      const entry = { callback, cancelled: false }
      this.queue.push(entry)
      return () => {
        entry.cancelled = true
      }
    }

    get pending(): number {
      return this.queue.filter((entry) => !entry.cancelled).length
    }

    elapse(): void {
      const due = this.queue
      this.queue = []
      for (const entry of due) if (!entry.cancelled) entry.callback()
    }
  }

  function setup(saved = 'https://example.com/a'): { locator: LocatorPersistence; timer: ManualTimer; writes: string[] } {
    const timer = new ManualTimer()
    const writes: string[] = []
    const locator = new LocatorPersistence({ saved, delayMs: 500, timer, write: (url) => writes.push(url) })
    return { locator, timer, writes }
  }

  test('writes a navigation once it settles', () => {
    const { locator, timer, writes } = setup()
    locator.navigated('https://example.com/b')
    expect(writes).toEqual([])
    timer.elapse()
    expect(writes).toEqual(['https://example.com/b'])
  })

  test('writes only the end of a navigation chain', () => {
    const { locator, timer, writes } = setup()
    locator.navigated('https://example.com/redirect-1')
    locator.navigated('https://example.com/redirect-2')
    locator.navigated('https://example.com/final')
    expect(timer.pending).toBe(1)
    timer.elapse()
    expect(writes).toEqual(['https://example.com/final'])
  })

  test('never writes when the address is unchanged', () => {
    const { locator, timer, writes } = setup('https://example.com/a')
    locator.navigated('https://example.com/a')
    timer.elapse()
    locator.navigated('https://example.com/b')
    locator.navigated('https://example.com/a')
    timer.elapse()
    expect(writes).toEqual([])
  })

  test('does not write the same address twice', () => {
    const { locator, timer, writes } = setup()
    locator.navigated('https://example.com/b')
    timer.elapse()
    locator.navigated('https://example.com/b')
    timer.elapse()
    expect(writes).toEqual(['https://example.com/b'])
  })

  test('flushing writes a pending navigation immediately', () => {
    const { locator, timer, writes } = setup()
    locator.navigated('https://example.com/b')
    locator.flush()
    expect(writes).toEqual(['https://example.com/b'])
    timer.elapse()
    expect(writes).toEqual(['https://example.com/b'])
  })

  test('recognizes its own write echoed back by the record', () => {
    const { locator, timer } = setup()
    locator.navigated('https://example.com/b')
    timer.elapse()
    expect(locator.recordChanged('https://example.com/b')).toBe(false)
  })

  test('reports a record change from another writer and drops the pending write it supersedes', () => {
    const { locator, timer, writes } = setup()
    locator.navigated('https://example.com/b')
    expect(locator.recordChanged('https://example.com/elsewhere')).toBe(true)
    timer.elapse()
    expect(writes).toEqual([])
    locator.navigated('https://example.com/elsewhere')
    timer.elapse()
    expect(writes).toEqual([])
  })
})
