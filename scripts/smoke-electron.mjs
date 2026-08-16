import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const output = []

const child = spawn('xvfb-run', ['-a', electron, '.', '--no-sandbox'], {
  env: {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    GADE_SMOKE_TEST: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    output.push(chunk)
    process.stdout.write(chunk)
  })
}

const timeout = setTimeout(() => {
  child.kill('SIGTERM')
  console.error('GADE smoke check timed out')
}, 20_000)

child.on('error', (error) => {
  clearTimeout(timeout)
  console.error(error)
  process.exitCode = 1
})

child.on('exit', (code) => {
  clearTimeout(timeout)
  const combinedOutput = output.join('')
  if (code !== 0 || !combinedOutput.includes('GADE_SMOKE_OK')) {
    process.exitCode = code || 1
  }
})
