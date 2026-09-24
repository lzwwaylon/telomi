import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";

/**
 * The Report Context a Research Schedule starts from: the one its baseline
 * Research Run was written under. A Schedule copies this onto itself at
 * creation and owns it from then on.
 */
export function readBaselineReportContext(args: {
	goalId: string;
	workspaceDir: string | undefined;
	runId: string;
}): string {
	const path = join(
		serverRuntimeDirForGoal(args.goalId, args.workspaceDir),
		"runs",
		args.runId,
		"resume-request.json",
	);
	const value = JSON.parse(readFileSync(path, "utf-8")) as { reportContext?: unknown };
	if (typeof value.reportContext !== "string" || !value.reportContext.trim()) {
		throw new Error("Research Schedule baseline requires reportContext");
	}
	return value.reportContext.trim();
}
