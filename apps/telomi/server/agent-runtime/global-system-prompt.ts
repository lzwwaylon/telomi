import { renderAgentPrompt } from "./prompt-registry.js";

export interface GlobalSystemPromptTool {
	name: string;
	promptSnippet?: string;
	description?: string;
	promptGuidelines?: readonly string[];
}

export interface GlobalSystemPromptOptions {
	tools?: readonly GlobalSystemPromptTool[];
	promptGuidelines?: readonly string[];
	conciseResponses?: boolean;
	showFilePaths?: boolean;
}

export function composeAgentSystemPrompt(
	agentPrompt = "",
	options: GlobalSystemPromptOptions = {},
): string {
	const tools = uniqueTools(options.tools ?? []);
	const guidelines = uniqueStrings([
		...(options.promptGuidelines ?? []),
		...tools.flatMap((tool) => tool.promptGuidelines ?? []),
	]);
	const globalPrompt = renderAgentPrompt("main", "global-base", "system", {
		tools: tools.length > 0
			? tools.map((tool) => {
				const snippet = (tool.promptSnippet ?? tool.description ?? "").replace(/\s+/gu, " ").trim();
				return snippet ? `- ${tool.name}: ${snippet}` : `- ${tool.name}`;
			}).join("\n")
			: "",
		concise_responses: options.conciseResponses !== false,
		show_file_paths: options.showFilePaths !== false,
		guidelines: guidelines.map((guideline) => `- ${guideline}`).join("\n"),
	}).content;
	const rolePrompt = agentPrompt.trim();
	return rolePrompt ? `${globalPrompt}\n\n${rolePrompt}` : globalPrompt;
}

function uniqueTools(tools: readonly GlobalSystemPromptTool[]): GlobalSystemPromptTool[] {
	const byName = new Map<string, GlobalSystemPromptTool>();
	for (const tool of tools) {
		const name = tool.name.trim();
		if (name && !byName.has(name)) byName.set(name, { ...tool, name });
	}
	return [...byName.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
}
