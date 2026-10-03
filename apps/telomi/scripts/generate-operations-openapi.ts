/**
 * Generates the Operations OpenAPI contract and commit-bound product Agent catalog.
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
import { evaluationAgentCatalog, registeredEvaluationAgentIds } from "../server/agent-runtime/agent-catalog.js";

import {
	OPERATIONS_BASE_PATH,
	OPERATIONS_PROTOCOL_VERSION,
	OPERATIONS_ROUTES,
	OPERATIONS_SCHEMA_HASH,
	SCHEMAS,
	canonicalJson,
} from "../server/evaluation/operations-contract.js";

const APPLICATION_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = join(APPLICATION_DIR, "server", "evaluation", "operations-openapi.json");
const CATALOG_OUTPUT = join(APPLICATION_DIR, "server", "agent-runtime", "agent-catalog.json");

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

for (const [path, value] of [
	[OUTPUT, buildDocument()],
	[CATALOG_OUTPUT, { schemaVersion: 1, generated: true,
		description: "Generated from owning Agent Bundles and agent-catalog.ts; do not edit by hand.",
		agents: evaluationAgentCatalog(registeredEvaluationAgentIds(), APPLICATION_DIR) }],
] as const) {
	const rendered = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.argv.includes("--check")) {
		let current: string | undefined;
		try { current = readFileSync(path, "utf-8"); } catch { /* Missing generated files are stale. */ }
		if (!current || canonicalJson(JSON.parse(current)) !== canonicalJson(JSON.parse(rendered))) {
			console.error(`${path} is stale. Run: npm run generate:operations-openapi`);
			process.exit(1);
		}
		console.log(`${path} is current (schemaHash=${OPERATIONS_SCHEMA_HASH.slice(0, 12)})`);
	} else {
		writeFileSync(path, rendered, "utf-8");
		console.log(`wrote ${path} (schemaHash=${OPERATIONS_SCHEMA_HASH.slice(0, 12)})`);
	}
}
