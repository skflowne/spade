// Injected into the web page models so their delays can be driven by tests.
export type Timer = {
  // Returns a function that cancels the callback.
  schedule(callback: () => void, delayMs: number): () => void
}

export const realTimer: Timer = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  }
}
