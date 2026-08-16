import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['node_modules', 'out', 'playwright-report', 'test-results', 'docs/style/vendor']
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['docs/style/code-highlight.js', 'docs/style/docs-tools.js'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly' }
    }
  }
)
