import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark'
})

export function MermaidDiagram({ source }: { source: string }): React.JSX.Element {
  const reactId = useId()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const renderId = `p2-mermaid-${reactId.replaceAll(':', '')}`

    void mermaid
      .render(renderId, source)
      .then(({ svg: rendered }) => {
        if (active) {
          setSvg(rendered)
          setError('')
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })

    return () => {
      active = false
    }
  }, [reactId, source])

  if (error) {
    return <pre className="prototype-error">{error}</pre>
  }

  return <div className="mermaid-output" dangerouslySetInnerHTML={{ __html: svg }} />
}
