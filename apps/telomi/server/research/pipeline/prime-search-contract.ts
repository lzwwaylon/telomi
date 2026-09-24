import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { materializePrimeSourceOrganizerDecision, validatePrimeSourceOrganizerIndex } from "./prime-source-organizer-index.js";
import { providerExecutionWorkspaceForSession } from "./provider-execution-workspace.js";
import { listSourceFiles } from "./source-bundle.js";
import { isInsideRoot } from "../../lib/paths.js";
import { isRecord, toErrorMessage } from "../../lib/values.js";
import { writeFileAtomic } from "../../lib/fs.js";

const MAX_CANDIDATE_SUMMARY_CHARACTERS = 2_000;
const SubmitCandidateLedgerParams = Type.Object({
	provider_id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
}, { additionalProperties: false });
const SubmitOrganizerDecisionParams = Type.Object({}, { additionalProperties: false });
/** Runtime-owned copy of the Organizer input the decision is validated against; the Agent never writes it. */
export const ORGANIZER_RUNTIME_INDEX = ".runtime/index.json";
// Distinct from organizer/.complete, which the Runtime writes after projecting the accepted decision.
export const ORGANIZER_COMPLETE_MARKER = ".decision-submitted";
/** Directory under the Prime Search agent root holding one execution workspace per Provider child and its Candidate Ledger. */
export const PROVIDER_EXECUTIONS_DIRECTORY = "provider-executions";

export function createPrimeSearchContractTools(artifactRoot: string): ToolDefinition[] {
	const root = resolve(artifactRoot);
	return [candidateLedgerTool(root)];
}

function candidateLedgerTool(root: string): ToolDefinition<typeof SubmitCandidateLedgerParams> {
	return {
		name: "submit_candidate_ledger",
		label: "submit_candidate_ledger",
		description: "Validate and submit this Provider child's Candidate Ledger after writing it. Repair the same file and retry if validation fails.",
		parameters: SubmitCandidateLedgerParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const execution = providerExecutionWorkspaceForSession(root, context.sessionManager.getSessionDir?.());
			if (!execution) throw new Error("Only a Prime Search Provider child can submit a Candidate Ledger");
			const ledgerPath = join(execution.absolutePath, "work", `${params.provider_id}_candidates.json`);
			const marker = join(execution.absolutePath, "work", ".provider-assignment");
			try {
				validatePrimeSearchCandidateLedger(execution.absolutePath, params.provider_id, ledgerPath, execution.childId);
				writeFileSync(marker, `${params.provider_id}\n`, "utf-8");
				return { content: [{ type: "text", text: "Candidate Ledger validated and submitted" }],
					details: { provider_id: params.provider_id, ledger_path: `work/${params.provider_id}_candidates.json` } };
			} catch (error) {
				if (existsSync(marker)) unlinkSync(marker);
				throw error;
			}
		},
	};
}

export function createPrimeOrganizerContractTools(organizerRoot: string): ToolDefinition[] {
	const root = resolve(organizerRoot);
	return [{
		name: "submit_organizer_decision",
		label: "submit_organizer_decision",
		description: "Validate and submit this Organizer's decision.json. Repair the same file and retry if validation fails.",
		parameters: SubmitOrganizerDecisionParams,
		executionMode: "sequential",
		async execute() {
			const marker = join(root, ORGANIZER_COMPLETE_MARKER);
			try {
				validatePrimeOrganizerDecisionFile(root);
				writeFileSync(marker, "validated\n", "utf-8");
				return { content: [{ type: "text", text: "Organizer decision validated and submitted" }], details: {} };
			} catch (error) {
				if (existsSync(marker)) unlinkSync(marker);
				throw error;
			}
		},
	}];
}

/** Applies the decision to the Runtime index without persisting anything; throws the precise validation error. */
export function validatePrimeOrganizerDecisionFile(organizerRoot: string): ReturnType<typeof materializePrimeSourceOrganizerDecision> {
	const decisionPath = join(organizerRoot, "decision.json");
	if (!existsSync(decisionPath)) throw new Error("decision.json does not exist");
	const runtime = parseJson(readFileSync(join(organizerRoot, ORGANIZER_RUNTIME_INDEX), "utf-8"), "Organizer runtime index");
	if (!isRecord(runtime) || !Array.isArray(runtime.new_source_ids)) throw new Error("Organizer runtime index is invalid");
	return materializePrimeSourceOrganizerDecision(
		validatePrimeSourceOrganizerIndex(runtime.index),
		parseJson(readFileSync(decisionPath, "utf-8"), "decision.json"),
		runtime.new_source_ids.map((id, index) => requiredString(id, `Organizer runtime index new_source_ids[${index}]`)),
	);
}

