import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackPauseFocusManager } from "../../web/src/features/media/player/PlaybackPauseFocusManager.js";

interface HarnessState {
	trackId: string | null;
	isPlaying: boolean;
	pauseCalls: number;
	resumeCalls: number;
}

function createHarness(initial: Pick<HarnessState, "trackId" | "isPlaying">) {
	const state: HarnessState = {
		...initial,
		pauseCalls: 0,
		resumeCalls: 0,
	};
	const manager = new PlaybackPauseFocusManager({
		getActiveTrackId: () => state.trackId,
		isPlaying: () => state.isPlaying,
		pause: () => {
			state.pauseCalls += 1;
			state.isPlaying = false;
		},
		resume: () => {
			state.resumeCalls += 1;
			state.isPlaying = true;
		},
	});
	return { state, manager };
}

test("playback focus pauses playing media and resumes it after the final release", () => {
	const { state, manager } = createHarness({ trackId: "podcast-1", isPlaying: true });
	const releaseFirst = manager.acquirePause();
	const releaseSecond = manager.acquirePause();

	assert.equal(state.pauseCalls, 1);
	assert.equal(state.isPlaying, false);
	releaseFirst();
	assert.equal(state.resumeCalls, 0);
	releaseSecond();
	assert.equal(state.resumeCalls, 1);
	assert.equal(state.isPlaying, true);
	releaseSecond();
	assert.equal(state.resumeCalls, 1);
});

test("playback focus leaves media that was already paused untouched", () => {
	const { state, manager } = createHarness({ trackId: "podcast-1", isPlaying: false });
	manager.acquirePause()();
	assert.equal(state.pauseCalls, 0);
	assert.equal(state.resumeCalls, 0);
});

test("user playback intent during dictation prevents automatic resume", () => {
	const { state, manager } = createHarness({ trackId: "podcast-1", isPlaying: true });
	const release = manager.acquirePause();
	manager.noteUserPlaybackIntent();
	release();
	assert.equal(state.pauseCalls, 1);
	assert.equal(state.resumeCalls, 0);
});

test("changing the active track during dictation prevents automatic resume", () => {
	const { state, manager } = createHarness({ trackId: "podcast-1", isPlaying: true });
	const release = manager.acquirePause();
	state.trackId = "podcast-2";
	release();
	assert.equal(state.resumeCalls, 0);
});

test("a focus pause failure is fail-open and never schedules a resume", () => {
	let resumeCalls = 0;
	const manager = new PlaybackPauseFocusManager({
		getActiveTrackId: () => "podcast-1",
		isPlaying: () => true,
		pause: () => {
			throw new Error("player unavailable");
		},
		resume: () => {
			resumeCalls += 1;
		},
	});
	assert.doesNotThrow(() => manager.acquirePause()());
	assert.equal(resumeCalls, 0);
});
