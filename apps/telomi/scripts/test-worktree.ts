import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const result = spawnSync("python3", [join(import.meta.dirname, "test-worktree.py")], { encoding: "utf-8" });
assert.equal(result.status, 0, result.stdout + result.stderr);
console.log(result.stdout + result.stderr);
