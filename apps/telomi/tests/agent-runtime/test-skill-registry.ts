import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializedSkillIdentity, materializeSkills, snapshotSkills } from "../../server/agent-runtime/skill-registry.js";

const root = mkdtempSync(join(tmpdir(), "telomi-skills-"));
const builtin = join(root, "builtin", "example");
mkdirSync(join(builtin, "scripts"), { recursive: true });
writeFileSync(join(builtin, "SKILL.md"), "---\nname: example\ndescription: Example Skill.\n---\n\nUse it.\n");
writeFileSync(join(builtin, "scripts", "run.py"), "print('one')\n");
chmodSync(join(builtin, "scripts", "run.py"), 0o755);

const first = snapshotSkills([join(root, "builtin")]);
assert.equal(first.skills[0]?.name, "example");
assert.equal(first.skills[0]?.files.length, 2);
const materialized = materializeSkills(first, join(root, "snapshot"));
assert.equal(readFileSync(join(materialized.get("example")!, "scripts", "run.py"), "utf-8"), "print('one')\n");
assert.equal(existsSync(join(root, "snapshot", ".skill-snapshot.json")), true);

// A staged Skill keeps its source identity when Runtime adds a generated reference, and a
// staged source file that changed is rejected rather than reported under the source identity.
const stagedExample = materialized.get("example")!;
mkdirSync(join(stagedExample, "references"));
writeFileSync(join(stagedExample, "references", "API.md"), "# Generated\n");
const staged = snapshotSkills([stagedExample]).skills[0]!;
assert.notEqual(staged.sha256, first.skills[0]!.sha256);
assert.equal(materializedSkillIdentity(staged), first.skills[0]!.sha256);
assert.equal(materializedSkillIdentity(first.skills[0]!), first.skills[0]!.sha256, "an unstaged Skill is its own identity");
// A source that already carries a stale copy of a generated file keeps its identity when Runtime overwrites it.
const carrying = join(root, "carrying", "example");
mkdirSync(join(carrying, "references"), { recursive: true });
writeFileSync(join(carrying, "SKILL.md"), "---\nname: example\ndescription: Example Skill.\n---\n");
writeFileSync(join(carrying, "references", "API.md"), "# Stale\n");
const carryingSource = snapshotSkills([join(root, "carrying")]);
const carryingStaged = materializeSkills(carryingSource, join(root, "carrying-staged")).get("example")!;
writeFileSync(join(carryingStaged, "references", "API.md"), "# Regenerated\n");
const regenerated = snapshotSkills([carryingStaged]).skills[0]!;
assert.throws(() => materializedSkillIdentity(regenerated), /changed after staging: references\/API\.md/u);
assert.equal(materializedSkillIdentity(regenerated, ["references/API.md"]), carryingSource.skills[0]!.sha256);
writeFileSync(join(stagedExample, "SKILL.md"), "---\nname: example\ndescription: Example Skill.\n---\n\nTampered.\n");
assert.throws(() => materializedSkillIdentity(snapshotSkills([stagedExample]).skills[0]!), /changed after staging: SKILL\.md/u);

writeFileSync(join(builtin, "scripts", "run.py"), "print('two')\n");
const second = snapshotSkills([join(root, "builtin")]);
assert.notEqual(first.sha256, second.sha256, "support files must participate in the Skill hash");
assert.throws(() => materializeSkills(first, join(root, "stale")), /changed after snapshot/u);

const override = join(root, "override", "example");
mkdirSync(override, { recursive: true });
writeFileSync(join(override, "SKILL.md"), "---\nname: example\ndescription: Goal override.\n---\n");
assert.equal(snapshotSkills([join(root, "builtin"), join(root, "override")], { allowOverrides: true })
	.skills[0]?.description, "Goal override.");
assert.throws(() => snapshotSkills([join(root, "builtin"), join(root, "override")]), /Duplicate Skill/u);

const linked = join(root, "linked");
mkdirSync(linked);
writeFileSync(join(linked, "SKILL.md"), "---\nname: linked\ndescription: Invalid linked Skill.\n---\n");
symlinkSync(join(builtin, "scripts", "run.py"), join(linked, "run.py"));
assert.throws(() => snapshotSkills([linked]), /cannot contain symlink/u);

console.log("Skill Registry snapshot and materialization tests passed");
