import { formatClockDuration } from "@/shared/lib/format";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { HeadphonesIcon as Headphones, PauseIcon as Pause, PlayIcon as Play } from "@/shared/ui/icons";
import {
	useMediaProductStatus,
	type PodcastState,
} from "@/features/goals/data/useMediaProductStatus";
import { usePlaybackStatus, type PodcastTrack } from "@/features/media/player/PlayerContext";
import { useArtifactsContext } from "@/features/goals/data/ArtifactsContext";
import i18n from "@/app/i18n";
import { uiText } from "@/app/ui-text";
import { artifactKindLabel } from "@/shared/artifact-preview/artifact-type";
import { generatedCoverUrl } from "@/features/goals/cover";

export interface MediaCardCredit {
	goalId: string;
	goalTitle: string;
	contribution: string;
}

export interface MediaCardData {
	id: string;
	artifactName: string;
	title: string;
	lede: string;
	heroUrl: string;
	updatedLabel: string;
	/** Optional cross-goal authorship list rendered below the chips row.
	 * Used by the home digest card; absent for regular goal artifact cards. */
	credits?: MediaCardCredit[];
	/** When set, the card renders in a "nothing yet" state. Chips are hidden,
	 * the lede is replaced by this hint, and the cover is dimmed. */
	emptyHint?: string;
	/** Click handler for credit chips. Only used when `credits` is set. */
	onCreditClick?: (goalId: string) => void;
}

interface MediaCardProps {
	data: MediaCardData;
	goalId: string;
	/** Nested artifacts can be rendered as reports even when media-products cannot map them to a cardId. */
	disableMediaProducts?: boolean;
	/** Disable the markdown overlay (e.g. home digest has no artifact blob to load). */
	disableOverlay?: boolean;
}

const podcastLabel = () => i18n.t("media.podcast");
const PODCAST_ICON = <Headphones size={14} aria-hidden />;

function getPodcastSlug(state: PodcastState | undefined): string | null {
	const slug = state?.extra?.slug;
	return typeof slug === "string" && slug.length > 0 ? slug : null;
}

function buildTrack(
	data: MediaCardData,
	goalId: string,
	state: PodcastState,
): PodcastTrack | null {
	if (!state.mediaUrl) return null;
	return {
		id: `${goalId}:${data.id}:podcast-ai`,
		url: state.generatedAt ? `${state.mediaUrl}${state.mediaUrl.includes("?") ? "&" : "?"}generatedAt=${encodeURIComponent(state.generatedAt)}` : state.mediaUrl,
		title: data.title,
		artist: podcastLabel(),
		artworkUrl: data.heroUrl,
		description: data.lede,
		transcriptUrl: getPodcastSlug(state) ? `/api/goals/${encodeURIComponent(goalId)}/podcasts/${encodeURIComponent(getPodcastSlug(state)!)}/transcript-json` : undefined,
		durationSec: state.durationSec,
		goalId,
		artifactName: data.artifactName,
	};
}

export function MediaCard({
	data,
	goalId,
	disableMediaProducts = false,
	disableOverlay,
}: MediaCardProps) {
	const artifacts = useArtifactsContext();
	const [coverFailed, setCoverFailed] = useState(false);
	const coverSrc = coverFailed ? generatedCoverUrl(data.title) : data.heroUrl;

	const { state, triggerGenerate: serverTrigger } = useMediaProductStatus(
		goalId,
		disableMediaProducts ? "" : data.id,
	);

	const triggerGenerate = () => {
		if (!state.implemented || state.status === "running" || state.status === "done") return;
		void serverTrigger();
	};
	const regenerate = () => {
		if (state.implemented) void serverTrigger();
	};
	const isEmpty = Boolean(data.emptyHint);
	const overlayEnabled = !isEmpty && !disableOverlay;

	const cardClassName = isEmpty ? "media-card is-empty" : "media-card";
	const bodyOnClick = overlayEnabled ? () => artifacts?.openArtifact(data.artifactName) : undefined;
	const bodyRole = overlayEnabled ? "button" : undefined;

	return (
		<>
			<article className={cardClassName} data-testid={`media-card-${data.id}`}>
				<button
					type="button"
					className="media-cover"
					onClick={() => overlayEnabled && artifacts?.openArtifact(data.artifactName)}
					aria-label={isEmpty ? "" : overlayEnabled ? i18n.t("media.expand") : i18n.t("media.play")}
					disabled={isEmpty}
				>
					<img src={coverSrc} alt="" aria-hidden="true" className="media-cover-blur" />
					<img
						src={coverSrc}
						alt=""
						className="media-cover-image"
						onError={() => setCoverFailed(true)}
					/>
				</button>
				<div
					className="media-body"
					onClick={bodyOnClick}
					role={bodyRole}
					tabIndex={overlayEnabled ? 0 : undefined}
					onKeyDown={(event) => {
						if (overlayEnabled && event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							artifacts?.openArtifact(data.artifactName);
						}
					}}
				>
					<div className="media-meta">
							<span>{artifactKindLabel(data.artifactName)}</span>
						<span>·</span>
						<span>{data.updatedLabel}</span>
					</div>
					<h3 className="media-title">{data.title}</h3>
					<p className="media-lede">{isEmpty ? data.emptyHint : data.lede}</p>

					{!isEmpty && (
						<div className="media-chips-row">
							{!disableMediaProducts && (
								<MediaChip
									state={state}
									data={data}
									goalId={goalId}
									onTrigger={triggerGenerate}
									onRedo={regenerate}
								/>
							)}
						</div>
					)}

					{data.credits && data.credits.length > 0 && (
						<MediaCredits credits={data.credits} onCreditClick={data.onCreditClick} />
					)}
				</div>
			</article>

		</>
	);
}

