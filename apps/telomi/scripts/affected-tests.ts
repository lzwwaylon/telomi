import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { discoverTests } from "./run-tests.js";

const SOURCE = /\.[cm]?[jt]sx?$/u;
const TEST = /^(?:tests\/.*\/test-[^/]+\.(?:ts|tsx)|scripts\/test-[^/]+\.ts)$/u;

/** A conservative commit check, not a replacement for the full merge regression. */
export function selectAffectedTests(root: string, changedPaths: readonly string[]): { tests: string[]; full: boolean; reasons: string[] } {
	const app = resolve(root, "apps/telomi");
	const previousCwd = process.cwd();
	let tests: string[];
	try {
		process.chdir(app);
		tests = discoverTests();
	} finally {
		process.chdir(previousCwd);
	}
	const all = (reason: string) => ({ tests, full: true, reasons: [reason] });
	const changed = [...new Set(changedPaths.map((file) => relative(app, resolve(root, file)).replaceAll("\\", "/")))];
	if (!changed.length) return { tests: [], full: false, reasons: [] };
	const tooling: Record<string, string[]> = {
		"scripts/worktree.py": ["scripts/test-worktree.ts"],
		"scripts/test-worktree.py": ["scripts/test-worktree.ts"],
		"scripts/chrome-debug.ts": ["tests/app/test-browser-startup.ts", "scripts/test-worktree.ts"],
		"start.sh": ["tests/app/test-browser-startup.ts", "scripts/test-worktree.ts"],
	};
	if (changed.some((file) => tooling[file])) {
		const result = selectAffectedTests(root, changed.flatMap((file) => tooling[file] ?? [file]).map((file) => relative(root, resolve(app, file))));
		result.reasons.unshift(`Lifecycle tooling checks: ${changed.filter((file) => tooling[file]).join(", ")}`);
		return result;
	}
	const testsOnly = changed.every((file) => TEST.test(file));
	if (testsOnly) {
		// A removed test may still be imported as a helper by another suite.
		if (changed.some((file) => !existsSync(join(app, file)))) return all("Deleted test may have consumers");
	}
	const domain = (file: string): string | undefined => {
		if (file.startsWith("web/")) return "web";
		return /^(?:server|tests)\/([^/]+)\//u.exec(file)?.[1];
	};
	for (const file of changed) {
		if (TEST.test(file)) continue;
		if (!SOURCE.test(file) || file.endsWith(".d.ts") || !/^(server|web)\//u.test(file)
			|| /^server\/(?:lib|config|app)(?:\/|\.)/u.test(file) || !domain(file)) {
			return all(`Global, asset or unmapped change: ${file}`);
		}
		if (!tests.some((test) => domain(test) === domain(file))) return all(`No test domain for ${file}`);
	}
	const config = ts.readConfigFile(join(app, "tsconfig.json"), ts.sys.readFile);
	if (config.error) return all("Cannot read TypeScript resolution config");
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app);
	if (parsed.errors.some((error) => error.code !== 18003)) return all("Cannot parse TypeScript resolution config");
	const cache = ts.createModuleResolutionCache(app, (file) => file, parsed.options);
	const consumers = new Map<string, Set<string>>();
	const dynamicConsumers = new Set<string>();
	const sources = globSync(["server/**/*", "shared/**/*", "web/**/*", "tests/**/*", "scripts/*"], {
		cwd: app, exclude: ["**/node_modules/**", "**/.venv/**", "**/dist/**"],
	}).filter((file) => SOURCE.test(file));
	for (const file of sources) {
		const absolute = join(app, file);
		const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
		const add = (specifier: string) => {
			const resolved = ts.resolveModuleName(specifier, absolute, parsed.options, ts.sys, cache).resolvedModule;
			const targets = resolved ? [resolved.resolvedFileName] : [];
			// Deleted modules cannot resolve in the index snapshot. Keep their edges,
			// including the .js specifiers conventionally used for TypeScript sources.
			const bases = specifier.startsWith(".") ? [resolve(dirname(absolute), specifier)] :
				Object.entries(parsed.options.paths ?? {}).flatMap(([alias, values]) => {
					const [prefix, suffix = ""] = alias.split("*");
					if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
					const capture = specifier.slice(prefix.length, suffix ? -suffix.length : undefined);
					return values.map((value) => resolve(parsed.options.baseUrl ?? app, value.replace("*", capture)));
				});
			for (const base of bases) {
				targets.push(base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].flatMap((extension) =>
					[base.replace(/\.[cm]?jsx?$/u, "") + extension, join(base, `index${extension}`)]));
			}
			for (const target of targets) {
				const dependency = relative(app, target).replaceAll("\\", "/");
				if (!consumers.has(dependency)) consumers.set(dependency, new Set());
				consumers.get(dependency)!.add(file);
			}
		};
		const visit = (node: ts.Node): void => {
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text);
			if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
				if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
				else dynamicConsumers.add(file);
			}
			if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) add(node.moduleReference.expression.text);
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	const affected = new Set([...changed, ...(testsOnly ? [] : dynamicConsumers)]);
	for (const file of affected) for (const consumer of consumers.get(file) ?? []) affected.add(consumer);
	// Computed imports are always included for source changes. Domain fallback
	// also covers source-reading assertions and runtime lookup within a module.
	const domains = new Set([...affected].filter((file) => !TEST.test(file)).map(domain).filter(Boolean));
	const selected = tests.filter((file) => affected.has(file) || domains.has(domain(file)) || domains.has("web") && file.startsWith("tests/voice/"));
	if (!selected.length && !testsOnly) return all("No affected tests could be established");
	return { tests: selected, full: false, reasons: [testsOnly ? "Changed tests and their import consumers" : `Affected imports and test domains: ${[...domains].sort().join(", ")}`] };
}
