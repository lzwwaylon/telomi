/**
 * Server module ownership and dependency direction.
 *
 * The generic Agent Runtime keeps Worker, Sandbox, credential, structural validation and
 * Published Artifact management; it must not learn Research. Wiki and Media curate or
 * present products of a Research Run without depending on how a Run executes. The Cornell
 * Evidence Corpus contract is owned by `cornell/` because Research produces it and Wiki
 * curates Editions from it, so neither of them may own it.
 *
 * The check asserts real dependency direction, not file locations: moving an
 * implementation is free, gaining a forbidden edge is not.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const server = fileURLToPath(new URL("../../server/", import.meta.url));

/**
 * Evolution counts Browser Provider evidence only from Research Runs that can no longer
 * change, so it reads one Research Run status contract. Every other Research edge from
 * these modules stays forbidden; a new entry here is a deliberate ownership decision.
 */
const ALLOWED_RESEARCH_EDGES = new Set(["evolution/browser-trigger.ts -> research/run-state.ts"]);

const FORBIDDEN: Array<{ owner: string; targets: string[]; reason: string }> = [
	{ owner: "agent-runtime", targets: ["research/", "wiki/", "goals/", "main-agent/", "evolution/", "cornell/", "providers/search-contracts.ts"], reason: "the generic Agent Runtime must not depend on a business module" },
	{ owner: "wiki", targets: ["research/"], reason: "a Wiki Update has a lifecycle independent of the Research Run that triggers it" },
	{ owner: "media", targets: ["research/"], reason: "Media must not depend on Research" },
	{ owner: "evolution", targets: ["research/"], reason: "Evolution consumes captured Cases, not the Research pipeline" },
	{ owner: "cornell", targets: ["research/", "wiki/"], reason: "the Cornell Evidence Corpus contract must not depend on its producer or its curator" },
];

const violations: string[] = [];
for (const { owner, targets, reason } of FORBIDDEN) {
	for (const [file, target] of localImports(join(server, owner))) {
		if (!targets.some((prefix) => target.startsWith(prefix))) continue;
		if (ALLOWED_RESEARCH_EDGES.has(`${file} -> ${target}`)) continue;
		violations.push(`${file} -> ${target}: ${reason}`);
	}
}
assert.deepEqual(violations, []);

/** Every allowance must name an edge that still exists, so the list cannot rot into permission. */
for (const edge of ALLOWED_RESEARCH_EDGES) {
	const [file, target] = edge.split(" -> ");
	assert.ok(existsSync(join(server, file!)), `Allowed edge names a missing file: ${file}`);
	assert.ok(existsSync(join(server, target!)), `Allowed edge names a missing target: ${target}`);
}

/** Callers import the owner directly; a module move never leaves a forwarding alias behind. */
for (const stale of [
	"agent-runtime/stage-runtime.ts",
	"agent-runtime/state.ts",
	"agent-runtime/contracts.ts",
	"research/pipeline/state.ts",
	"research/pipeline/contracts.ts",
	"research/pipeline/artifact-store.ts",
]) {
	assert.ok(!existsSync(join(server, stale)), `${stale} must not exist as a forwarding alias`);
}

console.log("Server module boundaries passed");

/** Yields `[file, target]` pairs for every relative import, export, dynamic import and import type. */
function* localImports(root: string): Generator<[string, string]> {
	for (const entry of readdirSync(root, { recursive: true })) {
		const name = String(entry);
		if (!/\.(?:ts|tsx|js|mjs)$/.test(name)) continue;
		const file = join(root, name);
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		const found: string[] = [];
		const visit = (node: ts.Node): void => {
			const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
				? node.moduleSpecifier
				: ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
					|| ts.isIdentifier(node.expression) && node.expression.text === "require")
					? node.arguments[0]
					: ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
			if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
				found.push(relative(server, resolve(dirname(file), specifier.text)).replace(/\.js$/, ".ts"));
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		for (const target of found) yield [relative(server, file), target];
	}
}
