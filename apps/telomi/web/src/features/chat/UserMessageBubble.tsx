// Modified for Telomi.
import { cn } from "@/shared/lib/utils";
import { FileTypeIcon, getFileTypeLabel, inferAttachmentType } from "@/features/chat/attachment-helpers";
import type { AttachmentPayload } from "@shared/types";
import { uiText } from "@/app/ui-text";

const USER_BUBBLE_CLASSES = [
	"max-w-[80%] leading-[1.55] break-words [overflow-wrap:anywhere] min-w-0 select-text",
	"px-5 py-3.5 text-sm",
	"rounded-[16px]",
	"bg-[var(--user-message-bubble)]",
	"text-[var(--foreground)]",
].join(" ");

// 用户消息按输入原样显示:Markdown 渲染会吃掉单换行、改写用户自己敲的标记,
// 纯文本加 pre-wrap 与输入框所见一致。Agent 回复仍然走 Markdown。
const USER_TEXT_CLASSES = "whitespace-pre-wrap";

const PARSE_STATUS_TEXT = {
	parsed: "chat.usermessagebubble.parsed",
	pending: "chat.usermessagebubble.parsePending",
	failed: "chat.usermessagebubble.parseFailed",
} as const;

export interface UserMessageBubbleProps {
	text: string;
	hasImages?: boolean;
	attachments?: AttachmentPayload[];
	isQueued?: boolean;
	onAttachmentClick?: (attachment: AttachmentPayload) => void;
	className?: string;
}

export function UserMessageBubble({
	text,
	hasImages = false,
	attachments = [],
	isQueued = false,
	onAttachmentClick,
	className,
}: UserMessageBubbleProps) {
	const hasAttachments = attachments.length > 0;
	const hasText = !!text;

	return (
		<div className={cn("flex flex-col items-end gap-3 w-full", className)}>
			{hasAttachments && (
				<div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
					{attachments.map((a) => {
						const type = inferAttachmentType(a.mimeType, a.fileName);
						const isImage = type === "image";
						const thumb = isImage ? a.content : a.preview;
						const hasThumb = !!thumb;
						const label = getFileTypeLabel(type, a.mimeType, a.fileName);
						const dataUri = hasThumb
							? `data:${isImage ? a.mimeType || "image/png" : "image/png"};base64,${thumb}`
							: undefined;
						const isClickable = !!onAttachmentClick;
						const handleClick = () => onAttachmentClick?.(a);

						if (isImage) {
							return (
								<div
									key={a.id}
									role={isClickable ? "button" : undefined}
									tabIndex={isClickable ? 0 : undefined}
									onClick={isClickable ? handleClick : undefined}
									onKeyDown={
										isClickable
											? (e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														handleClick();
													}
												}
											: undefined
									}
									className={cn(
										"shrink-0 h-14 w-14 rounded-[8px] overflow-hidden bg-[var(--background)] shadow-minimal transition-opacity",
										isClickable && "cursor-pointer hover:opacity-80",
									)}
									title={`${a.fileName} · ${a.mimeType}`}
								>
									{hasThumb ? (
										<img src={dataUri} alt={a.fileName} className="h-full w-full object-cover" />
									) : (
										<div className="h-full w-full flex items-center justify-center">
											<FileTypeIcon type={type} mimeType={a.mimeType} className="h-5 w-5" />
										</div>
									)}
								</div>
							);
						}

						return (
							<div
								key={a.id}
								role={isClickable ? "button" : undefined}
								tabIndex={isClickable ? 0 : undefined}
								onClick={isClickable ? handleClick : undefined}
								onKeyDown={
									isClickable
										? (e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													handleClick();
												}
											}
										: undefined
								}
								className={cn(
									"shrink-0 flex items-center gap-2.5 rounded-[8px] bg-[var(--user-message-bubble)] pl-1.5 pr-3 py-1.5 transition-opacity",
									isClickable && "cursor-pointer hover:opacity-80",
								)}
								title={`${a.fileName} · ${a.mimeType}`}
							>
								<div className="h-11 w-8 rounded-[6px] overflow-hidden bg-[var(--background)] shadow-minimal flex items-center justify-center shrink-0">
									{hasThumb ? (
										<img
											src={dataUri}
											alt={a.fileName}
											className="h-full w-full object-cover object-top"
										/>
									) : (
										<FileTypeIcon type={type} mimeType={a.mimeType} className="h-5 w-5" />
									)}
								</div>
								<div className="flex flex-col min-w-0 max-w-[120px]">
									<span
										className="text-xs font-medium line-clamp-2 break-all text-[var(--foreground)]"
										title={a.fileName}
									>
										{a.fileName}
									</span>
									<span className="text-[10px] text-[var(--foreground-50)]" title={a.parseError}>
										{label}
										{a.parseStatus && (
											<span className={cn(a.parseStatus === "failed" && "text-[var(--destructive)]")}>
												{" · "}
												{uiText(PARSE_STATUS_TEXT[a.parseStatus])}
											</span>
										)}
									</span>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{(hasText || (!hasAttachments && hasImages)) && (
				<div className={USER_BUBBLE_CLASSES}>
					{hasText && <div className={USER_TEXT_CLASSES}>{text}</div>}
					{!hasAttachments && hasImages && (
						<div
							className={cn(
								hasText && "mt-[0.4rem]",
								"text-[0.75rem] text-[var(--foreground-50)]",
							)}
						>
								{uiText("chat.usermessagebubble.includesImageContent")}
						</div>
					)}
				</div>
			)}

			{isQueued && (
				<span className="text-[10px] text-[var(--foreground-50)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2 py-0.5 rounded-full">
						{uiText("chat.usermessagebubble.queued")}
				</span>
			)}
		</div>
	);
}
