import { apiClient } from "@/shared/lib/api-client";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { GoalWorkspace } from "@/features/goals/GoalWorkspace";
import { goalAvatarSignals } from "@/features/goals/avatar-signals";
import { TopBar } from "@/app/TopBar";
import { GoalRail } from "@/features/home/GoalRail";
import { GoalCreateDialog } from "@/features/home/GoalCreateDialog";
import { GoalDeleteDialog } from "@/features/goals/GoalDeleteDialog";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { GoalEditDialog, type GoalEditPatch } from "@/features/goals/GoalEditDialog";
import { HomePage } from "@/features/home/HomePage";
import { ChatPage } from "@/features/chat/ChatPage";
import { CommandPalette } from "@/app/CommandPalette";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { ArtifactsOverlay } from "@/features/goals/ArtifactsOverlay";
import { ArtifactReaderPage } from "@/features/goals/ArtifactReaderPage";
import { ArtifactsContext } from "@/features/goals/data/ArtifactsContext";
import { GoalContext } from "@/features/goals/data/GoalContext";
import { useGoalStream } from "@/features/goals/data/useGoalStream";
import { useTopicPlan } from "@/features/goals/data/useTopicPlan";
import { readActiveTopicId, readArtifactRoute, readInitialGoalId, readTopicPlanRevision, readWikiPagePath, useRoute, useUrlSync } from "@/shared/hooks/useRoute";
import { useRailPinned } from "@/shared/lib/use-rail-pinned";
import type { GoalListEvent, GoalSummary } from "@shared/types";
import type { BackendConnectionStatus } from "@/features/goals/data/types";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useGlobalActivityProjection } from "@/features/goals/data/useActivityProjection";
import { PlayerProvider } from "@/features/media/player/PlayerContext";
import { GlobalAudioElement } from "@/features/media/player/GlobalAudioElement";
import { GlobalPlayer } from "@/features/media/player/GlobalPlayer";
import { subscribeGoalsEvents } from "@/shared/lib/goalsEventsStream";
import { TopicInspector } from "@/features/goals/TopicInspector";
import { useTopicInspectorLayout } from "@/shared/lib/use-topic-inspector-layout";
import type { OutputLanguage } from "@shared/languages.js";
import { uiText } from "@/app/ui-text";

const MemoryPage = lazy(() => import("@/features/memory/MemoryPage").then((module) => ({ default: module.MemoryPage })));
const WikiExplorer = lazy(() => import("@/features/wiki/WikiExplorer").then((module) => ({ default: module.WikiExplorer })));

function goalPreviewFromMessages(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; content?: unknown } | undefined;
		if (!msg || (msg.role !== "assistant" && msg.role !== "user" && msg.role !== "user-with-attachments")) continue;
		if (typeof msg.content === "string") return msg.content.trim().slice(0, 120);
		if (Array.isArray(msg.content)) {
			const text = msg.content
				.filter((part): part is { type: string; text: string } =>
					!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join(" ")
				.trim();
			if (text) return text.slice(0, 120);
		}
	}
	return "";
}

type PlayerSourceRequest = { goalId: string; filename: string };

export function App() {
	const [playerSource, setPlayerSource] = useState<PlayerSourceRequest | null>(null);
	return (
		<PlayerProvider>
			<MainApp playerSource={playerSource} />
			<GlobalAudioElement />
			<GlobalPlayer onOpenSource={(goalId, filename) => setPlayerSource({ goalId, filename })} />
		</PlayerProvider>
	);
}

