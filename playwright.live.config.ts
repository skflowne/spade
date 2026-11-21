import { defineConfig } from '@playwright/test'

// Live acceptance against the real local Paseo daemon; spawns real (cheap) agents. Run with `npm run test:live`.
export default defineConfig({
  testDir: './tests/live',
  outputDir: './artifacts/live-results',
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list'
})
