import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../lib/values.js";
import { validateSourceNote } from "../note-agent.js";
import { inspectAgentSourceView } from "./agent-source-view.js";

/** Source Readers keep their one-Logical-Source contract, without a Question corpus adapter. */
export function validateSourceReaderDraft(value: unknown, sourceDir: string, discoveryEnabled: boolean, expectedSourceId?: string) {
	if (!existsSync(join(sourceDir, "source-manifest.json"))) throw new Error("Source Reader requires one Logical Source manifest, not a Question-reading catalog");
	const manifest: unknown = JSON.parse(readFileSync(join(sourceDir, "source-manifest.json"), "utf8"));
	if (!isRecord(manifest) || manifest.schema_version !== 1 || !isRecord(manifest.source)
		|| typeof manifest.source.source_id !== "string" || !manifest.source.source_id.trim()) {
		throw new Error("Source Reader requires a frozen single-Source manifest identity");
	}
	const sourceId = manifest.source.source_id;
	if (expectedSourceId !== undefined && sourceId !== expectedSourceId) throw new Error("Source Reader manifest identity does not match the frozen Source");
	return validateSourceNote(value, sourceId, inspectAgentSourceView(sourceDir).contentFiles, discoveryEnabled);
}
