import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const prototypeRoot = resolve('prototypes/paseo-issue-to-pr-bridge')

export default defineConfig({
  main: {
    build: {
      outDir: resolve(prototypeRoot, 'out/main'),
      rollupOptions: { input: { index: resolve(prototypeRoot, 'main/index.ts') } }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      outDir: resolve(prototypeRoot, 'out/preload'),
      rollupOptions: {
        input: { index: resolve(prototypeRoot, 'preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(prototypeRoot, 'renderer'),
    build: {
      outDir: resolve(prototypeRoot, 'out/renderer'),
      rollupOptions: { input: { index: resolve(prototypeRoot, 'renderer/index.html') } }
    },
    plugins: [react()]
  }
})
