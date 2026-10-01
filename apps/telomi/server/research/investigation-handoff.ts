import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { isRecord } from "../lib/values.js";

export interface InvestigationHandoff {
	schema_version: 1;
	operation: string;
	result_ref: string;
	sha256: string;
	byte_length: number;
}

/** Publish one complete result before returning its bounded, invocation-local receipt. */
export function publishInvestigationHandoff(workspace: string, operation: string, value: unknown): InvestigationHandoff {
	if (!/^[a-z_]+$/u.test(operation)) throw new Error("Invalid investigation handoff operation");
	if (!isRecord(value)) throw new Error("Investigation handoff must contain an object");
	const artifact = new RunArtifactStore(workspace).publishText(`${JSON.stringify(value, null, 2)}\n`,
		`inputs/handoff/${operation}-${randomUUID()}.json`);
	const receipt: InvestigationHandoff = { schema_version: 1, operation, result_ref: artifact.relativePath,
		sha256: artifact.sha256, byte_length: artifact.byteLength };
	if (operation === "write_answer") writeJsonAtomic(join(workspace, "inputs", "handoff", "latest-writer.json"), receipt);
	return receipt;
}

/** Resolve only a published handoff in this Workspace, verifying identity and frozen bytes. */
export function readInvestigationHandoff(workspace: string, receipt: unknown, operation?: string): unknown {
	if (!isRecord(receipt) || receipt.schema_version !== 1
		|| typeof receipt.operation !== "string" || !/^[a-z_]+$/u.test(receipt.operation)
		|| (operation !== undefined && receipt.operation !== operation)
		|| typeof receipt.result_ref !== "string"
		|| !new RegExp(`^inputs/handoff/${receipt.operation}-[a-f0-9-]+\\.json$`, "u").test(receipt.result_ref)
		|| typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.sha256)
		|| !Number.isSafeInteger(receipt.byte_length) || Number(receipt.byte_length) < 1) {
		throw new Error("Invalid investigation handoff receipt");
	}
	const store = new RunArtifactStore(workspace);
	const artifact = store.openFile({ relative_path: receipt.result_ref, sha256: receipt.sha256,
		byte_length: Number(receipt.byte_length) });
	const value = store.readJson<unknown>(artifact);
	if (!isRecord(value)) throw new Error("Investigation handoff must contain an object");
	return value;
}

/** Submission must name the latest Writer artifact, even if an earlier draft has the same prose. */
export function readLatestInvestigationWriter(workspace: string, receipt: unknown): unknown {
	const store = new RunArtifactStore(workspace);
	const latest = JSON.parse(readFileSync(store.describeFile("inputs/handoff/latest-writer.json").absolutePath, "utf8")) as InvestigationHandoff;
	if (typeof receipt === "string" && receipt !== latest.result_ref) {
		throw new Error("Invalid latest Writer handoff reference");
	}
	const submitted = typeof receipt === "string" ? { ...latest, result_ref: receipt } : receipt as InvestigationHandoff;
	const value = readInvestigationHandoff(workspace, submitted, "write_answer");
	if (latest.result_ref !== submitted.result_ref || latest.sha256 !== submitted.sha256 || latest.byte_length !== submitted.byte_length) {
		throw new Error("Prime must submit the latest Writer handoff receipt");
	}
	return value;
}
