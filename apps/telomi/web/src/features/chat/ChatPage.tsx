import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelRightOpen } from "lucide-react";
import { CompassIcon as Compass, ChatIcon as MessageSquare, CloseIcon as X } from "@/shared/ui/icons";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { GoalSnapshot, SendMessageRequest, SendMessageResult } from "@shared/types";
import type { TopicPlanProposal } from "@/features/goals/data/useTopicPlan";
import type { ConnectionState } from "@/features/goals/data/types";
import { MessageList } from "@/features/chat/MessageList";
import { ChatComposer } from "@/features/chat/ChatComposer";
import { ChatRightDock } from "@/features/chat/ChatRightDock";
import { resolveWorkspaceFileTarget } from "@/shared/markdown/markdown-link-target";
import { WorkspaceFileOverlay } from "@/features/chat/WorkspaceFileOverlay";
import { LinkClickContext } from "@/shared/markdown/MarkdownView";
import { useArtifacts } from "@/features/goals/data/useArtifacts";
import { useChatRightDockLayout } from "@/shared/lib/use-chat-right-dock";
import { useDiscoveryCandidate } from "@/features/goals/data/useDiscoveryInbox";
import { useTranslation } from "react-i18next";

export interface ChatPageProps {
	selectedGoalId: string | null;
	snapshot: GoalSnapshot | null;
	connection: ConnectionState;
	sendMessage: (body: SendMessageRequest) => Promise<SendMessageResult>;
	abort: () => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
	activeTopicId: string | null;
	topicProposal: TopicPlanProposal | null;
	onOpenTopicPlan: () => void;
}

