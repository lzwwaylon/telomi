import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog'
import { MarkdownView } from '@/shared/markdown/MarkdownView'
import { uiText } from '@/app/ui-text'

interface BaseOverlayProps {
  isOpen?: boolean
  onClose?: () => void
  content?: string
}

export function ResponseFullscreenOverlay({
  content,
  isOpen,
  onClose,
}: BaseOverlayProps) {
  const markdown = typeof content === 'string' ? content : ''

  return (
    <Dialog open={Boolean(isOpen)} onOpenChange={(value) => { if (!value) onClose?.() }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="bg-[color-mix(in_oklch,var(--foreground)_34%,transparent)] backdrop-blur-sm"
        className="flex h-[92vh] w-[min(980px,92vw)] max-w-none sm:max-w-none flex-col gap-0 p-0 overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--background)] shadow-[0_20px_60px_-18px_color-mix(in_oklch,var(--foreground)_34%,transparent)]"
      >
        <DialogTitle className="sr-only">{uiText("app.responsefullscreenoverlay.responseFullscreenPreview")}</DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--card)_92%,var(--background)_8%)] px-4 py-2.5">
          <div className="min-w-0 text-[0.86rem] font-semibold text-[var(--foreground)]">
				{uiText("app.responsefullscreenoverlay.response")}
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-transparent bg-transparent text-[var(--foreground-50)] transition-[background,color,border-color] duration-[120ms] hover:border-[var(--border)] hover:bg-[var(--foreground-3)] hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-[color-mix(in_oklch,var(--accent)_55%,transparent)] focus-visible:outline-offset-1"
            onClick={onClose}
				aria-label={uiText("app.responsefullscreenoverlay.closeFullscreenPreview")}
          >
            x
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-[clamp(1rem,0.65rem+1.5vw,2rem)] py-4">
          <MarkdownView
            mode="document"
            text={markdown}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
