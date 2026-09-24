import { CloseIcon as X } from "@/shared/ui/icons";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { uiText } from "@/app/ui-text";

export interface EvidenceImagePreview {
	src: string;
	alt: string;
}

export function EvidenceImageLightbox({
	image,
	onClose,
	testId = "evidence-image-dialog",
}: {
	image: EvidenceImagePreview | null;
	onClose: () => void;
	testId?: string;
}) {
	return (
		<Dialog open={image !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
			{image ? (
				<DialogContent
					showCloseButton={false}
					data-testid={testId}
					onEscapeKeyDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}}
					className="!w-auto !max-w-[calc(100vw-32px)] gap-0 overflow-hidden border-[var(--line-soft)] bg-[var(--paper)] p-0 shadow-2xl sm:!max-w-[calc(100vw-32px)]"
				>
					<DialogTitle className="sr-only">{image.alt}</DialogTitle>
					<DialogDescription className="sr-only">{uiText("markdown.evidenceimagelightbox.evidenceImagePreview")}</DialogDescription>
					<div className="relative grid max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] place-items-center overflow-auto bg-[var(--paper)]">
						<img src={image.src} alt={image.alt} className="block h-auto max-h-[calc(100vh-96px)] w-auto max-w-[calc(100vw-48px)] object-contain" />
						<DialogClose
							aria-label={uiText("markdown.evidenceimagelightbox.closeImagePreview")}
							className="absolute right-3 top-3 grid size-8 place-items-center rounded-full bg-[color-mix(in_oklch,var(--ink)_78%,transparent)] text-[var(--paper)] shadow-md transition-colors hover:bg-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
						>
							<X className="size-4" aria-hidden />
						</DialogClose>
					</div>
				</DialogContent>
			) : null}
		</Dialog>
	);
}
