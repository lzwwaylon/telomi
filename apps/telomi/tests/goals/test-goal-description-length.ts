import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sourcePaths = [
	"../../web/src/features/home/GoalCreateDialog.tsx",
	"../../web/src/features/goals/GoalEditDialog.tsx",
	"../../web/src/app/App.tsx",
];

for (const path of sourcePaths) {
	const source = readFileSync(new URL(path, import.meta.url), "utf8");
	assert.doesNotMatch(source, /slice\(0, 500\)/u, `${path} must preserve the complete Goal description`);
}

for (const path of sourcePaths.slice(0, 2)) {
	const source = readFileSync(new URL(path, import.meta.url), "utf8");
	assert.doesNotMatch(source, /maxLength=\{500\}/u, `${path} must accept a complete Goal description`);
}

console.log("Goal description length regression test passed");
