import { type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { type LucideIcon } from "lucide-react";
import { CloseIcon as X } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";

export type OverlayBadgeVariant = "blue" | "amber" | "green" | "purple" | "gray" | "red";

export interface OverlayShellProps {
	open: boolean;
	onClose: () => void;
	badge: {
		icon: LucideIcon;
		label: string;
		variant?: OverlayBadgeVariant;
	};
	title?: string;
	subtitle?: string;
	error?: { label: string; message: string };
	headerActions?: ReactNode;
	children: ReactNode;
}

const BADGE_VARIANT_CLASSES: Record<OverlayBadgeVariant, string> = {
	blue: "bg-[var(--background)] text-[var(--foreground-70)] border-[var(--border)] shadow-minimal",
	amber: "bg-[var(--background)] text-[var(--foreground-70)] border-[var(--border)] shadow-minimal",
	green: "bg-[var(--background)] text-[var(--foreground-70)] border-[var(--border)] shadow-minimal",
	purple: "bg-[var(--background)] text-[var(--foreground-70)] border-[var(--border)] shadow-minimal",
	gray: "bg-[var(--background)] text-[var(--foreground-70)] border-[var(--border)] shadow-minimal",
	red: "bg-[var(--background)] text-[var(--foreground-70)] border-[var(--border)] shadow-minimal",
};

export function OverlayShell({
	open,
	onClose,
	badge,
	title,
	subtitle,
	error,
	headerActions,
	children,
}: OverlayShellProps) {
	const Icon = badge.icon;
	const variant = badge.variant ?? "gray";

	return (
		<Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				overlayClassName="bg-[color-mix(in_oklch,var(--foreground)_32%,transparent)] backdrop-blur-md"
				className="flex flex-col w-[min(1200px,92vw)] max-w-none sm:max-w-none h-[92vh] gap-0 p-0 bg-[var(--background)] border border-[var(--border)] rounded-[14px] shadow-[0_18px_50px_-12px_color-mix(in_oklch,var(--foreground)_28%,transparent),0_4px_14px_-4px_color-mix(in_oklch,var(--foreground)_18%,transparent)] overflow-hidden"
			>
				<DialogTitle className="sr-only">{title || badge.label}</DialogTitle>
				<header className="flex items-center justify-between gap-[0.75rem] px-[1.1rem] py-[0.85rem] border-b border-[var(--border)] bg-[var(--card)]">
					<div className="flex items-center gap-[0.6rem] min-w-0 flex-1">
						<span
							className={cn(
								"inline-flex items-center gap-[0.35rem] px-[0.55rem] py-[0.22rem] rounded-full text-[11.5px] font-semibold tracking-[0.01em] border whitespace-nowrap",
								BADGE_VARIANT_CLASSES[variant],
							)}
						>
							<Icon size={14} aria-hidden />
							<span>{badge.label}</span>
						</span>
						{title && (
							<span
								className="text-[13px] font-semibold text-[var(--foreground)] overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1"
								title={title}
							>
								{title}
							</span>
						)}
						{subtitle && (
							<span className="text-[11.5px] text-[var(--foreground-50)] whitespace-nowrap">
								{subtitle}
							</span>
						)}
					</div>
					<div className="flex items-center gap-[0.4rem]">
						{headerActions}
						<button
							type="button"
							className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg bg-transparent border border-transparent text-[var(--foreground-50)] cursor-pointer transition-[background,color,border-color] duration-[120ms] ease-[ease] hover:bg-[var(--foreground-3)] hover:text-[var(--foreground)] hover:border-[var(--border)]"
							onClick={onClose}
							aria-label={uiText("app.overlayshell.closeOverlay")}
						>
							<X size={16} />
						</button>
					</div>
				</header>
				{error && (
					<div className="mx-[1.1rem] mt-3 px-[0.85rem] py-[0.7rem] rounded-[10px] bg-[color-mix(in_oklch,var(--destructive)_12%,var(--card))] border border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))] text-[color-mix(in_oklch,var(--destructive)_70%,var(--foreground))] text-[12.5px]">
						<strong className="block mb-1">{error.label}</strong>
						<pre className="m-0 font-[ui-monospace,SFMono-Regular,monospace] text-[12px] whitespace-pre-wrap break-words">
							{error.message}
						</pre>
					</div>
				)}
				<div className="flex-1 min-h-0 overflow-auto p-[1.1rem]">{children}</div>
			</DialogContent>
		</Dialog>
	);
}
