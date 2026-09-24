import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AVATAR_COLORS,
	AVATAR_EYES,
	AVATAR_HEADS,
	avatarKey,
	isGoalAvatar,
	nextGoalAvatar,
	type GoalAvatar,
} from "../../shared/avatar.js";
import { EYES, HEADS, birdCharacter } from "../../web/src/features/goals/avatar-engine/birds.js";
import { GoalService } from "../../server/goals/service.js";

// The catalog only promises what the engine can draw, in every colour.
for (const head of AVATAR_HEADS) assert.ok(head in HEADS, `a silhouette is defined for ${head}`);
for (const eye of AVATAR_EYES) assert.ok(eye in EYES, `an eye box is defined for ${eye}`);
for (const color of AVATAR_COLORS) {
	const character = birdCharacter({ head: "tufts", eye: "round", color: color.id });
	for (const state of ["base", "dim", "soft", "blush", "alert", "off"]) {
		assert.match(character.palette.states[state] ?? "", /^#[0-9a-fA-F]{6}$/u, `${color.id} has a ${state} colour`);
	}
}

// Every Goal gets a triple nobody else wears, and fresh parts while any are left.
const TRIPLES = AVATAR_HEADS.length * AVATAR_EYES.length * AVATAR_COLORS.length;
const taken: GoalAvatar[] = [];
for (let index = 0; index < TRIPLES; index += 1) {
	const next = nextGoalAvatar(taken);
	assert.ok(isGoalAvatar(next));
	assert.ok(!taken.some((avatar) => avatarKey(avatar) === avatarKey(next)), `triple ${avatarKey(next)} is new`);
	if (index < AVATAR_HEADS.length) assert.ok(!taken.some((avatar) => avatar.head === next.head), `head ${next.head} is new while heads remain`);
	if (index < AVATAR_HEADS.length * AVATAR_EYES.length) {
		assert.ok(!taken.some((avatar) => avatar.head === next.head && avatar.eye === next.eye), `${next.head}/${next.eye} is a new shape while shapes remain`);
	}
	taken.push(next);
}

// A reroll walks on from the current avatar and lands on something unworn and different.
const current = taken[3]!;
const rerolled = nextGoalAvatar(taken.slice(0, 5).filter((avatar) => avatar !== current), current);
assert.notEqual(avatarKey(rerolled), avatarKey(current));
assert.ok(!taken.slice(0, 5).some((avatar) => avatarKey(avatar) === avatarKey(rerolled)));

// Goals saved by retired renderers or catalogs are migrated once and validated strictly afterwards.
const workspace = mkdtempSync(join(tmpdir(), "telomi-avatar-"));
const timestamp = "2026-09-18T00:00:00.000Z";
const legacy = (id: string) => ({
	id, title: id, description: "", createdAt: timestamp, updatedAt: timestamp, preview: "", messageCount: 0,
	avatarStyle: "gaze", avatarRevision: 2, discoveryEnabled: true, outputLanguage: "auto",
});
writeFileSync(join(workspace, "goals.json"), JSON.stringify([legacy("goal_a"), legacy("goal_b")]), "utf-8");
const unusedExecution = {} as ConstructorParameters<typeof GoalService>[1];
new GoalService(workspace, unusedExecution);
const migrated = JSON.parse(readFileSync(join(workspace, "goals.json"), "utf-8")) as Array<Record<string, unknown>>;
assert.equal(migrated.length, 2);
for (const record of migrated) {
	assert.ok(isGoalAvatar(record.avatar), "legacy Goal received an avatar");
	assert.equal("avatarStyle" in record, false);
	assert.equal("avatarRevision" in record, false);
}
assert.notEqual(avatarKey(migrated[0]!.avatar as GoalAvatar), avatarKey(migrated[1]!.avatar as GoalAvatar));

const { avatarStyle: _style, avatarRevision: _revision, ...modern } = legacy("goal_c");
writeFileSync(join(workspace, "goals.json"), JSON.stringify([{ ...modern, avatar: { species: "owl", color: "sky" } }]), "utf-8");
new GoalService(workspace, unusedExecution);
const repaired = JSON.parse(readFileSync(join(workspace, "goals.json"), "utf-8")) as Array<Record<string, unknown>>;
assert.ok(isGoalAvatar(repaired[0]!.avatar), "an avatar from a retired catalog is replaced instead of blocking startup");

console.log("avatar catalog, distinct assignment, reroll and legacy migration checks passed");
