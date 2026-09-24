import { fileURLToPath } from "node:url";

import "./config/socket-tos.js";
import { loadProjectEnvironment } from "./config/environment.js";
import { keepOutputLogBounded } from "./config/output-log.js";

// Static imports are evaluated before any statement here runs, and many modules resolve data paths
// into module constants when they load. Only modules that read no configuration may be imported
// statically; everything else loads after the checkout's env files, which may set TELOMI_DATA_DIR.
keepOutputLogBounded();
loadProjectEnvironment(fileURLToPath(new URL("..", import.meta.url)));

const { resolveDataDir } = await import("./config/data-dir.js");
const { DataDirectoryError, prepareDataDirectory, upgradeInProgress } = await import("./config/data-format.js");
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
