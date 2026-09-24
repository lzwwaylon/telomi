import { isThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
	decideSectionChildren,
	type SectionChildSnapshot,
} from "./report-writer-children.js";
import { isRecord, toErrorMessage } from "../../lib/values.js";
import { listFilesRecursive } from "../../lib/fs.js";
const {
	assertPrimeModelAnswered,
	createPrimeModelRegistry,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	projectPrimeChildLifecycleEvent,
} = await import(required("PRIME_AGENT_PATHS_MODULE_PATH")) as typeof import("../../agent-runtime/prime-agent-paths.js");
const logicalWorkspaceCaptureRoot = process.env.PRIME_AGENT_REPORT_LOGICAL_WORKSPACE_ROOT?.trim();
const logicalWorkspaceModulePath = process.env.PRIME_AGENT_LOGICAL_WORKSPACE_MODULE_PATH?.trim();
if (Boolean(logicalWorkspaceCaptureRoot) !== Boolean(logicalWorkspaceModulePath)) {
	throw new Error("Report Writer logical Workspace capture configuration is incomplete");
}
const logicalWorkspaceModule = logicalWorkspaceModulePath
	? await import(logicalWorkspaceModulePath) as typeof import("../../agent-runtime/logical-workspace-snapshot.js")
	: undefined;

const cwd = required("PRIME_AGENT_REPORT_CWD");
const runtimeRoot = required("PRIME_AGENT_REPORT_RUNTIME");
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const skillPaths = stringArray("PRIME_AGENT_REPORT_SKILLS");
const expectedSkills = stringArray("PRIME_AGENT_REPORT_EXPECTED_SKILLS");
const completedSectionIds = stringArray("PRIME_AGENT_REPORT_COMPLETED_SECTIONS", true);
const completedSections = new Set(completedSectionIds);
const rootProvider = required("PRIME_AGENT_REPORT_ROOT_PROVIDER");
const rootModelId = required("PRIME_AGENT_REPORT_ROOT_MODEL");
const childProvider = required("PRIME_AGENT_REPORT_CHILD_PROVIDER");
const childModelId = required("PRIME_AGENT_REPORT_CHILD_MODEL");
const thinkingLevel = required("PRIME_AGENT_REPORT_THINKING_LEVEL");
if (!isThinkingLevel(thinkingLevel)) throw new Error("Invalid configured thinking level");
const knowledgeMode = required("PRIME_AGENT_REPORT_KNOWLEDGE_MODE");
const materialContract = JSON.parse(readFileSync(join(cwd, "inputs", "materials.json"), "utf-8")) as {
	schema_version?: unknown; kind?: unknown; refs?: unknown;
};
if (materialContract.schema_version !== 1 || materialContract.kind !== knowledgeMode
	|| !Array.isArray(materialContract.refs) || materialContract.refs.length === 0
	|| materialContract.refs.some((ref) => typeof ref !== "string" || !ref.trim())) {
	throw new Error("Prime Report Writer material contract is invalid");
}
const allowedMaterialRefs = new Set(materialContract.refs as string[]);
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));
const systemPrompt = readFileSync(join(runtimeRoot, "system-prompt.md"), "utf-8");
const initialPrompt = readFileSync(join(runtimeRoot, "initial-prompt.md"), "utf-8");
const delegationPrompt = readFileSync(join(runtimeRoot, "delegation-prompt.md"), "utf-8");
const finalPrompt = readFileSync(join(runtimeRoot, "final-prompt.md"), "utf-8");
const finalRepairPrompt = readFileSync(join(runtimeRoot, "final-repair-prompt.md"), "utf-8");
const authoredOutlinePath = join(cwd, "work", "report-outline.json");
let outline: { sections: Array<{ section_id: string; title: string }> } = { sections: [] };

const eventLog = join(runtimeRoot, "root-events.jsonl");
const rlmSessionDir = join(runtimeRoot, "session-artifacts");
const rootSessionDir = join(runtimeRoot, "session");
mkdirSync(rlmSessionDir, { recursive: true });
mkdirSync(rootSessionDir, { recursive: true });

const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const rootModel = modelRegistry.find(rootProvider, rootModelId);
const childModel = modelRegistry.find(childProvider, childModelId);
if (!rootModel || !childModel) {
	throw new Error(`${rootProvider}/${rootModelId} and ${childProvider}/${childModelId} must be configured`);
}

const settingsManager = createPrimeSettingsManager(prime.SettingsManager, cwd, agentDir);
const loader = new prime.DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	additionalSkillPaths: skillPaths,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	appendSystemPrompt: [systemPrompt],
});
await loader.reload();
const loadedSkills = new Set(loader.getSkills().skills.map((skill: { name: string }) => skill.name));
for (const skill of expectedSkills) {
	if (!loadedSkills.has(skill)) throw new Error(`${skill} Skill did not load`);
}

