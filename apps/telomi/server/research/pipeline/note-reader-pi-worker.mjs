import { register } from "tsx/esm/api";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGTERM", abort);
process.on("SIGINT", abort);
process.on("disconnect", abort);
const unregister = register();
try {
	const { runPiReaderWorker } = await import("./note-reader-pi-subagents.ts");
	await runPiReaderWorker(controller.signal);
} catch (error) {
	const directory = process.argv.includes("--mode") ? dirname(process.cwd()) : dirname(process.env.TELOMI_PI_READER_CONFIG);
	writeFileSync(join(directory, "failure.json"), JSON.stringify({ error: error instanceof Error ? error.message : String(error), failureClass: error?.failureClass }));
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	await unregister();
	process.off("disconnect", abort);
	if (process.connected) process.disconnect();
}
