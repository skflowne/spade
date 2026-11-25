// Mermaid's published declarations import `type-fest`, which is not installed, so type-checking them
// fails without skipLibCheck. Rich content imports Mermaid's ESM entry (the same file the package's
// main export points to) by its path, which has no declarations, and describes the API it uses here.
declare module 'mermaid/dist/mermaid.core.mjs' {
  export type MermaidConfig = {
    startOnLoad?: boolean
    securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox'
    theme?: 'base' | 'default' | 'dark' | 'forest' | 'neutral'
    fontFamily?: string
    themeVariables?: Record<string, unknown>
  }

  export type Mermaid = {
    initialize(config: MermaidConfig): void
    parse(text: string): Promise<unknown>
    render(id: string, text: string): Promise<{ svg: string }>
  }

  const mermaid: Mermaid
  export default mermaid
}
