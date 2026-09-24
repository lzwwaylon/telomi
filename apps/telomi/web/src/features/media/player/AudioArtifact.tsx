import { DownloadIcon as Download, PauseIcon as Pause, PlayIcon as Play } from "@/shared/ui/icons";
import { useTranslation } from "react-i18next";
import { usePlaybackStatus } from "@/features/media/player/PlayerContext";

export function AudioArtifact({ url, filename }: { url: string; filename: string }) {
	const { t } = useTranslation();
	const player = usePlaybackStatus();
	const id = `audio:${url}`;
	const active = player.state.activeTrack?.id === id;
	return <div className="audio-artifact" data-testid="artifact-audio">
		<button type="button" className="player-pill" onClick={() => active ? player.toggle() : player.play({ id, url, title: filename })}>{active && player.state.isPlaying ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}{t(active && player.state.isPlaying ? "media.pause" : "media.play")}</button>
		<a href={url} download={filename}><Download size={15} aria-hidden />{t("common.download")}</a>
	</div>;
}
