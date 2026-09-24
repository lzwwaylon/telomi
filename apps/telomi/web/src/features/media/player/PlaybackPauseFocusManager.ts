export interface PlaybackPauseFocusAdapter {
	getActiveTrackId: () => string | null;
	isPlaying: () => boolean;
	pause: () => void;
	resume: () => void;
}

interface PausedPlayback {
	trackId: string;
	intentVersion: number;
}

const NOOP_RELEASE = () => undefined;

/**
 * Coordinates temporary playback pauses without overriding a later user action.
 * Multiple consumers share one pause and playback resumes only after the final
 * lease releases.
 */
export class PlaybackPauseFocusManager {
	private leaseCount = 0;
	private intentVersion = 0;
	private pausedPlayback: PausedPlayback | null = null;

	constructor(private readonly adapter: PlaybackPauseFocusAdapter) {}

	noteUserPlaybackIntent(): void {
		this.intentVersion += 1;
	}

	acquirePause(): () => void {
		if (this.leaseCount > 0) {
			this.leaseCount += 1;
			return this.createRelease();
		}

		const trackId = this.adapter.getActiveTrackId();
		if (!trackId || !this.adapter.isPlaying()) return NOOP_RELEASE;

		try {
			this.adapter.pause();
		} catch (error) {
			console.debug(
				`[audio-focus] playback pause unavailable: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return NOOP_RELEASE;
		}

		this.pausedPlayback = { trackId, intentVersion: this.intentVersion };
		this.leaseCount = 1;
		return this.createRelease();
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.releasePause();
		};
	}

	private releasePause(): void {
		if (this.leaseCount === 0) return;
		this.leaseCount -= 1;
		if (this.leaseCount > 0) return;

		const paused = this.pausedPlayback;
		this.pausedPlayback = null;
		if (
			!paused ||
			paused.intentVersion !== this.intentVersion ||
			this.adapter.getActiveTrackId() !== paused.trackId
		) {
			return;
		}

		try {
			this.adapter.resume();
		} catch (error) {
			console.debug(
				`[audio-focus] playback resume unavailable: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
