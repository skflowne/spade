import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const prototypeRoot = resolve('prototypes/electron-browser-custom-answer')

export default defineConfig({
  main: {
    build: {
      outDir: resolve(prototypeRoot, 'out/main'),
      rollupOptions: {
        input: { index: resolve(prototypeRoot, 'main/index.ts') }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      outDir: resolve(prototypeRoot, 'out/preload'),
      rollupOptions: {
        input: { index: resolve(prototypeRoot, 'preload/index.ts') }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(prototypeRoot, 'renderer'),
    build: {
      outDir: resolve(prototypeRoot, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(prototypeRoot, 'renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
