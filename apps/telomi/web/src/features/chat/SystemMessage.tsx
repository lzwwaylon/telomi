import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { cn } from "@/shared/lib/utils";

export type SystemMessageType = "error" | "warning" | "info" | "system";

const typeClasses: Record<SystemMessageType, string> = {
	error:
		"text-[color-mix(in_oklch,var(--destructive)_65%,var(--foreground))] " +
		"bg-[color-mix(in_oklch,var(--background)_96%,var(--destructive)_4%)] " +
		"shadow-[0_1px_0_color-mix(in_oklch,var(--destructive)_22%,transparent),0_4px_14px_-8px_color-mix(in_oklch,var(--destructive)_30%,transparent)]",
	warning:
		"text-[color-mix(in_oklch,var(--info)_55%,var(--foreground))] " +
		"bg-[color-mix(in_oklch,var(--background)_96%,var(--info)_4%)] " +
		"shadow-[0_1px_0_color-mix(in_oklch,var(--info)_22%,transparent),0_4px_14px_-8px_color-mix(in_oklch,var(--info)_30%,transparent)]",
	info:
		"text-[var(--foreground-50)] " +
		"bg-[color-mix(in_oklch,var(--background)_94%,var(--border)_6%)] " +
		"border border-[color-mix(in_oklch,var(--border)_70%,transparent)]",
	system:
		"text-[var(--foreground-50)] " +
		"bg-[color-mix(in_oklch,var(--background)_94%,var(--border)_6%)] " +
		"border border-[color-mix(in_oklch,var(--border)_70%,transparent)]",
};

export function SystemMessage({
	type,
	content,
	markdown = true,
	className,
}: {
	type: SystemMessageType;
	content: string;
	markdown?: boolean;
	className?: string;
}) {
	if (!content) return null;
	return (
		<div className={cn("px-4 py-2", className)}>
			<div
				className={cn(
					"block rounded-lg px-[0.85rem] py-2 text-[0.85rem] leading-[1.45] break-words [overflow-wrap:anywhere]",
					typeClasses[type],
				)}
			>
				{markdown ? <MarkdownView text={content} /> : <span>{content}</span>}
			</div>
		</div>
	);
}
