import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { SANDBOX_TOOL_NAMES, createMainAgentSandboxExecutionSpec } from "../agent-runtime/sandbox.js";
import { snapshotLogicalWorkspace } from "../agent-runtime/logical-workspace-snapshot.js";
import {
	createSrtAgentSandbox,
	type SrtAgentSandbox,
} from "../agent-runtime/srt-agent-sandbox.js";
import type { MainWorkspaceSession } from "./main-workspace-runtime.js";

export function createMainAgentSandbox(
	goalDir: string,
	session: MainWorkspaceSession,
): SrtAgentSandbox {
	const executionSpec = createMainAgentSandboxExecutionSpec({
		id: session.id,
		goalDir,
		sandboxDir: session.sandboxDir,
		historyDirectory: session.historyDirectory,
	});
	return createSrtAgentSandbox({
		id: session.id,
		role: "main.goal_agent",
		workDirectory: session.workDirectory,
		readonlyMounts: [],
		activeTools: SANDBOX_TOOL_NAMES,
		network: "deny",
		executionSpec,
	});
}

/** Materializes the exact guest-visible file tree at Main Agent turn start. */
export function snapshotMainAgentLogicalWorkspace(
	goalDir: string,
	session: MainWorkspaceSession,
	destination: string,
): void {
	const spec = createMainAgentSandboxExecutionSpec({
		id: session.id,
		goalDir,
		sandboxDir: session.sandboxDir,
		historyDirectory: session.historyDirectory,
	});
	snapshotLogicalWorkspace(spec, destination);
}

export function createMainAgentSandboxProxyTools(
	getSandbox: () => SrtAgentSandbox | undefined,
): AgentTool<any>[] {
	const definitions = [
		createReadToolDefinition("/work"),
		createWriteToolDefinition("/work"),
		createEditToolDefinition("/work"),
		createBashToolDefinition("/work"),
		createLsToolDefinition("/work"),
		createFindToolDefinition("/work"),
		createGrepToolDefinition("/work"),
	];
	return definitions.map((definition) => ({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.name === "bash"
			? Type.Object({
					command: Type.String({ description: "Command to execute inside the isolated Main Agent sandbox." }),
				}, { additionalProperties: false })
			: definition.parameters,
		execute: async (toolCallId, args, signal, onUpdate) => {
			const sandbox = getSandbox();
			if (!sandbox) throw new Error("Main Agent file tools are unavailable outside an active isolated directory");
			const target = sandbox.tools.find((tool) => tool.name === definition.name);
			if (!target) throw new Error(`Main Agent sandbox does not expose ${definition.name}`);
			return target.execute(toolCallId, args, signal, onUpdate);
		},
	}));
}
