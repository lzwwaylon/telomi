import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ActivityItem, ResponseContent, TodoItem } from "@/features/goals/data/types";
import { ThinkingPlaceholder, TurnCard } from "@/features/chat/TurnCard";
import { TurnCardActionsMenu } from "@/features/chat/TurnCardActionsMenu";
import { UserMessageBubble, type UserMessageBubbleProps } from "@/features/chat/UserMessageBubble";
import { Spinner } from "@/shared/ui/loading-indicator";
import { groupMessagesIntoTurns } from "@/features/chat/turn-adapter";
import { SystemMessage, type SystemMessageType } from "@/features/chat/SystemMessage";
import { OverlayProvider } from "@/app/overlays/dispatcher";
import { useOverlay } from "@/app/overlays/OverlayContext";
import type { DiffChange } from "@/app/overlays/DiffOverlay";
import type { AttachmentPayload } from "@shared/types";
import { researchDeliveryFromReport } from "@/features/chat/research-delivery";
import type { PublishedReport } from "@/features/chat/turn-utils";
import { MediaCard } from "@/features/goals/MediaCard";
import { reportCoverUrl } from "@/features/goals/cover";
import { useGoalArtifactFiles } from "@/features/goals/data/useGoalArtifactFiles";
import { uiText } from "@/app/ui-text";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

const STREAM_LIST_CLASSES = "flex w-full flex-col gap-[0.75rem]";
const ROW_BASE = "flex w-full";
const ROW_USER = "justify-end";
const ROW_ASSISTANT_TURN = "flex-col max-w-full [&>*]:w-full";
const ROW_SYSTEM = "max-w-full";

