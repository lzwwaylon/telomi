import { apiClient } from "./api-client.js";
/**
 * Browser-side counterpart of server/tool-icons.
 *
 * - Fetches /api/tool-icons once, caches the manifest.
 * - Uses the shared cli-icon-resolver command parser so that
 *   `git status`, `NODE_ENV=prod npm run build`, `sudo docker ps`,
 *   `bash -lc 'git push'` all resolve to the matching brand icon.
 */

import { extractCommandNames } from "@shared/cli-command-parser";
import type { ToolIconManifest } from "@shared/types.js";

export {
	extractCommandName,
	extractCommandNames,
	splitCommands,
} from "@shared/cli-command-parser";

export type ToolDisplayMeta = {
	displayName: string;
	iconDataUrl?: string;
	category: "native" | "source" | "skill" | "mcp";
	description?: string;
};

/**
 * Includes both PascalCase (Claude SDK conventions, future compat) and
 * snake_case (pi-coding-agent built-in + telomi custom tools).
 */
const NATIVE_TOOL_DISPLAY_NAMES: Record<string, string> = {
	// Claude SDK PascalCase (kept for forward compatibility; most are
	// not currently registered by pi-coding-agent)
	Read: "Read",
	Write: "Write",
	Edit: "Edit",
	Bash: "Terminal",
	Grep: "Search",
	Glob: "Find Files",
	Task: "Agent",
	Agent: "Agent",
	WebFetch: "Fetch URL",
	WebSearch: "Web Search",
	TodoWrite: "Update Todos",
	NotebookEdit: "Edit Notebook",
	KillShell: "Kill Shell",
	TaskOutput: "Task Output",
	// pi-coding-agent + telomi snake_case
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Terminal",
	artifacts: "Artifacts",
	javascript_repl: "JavaScript REPL",
	extract_document: "Extract Document",
	research: "Research",
	generate_report: "Generate Report",
	workspace_read: "Workspace Read",
	wiki_search: "搜索 Wiki",
	wiki_read_page: "读取 Wiki 页面",
	wiki_graph_search: "展开 Wiki 关系",
	wiki_source_search: "搜索原始 Source",
};

let manifestPromise: Promise<ToolIconManifest> | undefined;
let manifestSnapshot: ToolIconManifest | undefined;

export async function loadToolIconManifest(): Promise<ToolIconManifest> {
	if (manifestSnapshot) return manifestSnapshot;
	if (!manifestPromise) {
		manifestPromise = apiClient.get<ToolIconManifest>("/api/tool-icons", {
			fallbackMessage: (status) => `tool-icons request failed: ${status}`,
		})
			.then((manifest) => {
				manifestSnapshot = manifest;
				return manifest;
			})
			.catch((err) => {
				manifestPromise = undefined;
				throw err;
			});
	}
	return manifestPromise;
}

export function resolveBashToolDisplayMeta(
	command: string | undefined,
	manifest: ToolIconManifest | undefined = manifestSnapshot,
): ToolDisplayMeta | undefined {
	if (!manifest || !command) return undefined;
	for (const cmd of extractCommandNames(command)) {
		const entry = manifest.commands[cmd];
		if (entry) {
			return {
				displayName: entry.displayName,
				iconDataUrl: entry.iconDataUrl,
				category: "native",
			};
		}
	}
	return undefined;
}

/**
 * Unified tool display resolver for native and Bash flows:
 *   1. Bash brand match (cli-icon-resolver) → iconDataUrl from manifest
 *   2. Bash without brand match → "Terminal" (no iconDataUrl, UI falls back to lucide)
 *   3. Other native tools → displayName from NATIVE_TOOL_DISPLAY_NAMES
 *   4. Unknown → undefined (caller falls back to raw toolName)
 *
 * MCP / Skill / Source resolution is intentionally not handled here: those
 * categories require server-side sources/skills lookup which telomi
 * doesn't currently surface to the chat client.
 */
export function resolveToolDisplayMeta(
	toolName: string | undefined,
	toolInput?: Record<string, unknown> | undefined,
	manifest: ToolIconManifest | undefined = manifestSnapshot,
): ToolDisplayMeta | undefined {
	if (!toolName) return undefined;
	const isBash = toolName === "Bash" || toolName === "bash";
	if (isBash) {
		const command = toolInput?.command;
		if (typeof command === "string") {
			const brand = resolveBashToolDisplayMeta(command, manifest);
			if (brand) return brand;
		}
		return { displayName: "Terminal", category: "native" };
	}
	const native = NATIVE_TOOL_DISPLAY_NAMES[toolName];
	if (native) return { displayName: native, category: "native" };
	return undefined;
}
