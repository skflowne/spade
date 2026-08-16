import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['node_modules', 'out', 'playwright-report', 'test-results']
  },
  eslint.configs.recommended,
  tseslint.configs.recommended
)
