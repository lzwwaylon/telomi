import { DocumentIcon as FileText } from "@/shared/ui/icons";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { OverlayShell } from "@/app/overlays/OverlayShell";
import { uiText } from "@/app/ui-text";

export interface MarkdownOverlayProps {
	open: boolean;
	onClose: () => void;
	title: string;
	subtitle?: string;
	content: string;
	error?: string;
}

export function MarkdownOverlay({ open, onClose, title, subtitle, content, error }: MarkdownOverlayProps) {
	return (
		<OverlayShell
			open={open}
			onClose={onClose}
			badge={{ icon: FileText, label: "Markdown", variant: "blue" }}
			title={title}
			subtitle={subtitle}
			error={error ? { label: uiText("common.error.b859c7b"), message: error } : undefined}
		>
			<div className="max-w-[1000px] mx-auto">
				{content ? (
					<MarkdownView text={content} />
				) : (
					<div className="text-[var(--foreground-50)] text-[13px] italic">{uiText("app.markdownoverlay.empty")}</div>
				)}
			</div>
		</OverlayShell>
	);
}