const { session } = await prime.createAgentSession({
	cwd,
	agentDir,
	authStorage,
	modelRegistry,
	settingsManager,
	resourceLoader: loader,
	sessionManager: prime.SessionManager.create(cwd, rootSessionDir),
	model: rootModel,
	thinkingLevel,
	scopedModels: [
		{ model: rootModel, thinkingLevel },
		{ model: childModel, thinkingLevel },
	],
	tools: ["ipython"],
	rlmSessionDir,
	rlmMaxDepth: 1,
	prewarmIpythonKernel: true,
	executionMode: "print",
	telemetryDisabled: true,
});
const logicalWorkspace = {
	guestCwd: "/workspace",
	mounts: [
		{ hostPath: cwd, guestPath: "/workspace", access: "read-write" as const },
		...skillPaths.map((path) => ({
			hostPath: path,
			guestPath: `/capabilities/skills/${basename(path)}`,
			access: "read-only" as const,
		})),
	],
};
if (logicalWorkspaceCaptureRoot && logicalWorkspaceModule) {
	logicalWorkspaceModule.snapshotLogicalWorkspace(logicalWorkspace, join(logicalWorkspaceCaptureRoot, "root"));
}
const snapshotChildWorkspace = logicalWorkspaceCaptureRoot && logicalWorkspaceModule
	? logicalWorkspaceModule.createRlmChildLogicalWorkspaceSnapshotter(logicalWorkspace, logicalWorkspaceCaptureRoot, "child")
	: undefined;

let rootToolCalls = 0;
const rootUsage = emptyUsage();
/** Latest native snapshot per Section child. The SDK is the authority on whether a child still lives. */
const childrenById = new Map<string, SectionChildSnapshot>();
const shouldRecordTraceEvent = createPrimeTraceEventFilter();
session.subscribe((event: unknown) => {
	try {
		snapshotChildWorkspace?.(event);
		const value = event as {
			type?: string;
			toolName?: string;
			child?: SectionChildSnapshot;
			message?: { role?: string; provider?: string; model?: string; usage?: unknown };
		};
		if (value.type === "tool_execution_start") rootToolCalls += 1;
		if (value.type === "message_end" && value.message?.role === "assistant") {
			addUsage(rootUsage, value.message.usage);
		}
		if (value.type === "rlm_child_update" && value.child?.id) {
			childrenById.set(value.child.id, value.child);
		}
		if (shouldRecordTraceEvent(value)) {
			appendFileSync(eventLog, `${JSON.stringify(projectPrimeChildLifecycleEvent(value))}\n`);
		}
	} catch {
		// Observability must not interrupt report generation.
	}
});

let terminalValidationError: string | undefined;
try {
	console.log("[prime-report] root planning started");
	if (!existsSync(authoredOutlinePath)) {
		await prompt(initialPrompt);
	}
	for (let submission = 1; submission <= 2; submission += 1) {
		try {
			if (!existsSync(authoredOutlinePath)) throw new Error("work/report-outline.json is missing");
			materializeAuthoredOutline(authoredOutlinePath);
			break;
		} catch (error) {
			const validationError = toErrorMessage(error);
			if (submission === 2) {
				terminalValidationError = validationError;
				throw error;
			}
			await prompt([
				"Runtime rejected work/report-outline.json. Repair that complete file before delegation.",
				`Validation error: ${validationError}`,
			].join("\n\n"), { streamingBehavior: "followUp" });
		}
	}
	outline = readOutline(authoredOutlinePath);
	if (outline.sections.length === 0) throw new Error("Prime Report Writer authored an outline with no Section");
	await prompt(delegationPrompt, { streamingBehavior: "followUp" });
	console.log(`[prime-report] waiting for ${outline.sections.length} Section children`);
	await waitForSectionChildren();
	console.log("[prime-report] child drafts complete; same root editing");
	await prompt(finalPrompt, { streamingBehavior: "followUp" });
	materializeFinalOutput();
	for (let submission = 1; submission <= 2; submission += 1) {
		const validation = await requestRuntimeValidation(submission);
		if (validation.accepted) break;
		const validationError = validation.error || "Runtime rejected writer-output without an error description";
		if (submission === 2) {
			terminalValidationError = validationError;
			throw new Error(validationError);
		}
		await prompt(`${finalRepairPrompt}\n\nRuntime validation error:\n${validationError}`, { streamingBehavior: "followUp" });
		materializeFinalOutput();
	}
} catch (error) {
	await reportWorkerFailure(
		terminalValidationError ? "validation" : "provider",
		terminalValidationError ?? (toErrorMessage(error)),
	);
	throw error;
} finally {
	await session.abort().catch(() => undefined);
	session.dispose();
}

