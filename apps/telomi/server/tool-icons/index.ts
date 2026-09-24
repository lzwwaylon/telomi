import { join } from "path";
import { fileURLToPath } from "url";
import { encodeIconToDataUrl } from "./icon-encoder.js";
import { loadToolIconConfig, type ToolIconConfig } from "./cli-icon-resolver.js";
import type { ToolIconManifest, ToolIconManifestEntry } from "../../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_TOOL_ICONS_DIR = join(__dirname, "..", "..", "resources", "tool-icons");

export function getToolIconsDir(): string {
	return process.env.TELOMI_TOOL_ICONS_DIR || DEFAULT_TOOL_ICONS_DIR;
}

let cached: ToolIconManifest | undefined;

export function buildToolIconManifest(toolIconsDir = getToolIconsDir()): ToolIconManifest {
	if (cached) return cached;
	const config: ToolIconConfig | null = loadToolIconConfig(toolIconsDir);
	const manifest: ToolIconManifest = {
		version: config?.version ?? 1,
		commands: {},
	};
	if (config) {
		for (const tool of config.tools) {
			const iconPath = join(toolIconsDir, tool.icon);
			const iconDataUrl = encodeIconToDataUrl(iconPath);
			if (!iconDataUrl) continue;
			const entry: ToolIconManifestEntry = {
				id: tool.id,
				displayName: tool.displayName,
				iconDataUrl,
			};
			for (const cmd of tool.commands) {
				if (!manifest.commands[cmd]) manifest.commands[cmd] = entry;
			}
		}
	}
	cached = manifest;
	return manifest;
}
