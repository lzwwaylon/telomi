/** Deterministic SDK adapter for Runtime lifecycle tests. Never calls a model or Provider. */
import { mkdirSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

interface SessionOptions {
	cwd: string;
	customTools: ToolDefinition[];
	sessionManager: { directory: string };
}
export const hooks = {
	prompt: async (_options: SessionOptions, _prompt: string): Promise<void> => {},
	dispose: (_options: SessionOptions): void => {},
};
export { AuthStorage, ModelRegistry } from "prime-agent";
export class SettingsManager {
	private enabled = true;
	static create() { return new SettingsManager(); }
	applyOverrides(value: { autoRefine: { enabled: boolean } }) { this.enabled = value.autoRefine.enabled; }
	getAutoRefineSettings() { return { enabled: this.enabled }; }
}
export class DefaultResourceLoader { async reload() {} }
export const SessionManager = {
	create: (_cwd: string, directory: string) => {
		mkdirSync(directory, { recursive: true });
		return { directory };
	},
};
export async function createAgentSession(options: SessionOptions) {
	return { session: {
		messages: [],
		setSessionName: (_name: string) => {},
		subscribe: (_listener: (event: unknown) => void) => {},
		prompt: (prompt: string) => hooks.prompt(options, prompt),
		waitForRlmQuiescence: async () => {},
		abort: async () => {},
		disposeAsync: async () => hooks.dispose(options),
	} };
}
