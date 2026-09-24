import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResearchSourceCatalogEntry } from "../providers/search-types.js";

const PYTHON_TOOLS_ROOT = fileURLToPath(new URL("./python-tools/", import.meta.url));
const PYTHON_TOOLS_README_SOURCE = join(PYTHON_TOOLS_ROOT, "tools", "README.md");
const PROVIDER_API_REFERENCE_RENDERER = join(PYTHON_TOOLS_ROOT, "render_api_reference.py");

/** The README keeps one `## <name>` section per Provider module; only the assigned Provider's stays. */
export function workspaceToolsReadmeContent(source?: ResolvedProviderPythonTool): string {
	const content = readFileSync(PYTHON_TOOLS_README_SOURCE, "utf-8");
	const assignedSection = source?.module.slice("tools.".length);
	return content
		.split(/(?=^## )/mu)
		.filter((section) => {
			const sectionName = /^## ([a-z][a-z0-9_]*)\s*$/mu.exec(section)?.[1];
			const isProviderSection = sectionName !== undefined && existsSync(join(PYTHON_TOOLS_ROOT, "tools", `${sectionName}.py`));
			return !isProviderSection || assignedSection === undefined || sectionName === assignedSection;
		})
		.join("");
}

export interface ResolvedProviderPythonTool {
	sourceId: string;
	module: string;
	fileName: string;
	/** Helper modules copied next to the Provider module. */
	files: readonly string[];
}

export function renderProviderApiReference(module: string, python: string): string {
	return execFileSync(python, [PROVIDER_API_REFERENCE_RENDERER, module], {
		encoding: "utf-8",
		env: {
			...process.env,
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONPATH: [PYTHON_TOOLS_ROOT, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
		},
	});
}

export function materializeProviderSdkAssets(
	root: string,
	source: ResearchSourceCatalogEntry & { id: string },
	additionalSources: Array<ResearchSourceCatalogEntry & { id: string }> = [],
): void {
	const sourceTool = resolveWorkerPythonTool(source);
	const sourceTools = [sourceTool, ...additionalSources.map(resolveWorkerPythonTool)]
		.filter((tool, index, tools) => tools.findIndex((item) => item.sourceId === tool.sourceId) === index);
	mountWorkspacePythonTools(root, sourceTools, sourceTools.length > 1);
}

export function resolveWorkerPythonTool(
	source: ResearchSourceCatalogEntry & { id: string },
): ResolvedProviderPythonTool {
	const configured = source.workerPython;
	if (!configured) {
		throw new Error(`Provider '${source.id}' does not have a dedicated Prime Search Python interface`);
	}
	if (!/^tools\.[a-z][a-z0-9_]{0,63}$/.test(configured.module)) {
		throw new Error(`Provider '${source.id}' has invalid Worker Python module '${configured.module}'`);
	}
	const fileName = `${configured.module.slice("tools.".length)}.py`;
	const files = configured.files ?? [];
	for (const file of [fileName, ...files]) {
		if (!/^[a-z][a-z0-9_]{0,63}\.py$/.test(file) || !existsSync(join(PYTHON_TOOLS_ROOT, "tools", file))) {
			throw new Error(`Provider '${source.id}' declares Worker Python file '${file}' that is not shipped in python-tools/tools`);
		}
	}
	return { sourceId: source.id, module: configured.module, fileName, files };
}

function mountWorkspacePythonTools(
	root: string,
	sources: readonly ResolvedProviderPythonTool[],
	includeAllDocumentation: boolean,
): void {
	const toolsRoot = join(root, "tools");
	mkdirSync(toolsRoot, { recursive: true });
	copyReadOnly(join(PYTHON_TOOLS_ROOT, "research_runtime.py"), join(root, "research_runtime.py"));
	copyReadOnly(join(PYTHON_TOOLS_ROOT, "tools", "__init__.py"), join(toolsRoot, "__init__.py"));
	copyReadOnly(join(PYTHON_TOOLS_ROOT, "tools", "candidate_ledger.py"), join(toolsRoot, "candidate_ledger.py"));
	writeReadOnly(
		join(toolsRoot, "README.md"),
		workspaceToolsReadmeContent(includeAllDocumentation ? undefined : sources[0]),
	);
	for (const source of sources) {
		for (const file of [source.fileName, ...source.files]) {
			copyReadOnly(join(PYTHON_TOOLS_ROOT, "tools", file), join(toolsRoot, file));
		}
	}
}

function copyReadOnly(source: string, target: string): void {
	copyFileSync(source, target);
	chmodSync(target, 0o444);
}

function writeReadOnly(target: string, content: string): void {
	writeFileSync(target, content, "utf-8");
	chmodSync(target, 0o444);
}
