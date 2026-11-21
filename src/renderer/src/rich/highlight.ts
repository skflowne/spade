import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml
}

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language)
}

// Returns highlight.js markup for a known language, or null to render the code as plain text.
// The markup is safe to inject: highlight.js escapes all source text and only adds <span class>.
export function highlightCode(code: string, language: string | null): string | null {
  if (!language || !hljs.getLanguage(language)) return null
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
