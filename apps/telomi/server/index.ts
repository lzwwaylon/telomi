import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./config/data-dir.js";
import { DataDirectoryError, prepareDataDirectory } from "./config/data-format.js";
import { loadProjectEnvironment } from "./config/environment.js";

loadProjectEnvironment(fileURLToPath(new URL("..", import.meta.url)));
// Before app.js loads: its modules and managed services (Hindsight, Source Service) open the data directory.
try {
	await prepareDataDirectory(resolveDataDir());
} catch (error) {
	if (!(error instanceof DataDirectoryError)) throw error;
	console.error(`[telomi] ERROR: ${error.message}`);
	process.exit(1);
}
await import("./app.js");
