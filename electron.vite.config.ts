import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // `cli` is the agent CLI that launcher shims run in Node mode; it must stay free of Electron imports.
        input: { index: resolve('src/main/index.ts'), cli: resolve('src/cli/main.ts') }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // Sandboxed preloads run as plain CommonJS scripts; Electron cannot load them as ES modules.
    build: { rollupOptions: { output: { format: 'cjs' } } },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
