import { fileURLToPath } from "node:url";

import { resolveDataDir, upgradeInProgress } from "./config/data-dir.js";
import { DataDirectoryError, prepareDataDirectory } from "./config/data-format.js";
import { loadProjectEnvironment } from "./config/environment.js";
import { keepOutputLogBounded } from "./config/output-log.js";

keepOutputLogBounded();
loadProjectEnvironment(fileURLToPath(new URL("..", import.meta.url)));
// Before app.js loads: its modules and managed services (Hindsight, Source Service) open the data directory.
try {
	const upgrade = upgradeInProgress();
	if (upgrade) throw new DataDirectoryError(`An upgrade (pid ${upgrade}) is changing this installation; it starts Telomi again when it finishes.`);
	await prepareDataDirectory(resolveDataDir());
} catch (error) {
	if (!(error instanceof DataDirectoryError)) throw error;
	console.error(`[telomi] ERROR: ${error.message}`);
	process.exit(1);
}
await import("./app.js");