export function primeProviderAssignments(root: string): Array<{
	childId: string;
	providerId: string;
	workRoot: string;
	ledgerPath: string;
}> {
	const executionRoot = join(root, PROVIDER_EXECUTIONS_DIRECTORY);
	if (!existsSync(executionRoot)) return [];
	return readdirSync(executionRoot, { withFileTypes: true }).flatMap((execution) => {
		if (!execution.isDirectory() || !/^sub-[A-Za-z0-9-]+$/u.test(execution.name)) return [];
		const workRoot = join(executionRoot, execution.name, "work");
		const marker = join(workRoot, ".provider-assignment");
		if (!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) return [];
		const providerId = readFileSync(marker, "utf-8").trim();
		if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(providerId)) return [];
		const ledgerPath = join(workRoot, `${providerId}_candidates.json`);
		return existsSync(ledgerPath) ? [{ childId: execution.name, providerId, workRoot, ledgerPath }] : [];
	});
}


export function validatePrimeSearchCandidateLedger(
	root: string,
	providerId: string,
	ledgerPath: string,
	executionId?: string,
): void {
	const resolvedRoot = realpathSync(root);
	if (!existsSync(ledgerPath)) throw new Error("Candidate Ledger file does not exist");
	const resolvedLedger = realpathSync(ledgerPath);
	if (!isInsideRoot(join(resolvedRoot, "work"), resolvedLedger)) {
		throw new Error("Candidate Ledger must stay under work/");
	}
	const ledger = parseJson(readFileSync(resolvedLedger, "utf-8"), "Candidate Ledger");
	if (!isRecord(ledger)) throw new Error("Candidate Ledger must be an object");
	const materialized = ledger.schema_version !== undefined || ledger.provider_id !== undefined;
	assertExactKeys(ledger, materialized
		? ["schema_version", "provider_id", "candidates"]
		: ["candidates"], "Candidate Ledger");
	if (materialized && (ledger.schema_version !== 2 || ledger.provider_id !== providerId)) {
		throw new Error(`Runtime Candidate Ledger identity must match Provider '${providerId}' and schema 2`);
	}
	if (!Array.isArray(ledger.candidates)) throw new Error("candidates must be an array");
	const urls = new Set<string>();
	const claimedMaterials = new Map<string, number>();
	for (const [candidateIndex, candidate] of ledger.candidates.entries()) {
		if (!isRecord(candidate)) throw new Error(`candidates[${candidateIndex}] must be an object`);
		assertExactKeys(candidate, materialized
			? ["candidate_ref", "title", "url", "query", "summary", "metadata", "material_paths"]
			: ["title", "url", "query", "summary", "metadata", "material_paths"],
		`candidates[${candidateIndex}]`);
		if (materialized && candidate.candidate_ref !== candidateRef(providerId, candidateIndex, executionId)) {
			throw new Error(`candidates[${candidateIndex}].candidate_ref is not Runtime-assigned`);
		}
		requiredString(candidate.title, `candidates[${candidateIndex}].title`);
		const url = requiredString(candidate.url, `candidates[${candidateIndex}].url`);
		if (!/^https?:\/\//iu.test(url)) throw new Error(`candidates[${candidateIndex}].url must be HTTP(S)`);
		if (urls.has(url)) throw new Error(`duplicate candidate URL '${url}'`);
		urls.add(url);
		requiredString(candidate.query, `candidates[${candidateIndex}].query`);
		const summary = requiredString(candidate.summary, `candidates[${candidateIndex}].summary`);
		if ([...summary].length > MAX_CANDIDATE_SUMMARY_CHARACTERS) {
			throw new Error(`candidates[${candidateIndex}].summary cannot exceed ${MAX_CANDIDATE_SUMMARY_CHARACTERS} characters`);
		}
		if (!isRecord(candidate.metadata)) throw new Error(`candidates[${candidateIndex}].metadata must be an object`);
		if (!Array.isArray(candidate.material_paths) || candidate.material_paths.length === 0) {
			throw new Error(`candidates[${candidateIndex}].material_paths must be a non-empty array`);
		}
		const materialPaths = candidate.material_paths.map((value, pathIndex) => {
			const path = requiredString(value, `candidates[${candidateIndex}].material_paths[${pathIndex}]`);
			const label = `candidates[${candidateIndex}].material_paths[${pathIndex}]`;
			const resolved = validateMaterialPath(resolvedRoot, path, label);
			if (lstatSync(resolved).isDirectory()) {
				try {
					listSourceFiles(resolved);
				} catch (error) {
					throw new Error(`${label}: ${toErrorMessage(error)}; point at the relevant subdirectory or files instead`);
				}
			}
			const owner = claimedMaterials.get(resolved);
			if (owner !== undefined) {
				throw new Error(`candidates[${candidateIndex}].material_paths[${pathIndex}] already belongs to candidates[${owner}]`);
			}
			claimedMaterials.set(resolved, candidateIndex);
			return resolved;
		});
		if (providerId === "arxiv" && !materialPaths.some(isConvertedMarkdownMaterial)) {
			throw new Error(`candidates[${candidateIndex}] must use arxiv.download_pdf() and include its converted Markdown download_path; metadata JSON is not full-text evidence`);
		}
		if (providerId === "huggingface" && /^https:\/\/huggingface\.co\/papers\//iu.test(url)
			&& !materialPaths.some(isHuggingFacePaperBundle)) {
			throw new Error(`candidates[${candidateIndex}] must use huggingface.download_paper() and include its paper.md plus metadata.json bundle; search metadata is not full-text evidence`);
		}
	}
	if (!materialized) writeMaterializedLedger(ledgerPath, providerId, ledger.candidates, executionId);
}

function writeMaterializedLedger(
	path: string,
	providerId: string,
	candidates: readonly Record<string, unknown>[],
	executionId?: string,
): void {
	writeFileAtomic(path, `${JSON.stringify({
		schema_version: 2,
		provider_id: providerId,
		candidates: candidates.map((candidate, index) => ({
			candidate_ref: candidateRef(providerId, index, executionId),
			...candidate,
		})),
	}, null, 2)}\n`);
}

function candidateRef(providerId: string, index: number, executionId?: string): string {
	const execution = executionId ? `-${executionId.replace(/[^A-Za-z0-9]+/gu, "-")}` : "";
	return `C-${providerId.replace(/[^A-Za-z0-9]+/gu, "-")}${execution}-${String(index + 1).padStart(3, "0")}`;
}

function validateMaterialPath(root: string, value: string, label: string): string {
	if (/^https?:\/\//iu.test(value)) {
		throw new Error(`${label} must be a local existing file or directory; URL values belong in url or metadata`);
	}
	const logical = value.startsWith("/workspace/") ? join(root, value.slice("/workspace/".length)) : value;
	const absolute = isAbsolute(logical) ? logical : join(root, logical);
	if (!existsSync(absolute)) throw new Error(`${label} must be a local existing file or directory`);
	if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
	const resolved = realpathSync(absolute);
	const allowedRoots = [join(root, "artifacts"), join(root, "work", "materials")]
		.filter(existsSync)
		.map((path) => realpathSync(path));
	if (!allowedRoots.some((allowedRoot) => isInsideRoot(allowedRoot, resolved))) {
		throw new Error(`${label} must stay under artifacts/ or work/materials/`);
	}
	return resolved;
}

function isConvertedMarkdownMaterial(path: string): boolean {
	const stat = lstatSync(path);
	const directory = stat.isDirectory() ? path : dirname(path);
	if (!existsSync(join(directory, "parser-manifest.json"))) return false;
	return stat.isDirectory()
		? readdirSync(path, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".md"))
		: path.endsWith(".md");
}

function isHuggingFacePaperBundle(path: string): boolean {
	return lstatSync(path).isDirectory()
		&& existsSync(join(path, "paper.md"))
		&& existsSync(join(path, "metadata.json"));
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${toErrorMessage(error)}`);
	}
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
		throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
	}
}