export function MessageList({
	messages,
	pendingToolCalls,
	isStreaming,
	goalId,
	isLoading = false,
	emptyState,
}: {
	messages: AgentMessage[];
	pendingToolCalls: string[];
	isStreaming: boolean;
	goalId?: string | null;
	isLoading?: boolean;
	emptyState?: ReactNode;
}) {
	const toolResultMap = useMemo(() => {
		const m = new Map<string, ToolResult>();
		for (const msg of messages) {
			if (msg.role === "toolResult") m.set(msg.toolCallId, msg);
		}
		return m;
	}, [messages]);

	const pendingSet = useMemo(
		() => new Set(pendingToolCalls),
		[pendingToolCalls],
	);

	const lastAssistantIndex = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") return i;
		}
		return -1;
	}, [messages]);

	const lastUserTurnIndex = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const role = (messages[i] as { role: string }).role;
			if (role === "user" || role === "user-with-attachments") return i;
		}
		return -1;
	}, [messages]);

	const isWaitingForFirstAssistantToken =
		isStreaming && lastUserTurnIndex >= 0 && lastUserTurnIndex > lastAssistantIndex;

	// Server flips isStreaming=true the moment agent_start fires, but the next
	// assistant message hasn't been pushed yet. lastAssistantIndex still points
	// at the *previous* turn — passing it to turn-adapter would mark that old
	// turn as streaming, causing TurnCard to swap its rendered markdown for a
	// loading indicator for ~1s until the new assistant message arrives. Pass
	// -1 in that window so no existing turn gets mis-flagged.
	const effectiveLastAssistantIndex = isWaitingForFirstAssistantToken ? -1 : lastAssistantIndex;

	const turns = useMemo(
		() =>
			groupMessagesIntoTurns(messages, {
				toolResultMap,
				pendingToolCalls: pendingSet,
				isStreaming,
				lastAssistantIndex: effectiveLastAssistantIndex,
			}),
		[messages, toolResultMap, pendingSet, isStreaming, effectiveLastAssistantIndex],
	);

	const sessionKey = goalId ?? "no-goal";
	const contentKey = isLoading
		? `${sessionKey}-loading`
		: turns.length === 0
			? `${sessionKey}-empty`
			: `${sessionKey}-loaded`;

	const endRef = useRef<HTMLDivElement>(null);
	const scrollerRef = useRef<HTMLElement | null>(null);
	const stickyRef = useRef(true);
	const lastScrollTopRef = useRef(0);
	const lastUserTurnIndexRef = useRef(-1);

	useEffect(() => {
		stickyRef.current = true;
		lastUserTurnIndexRef.current = -1;
	}, [sessionKey]);

	useEffect(() => {
		const sentinel = endRef.current;
		if (!sentinel) return;
		let scroller: HTMLElement | null = sentinel.parentElement;
		while (scroller) {
			const oy = getComputedStyle(scroller).overflowY;
			if (oy === "auto" || oy === "scroll") break;
			scroller = scroller.parentElement;
		}
		if (!scroller) return;
		scrollerRef.current = scroller;
		lastScrollTopRef.current = scroller.scrollTop;
		const onScroll = () => {
			const scrollTop = scroller!.scrollTop;
			const delta = scroller!.scrollHeight - scroller!.scrollTop - scroller!.clientHeight;
			if (scrollTop < lastScrollTopRef.current) {
				stickyRef.current = false;
			} else if (scrollTop > lastScrollTopRef.current && delta < 60) {
				stickyRef.current = true;
			}
			lastScrollTopRef.current = scrollTop;
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroller!.removeEventListener("scroll", onScroll);
			if (scrollerRef.current === scroller) scrollerRef.current = null;
		};
	}, [sessionKey]);

	useEffect(() => {
		const sentinel = endRef.current;
		const content = sentinel?.parentElement;
		if (!sentinel || !content) return;
		const observer = new ResizeObserver(() => {
			if (turns.length === 0) return;
			if (!stickyRef.current) return;
			sentinel.scrollIntoView({ block: "end", behavior: "auto" });
			if (scrollerRef.current) lastScrollTopRef.current = scrollerRef.current.scrollTop;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [sessionKey, turns.length]);

	useEffect(() => {
		if (isLoading) return;
		if (turns.length === 0) {
			if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
			lastScrollTopRef.current = 0;
			return;
		}
		const sentinel = endRef.current;
		if (!sentinel) return;
		if (lastUserTurnIndex > lastUserTurnIndexRef.current) {
			stickyRef.current = true;
		}
		lastUserTurnIndexRef.current = lastUserTurnIndex;
		if (stickyRef.current) {
			sentinel.scrollIntoView({ block: "end", behavior: "auto" });
			if (scrollerRef.current) lastScrollTopRef.current = scrollerRef.current.scrollTop;
		}
	}, [messages, isLoading, sessionKey, lastUserTurnIndex, turns.length]);

	return (
		<OverlayProvider toolResultMap={toolResultMap}>
			<div key={sessionKey}>
				{isLoading ? (
					<div
						key={contentKey}
						className="flex items-center justify-center py-16 text-[var(--foreground-50)] text-2xl"
					>
						<Spinner />
					</div>
				) : turns.length === 0 && emptyState ? emptyState : turns.length === 0 ? (
					<div
						key={contentKey}
						className="px-4 pt-12 pb-0 text-center text-[0.95rem] text-[var(--foreground-50)]"
					>
							<p className="m-0">{uiText("chat.messagelist.noMessagesYet")}</p>
					</div>
				) : (
					<div key={contentKey} className={STREAM_LIST_CLASSES}>
						{turns.map((turn) => {
							if (turn.type === "user") {
								return (
									<div key={turn.turnId} className={`${ROW_BASE} ${ROW_USER}`}>
										<MemoizedUserMessageBubble
											text={turn.text}
											hasImages={turn.hasImages}
											attachments={turn.attachments}
										/>
									</div>
								);
							}
							if (turn.type === "system") {
								return (
									<div key={turn.turnId} className={`${ROW_BASE} ${ROW_SYSTEM}`}>
										<MemoizedSystemMessage type={turn.level} content={turn.content} />
									</div>
								);
							}
							return (
								<TurnRow
									key={turn.turnId}
									turnId={turn.turnId}
									activities={turn.activities}
									response={turn.response}
									intent={turn.intent}
									isStreaming={turn.isStreaming}
									isComplete={turn.isComplete}
									todos={turn.todos}
									report={turn.report}
									goalId={goalId}
								/>
							);
						})}
						{isWaitingForFirstAssistantToken && (
							<div className={`${ROW_BASE} ${ROW_ASSISTANT_TURN}`} data-testid="turn-placeholder">
								<ThinkingPlaceholder />
							</div>
						)}
					</div>
				)}
				<div ref={endRef} aria-hidden />
			</div>
		</OverlayProvider>
	);
}

function TurnRow({
	turnId,
	activities,
	response,
	intent,
	isStreaming,
	isComplete,
	todos,
	report: publishedReport,
	goalId,
}: {
	turnId: string;
	activities: ActivityItem[];
	response: ResponseContent | undefined;
	intent: string | undefined;
	isStreaming: boolean;
	isComplete: boolean;
	todos: TodoItem[] | undefined;
	report: PublishedReport | undefined;
	goalId?: string | null;
}) {
	const overlay = useOverlay();
	const report = useMemo(() => researchDeliveryFromReport(publishedReport), [publishedReport]);
	const { files: reportFiles } = useGoalArtifactFiles(report && goalId ? goalId : null);
	const visibleResponse = response;

	const editWriteChanges = useMemo<DiffChange[]>(() => {
		const out: DiffChange[] = [];
		for (const a of activities) {
			if (a.type !== "tool" || !a.toolName) continue;
			const name = a.toolName.toLowerCase();
			const input = (a.toolInput ?? {}) as Record<string, unknown>;
			const filePath =
				(typeof input.file_path === "string" && input.file_path) ||
				(typeof input.path === "string" && input.path) ||
				"";
			if (name === "edit") {
				out.push({
					id: a.id,
					filePath,
					original: typeof input.old_string === "string" ? input.old_string : "",
					modified: typeof input.new_string === "string" ? input.new_string : "",
				});
			} else if (name === "multi_edit" || name === "multiedit") {
				const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
				edits.forEach((edit, i) => {
					out.push({
						id: `${a.id}:${i}`,
						filePath,
						original: typeof edit.old_string === "string" ? edit.old_string : "",
						modified: typeof edit.new_string === "string" ? edit.new_string : "",
					});
				});
			} else if (name === "write") {
				out.push({
					id: a.id,
					filePath,
					original: "",
					modified: typeof input.content === "string" ? input.content : "",
				});
			}
		}
		return out;
	}, [activities]);

	const hasEditOrWriteActivities = editWriteChanges.length > 0;

	const handleOpenDetails = useCallback(() => {
		overlay?.openJson(
			uiText("chat.messagelist.turnDetails"),
			{ turnId, activities, response: visibleResponse, isStreaming, isComplete, todos },
			turnId,
		);
	}, [overlay, turnId, activities, visibleResponse, isStreaming, isComplete, todos]);

	const handleOpenMultiFileDiff = useCallback(() => {
		if (editWriteChanges.length === 0) return;
		const uniquePaths = Array.from(new Set(editWriteChanges.map((c) => c.filePath).filter(Boolean)));
		const headerPath =
			uniquePaths.length === 1
				? uniquePaths[0]
				: `${uniquePaths.length} files`;
		overlay?.openDiff(headerPath, editWriteChanges);
	}, [overlay, editWriteChanges]);

	return (
		<div className={`${ROW_BASE} ${ROW_ASSISTANT_TURN}`}>
			<TurnCard
				turnId={turnId}
				activities={activities}
				response={visibleResponse}
				intent={intent}
				isStreaming={isStreaming}
				isComplete={isComplete}
				todos={todos}
				onOpenActivityDetails={(activity) => overlay?.openActivity(activity)}
				renderActionsMenu={() => (
					<TurnCardActionsMenu
						onOpenDetails={handleOpenDetails}
						onOpenMultiFileDiff={hasEditOrWriteActivities ? handleOpenMultiFileDiff : undefined}
						hasEditOrWriteActivities={hasEditOrWriteActivities}
					/>
				)}
			/>
			{report && goalId ? (
				<div className="chat-report-card mt-2" data-testid="research-report-card">
					<MediaCard
						goalId={goalId}
						data={{
							id: report.cardId,
							artifactName: report.artifactName,
							title: report.title,
							lede: report.lede,
							heroUrl: reportCoverUrl(goalId, report.title, reportFiles.find((f) => f.name === report.artifactName)?.cover),
							updatedLabel: uiText("common.researchReport"),
						}}
					/>
				</div>
			) : null}
		</div>
	);
}

/**
 * 完成的 user 气泡在
 * snapshot 流式更新时不参与 reconcile。turn-adapter 每帧重算 turns,每条 snapshot 的
 * attachments 都是新解析出来的对象,所以比较器走"内容浅比":text 字符串相等、
 * isQueued / hasImages 标志位相等,附件逐项比较气泡真正渲染的字段。
 * 解析状态在轮次进行中才写回附件,漏掉任何一个渲染字段都会让气泡停在旧文案上。
 * 流式时这些字段都不变,user 气泡照常全部 bail。
 */
function userAttachmentsEqual(
	prev: AttachmentPayload[] | undefined,
	next: AttachmentPayload[] | undefined,
): boolean {
	if (prev === next) return true;
	const a = prev ?? [];
	const b = next ?? [];
	if (a.length !== b.length) return false;
	return a.every((attachment, index) => {
		const other = b[index];
		return (
			attachment.id === other.id &&
			attachment.fileName === other.fileName &&
			attachment.mimeType === other.mimeType &&
			attachment.content === other.content &&
			attachment.preview === other.preview &&
			attachment.parseStatus === other.parseStatus &&
			attachment.parseError === other.parseError
		);
	});
}

export function userBubblePropsEqual(
	prev: UserMessageBubbleProps,
	next: UserMessageBubbleProps,
): boolean {
	return (
		prev.text === next.text &&
		!!prev.hasImages === !!next.hasImages &&
		!!prev.isQueued === !!next.isQueued &&
		userAttachmentsEqual(prev.attachments, next.attachments) &&
		prev.onAttachmentClick === next.onAttachmentClick &&
		prev.className === next.className
	);
}

const MemoizedUserMessageBubble = memo(UserMessageBubble, userBubblePropsEqual);
MemoizedUserMessageBubble.displayName = "MemoizedUserMessageBubble";

const MemoizedSystemMessage = memo(
	SystemMessage,
	(prev: { type: SystemMessageType; content: string; markdown?: boolean; className?: string }, next) =>
		prev.type === next.type &&
		prev.content === next.content &&
		prev.markdown === next.markdown &&
		prev.className === next.className,
);
MemoizedSystemMessage.displayName = "MemoizedSystemMessage";
