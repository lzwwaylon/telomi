/**
 * Provider search execution contracts: the objective ledger of one Search Attempt and the
 * output a Prime Search Provider publishes. Research runs Search Attempts and Evolution
 * counts settled Browser Provider executions, so the Provider module owns both shapes.
 */
import { Type, type Static } from "@sinclair/typebox";

import { validateSchema } from "../agent-runtime/structured-output.js";
import { sha256 } from "../lib/hash.js";
import { assertNoDuplicates } from "../lib/values.js";

const NonEmptyString = Type.String({ minLength: 1 });
const RuntimeId = Type.String({
	minLength: 1,
	maxLength: 200,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const ProviderExecutionSchema = Type.Object({
	execution_id: RuntimeId,
	provider_id: RuntimeId,
}, { additionalProperties: false });

const PrimeSearchOutputSchema = Type.Object({
	sources: Type.Array(Type.Object({
		path: NonEmptyString,
	}, { additionalProperties: false })),
}, { additionalProperties: false });

const SearchExecutionRecordSchema = Type.Object({
	schema_version: Type.Literal(3),
	run_id: RuntimeId,
	execution_id: RuntimeId,
	attempt_id: RuntimeId,
	provider_id: RuntimeId,
	operations: Type.Array(Type.Object({
		operation: NonEmptyString,
		request_ref: NonEmptyString,
		response_count: Type.Integer({ minimum: 0 }),
		source_count: Type.Integer({ minimum: 0 }),
		status: Type.Union([
			Type.Literal("succeeded"),
			Type.Literal("failed"),
			Type.Literal("timed_out"),
		]),
		error: Type.Optional(NonEmptyString),
	}, { additionalProperties: false })),
	terminal_status: Type.Union([
		Type.Literal("valid_bundle"),
		Type.Literal("degraded_bundle"),
		Type.Literal("program_failed"),
		Type.Literal("infrastructure_failed"),
		Type.Literal("cancelled"),
	]),
	/** Provider Runtime access this execution spent, from the Runtime's own Provider call records. */
	provider_access: Type.Optional(Type.Object({
		upstream_attempts: Type.Integer({ minimum: 0 }),
		interval_wait_ms: Type.Integer({ minimum: 0 }),
		rate_limit_wait_ms: Type.Integer({ minimum: 0 }),
		termination: Type.Optional(Type.Object({
			code: NonEmptyString,
			reason: Type.Optional(NonEmptyString),
		}, { additionalProperties: false })),
	}, { additionalProperties: false })),
	bundle_ref: Type.Optional(NonEmptyString),
	bundle_quality: Type.Optional(Type.Object({
		source_unit: Type.Literal("provider_record"),
		exact_content_duplicate_count: Type.Integer({ minimum: 0 }),
		generic_title_count: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export type ProviderExecution = Static<typeof ProviderExecutionSchema>;
export type PrimeSearchOutput = Static<typeof PrimeSearchOutputSchema>;
export type SearchExecutionRecord = Static<typeof SearchExecutionRecordSchema>;

export function validatePrimeSearchOutput(value: unknown): PrimeSearchOutput {
	const output = validateSchema(PrimeSearchOutputSchema, value);
	assertNoDuplicates(output.sources.map((source) => source.path), "PrimeSearch output path");
	return output;
}

export function validateSearchExecutionRecord(
	value: unknown,
	expected: {
		runId: string;
		execution?: Pick<ProviderExecution, "execution_id" | "provider_id">;
	},
): SearchExecutionRecord {
	const record = validateSchema(SearchExecutionRecordSchema, value);
	if (record.run_id !== expected.runId) throw new Error("Search Execution Record run_id does not match the current Run");
	if (expected.execution) {
		if (record.execution_id !== expected.execution.execution_id) {
			throw new Error("Search Execution Record execution_id does not match the Provider execution_id");
		}
		if (record.provider_id !== expected.execution.provider_id) {
			throw new Error("Search Execution Record provider_id does not match the Provider execution");
		}
	}
	if (["valid_bundle", "degraded_bundle"].includes(record.terminal_status) && !record.bundle_ref) {
		throw new Error("A completed Search Attempt requires bundle_ref");
	}
	if (!["valid_bundle", "degraded_bundle"].includes(record.terminal_status) && record.bundle_ref !== undefined) {
		throw new Error("A failed or cancelled Search Attempt cannot publish bundle_ref");
	}
	for (const operation of record.operations) {
		if (operation.status === "succeeded" && operation.error !== undefined) {
			throw new Error(`Successful Search operation '${operation.operation}' cannot contain error`);
		}
		if (operation.status !== "succeeded" && !operation.error) {
			throw new Error(`Failed Search operation '${operation.operation}' requires error`);
		}
	}
	return record;
}

export function derivePrimeSearchSourceId(providerId: string, url: string): string {
	const identity = `${providerId.trim()}\0${url.trim()}`;
	return `source:${sha256(identity).slice(0, 24)}`;
}