const childMetrics = readChildMetrics(rlmSessionDir);
writeFileSync(join(runtimeRoot, "result.json"), `${JSON.stringify({
	schema_version: 1,
	root_model: `${rootProvider}/${rootModelId}`,
	child_model: `${childProvider}/${childModelId}`,
	root_usage: rootUsage,
	child_usage: childMetrics.usage,
	usage: sumUsage(rootUsage, childMetrics.usage),
	tool_calls: rootToolCalls + childMetrics.toolCalls,
	turns: rootUsage.model_calls + childMetrics.usage.model_calls,
	session_path: session.sessionFile ?? eventLog,
}, null, 2)}\n`);

async function prompt(text: string, options?: { streamingBehavior: "followUp" }): Promise<void> {
	await session.prompt(text, options);
	assertPrimeModelAnswered(session);
}

/**
 * 等 Section 子 Agent 跑完，依据是 SDK 原生上报的子 Agent 状态，而不是"盘上有没有 draft.md"。
 * 用产物存在与否代替状态查询，分不清"还在写"和"已经死了"：一个子 Agent 掉线就再也写不出草稿，
 * 于是等待条件永远不成立，整个 Stage 无限期挂住——这个 Stage 恰好是全链最贵的一段。
 */
async function waitForSectionChildren(): Promise<void> {
	const expected = outline.sections.filter((section) => !completedSections.has(section.section_id)).length;
	await session.waitForRlmQuiescence();
	assertPrimeModelAnswered(session);
	const decision = decideSectionChildren({
		children: [...childrenById.values()],
		expected,
	});
	if (decision.kind === "failed") throw new Error(decision.message);
	const missing = outline.sections
		.map((section) => section.section_id)
		.filter((id) => !["draft.md", "ledger.md"].every((name) => {
			const path = join(cwd, "work", "sections", id, name);
			return existsSync(path) && readFileSync(path, "utf-8").trim().length > 0;
		}));
	if (missing.length > 0) {
		throw new Error(`Section children finished without drafts for: ${missing.join(", ")}`);
	}
}


function readOutline(path: string): { sections: Array<{ section_id: string; title: string }> } {
	const value = JSON.parse(readFileSync(path, "utf-8")) as { sections?: Array<{ section_id?: unknown; title?: unknown }> };
	if (!Array.isArray(value.sections)) throw new Error(`${path} must carry a sections array`);
	return {
		sections: value.sections.map((section, index) => {
			if (typeof section?.section_id !== "string" || !section.section_id.trim()) {
				throw new Error(`${path} Section ${index + 1} requires a section_id`);
			}
			if (typeof section.title !== "string" || !section.title.trim()) {
				throw new Error(`${path} Section ${index + 1} requires a title`);
			}
			return { section_id: section.section_id, title: section.title.trim() };
		}),
	};
}

function materializeAuthoredOutline(path: string): void {
	let value: { title?: unknown; sections?: unknown };
	try {
		value = JSON.parse(readFileSync(path, "utf-8")) as { title?: unknown; sections?: unknown };
	} catch (error) {
		throw new Error(`work/report-outline.json must be valid JSON: ${toErrorMessage(error)}`);
	}
	if (typeof value.title !== "string" || !value.title.trim()) {
		throw new Error("work/report-outline.json.title must be a non-empty string");
	}
	if (!Array.isArray(value.sections) || value.sections.length === 0) {
		throw new Error("work/report-outline.json.sections must be a non-empty array");
	}
	const sections = value.sections.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`work/report-outline.json.sections[${index}] must be an object`);
		}
		const section = raw as Record<string, unknown>;
		const materialRefs = knowledgeMode === "wiki" ? "knowledge_refs" : "cornell_notes_refs";
		const expectedKeys = section.section_id === undefined
			? [materialRefs, "purpose", "title"].sort()
			: [materialRefs, "purpose", "section_id", "title"].sort();
		if (JSON.stringify(Object.keys(section).sort()) !== JSON.stringify(expectedKeys)) {
			throw new Error(`work/report-outline.json.sections[${index}] fields are invalid; expected ${expectedKeys.join(", ")}; received ${Object.keys(section).sort().join(", ")}`);
		}
		for (const field of ["title", "purpose"] as const) {
			if (typeof section[field] !== "string" || !section[field].trim()) {
				throw new Error(`work/report-outline.json.sections[${index}].${field} must be a non-empty string`);
			}
		}
		if (!Array.isArray(section[materialRefs]) || section[materialRefs].length === 0) {
			throw new Error(`work/report-outline.json.sections[${index}].${materialRefs} must be a non-empty array`);
		}
		const refs = section[materialRefs] as string[];
		const invalidRef = refs.findIndex((ref) => typeof ref !== "string" || !ref.trim() || !allowedMaterialRefs.has(ref));
		if (invalidRef >= 0) {
			throw new Error(`work/report-outline.json.sections[${index}].${materialRefs}[${invalidRef}] contains unknown ref '${String(refs[invalidRef])}'; allowed refs: ${[...allowedMaterialRefs].join(", ")}`);
		}
		if (new Set(refs).size !== refs.length) {
			throw new Error(`work/report-outline.json.sections[${index}].${materialRefs} contains duplicate refs`);
		}
		const sectionId = `section-${String(index + 1).padStart(3, "0")}`;
		if (section.section_id !== undefined && section.section_id !== sectionId) {
			throw new Error(`work/report-outline.json.sections[${index}].section_id must be Runtime ID '${sectionId}', got '${String(section.section_id)}'`);
		}
		return { ...section, section_id: sectionId };
	});
	writeFileSync(path, `${JSON.stringify({ title: value.title.trim(), sections }, null, 2)}\n`);
}

