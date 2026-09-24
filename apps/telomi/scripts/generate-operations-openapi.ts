/**
 * Generates `server/evaluation/operations-openapi.json` from the TypeBox contract.
 *
 * The document is the only thing the external evaluation environment reads to generate its client types,
 * so it is checked in. `--check` fails when the committed file is stale; that is the
 * deterministic freshness check for the Operations contract.
 *
 *   npm run generate:operations-openapi
 *   npm run generate:operations-openapi -- --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	OPERATIONS_BASE_PATH,
	OPERATIONS_PROTOCOL_VERSION,
	OPERATIONS_ROUTES,
	OPERATIONS_SCHEMA_HASH,
	SCHEMAS,
	canonicalJson,
} from "../server/evaluation/operations-contract.js";

const OUTPUT = join(fileURLToPath(new URL("..", import.meta.url)), "server", "evaluation", "operations-openapi.json");

function buildDocument(): unknown {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const route of OPERATIONS_ROUTES) {
		const path = `${OPERATIONS_BASE_PATH}${route.path}`;
		const parameters = [
			...[...route.path.matchAll(/\{(\w+)\}/gu)].map(([, name]) => ({
				name, in: "path", required: true, schema: { type: "string" },
			})),
			...(route.query ?? []).map((query) => ({
				name: query.name, in: "query", required: query.required === true, schema: { type: "string" },
			})),
		];
		(paths[path] ??= {})[route.method] = {
			operationId: route.operationId,
			summary: route.summary,
			tags: [route.access === "read" ? "capture" : "eval-instance"],
			...(parameters.length > 0 ? { parameters } : {}),
			...(route.requestSchema ? {
				requestBody: {
					required: true,
					content: { "application/json": { schema: ref(route.requestSchema) } },
				},
			} : {}),
			responses: {
				// The success status is the one the Router actually sends, so the document is
				// not quietly wrong about, for example, startReplay's 202 Accepted.
				[String(route.successStatus ?? 200)]: route.binary
					? { description: "File stream", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }
					: { description: SUCCESS_DESCRIPTIONS[route.successStatus ?? 200] ?? "OK", content: { "application/json": { schema: ref(route.responseSchema!) } } },
				default: { description: "Error", content: { "application/json": { schema: ref("ErrorResponse") } } },
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Telomi Operations HTTP",
			version: `${OPERATIONS_PROTOCOL_VERSION}.0.0`,
			description: "Loopback-only Evaluation Interface. Generated from server/evaluation/operations-contract.ts; do not edit by hand.",
			"x-protocol-version": OPERATIONS_PROTOCOL_VERSION,
			"x-schema-hash": OPERATIONS_SCHEMA_HASH,
		},
		servers: [{ url: "http://127.0.0.1:8788", description: "Operations Listener (loopback only)" }],
		paths,
		components: { schemas: SCHEMAS },
	};
}

const SUCCESS_DESCRIPTIONS: Record<number, string> = { 200: "OK", 202: "Accepted" };

function ref(name: string): { $ref: string } {
	return { $ref: `#/components/schemas/${name}` };
}

const rendered = `${JSON.stringify(buildDocument(), null, "\t")}\n`;

if (process.argv.includes("--check")) {
	const current = readFileSync(OUTPUT, "utf-8");
	if (canonicalJson(JSON.parse(current)) !== canonicalJson(JSON.parse(rendered))) {
		console.error("operations-openapi.json is stale. Run: npm run generate:operations-openapi");
		process.exit(1);
	}
	console.log(`operations-openapi.json is current (schemaHash=${OPERATIONS_SCHEMA_HASH.slice(0, 12)})`);
} else {
	writeFileSync(OUTPUT, rendered, "utf-8");
	console.log(`wrote ${OUTPUT} (schemaHash=${OPERATIONS_SCHEMA_HASH.slice(0, 12)})`);
}
