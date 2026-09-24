import { existsSync, lstatSync, statSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { SrtWorkspace } from "../../../extensions/telomi-srt/tool-operations.js";
import { createMainAgentBusinessMounts } from "../agent-runtime/sandbox.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import { GoalTopicPlanStore } from "../goals/topic-plan/store.js";
import { stringifyGoalTopicDocument, TOPIC_PLAN_SANDBOX_PATH } from "../goals/topic-plan/document.js";

/** One read-only view of the business paths mounted for Main Agent. */
export function openMainAgentFiles(goalDir: string, directories?: { workDirectory: string; artifactsDirectory: string }) {
	const mounts = createMainAgentBusinessMounts({ goalDir, ...directories });
	const topicStore = new GoalTopicPlanStore(basename(goalDir), dirname(goalDir));
	const virtualFile = directories && existsSync(join(directories.workDirectory, TOPIC_PLAN_SANDBOX_PATH)) ? undefined : {
		path: `/work/${TOPIC_PLAN_SANDBOX_PATH}`,
		content: stringifyGoalTopicDocument(topicStore.readMainAgentDocument()),
		modifiedAt: topicStore.listProposals()[0]?.created_at ?? statSync(goalDir).mtime.toISOString(),
	};
	const workspace = new SrtWorkspace({
		version: 1, id: "workspace-browser", role: "main.goal_agent", sessionLabel: "workspace-browser",
		hostCwd: goalDir, guestCwd: "/work", mounts, activeTools: [], env: {},
		network: { mode: "deny" }, writablePaths: [],
	});
	const resolve = (value: string) => {
		if (!value || value.includes("\0") || value.includes("\\")) throw new Error("Invalid workspace path");
		const path = workspace.guestPath(resolveWorkspacePath(value));
		if (virtualFile?.path === path) return { kind: "virtual" as const, ...virtualFile };
		const absolutePath = workspace.hostPath(path);
		const mount = [...mounts].sort((a, b) => b.guestPath.length - a.guestPath.length)
			.find((entry) => path === entry.guestPath || path.startsWith(`${entry.guestPath}/`))!;
		let current = mount.hostPath;
		for (const part of posix.relative(mount.guestPath, path).split("/").filter(Boolean)) {
			current = join(current, part);
			if (lstatSync(current).isSymbolicLink()) throw new Error("Workspace symbolic links are not exposed");
		}
		return { kind: "file" as const, path, absolutePath };
	};
	return { mounts, virtualFile, resolve, close: () => workspace.close() };
}