/** Goal conversation with a file list and one shared file preview overlay. */
export function ChatPage({
	selectedGoalId,
	snapshot,
	connection,
	sendMessage,
	abort,
	setModel,
	setThinkingLevel,
	activeTopicId,
	topicProposal,
	onOpenTopicPlan,
}: ChatPageProps) {
	const { t } = useTranslation();
	const artifacts = useArtifacts(snapshot?.messages ?? []);
	const { width, collapsed, toggleCollapsed, setCollapsed, resizeBy } = useChatRightDockLayout();
	const [compact, setCompact] = useState(() =>
		typeof window !== "undefined"
			? window.matchMedia("(max-width: 760px)").matches
			: false,
	);
	const [compactDockOpen, setCompactDockOpen] = useState(false);
	const [discoveryContextDismissed, setDiscoveryContextDismissed] = useState(false);
	const discoveryCandidateId = discoveryContextDismissed ? null : discoveryIdFromHash(window.location.hash);
	const discoveryContext = useDiscoveryCandidate(selectedGoalId, discoveryCandidateId);
	const activeDiscovery = discoveryContext.candidate?.status === "open" ? discoveryContext.candidate : null;
	const rightCol = compact || collapsed ? "0" : `${width}px`;
	useEffect(() => setDiscoveryContextDismissed(false), [selectedGoalId]);
	const sendWithDiscoveryContext = useCallback((body: SendMessageRequest) => {
		if (discoveryCandidateId && discoveryContext.loading) return Promise.reject(new Error(t("chat.discoveryLoading")));
		if (discoveryCandidateId && discoveryContext.error) return Promise.reject(new Error(t("chat.discoveryError")));
		return sendMessage({
			...body,
			...(activeDiscovery || activeTopicId ? { context: {
				...(body.context ?? {}),
				...(activeDiscovery ? { discoveryCandidateId: activeDiscovery.id } : {}),
				...(activeTopicId ? { topicId: activeTopicId } : {}),
			} } : {}),
		});
	}, [activeDiscovery, activeTopicId, discoveryCandidateId, discoveryContext.error, discoveryContext.loading, sendMessage, t]);

	useEffect(() => {
		const query = window.matchMedia("(max-width: 760px)");
		const update = () => {
			setCompact(query.matches);
			if (!query.matches) setCompactDockOpen(false);
		};
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const [openFile, setOpenFile] = useState<{ goalId: string; path: string; line?: number; anchor?: string; displayPath?: string } | null>(null);
	useEffect(() => setOpenFile(null), [selectedGoalId]);
	// Callers that only know a path (citations, Markdown links) keep working: naming falls back to it.
	const selectFile = useCallback((path: string, line?: number, anchor?: string, displayPath?: string) => {
		if (selectedGoalId) setOpenFile({ goalId: selectedGoalId, path, line, anchor, displayPath });
	}, [selectedGoalId]);
	const onFileClick = useCallback((rawPath: string, line?: number) => {
		const target = resolveWorkspaceFileTarget(rawPath);
		if (target) selectFile(target.path, line ?? target.line, target.anchor);
	}, [selectFile]);

	const linkCtx = useMemo(
		() => ({ onFileClick, goalId: selectedGoalId }),
		[onFileClick, selectedGoalId],
	);
	return (
		<LinkClickContext.Provider value={linkCtx}>
			<section
				className="relative grid h-full min-h-0 w-full"
				style={{ gridTemplateColumns: `minmax(0,1fr) ${rightCol}` }}
				data-testid="chat-page"
			>
				{/* ── Left: messages + composer ───────────────────────────────── */}
				<div className="min-h-0 min-w-0 flex flex-col bg-[var(--background)] relative overflow-hidden">
					{(compact || collapsed) && !compactDockOpen && (
						<button
							type="button"
							onClick={() => {
								if (compact) setCompactDockOpen(true);
								else setCollapsed(false);
							}}
							aria-label={compact ? t("chat.openFiles") : t("chat.expandSidebar")}
							title={compact ? t("chat.openFiles") : t("chat.expandSidebar")}
							data-testid="chat-page-expand-right"
							className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-[var(--ink-mut)] backdrop-blur-sm hover:bg-[var(--paper-2)] hover:text-[var(--ink)] max-[760px]:h-[44px] max-[760px]:w-[44px]"
						>
							<PanelRightOpen className="h-4 w-4" aria-hidden />
						</button>
					)}
					<div className="flex-1 min-h-0 overflow-y-auto px-5 pt-10 pb-3">
						{!selectedGoalId ? (
							<div className="h-full flex flex-col items-center justify-center gap-2 text-[var(--ink-faint)]">
								<MessageSquare className="h-8 w-8" aria-hidden />
								<div className="text-[13px]">{t("chat.noGoal")}</div>
							</div>
						) : (
							<>
								<MessageList
									messages={snapshot?.messages ?? []}
									pendingToolCalls={snapshot?.pendingToolCalls ?? []}
									isStreaming={snapshot?.isStreaming ?? false}
									goalId={selectedGoalId}
									isLoading={!snapshot}
									emptyState={topicProposal ? <></> : undefined}
								/>
								{topicProposal ? <TopicPlanReadyNotice proposal={topicProposal} onOpen={onOpenTopicPlan} /> : null}
							</>
						)}
					</div>
					<div className="border-t border-[var(--line-soft)] bg-[var(--paper)] px-5 py-3">
						{activeDiscovery ? <div className="discovery-chat-context" data-testid="discovery-chat-context">
							<Compass size={14} aria-hidden />
							<span><small>{t("chat.discussingDiscovery")}</small><strong>{activeDiscovery.finding}</strong></span>
							<button type="button" aria-label={t("chat.removeDiscovery")} onClick={() => {
								setDiscoveryContextDismissed(true);
								window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
							}}><X size={14} /></button>
						</div> : null}
						{discoveryContext.error && discoveryCandidateId ? <div className="discovery-chat-context-error" role="alert">{t("chat.discoveryError")}</div> : null}
						<ChatComposer
							goalId={selectedGoalId}
							snapshot={snapshot}
							connection={connection}
							sendMessage={sendWithDiscoveryContext}
							abort={abort}
							setModel={setModel}
							setThinkingLevel={setThinkingLevel}
						/>
					</div>
				</div>

				{/* ── Right: drill-in dock ────────────────────────────────────── */}
				{!compact && !collapsed && (
					<ChatRightDock
						goalId={selectedGoalId}
						artifacts={artifacts}
						onOpenFile={selectFile}
						snapshot={snapshot}
						onCollapse={toggleCollapsed}
						onResize={resizeBy}
					/>
				)}
				{compact && compactDockOpen && (
					<div className="absolute inset-0 z-20 bg-[var(--paper)]">
						<ChatRightDock
							goalId={selectedGoalId}
							artifacts={artifacts}
							onOpenFile={selectFile}
							snapshot={snapshot}
							onCollapse={() => setCompactDockOpen(false)}
						/>
					</div>
				)}
			</section>
			{openFile && openFile.goalId === selectedGoalId && <WorkspaceFileOverlay
				goalId={openFile.goalId} path={openFile.path} line={openFile.line} anchor={openFile.anchor}
				displayPath={openFile.displayPath}
				onOpenFile={selectFile} onClose={() => setOpenFile(null)}
			/>}
		</LinkClickContext.Provider>
	);
}

function discoveryIdFromHash(hash: string): string | null {
	const prefix = "#discovery-";
	if (!hash.startsWith(prefix)) return null;
	try {
		return decodeURIComponent(hash.slice(prefix.length)) || null;
	} catch {
		return null;
	}
}

export function TopicPlanReadyNotice({ proposal, onOpen }: { proposal: TopicPlanProposal; onOpen: () => void }) {
	const { t } = useTranslation();
	return <section className="my-5 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--warm-line)] bg-[var(--warm-soft)] p-4" data-testid="chat-topic-plan-ready" aria-label={t("chat.topicPlanReady")}>
		<div className="min-w-0 flex-1">
			<p className="text-[14px] font-semibold text-[var(--ink)]">{t("chat.topicPlanReady")}</p>
			<p className="mt-1 text-[12px] leading-5 text-[var(--ink-mut)]">{t("chat.topicPlanReview", { count: proposal.candidate_plan.topics.length })}</p>
		</div>
		<button type="button" onClick={onOpen} className="min-h-10 rounded-[7px] border border-[var(--warm-line)] bg-[var(--paper)] px-3 text-[12px] font-semibold text-[var(--warm-deep)] hover:bg-[var(--paper-2)] focus-visible:outline-2 focus-visible:outline-[var(--warm)] focus-visible:outline-offset-2">{t("chat.openTopicPlan")}</button>
	</section>;
}