function MainApp({ playerSource }: { playerSource: PlayerSourceRequest | null }) {
	const [goals, setGoals] = useState<GoalSummary[] | null>(null);
	const [selected, setSelected] = useState<string | null>(() => readInitialGoalId());
	const [route, setRoute] = useRoute("home");
	const [activeTopicId, setActiveTopicId] = useState<string | null>(() => readActiveTopicId());
	const [topicRevision, setTopicRevision] = useState<string | null>(() => readTopicPlanRevision());
	const [wikiPagePath, setWikiPagePath] = useState<string | null>(() => readWikiPagePath());
	const [artifactFilename, setArtifactFilename] = useState<string | null>(() => readArtifactRoute()?.filename ?? null);
	const [overlayArtifact, setOverlayArtifact] = useState<{ goalId: string; filename: string } | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	// A reroll that failed left the avatar as it was; the app says so rather than the browser.
	const [avatarError, setAvatarError] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<GoalSummary | null>(null);
	const [pendingEdit, setPendingEdit] = useState<GoalSummary | null>(null);
	const [goalListConnection, setGoalListConnection] = useState<BackendConnectionStatus>("connecting");
	const [topicInspectorOpen, setTopicInspectorOpen] = useState(false);
	const topicInspectorLayout = useTopicInspectorLayout();

	useEffect(() => {
		let cancelled = false;
		void apiClient.get<{ goals: GoalSummary[] }>("/api/goals").then((payload) => {
			if (!cancelled) {
				setGoals(payload.goals);
				setGoalListConnection("connected");
			}
		}).catch(() => {
			if (!cancelled) setGoalListConnection("disconnected");
		});
		const unsubscribe = subscribeGoalsEvents((event) => {
			const payload = event as GoalListEvent;
			if (payload.type === "snapshot") {
				setGoals(payload.goals);
				setSelected((cur) => {
					if (cur && !payload.goals.some((goal) => goal.id === cur)) {
						setActiveTopicId(null);
						setTopicRevision(null);
						setArtifactFilename(null);
						setRoute("home");
						return null;
					}
					return cur;
				});
				return;
			}
			if (payload.type === "created") {
				setGoals((prev) => {
					const list = prev ?? [];
					if (list.some((g) => g.id === payload.goal.id)) return list;
					return [payload.goal, ...list];
				});
				return;
			}
			if (payload.type === "updated") {
				setGoals((prev) =>
					prev?.map((g) => (g.id === payload.goal.id ? payload.goal : g)) ?? prev,
				);
				return;
			}
			if (payload.type === "deleted") {
				setGoals((prev) => prev?.filter((g) => g.id !== payload.id) ?? prev);
				setSelected((cur) => {
					if (cur === payload.id) {
						setActiveTopicId(null);
						setTopicRevision(null);
						setArtifactFilename(null);
						setRoute("home");
						return null;
					}
					return cur;
				});
			}
		}, (connected) => setGoalListConnection(connected ? "connected" : "disconnected"));
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [setRoute]);

	const handleSelectGoal = useCallback(
		(id: string) => {
			setSelected(id);
			setActiveTopicId(null);
			setTopicRevision(null);
			setArtifactFilename(null);
			setRoute("goal");
		},
		[setRoute],
	);

	const handleOpenArtifact = useCallback(
		(goalId: string, name: string) => {
			setSelected(goalId);
			setActiveTopicId(null);
			setTopicRevision(null);
			setArtifactFilename(null);
			setRoute("goal");
			setOverlayArtifact({ goalId, filename: name });
		},
		[setRoute],
	);

	useEffect(() => {
		if (playerSource) handleOpenArtifact(playerSource.goalId, playerSource.filename);
	}, [playerSource, handleOpenArtifact]);

	useEffect(() => {
		if ((route === "goal" || route === "artifact" || route === "wiki" || route === "memory") && !selected) {
			setRoute("home");
		}
		if (route === "artifact" && !artifactFilename) {
			setRoute(selected ? "goal" : "home");
		}
	}, [artifactFilename, route, selected, setRoute]);

	const [paletteOpen, setPaletteOpen] = useState(false);
	const [railPinned] = useRailPinned();

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const k = e.key.toLowerCase();
			if ((e.metaKey || e.ctrlKey) && k === "k") {
				e.preventDefault();
				setPaletteOpen((v) => !v);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const stream = useGoalStream(selected);
	const topicPlan = useTopicPlan(selected);
	const selectedVersion = topicRevision
		? topicPlan.history.find((version) => version.revision === topicRevision)
		: topicPlan.history.find((version) => version.active);
	const viewingProposal = !topicRevision && Boolean(topicPlan.proposal);
	const viewedPlan = topicRevision
		? selectedVersion?.plan ?? null
		: topicPlan.proposal?.candidate_plan ?? topicPlan.active;
	const viewedRevision = viewedPlan?.revision ?? null;
	const activeRevision = topicPlan.active?.revision ?? null;
	const topics = viewedPlan?.topics ?? [];
	const selectedTopicId = topics.some((topic) => topic.id === activeTopicId)
		? activeTopicId
		: topics[0]?.id ?? null;
	const historicalRevision = !viewingProposal && viewedRevision && viewedRevision !== activeRevision ? viewedRevision : null;
	const agentTopicId = historicalRevision || viewingProposal || !topicPlan.active ? null : selectedTopicId;
	const setTopicInspector = useCallback((open: boolean) => {
		setTopicInspectorOpen(open);
		if (!open && window.location.hash === "#topic-plan-proposal") {
			window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
		}
	}, []);
	const discussTopicPlan = useCallback(() => {
		if (!selected) return;
		setTopicInspector(false);
		setRoute("chat");
		window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')?.focus(), 0);
	}, [selected, setRoute, setTopicInspector]);
	const selectTopicRevision = useCallback((revision: string) => {
		setTopicRevision(revision === activeRevision ? null : revision);
		setActiveTopicId(null);
	}, [activeRevision]);
	const globalActivityProjection = useGlobalActivityProjection();
	const backendConnection: BackendConnectionStatus =
		goalListConnection === "disconnected" || globalActivityProjection.connection === "disconnected"
			? "disconnected"
			: goalListConnection === "connected" && globalActivityProjection.connection === "connected"
				? "connected"
				: "connecting";

	const updateSelectedGoal = (patch: Partial<GoalSummary>) => {
		if (!selected) return;
		setGoals((prev) =>
			prev?.map((goal) => goal.id === selected ? { ...goal, ...patch } : goal) ?? prev,
		);
	};
	const updateDiscoveryEnabled = useCallback(async (enabled: boolean) => {
		if (!selected) return;
		const body = await apiClient.patch<{ goal?: GoalSummary }>(
			`/api/goals/${encodeURIComponent(selected)}/config`, { discoveryEnabled: enabled },
		);
		if (body.goal) setGoals((current) => current?.map((goal) => goal.id === body.goal!.id ? body.goal! : goal) ?? current);
	}, [selected]);

	const artifactsCtx = useMemo(
		() => ({
			openArtifact: (filename: string) => {
				if (selected) setOverlayArtifact({ goalId: selected, filename });
			},
			openArtifactPage: (filename: string) => {
				if (!selected) return;
				setOverlayArtifact(null);
				setArtifactFilename(filename);
				setRoute("artifact");
			},
		}),
		[selected, setRoute],
	);

	const goalCtx = useMemo(() => (selected ? { goalId: selected } : null), [selected]);

	useEffect(() => {
		setOverlayArtifact((cur) => (cur && cur.goalId === selected ? cur : null));
	}, [selected]);

	useEffect(() => {
		if (!stream.snapshot) return;
		updateSelectedGoal({
			title: stream.snapshot.title,
			description: stream.snapshot.description,
			messageCount: stream.snapshot.messages.length,
			preview: goalPreviewFromMessages(stream.snapshot.messages),
			isStreaming: stream.snapshot.isStreaming,
		});
	}, [stream.snapshot]);

	const selectedGoal = goals?.find((g) => g.id === selected) ?? null;
	const searchGoalId = route === "goal" || route === "chat" || route === "wiki" || route === "memory" || route === "artifact" ? selected : null;
	const selectedAvatarSignals = useMemo(
		() => (selected ? goalAvatarSignals(globalActivityProjection.summary?.activities ?? [], selected) : undefined),
		[globalActivityProjection.summary, selected],
	);

	useUrlSync(route, selected, artifactFilename, viewingProposal ? null : selectedTopicId, historicalRevision, wikiPagePath);

	const createGoal = useCallback(
		async (input: { title: string; description: string; outputLanguage: OutputLanguage }) => {
			const { goal } = await apiClient.post<{ goal: GoalSummary }>("/api/goals", input);
			setGoals((prev) => {
				const list = prev ?? [];
				if (list.some((g) => g.id === goal.id)) return list;
				return [goal, ...list];
			});
			setSelected(goal.id);
			setActiveTopicId(null);
			setTopicRevision(null);
			setArtifactFilename(null);
			setRoute("goal");
			return goal;
		},
		[setRoute],
	);

	const handleCreateGoal = useCallback(
		async (input: { title: string; description: string; outputLanguage: OutputLanguage }) => {
			await createGoal(input);
		},
		[createGoal],
	);

	const handleRequestEdit = useCallback((goal: GoalSummary) => {
		setPendingEdit(goal);
	}, []);

	const handleConfirmEdit = useCallback(
		async (goal: GoalSummary, patch: GoalEditPatch) => {
			await apiClient.patch(`/api/goals/${encodeURIComponent(goal.id)}/config`, {
				title: patch.title, description: patch.description, outputLanguage: patch.outputLanguage,
			});
			setPendingEdit(null);
		},
		[],
	);

	const handleRequestDelete = useCallback((goal: GoalSummary) => {
		setPendingDelete(goal);
	}, []);

	const handleRerollAvatar = useCallback(async (goal: GoalSummary) => {
		const body = await apiClient.post<{ goal?: GoalSummary; error?: string }>(
			`/api/goals/${encodeURIComponent(goal.id)}/avatar/reroll`,
		);
		if (!body.goal) throw new Error(body.error || "HTTP 200");
		setGoals((current) => current?.map((entry) => entry.id === body.goal!.id ? body.goal! : entry) ?? null);
	}, []);

	const handleConfirmDelete = useCallback(
		async (goal: GoalSummary) => {
			await apiClient.delete(`/api/goals/${encodeURIComponent(goal.id)}`);
			setGoals((prev) => prev?.filter((entry) => entry.id !== goal.id) ?? prev);
			if (selected === goal.id) {
				setSelected(null);
				setActiveTopicId(null);
				setTopicRevision(null);
				setArtifactFilename(null);
				setRoute("home");
			}
			setPendingDelete(null);
		},
		[selected, setRoute],
	);

	if (route === "settings") {
		return (
			<TooltipProvider>
				<SettingsPage onBack={() => setRoute("home")} />
			</TooltipProvider>
		);
	}

	// Artifact reader keeps the goal shell selected while the stage renders the
	// full-page reader.
	const topbarRoute = (route === "artifact" ? "goal" : route) as
		| "home"
		| "goal"
		| "chat"
		| "wiki"
		| "memory";
	const railRoute = (route === "artifact" || route === "wiki" || route === "memory" ? "goal" : route) as
		| "home"
		| "goal"
		| "chat";

	return (
		<TooltipProvider>
			<ArtifactsContext.Provider value={artifactsCtx}>
				<GoalContext.Provider value={goalCtx}>
					<div
						className="app-shell"
						data-rail-pinned={railPinned ? "true" : undefined}
						data-topic-inspector={topicInspectorOpen && viewedPlan ? "open" : undefined}
						style={{ "--topic-inspector-width": `${topicInspectorLayout.width}px` } as CSSProperties}
					>
						<TopBar
							route={topbarRoute}
							goals={goals ?? []}
							selectedGoal={selectedGoal}
							snapshot={stream.snapshot}
							activitySummary={globalActivityProjection.summary}
							backendConnection={backendConnection}
							topicPlan={viewedPlan ?? null}
							topicProposal={topicPlan.proposal}
							topicOpen={topicInspectorOpen}
							onTopicOpenChange={setTopicInspector}
							onGoHome={() => {
								setArtifactFilename(null);
								setRoute("home");
							}}
							onOpenPalette={() => setPaletteOpen(true)}
							onOpenSettings={(section) => {
								// The settings page reads `?section=` when it mounts; the route keeps the query.
								if (section) {
									const url = new URL(window.location.href);
									url.searchParams.set("section", section);
									window.history.replaceState(null, "", url);
								}
								setRoute("settings");
							}}
							onOpenWiki={() => selected && setRoute("wiki")}
							onOpenMemory={() => selected && setRoute("memory")}
							onSelectGoal={handleSelectGoal}
							onLeaveChat={() => setRoute(selected ? "goal" : "home")}
						/>
						<GoalRail
							goals={goals ?? []}
							route={railRoute}
							selected={selected}
							onGoHome={() => {
								setArtifactFilename(null);
								setRoute("home");
							}}
							onSelect={handleSelectGoal}
							onCreateGoal={() => setCreateOpen(true)}
							onRequestEdit={handleRequestEdit}
							onRequestDelete={handleRequestDelete}
							onRerollAvatar={(goal) => void handleRerollAvatar(goal).catch((error) => {
								setAvatarError(error instanceof Error ? error.message : String(error));
							})}
							activitySummary={globalActivityProjection.summary}
						/>
						<main className="app-stage">
							<div
								className={cn(
									route === "chat" ? "h-full overflow-hidden" : route === "artifact" && artifactFilename ? "h-full" : "min-h-full",
									"animate-[paper-drift_320ms_ease-out]",
								)}
								key={`route-${route}-${selected ?? "none"}`}
							>
								{route === "chat" ? (
									<ChatPage
									selectedGoalId={selected}
									snapshot={stream.snapshot}
									connection={stream.connection}
									sendMessage={stream.sendMessage}
									abort={stream.abort}
									setModel={stream.setModel}
									setThinkingLevel={stream.setThinkingLevel}
									activeTopicId={agentTopicId}
									topicProposal={topicPlan.proposal}
									onOpenTopicPlan={() => {
										setTopicRevision(null);
										setTopicInspector(true);
									}}
									/>
								) : route === "wiki" && selected ? (
									<Suspense fallback={<div className="grid min-h-[calc(100dvh-var(--topbar-h))] place-items-center text-sm text-muted-foreground">{uiText("app.app.loadingWiki")}</div>}>
										<WikiExplorer
											goalId={selected}
											topics={topics}
											activeTopicId={selectedTopicId}
											onActiveTopicChange={setActiveTopicId}
											revision={viewedRevision}
											initialPath={wikiPagePath}
											onSelectedPathChange={setWikiPagePath}
											onBack={() => setRoute("goal")}
										/>
									</Suspense>
								) : route === "memory" && selected ? (
									<Suspense fallback={<div className="grid min-h-[calc(100dvh-var(--topbar-h))] place-items-center text-sm text-muted-foreground">{uiText("memory.loading")}</div>}>
										<MemoryPage goalId={selected} goalTitle={selectedGoal?.title ?? ""} onBack={() => setRoute("goal")} />
									</Suspense>
								) : route === "home" || !selected ? (
									<HomePage
										goals={goals ?? []}
										activities={globalActivityProjection.summary?.activities ?? []}
										backendConnection={backendConnection}
										onSelectGoal={handleSelectGoal}
										onOpenArtifact={handleOpenArtifact}
									/>
								) : route === "artifact" && artifactFilename ? (
									<ArtifactReaderPage
										goalId={selected}
										filename={artifactFilename}
										onBack={() => {
											setArtifactFilename(null);
											setRoute("goal");
										}}
									/>
								) : (
									<GoalWorkspace
										goalId={selected}
										goal={selectedGoal}
										snapshot={stream.snapshot}
										onGoHome={() => setRoute("home")}
										onTalkOrigin={() => setRoute("chat")}
										avatarSignals={selectedAvatarSignals}
									/>
								)}
							</div>
						</main>
						{viewedPlan ? <TopicInspector
							open={topicInspectorOpen}
							plan={viewedPlan}
							proposal={topicPlan.proposal}
							activating={topicPlan.activating}
							error={topicPlan.error}
							versions={topicPlan.history}
							activeRevision={activeRevision}
							selectedTopicId={selectedTopicId}
							discoveryEnabled={selectedGoal?.discoveryEnabled ?? true}
							onSelectTopic={setActiveTopicId}
							onSelectRevision={selectTopicRevision}
							onConfirm={() => {
								if (topicPlan.proposal) void topicPlan.activate(topicPlan.proposal.proposal_id);
							}}
							onDiscuss={discussTopicPlan}
							onResize={topicInspectorLayout.resizeBy}
							onDiscoveryEnabledChange={updateDiscoveryEnabled}
							onClose={() => setTopicInspector(false)}
						/> : null}
					</div>
					<CommandPalette
						open={paletteOpen}
						onOpenChange={setPaletteOpen}
						selectedGoalId={searchGoalId}
						selectedGoalTitle={searchGoalId ? selectedGoal?.title : undefined}
						onOpenArtifact={handleOpenArtifact}
						onOpenChat={(goalId) => {
							setSelected(goalId);
							setActiveTopicId(null);
							setTopicRevision(null);
							setArtifactFilename(null);
							setRoute("chat");
						}}
					/>
					<GoalCreateDialog
						open={createOpen}
						onOpenChange={setCreateOpen}
						goalsCount={goals?.length ?? 0}
						onCreate={handleCreateGoal}
					/>
					<GoalEditDialog
						goal={pendingEdit}
						onCancel={() => setPendingEdit(null)}
						onConfirm={handleConfirmEdit}
					/>
					<ConfirmDialog
						open={avatarError !== null}
						title={uiText("app.app.avatarUpdateFailed")}
						description={avatarError ?? ""}
						confirmLabel={uiText("common.close")}
						acknowledge
						onCancel={() => setAvatarError(null)}
						onConfirm={() => setAvatarError(null)}
						testId="avatar-error-dialog"
					/>
					<GoalDeleteDialog
						goal={pendingDelete}
						onCancel={() => setPendingDelete(null)}
						onConfirm={handleConfirmDelete}
					/>
					{overlayArtifact && (
						<ArtifactsOverlay
							goalId={overlayArtifact.goalId}
							filename={overlayArtifact.filename}
							onFullscreen={() => artifactsCtx.openArtifactPage(overlayArtifact.filename)}
							onClose={() => setOverlayArtifact(null)}
							onSelect={(filename) =>
								setOverlayArtifact((cur) => (cur ? { ...cur, filename } : cur))
							}
						/>
					)}
				</GoalContext.Provider>
			</ArtifactsContext.Provider>
		</TooltipProvider>
	);
}
