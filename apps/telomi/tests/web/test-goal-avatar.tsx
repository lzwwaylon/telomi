import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ActivityKind, ActivityProjectionItem } from "../../shared/events/activity-projection.js";
import type { AvatarColor } from "../../shared/avatar.js";
import i18n from "../../web/src/app/i18n.js";
import { BirdAvatar } from "../../web/src/features/goals/BirdAvatar.js";
import { GoalAvatar } from "../../web/src/features/goals/GoalAvatar.js";
import { EYES, HEADS, birdCharacter } from "../../web/src/features/goals/avatar-engine/birds.js";
import { MOODS } from "../../web/src/features/goals/avatar-engine/moods.js";
import { frameFor, headPath, lensPath } from "../../web/src/features/goals/avatar-engine/shapes.js";
import { EMOTION, IDLE_SIGNALS, goalAvatarEmotion, goalAvatarSignals } from "../../web/src/features/goals/avatar-signals.js";

const timestamp = "2026-09-18T00:00:00.000Z";
function activity(goalId: string, overrides: Partial<ActivityProjectionItem>): ActivityProjectionItem {
	return {
		activityId: `${goalId}-${Math.random().toString(36).slice(2, 6)}`, kind: "research", scope: { kind: "goal", goalId },
		trigger: { kind: "manual" }, title: "", summary: "", lifecycle: "running",
		timing: { createdAt: timestamp, updatedAt: timestamp }, resultLinks: [], steps: [], sourceRef: "research",
		...overrides,
	};
}

// Signals come from the Goal's own Activities only, and the most pressing attention wins.
const activities = [
	activity("a", { kind: "wiki-update" }),
	activity("a", { kind: "topic-plan", lifecycle: "finished", attention: { kind: "decision", summary: "", actions: [] } }),
	activity("a", { kind: "podcast", lifecycle: "queued" }),
	activity("b", { lifecycle: "finished", outcome: "failed", attention: { kind: "failure", summary: "", actions: [] } }),
];
const a = goalAvatarSignals(activities, "a");
assert.deepEqual({ attention: a.attention, running: a.running, pending: a.pending }, { attention: "decision", running: ["wiki-update"], pending: true });
assert.equal(a.lastFinished?.outcome, null, "the finished topic plan carries no outcome");
assert.equal(a.lastActiveAt, timestamp);
const b = goalAvatarSignals(activities, "b");
assert.deepEqual({ attention: b.attention, running: b.running, pending: b.pending, outcome: b.lastFinished?.outcome }, { attention: "failure", running: [], pending: false, outcome: "failed" });
assert.deepEqual(goalAvatarSignals(activities, "c"), IDLE_SIGNALS);
assert.equal(goalAvatarSignals([
	activity("d", { lifecycle: "finished", attention: { kind: "input", summary: "", actions: [] } }),
	activity("d", { lifecycle: "finished", attention: { kind: "failure", summary: "", actions: [] } }),
], "d").attention, "failure");

// One emotion at a time, most pressing first.
const idle = { signals: IDLE_SIGNALS, isStreaming: false, moment: null, asleep: false };
const running = (...kinds: ActivityKind[]) => ({ ...IDLE_SIGNALS, running: kinds });
assert.equal(goalAvatarEmotion({ ...idle, signals: { ...running("research"), attention: "failure", pending: true }, isStreaming: true, moment: "done" }), EMOTION.failed);
assert.equal(goalAvatarEmotion({ ...idle, signals: { ...running("research"), attention: "credential" }, isStreaming: true }), EMOTION.waitingForUser);
assert.equal(goalAvatarEmotion({ ...idle, signals: running("research"), moment: "started" }), EMOTION.started, "a moment plays on top of work");
assert.equal(goalAvatarEmotion({ ...idle, signals: running("research"), isStreaming: true }), EMOTION.researching, "a turn that waits on research shows the research");
assert.equal(goalAvatarEmotion({ ...idle, isStreaming: true }), EMOTION.thinking);
assert.equal(goalAvatarEmotion({ ...idle, signals: running("wiki-update", "research") }), EMOTION.researching, "research outranks other work");
assert.equal(goalAvatarEmotion({ ...idle, signals: running("signal-evaluation") }), EMOTION.researching);
assert.equal(goalAvatarEmotion({ ...idle, signals: running("wiki-update") }), EMOTION.updatingWiki);
assert.equal(goalAvatarEmotion({ ...idle, signals: running("podcast") }), EMOTION.recording);
assert.equal(goalAvatarEmotion({ ...idle, signals: running("topic-plan") }), EMOTION.thinking);
assert.equal(goalAvatarEmotion({ ...idle, signals: { ...IDLE_SIGNALS, pending: true }, asleep: true }), EMOTION.waitingOutside, "a queue keeps the bird awake");
assert.equal(goalAvatarEmotion({ ...idle, moment: "done" }), EMOTION.done);
assert.equal(goalAvatarEmotion({ ...idle, moment: "cancelled" }), EMOTION.cancelled);
assert.equal(goalAvatarEmotion({ ...idle, moment: "born" }), EMOTION.born);
assert.equal(goalAvatarEmotion({ ...idle, asleep: true }), EMOTION.asleep);
assert.equal(goalAvatarEmotion(idle), EMOTION.idle);