function materializeFinalOutput(): void {
	const outputRoot = join(cwd, "writer-output");
	const marker = join(outputRoot, ".complete");
	rmSync(marker, { force: true });
	if (!outline.sections.every((section) => {
		const path = join(outputRoot, "sections", `${section.section_id}.md`);
		return existsSync(path) && readFileSync(path, "utf-8").trim().length > 0;
	})) return;
	mkdirSync(outputRoot, { recursive: true });
	writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
		schema_version: 1,
		sections: outline.sections.map((section) => ({
			section_id: section.section_id,
			path: `sections/${section.section_id}.md`,
			title: section.title,
		})),
	}, null, 2)}\n`);
	writeFileSync(marker, "");
}

function requestRuntimeValidation(submission: number): Promise<{ accepted: boolean; error?: string }> {
	if (!process.send) throw new Error("Prime Report Writer requires a Runtime validation channel");
	return new Promise((resolvePromise) => {
		const onMessage = (message: unknown) => {
			if (!isRecord(message) || message.type !== "stage_output_validation" || message.submission !== submission) return;
			process.off("message", onMessage);
			resolvePromise({
				accepted: message.accepted === true,
				...(typeof message.error === "string" ? { error: message.error } : {}),
			});
		};
		process.on("message", onMessage);
		process.send!({ type: "stage_output_candidate", submission });
	});
}

async function reportWorkerFailure(failureClass: "validation" | "provider", error: string): Promise<void> {
	if (!process.send) return;
	await new Promise<void>((resolvePromise) => {
		try {
			process.send!({ type: "stage_worker_failure", failure_class: failureClass, error }, () => resolvePromise());
		} catch {
			resolvePromise();
		}
	});
}

function readChildMetrics(root: string): { usage: Usage; toolCalls: number } {
	const usage = emptyUsage();
	let toolCalls = 0;
	for (const path of listFilesRecursive(root).map((rel) => join(root, rel)).filter((value) => value.endsWith(".jsonl"))) {
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			const event = JSON.parse(line) as unknown;
			if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "assistant") continue;
			addUsage(usage, event.message.usage);
			if (Array.isArray(event.message.content)) {
				toolCalls += event.message.content.filter((part) => isRecord(part) && part.type === "toolCall").length;
			}
		}
	}
	return { usage, toolCalls };
}

interface Usage {
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	model_calls: number;
}

function emptyUsage(): Usage {
	return { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
}

function addUsage(total: Usage, value: unknown): void {
	if (!isRecord(value)) return;
	total.input_tokens += finite(value.input);
	total.output_tokens += finite(value.output);
	total.model_calls += 1;
	if (isRecord(value.cost)) total.cost_usd += finite(value.cost.total);
}

function sumUsage(left: Usage, right: Usage): Usage {
	return {
		input_tokens: left.input_tokens + right.input_tokens,
		output_tokens: left.output_tokens + right.output_tokens,
		cost_usd: left.cost_usd + right.cost_usd,
		model_calls: left.model_calls + right.model_calls,
	};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function stringArray(name: string, allowEmpty = false): string[] {
	const value = JSON.parse(process.env[name] || "[]") as unknown;
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
		|| !value.every((item) => typeof item === "string" && item.trim())) {
		throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} JSON string array`);
	}
	return value;
}
