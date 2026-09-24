import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { uiText } from "@/app/ui-text";

interface ThinkingBlockProps {
	/** Thinking text as the provider returned it (may be streaming and growing). */
	content: string;
	/** True while the model is still emitting thinking deltas. */
	isStreaming?: boolean;
	/** Initial collapsed state when not streaming. Defaults to true. */
	defaultCollapsed?: boolean;
}

/**
 * ThinkingBlock — collapsible container for the thinking text a provider returns.
 *
 * That text is not the model's raw reasoning in the providers Telomi uses: OpenAI Responses
 * returns a reasoning summary and keeps the reasoning encrypted, and Anthropic defaults to a
 * summarized display. Pi does not mark which kind a block is, so the label names it a summary.
 * Summaries are Markdown (often bold section titles), so they render as Markdown.
 *
 * Behavior:
 *  - While streaming: forced expanded so the user can watch tokens land.
 *  - On completion: snaps to the user-requested default (collapsed by default).
 *  - User toggles persist after completion (we only auto-set on the
 *    streaming → done transition).
 */
export function ThinkingBlock({
	content,
	isStreaming = false,
	defaultCollapsed = true,
}: ThinkingBlockProps) {
	// While streaming we force-expand. Once streaming ends we honor
	// `defaultCollapsed` exactly once, then leave control to the user.
	const [expanded, setExpanded] = useState<boolean>(
		isStreaming ? true : !defaultCollapsed,
	);
	const [wasStreaming, setWasStreaming] = useState<boolean>(isStreaming);

	useEffect(() => {
		if (wasStreaming && !isStreaming) {
			// streaming → done: snap to the requested default
			setExpanded(!defaultCollapsed);
		}
		if (!wasStreaming && isStreaming) {
			// (re)started streaming: re-open
			setExpanded(true);
		}
		setWasStreaming(isStreaming);
	}, [isStreaming, wasStreaming, defaultCollapsed]);

	const trimmed = content.trim();
	// Single-line plain preview: drop Markdown markers, then collapse all whitespace to a space.
	const preview = trimmed.replace(/^#{1,6}\s+/gmu, "").replace(/\*\*|__|`/gu, "").replace(/\s+/g, " ");
	const hasContent = trimmed.length > 0;

	return (
		<div className="my-[0.35rem] mb-2 rounded-[8px] border border-[var(--border)] bg-[color-mix(in_oklch,var(--background)_96%,var(--foreground)_4%)] text-[0.8rem] text-[var(--foreground-70)]">
			<button
				type="button"
				onClick={() => hasContent && setExpanded((v) => !v)}
				disabled={!hasContent}
				className={cn(
					"group flex w-full min-w-0 items-center gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-[0.8rem]",
					hasContent ? "cursor-pointer" : "cursor-default",
				)}
				aria-expanded={expanded}
				aria-label={expanded ? uiText("chat.thinkingblock.collapseThinking") : uiText("chat.thinkingblock.expandThinking")}
			>
				<motion.span
					initial={false}
					animate={{ rotate: expanded ? 90 : 0 }}
					transition={{ type: "spring", stiffness: 300, damping: 25 }}
					className="flex-none text-[var(--foreground-50)]"
				>
					<ChevronRight className="h-3 w-3" />
				</motion.span>
				<span className="flex-none italic text-[var(--foreground-50)]">
						{uiText("chat.thinkingblock.thinking")}
				</span>
				{isStreaming && (
					<motion.span
						animate={{ opacity: [0.4, 1, 0.4] }}
						transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
						className="flex-none text-[var(--foreground-50)]"
					>
						…
					</motion.span>
				)}
				{!expanded && hasContent && (
					<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap italic text-[var(--foreground-50)]">
						{preview}
					</span>
				)}
			</button>
			<AnimatePresence initial={false}>
				{expanded && hasContent && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{
							height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
							opacity: { duration: 0.15 },
						}}
						className="overflow-hidden"
					>
						<div className="px-2.5 pb-2.5 break-words [overflow-wrap:anywhere]">
							{/* Keep the summary quieter than the reply around it: muted ink, light emphasis, tight paragraphs. */}
							<MarkdownView
								mode="chat"
								text={trimmed}
								isStreaming={isStreaming}
								className="text-[0.8rem] italic leading-[1.55] text-[var(--foreground-60)] [&_strong]:font-medium [&_p]:my-1"
							/>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
