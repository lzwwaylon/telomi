/**
 * CLI tool icon resolver.
 *
 * Parses bash command strings to detect known CLI tools (git, npm, docker, …)
 * and resolves their display name + base64 icon. The mapping lives in
 * resources/tool-icons/tool-icons.json next to the icon files.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export {
	extractCommandName,
	extractCommandNames,
	splitCommands,
} from "../../shared/cli-command-parser.js";

export interface ToolIconEntry {
	id: string;
	displayName: string;
	icon: string;
	commands: string[];
}

export interface ToolIconConfig {
	version: number;
	tools: ToolIconEntry[];
}

const TOOL_ICONS_JSON = "tool-icons.json";

export function loadToolIconConfig(toolIconsDir: string): ToolIconConfig | null {
	try {
		const configPath = join(toolIconsDir, TOOL_ICONS_JSON);
		if (!existsSync(configPath)) return null;
		const raw = readFileSync(configPath, "utf-8");
		const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
		const config = JSON.parse(text) as ToolIconConfig;
		if (!config.tools || !Array.isArray(config.tools)) return null;
		return config;
	} catch {
		return null;
	}
}