function MediaCredits({
	credits,
	onCreditClick,
}: {
	credits: MediaCardCredit[];
	onCreditClick?: (goalId: string) => void;
}) {
	return (
		<div className="media-credits" data-testid="media-credits">
			{credits.map((c, idx) => (
				<span key={c.goalId} className="media-credit-item">
					<span aria-hidden className="gd" />
					{onCreditClick ? (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onCreditClick(c.goalId);
							}}
							className="media-credit-link"
							data-testid={`media-credit-${c.goalId}`}
						>
							<b>{c.goalTitle}</b>
						</button>
					) : (
						<b>{c.goalTitle}</b>
					)}
					<span>{c.contribution}</span>
					{idx < credits.length - 1 && <span className="media-credit-sep">·</span>}
				</span>
			))}
		</div>
	);
}

interface MediaChipProps {
	state: PodcastState;
	data: MediaCardData;
	goalId: string;
	onTrigger: () => void;
	onRedo: () => void;
}

function MediaChip({ state, data, goalId, onTrigger, onRedo }: MediaChipProps) {
	if (state.loading) {
		return (
			<button type="button" className="media-chip" data-mode="podcast-ai" data-state="loading" disabled
				onClick={(e) => e.stopPropagation()} style={{ opacity: 0.45 }}>
				<span className="ico" aria-hidden>{PODCAST_ICON}</span>
				<span>{podcastLabel()}</span>
			</button>
		);
	}
	if (!state.implemented) {
		return (
			<button
				type="button"
				className="media-chip"
				data-mode="podcast-ai"
				data-state="idle"
				disabled
				title={i18n.t("media.unavailable", { label: podcastLabel() })}
				onClick={(e) => e.stopPropagation()}
				style={{ opacity: 0.45, cursor: "not-allowed" }}
			>
				<span className="ico" aria-hidden>{PODCAST_ICON}</span>
				<span>{i18n.t("media.unavailable", { label: podcastLabel() })}</span>
			</button>
		);
	}
	if (state.status === "idle" || state.status === "failed") {
		return (
			<button
				type="button"
				className="media-chip"
				data-mode="podcast-ai"
				data-state={state.status}
				onClick={(e) => {
					e.stopPropagation();
					onTrigger();
				}}
				title={state.status === "failed" ? i18n.t("media.failed", { error: state.error ?? i18n.t("media.unknown") }) : podcastLabel()}
			>
				<span className="ico" aria-hidden>{PODCAST_ICON}</span>
				<span>{state.status === "failed" ? `${podcastLabel()} · ${i18n.t("media.retry")}` : podcastLabel()}</span>
			</button>
		);
	}
	if (state.status === "running") {
		return (
			<div
				className="media-chip"
				data-mode="podcast-ai"
				data-state="generating"
				role="status"
				aria-label={`${podcastLabel()} ${i18n.t("media.generating")}${state.progress ? ` · ${state.progress}` : ""}`}
				title={state.progress || undefined}
			>
				<span className="ico" aria-hidden>{PODCAST_ICON}</span>
				<span>{state.progress ? `${podcastLabel()} · ${state.progress}` : `${i18n.t("media.generating")} ·····`}</span>
			</div>
		);
	}
	return (
		<MediaChipGenerated
			state={state}
			data={data}
			goalId={goalId}
			onRedo={onRedo}
		/>
	);
}

interface MediaChipGeneratedProps {
	state: PodcastState;
	data: MediaCardData;
	goalId: string;
	onRedo: () => void;
}

function MediaChipGenerated({
	state,
	data,
	goalId,
	onRedo,
}: MediaChipGeneratedProps) {
	const player = usePlaybackStatus();
	const trackId = `${goalId}:${data.id}:podcast-ai`;
	const isActiveTrack = player.state.activeTrack?.id === trackId && player.state.activeTrack.url === buildTrack(data, goalId, state)?.url;
	const isPlaying = isActiveTrack && player.state.isPlaying;

	const togglePlay = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!state.mediaUrl) return;
		if (isActiveTrack) {
			player.toggle();
			return;
		}
		const track = buildTrack(data, goalId, state);
		if (track) player.play(track);
	};

	return (
		<div
			className="media-chip"
			data-mode="podcast-ai"
			data-state="generated"
			data-playing={isPlaying ? "true" : undefined}
			onClick={(e) => e.stopPropagation()}
		>
			<button
				type="button"
				className="mini-play"
				aria-label={`${isPlaying ? i18n.t("media.pause") : i18n.t("media.play")} ${podcastLabel()}`}
				onClick={togglePlay}
				title={`${isPlaying ? i18n.t("media.pause") : i18n.t("media.play")} ${podcastLabel()}`}
			>
				{isPlaying ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
			</button>
			<button type="button" className="mini-title" onClick={togglePlay} aria-label={`${isPlaying ? i18n.t("media.pause") : i18n.t("media.play")} ${podcastLabel()}`}><Headphones size={14} aria-hidden />{podcastLabel()}</button>
			<span className="mini-time">{formatTime(state.durationSec)}</span>
			<button
				type="button"
				className="mini-redo"
				aria-label={uiText("goals.mediacard.regenerate")}
				onClick={(e) => {
					e.stopPropagation();
					onRedo();
				}}
				title={uiText("goals.mediacard.regenerate")}
			>
				<RotateCcw size={14} aria-hidden />
			</button>
		</div>
	);
}

function formatTime(sec: number | undefined): string {
	return formatClockDuration(sec, { fallback: "--:--" });
}
