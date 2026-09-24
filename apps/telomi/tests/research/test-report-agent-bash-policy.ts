import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	assertBashCommandAllowed,
	createSrtAgentSandbox,
} from "../../server/agent-runtime/srt-agent-sandbox.js";

const capturedWriterCommand = 'grep -R "Automating SKILL.md Generation" -n / 2>/dev/null | head -200';

assert.doesNotThrow(
	() => assertBashCommandAllowed(
		capturedWriterCommand,
		undefined,
	),
);

for (const command of [
	"find / -name '*.md'",
	"rg evidence /.",
	"command grep --recursive evidence //",
	"env LC_ALL=C ls -laR /",
]) {
	assert.doesNotThrow(
		() => assertBashCommandAllowed(command, undefined),
		command,
	);
}

for (const command of [
	"grep -R evidence /work/inputs | head -20",
	"grep evidence /work/input.json",
	"find /context -maxdepth 2 -type f",
	"rg evidence /inputs",
	"printf '%s\\n' 'grep -R evidence /'",
]) {
	assert.doesNotThrow(
		() => assertBashCommandAllowed(command, undefined),
		command,
	);
}

for (const command of [
	"python - <<'PY'\nprint('inline')\nPY",
	"python3 -c 'print(1)'",
	"mkdir -p /work/programs && python3 - <<'PY'\nprint('inline')\nPY",
	"python /work/programs/pipeline.py",
	"python3 /work/programs/pipeline.py --inspect",
	"printf '%s\\n' \"python - <<'PY'\"",
]) {
	assert.doesNotThrow(
		() => assertBashCommandAllowed(command, undefined),
		command,
	);
}

const workDirectory = mkdtempSync(join(tmpdir(), "telomi-report-bash-policy-"));
const sandbox = createSrtAgentSandbox({
	id: "captured-writer-root-search",
	role: "report.report_writer",
	workDirectory,
	readonlyMounts: [],
	activeTools: ["bash"],
});
try {
	const bash = sandbox.toolDefinitions.find((tool) => tool.name === "bash");
	assert.ok(bash, "report sandbox did not expose Bash");
	await assert.doesNotReject(
		() => bash.execute(
			"captured-writer-root-search",
			{ command: "find / -maxdepth 1 -type d" },
			new AbortController().signal,
			() => undefined,
			undefined as never,
		),
	);
} finally {
	await sandbox.close();
	rmSync(workDirectory, { recursive: true, force: true });
}

console.log("report Agent Bash policy tests passed");
