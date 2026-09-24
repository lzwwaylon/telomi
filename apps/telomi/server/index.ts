import { fileURLToPath } from "node:url";

import { loadProjectEnvironment } from "./config/environment.js";

loadProjectEnvironment(fileURLToPath(new URL("..", import.meta.url)));
await import("./app.js");
