import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState, playerReducer, restorePlayer, sameMediaSource, type PodcastTrack } from "../../web/src/features/media/player/state.js";
import { PlayerProvider } from "../../web/src/features/media/player/PlayerContext.js";
import { AudioArtifact } from "../../web/src/features/media/player/AudioArtifact.js";

const track: PodcastTrack = { id: "episode", url: "/audio/episode.mp3", title: "An episode", durationSec: 120 };

test("presentation changes preserve playback, position, speed and the selected track", () => {
	let state = playerReducer(initialState, { type: "load", track, playOnReady: true, resumePosition: 48 });
	state = playerReducer(state, { type: "setSpeed", speed: 1.75 });
	const expanded = playerReducer(state, { type: "setExpanded", expanded: true });
	assert.deepEqual({ ...expanded, expanded: false }, state);
	assert.deepEqual(playerReducer(expanded, { type: "setExpanded", expanded: false }), state);
	assert.equal(playerReducer(initialState, { type: "setExpanded", expanded: true }).expanded, false);
});

test("changing episodes resets source-specific state and clamps explicit positions", () => {
	let state = playerReducer(initialState, { type: "load", track, playOnReady: true, resumePosition: 48 });
	state = playerReducer(state, { type: "setBuffered", end: 110 });
	state = playerReducer(state, { type: "setSleep", until: Date.now() + 50000 });
	const next = playerReducer(state, { type: "load", track: { ...track, id: "next", durationSec: 20 }, playOnReady: false, resumePosition: 99 });
	assert.equal(next.position, 20);
	assert.equal(next.bufferedEnd, 0);
	assert.equal(next.isPlaying, false);
	assert.equal(next.sleepAt, null);
	const regenerated = playerReducer(state, { type: "load", track: { ...track, url: "/audio/episode.mp3?v=2" }, playOnReady: true });
	assert.equal(regenerated.position, 0);
	const explicit = playerReducer(state, { type: "load", track, playOnReady: true, resumePosition: 12 });
	assert.equal(explicit.position, 12);
});

test("failure, retry and completion are distinct from pause", () => {
	const playing = playerReducer(initialState, { type: "load", track, playOnReady: true });
	const failed = playerReducer(playing, { type: "error" });
	assert.equal(failed.error, true);
	assert.equal(failed.isPlaying, false);
	const retry = playerReducer(failed, { type: "retry" });
	assert.equal(retry.error, false);
	assert.equal(retry.isPlaying, true);
	assert.equal(retry.revision, 1);
	const ended = playerReducer(playing, { type: "ended" });
	assert.equal(ended.position, 120);
	assert.equal(ended.isPlaying, false);
	assert.equal(ended.ended, true);
	assert.equal(playerReducer(ended, { type: "setTime", position: 40 }).ended, false);
});

test("persisted state is validated and never restores autoplay or an open overlay", () => {
	assert.deepEqual(restorePlayer("broken").state, initialState);
	assert.deepEqual(restorePlayer("[]").state, initialState);
	const saved = restorePlayer(JSON.stringify({ state: { activeTrack: track, position: 48, speed: 1.5, volume: .6, muted: true, isPlaying: true, expanded: true } }));
	assert.equal(saved.state.position, 48);
	assert.equal(saved.state.speed, 1.5);
	assert.equal(saved.state.isPlaying, false);
	assert.equal(saved.state.expanded, false);
	const corrupt = restorePlayer(JSON.stringify({ state: { activeTrack: { ...track, url: "javascript:alert(1)" }, speed: "bad", volume: 12, position: -2 } }));
	assert.equal(corrupt.state.activeTrack, null);
	assert.equal(corrupt.state.speed, 1);
	assert.equal(corrupt.state.volume, 1);
	assert.equal(corrupt.state.position, 0);
	const restored = restorePlayer(JSON.stringify({ state: { ...initialState, activeTrack: track, ended: true, position: 120 }, history: { episode: { url: track.url, position: 120, ended: true } } }));
	assert.equal(restored.history.episode.ended, true);
	assert.equal(restored.state.ended, true);
});

test("audio artifacts delegate to the global player rather than creating another media element", () => {
	const html = renderToStaticMarkup(<PlayerProvider><AudioArtifact url="/audio/episode.mp3" filename="episode.mp3" /></PlayerProvider>);
	assert.match(html, /artifact-audio/);
	assert.doesNotMatch(html, /展开播放器/);
	assert.match(html, /download="episode.mp3"/);
	assert.doesNotMatch(html, /<audio/);
});


test("unversioned and regenerated sources cannot reuse a different version", () => {
	assert.equal(sameMediaSource("/media", "/media?generatedAt=first"), false);
	assert.equal(sameMediaSource("/media?generatedAt=first", "/media?generatedAt=second"), false);
	assert.equal(sameMediaSource("/media", "/other?generatedAt=first"), false);
	assert.equal(sameMediaSource("https://one.test/media", "https://two.test/media?generatedAt=first"), false);
});

test("restored artwork keeps valid URLs and rejects executable URLs", () => {
	for (const artworkUrl of ["/api/cover.png", "https://example.com/cover.png"]) {
		assert.equal(restorePlayer(JSON.stringify({ state: { activeTrack: { ...track, artworkUrl } } })).state.activeTrack?.artworkUrl, artworkUrl);
	}
	assert.equal(restorePlayer(JSON.stringify({ state: { activeTrack: { ...track, artworkUrl: "javascript:alert(1)" } } })).state.activeTrack?.artworkUrl, undefined);
});


test("old flat snapshots and track aliases do not restore a playback session", () => {
	for (const old of [{ track, position: 48 }, { activeTrack: track, position: 48 }, { state: { track, position: 48 } }]) {
		assert.deepEqual(restorePlayer(JSON.stringify(old)).state, initialState);
	}
});
