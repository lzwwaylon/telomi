import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

type MainAgentSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements MainAgentSettingsStorage {
	constructor(private readonly workspaceDir: string) {}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			fn(undefined);
			return;
		}

		const settingsPath = join(this.workspaceDir, "settings.json");
		const current = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) return;

		const dir = dirname(settingsPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(settingsPath, next, "utf-8");
	}
}

export function createMainAgentSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}