// Without a browser the component renders its host only, carrying what the engine will draw.
const host = renderToStaticMarkup(<BirdAvatar look={{ head: "tufts", eye: "round", color: "tawny" }} emotion={EMOTION.idle} size={32} still label="Goal" />);
assert.match(host, /<div[^>]*role="img"[^>]*aria-label="Goal"/u);
assert.match(host, /data-avatar-head="tufts"/u);
assert.match(host, /data-avatar-eye="round"/u);
assert.match(host, /data-avatar-emotion="idle"/u);

// Failure keeps the bird's own hue. An absolute alert colour painted every broken Goal
// the same red, so a rail could not say which Goal broke, and it collided with the birds
// whose own colour is already warm.
const alertOf = (color: AvatarColor) =>
	birdCharacter({ head: "tufts", eye: "round", color }).palette.states.alert;
assert.notEqual(alertOf("sage"), alertOf("coral"), "the alert state is derived per bird, not one shared red");
assert.notEqual(alertOf("coral"), "#D9534F", "no absolute alert colour");

// Every emotion a Goal can reach is one the engine can draw.
for (const id of Object.values(EMOTION)) assert.ok(id in MOODS, `${id} has a mood`);

// Heads are drawn in the units birds.ts encodes, and the frame opens around the silhouette
// rather than clipping it: a cut crest or ruff is exactly the feather that tells birds apart.
// The frame may not run away either, or that bird would be drawn smaller than the rest.
const points = (path: string) => path.slice(1, -1).split("L").map((pair) => pair.split(" ").map(Number) as [number, number]);
for (const [name, head] of Object.entries(HEADS)) {
	const path = headPath(head);
	const drawn = points(path);
	const [left, top, span] = frameFor(path).split(" ").map(Number) as [number, number, number, number];
	assert.ok(drawn.every(([x, y]) => x > left && x < left + span && y > top && y < top + span), `${name} is drawn inside its frame`);
	assert.ok(span <= 280, `${name} does not blow the frame open`);
	const reach = Math.max(...drawn.map(([x, y]) => Math.hypot(x - 120, y - 120)));
	if (head.bumps.length > 0) assert.ok(reach > 104 * head.r, `${name} wears its feathers outside the base shape`);
	if (head.flat) {
		// The base is a straight line at the seat, and a ruff's feathers still hang below it.
		const seat = 120 + 104 * head.r * (head.sy ?? 1) * (1 - head.flat);
		assert.ok(drawn.filter(([, y]) => Math.abs(y - seat) < 0.5).length > 1, `${name} is seated flat`);
	}
}

// The ruff is one scalloped hem, unlike the tufts and horns, which are separate feathers.
// Narrow feathers with a gap between them drop the outline back to the base radius, and the
// shallow notches that leaves read as drips hanging off the bird rather than as a ruff.
const hem = HEADS.ruff.bumps.map((bump) => [bump.at - bump.width, bump.at + bump.width] as const).sort((a, b) => a[0] - b[0]);
for (const [index, span] of hem.slice(1).entries()) {
	assert.ok(span[0] <= hem[index]![1], `ruff feathers ${index} and ${index + 1} merge into one hem`);
}

// A shut eye has to stay a visible line: eye shape is how the rail tells birds apart, and a
// sleeping bird that loses its eyes altogether loses the only cue it has at 32px.
const round = EYES.round;
const eyeSpan = (path: string) => {
	const ys = points(path).map(([, y]) => y);
	return Math.max(...ys) - Math.min(...ys);
};
assert.ok(eyeSpan(lensPath(round, 1.4, 1, 0)) < eyeSpan(lensPath(round, 1.4, 0, 0)) * 0.35, "a shut eye is a line");
assert.ok(eyeSpan(lensPath(round, 1.4, 1, 0)) > 6.5, "a shut eye is still about a pixel at 32px");

// Anything waiting on the user shows a badge, and a failure is told apart from a wait by
// its shape rather than by a hue the birds already use.
await i18n.changeLanguage("zh-CN");
const goal = { id: "g1", title: "Goal", isStreaming: false, avatar: { head: "tufts", eye: "round", color: "tawny" }, createdAt: timestamp, lastActivityAt: timestamp } as const;
const badgeOf = (attention: "failure" | "decision" | null) =>
	renderToStaticMarkup(<GoalAvatar goal={goal} signals={{ ...IDLE_SIGNALS, attention }} size={32} />);

const failed = badgeOf("failure");
assert.match(failed, /data-attention="failure"/u);
assert.match(failed, /background:var\(--attention-alert\)/u, "a failure is a solid badge");
assert.doesNotMatch(failed, /border:2\.5px/u);

const waiting = badgeOf("decision");
assert.match(waiting, /data-attention="decision"/u, "attention other than a failure is badged too");
assert.match(waiting, /border:2\.5px solid var\(--warm-deep\)/u, "a wait is a hollow badge");
assert.notEqual(
	/aria-label="([^"]*)"[^>]*data-testid="goal-avatar-attention/u.exec(failed)?.[1],
	/aria-label="([^"]*)"[^>]*data-testid="goal-avatar-attention/u.exec(waiting)?.[1],
	"the two are named apart for anyone who cannot see the shape",
);

assert.doesNotMatch(badgeOf(null), /data-attention=/u, "a Goal with nothing waiting carries no badge");

console.log("goal avatar signals, emotion priority, engine moods and shapes, alert colour, attention badge and host render passed");
