import * as React from 'react'
import { cn } from '@/shared/lib/utils'
import { uiText } from '@/app/ui-text'

interface MarkdownLatexBlockProps {
  code: string
  className?: string
}

/**
 * MarkdownLatexBlock - Renders fenced ```latex / ```math code blocks as display math.
 *
 * Uses KaTeX to render LaTeX source into styled HTML.
 * On parse errors, shows the raw source with an error message.
 */
export function MarkdownLatexBlock({ code, className }: MarkdownLatexBlockProps) {
  const [html, setHtml] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void import('katex').then(({ default: katex }) => {
      let rendered: string | null = null
      try {
        rendered = katex.renderToString(code.trim(), {
          displayMode: true,
          throwOnError: false,
          strict: false,
        })
      } catch {
        rendered = null
      }
      if (!cancelled) {
        setHtml(rendered)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) {
        setHtml(null)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [code])

  if (loading) {
    return <div className={cn('py-2 text-sm text-muted-foreground', className)}>{uiText("markdown.markdownlatexblock.renderingFormula")}</div>
  }

  if (!html) {
    return (
      <pre className={cn('font-mono text-sm whitespace-pre-wrap text-destructive', className)}>
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className={cn('overflow-x-auto py-2', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
