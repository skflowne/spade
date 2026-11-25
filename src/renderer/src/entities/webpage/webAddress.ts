// What a user may type as a web page address (plan §7.3): only http and https pages open in a guest.

// A scheme, as opposed to a host followed by a port (`localhost:3000`).
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i

// The canonical URL for an address, or null when it is not an http or https page. A bare host gets https,
// except a local dev server (localhost, loopback), which gets http.
export function normalizeWebAddress(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const candidate = SCHEME.test(trimmed) ? trimmed : `${LOCAL_HOST.test(trimmed) ? 'http' : 'https'}://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.hostname.length > 0 ? url.href : null
}

export function sameWebAddress(a: string, b: string): boolean {
  return (normalizeWebAddress(a) ?? a) === (normalizeWebAddress(b) ?? b)
}
