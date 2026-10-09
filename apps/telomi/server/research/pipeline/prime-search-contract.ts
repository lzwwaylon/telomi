import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";


import { materializePrimeSourceOrganizerDecision, validatePrimeSourceOrganizerIndex } from "./prime-source-organizer-index.js";
import { providerExecutionWorkspace } from "./provider-execution-workspace.js";
import { listSourceFiles } from "./source-bundle.js";
import { isInsideRoot } from "../../lib/paths.js";
import { isRecord, toErrorMessage } from "../../lib/values.js";
import { writeFileAtomic } from "../../lib/fs.js";
import { sha256 } from "../../lib/hash.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";

const MAX_CANDIDATE_SUMMARY_CHARACTERS = 2_000;
/** Runtime-owned copy of the Organizer input the decision is validated against; the Agent never writes it. */
export const ORGANIZER_RUNTIME_INDEX = ".runtime/index.json";
export const ORGANIZER_ACCEPTED_INDEX = ".runtime/accepted-index.json";
/** Directory under the Prime Search agent root holding one execution workspace per Provider child and its Candidate Ledger. */
export const PROVIDER_EXECUTIONS_DIRECTORY = "provider-executions";

/** The Providers whose discovery pool is screened in fresh model contexts; the others return every record its own fields do not exclude. */
export const SCREENED_PROVIDERS: ReadonlySet<string> = new Set(["github", "arxiv"]);
/**
 * What an Evidence Need covers. `coverage` is a category: its pool comes from the Provider's native category, and
 * names are leads looked up beside it. `named_objects` is something named, found through native search by name.
 * `exact_objects` is a fixed list of identified objects acquired without a pool. The kind is task data for the child
 * and for review: Runtime records it and rejects nothing by it.
 */
export const ASSIGNMENT_KINDS = ["coverage", "named_objects", "exact_objects"] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

/** Root registers each Evidence Need; Runtime mints its id and records its kind where no Agent can write. */
export function registerEvidenceNeed(root: string, kind: unknown): { needId: string; kind: AssignmentKind } {
	const known = ASSIGNMENT_KINDS.find((value) => value === kind);
	if (!known) throw new Error(`Evidence Need kind must be one of: ${ASSIGNMENT_KINDS.join(", ")}`);
	const needId = `need-${randomBytes(4).toString("hex")}`;
	writeFileAtomic(join(runtimeDirectory(resolve(root), "assignment-kinds"), needId), `${known}\n`, { mode: 0o600 });
	return { needId, kind: known };
}

/**
 * A child belongs to the Evidence Need whose Runtime-minted id its task carries, whatever words surround the id,
 * and has that need's kind: every child of a need has the kind the need was registered with. A task that carries
 * no registered id has no kind.
 */
export function resolveAssignmentKind(root: string, task: string): { kind?: AssignmentKind; needId?: string } {
	const directory = runtimeDirectory(resolve(root), "assignment-kinds");
	// ponytail: a task naming several needs belongs to the first one it mentions; pass the id as rlm() data if Prime ever exposes that.
	const needId = readdirSync(directory).filter((id) => task.includes(id)).sort((left, right) => task.indexOf(left) - task.indexOf(right))[0];
	if (!needId) return {};
	const recorded = readFileSync(join(directory, needId), "utf8").trim();
	return { kind: ASSIGNMENT_KINDS.find((value) => value === recorded) ?? "coverage", needId };
}

/** Validate and freeze one authenticated Provider child's final Ledger; Runtime supplies the child identity. */
export async function submitProviderCandidateLedger(artifactRoot: string, childId: string, providerId: string): Promise<{
	provider_id: string; ledger_path: string; submitted: true;
}> {
	if (!/^sub-[A-Za-z0-9-]+$/u.test(childId)) throw new Error("Only a Prime Search Provider child can submit a Candidate Ledger");
	if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(providerId)) throw new Error("Invalid Provider submission identity");
	const root = resolve(artifactRoot);
	const execution = providerExecutionWorkspace(root, childId);
	const ledgerPath = join(execution.absolutePath, "work", `${providerId}_candidates.json`);
	const marker = join(execution.absolutePath, "work", ".provider-assignment");
	const expectedPath = `work/${providerId}_candidates.json`;
	const frozenPath = join(root, ".runtime", "provider-submissions", execution.childId, "ledger.json");
	if (existsSync(frozenPath) && !lstatSync(frozenPath).isSymbolicLink() && (!existsSync(ledgerPath) || (lstatSync(ledgerPath).isFile() && !lstatSync(ledgerPath).isSymbolicLink()))) {
		// Submission is final. A child that rewrites its Ledger file and calls finish again changes nothing: it cannot
		// read the frozen copy to restore the file, so Runtime restores it here.
		const frozen = readFileSync(frozenPath);
		const rewritten = !existsSync(ledgerPath) || sha256(readFileSync(ledgerPath)) !== sha256(frozen);
		if (rewritten) writeFileAtomic(ledgerPath, frozen);
		const submitted = primeProviderSubmission(root, execution.childId);
		if (submitted?.provider_id === providerId) {
			if (!rewritten) return { provider_id: providerId, ledger_path: expectedPath, submitted: true };
			throw new ResearchNodeError("This child's Candidate Ledger is already submitted and final; Runtime restored the submitted file. Do not write the Ledger or call finish again: end the task with the completion reply. New evidence requires a new task from Root.", "permanent", false, { code: "provider_task_completed" });
		}
	}
	if (!existsSync(ledgerPath)) throw new ResearchNodeError(`Candidate Ledger file does not exist at '${expectedPath}'. Write or rename it to this exact path before submitting.`, "validation", false, {
		code: "candidate_ledger_missing", details: { provider_id: providerId, expected_path: expectedPath, next_action: "correct_path" },
	});
	const bindings = runtimeDirectory(root, "provider-bindings");
	const binding = join(bindings, execution.childId);
	if (existsSync(binding) && (lstatSync(binding).isSymbolicLink() || readFileSync(binding, "utf8").trim() !== providerId)) {
		throw new ResearchNodeError("Final submission must match this child's bound Provider.", "permanent", false, { code: "provider_scope_mismatch" });
	}
	const bytes = validatePrimeSearchCandidateLedger(execution.absolutePath, providerId, ledgerPath, execution.childId);
	const submissions = runtimeDirectory(root, "provider-submissions");
	const existing = primeProviderSubmission(root, execution.childId);
	if (existing && (existing.provider_id !== providerId || existing.ledger_sha256 !== sha256(bytes))) {
		throw new ResearchNodeError("This child's final Ledger is already frozen. Ask Root to create a new task.", "permanent", false, { code: "provider_task_completed" });
	}
	// The receipt directory rename is the sole completion commit. No fallible writes follow it.
	if (!existsSync(binding)) writeFileAtomic(binding, `${providerId}\n`, { mode: 0o600 });
	writeFileAtomic(marker, `${providerId}\n`);
	if (!existing) {
		const temporary = mkdtempSync(join(submissions, ".pending-"));
		try {
			writeFileSync(join(temporary, "ledger.json"), bytes, { mode: 0o600 });
			writeFileSync(join(temporary, "receipt.json"), JSON.stringify({ schema_version: 1,
				child_id: execution.childId, provider_id: providerId,
				ledger_sha256: sha256(bytes), ledger_byte_count: bytes.length,
			}), { mode: 0o600 });
			renameSync(temporary, join(submissions, execution.childId));
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	}
	return { provider_id: providerId, ledger_path: expectedPath, submitted: true };
}

/** Runtime's own record of the pools and screen windows of one child, kept for evaluation; the bridge appends. */
export function reviewAuditPath(root: string, childId: string): string {
	if (!/^sub-[A-Za-z0-9-]+$/u.test(childId)) throw new Error("Invalid review audit child identity");
	return join(runtimeDirectory(resolve(root), "review-windows"), `${childId}.jsonl`);
}

/** The pool of one discovery call as Runtime recorded it before anything was screened or retained. */
export interface ReviewPool {
	/** How the pool was defined: native category values and native search terms. */
	definition: { category: string[]; queries: string[] };
	/** Every pool record in pool order, with the machine exclusion its own fields raised, if any. */
	records: Array<{ id: string; excluded: string | null }>;
	/** The bounds the discovery call reported, if any. */
	screen: number | null;
	limit: number | null;
	/** Whether the Provider's survivors go through the screen. */
	screened: boolean;
}

/** Whether Runtime already recorded a pool under this attempt of the child: each discovery call names a new one. */
export function reviewAuditHasPool(auditPath: string, attempt: string): boolean {
	if (!existsSync(auditPath)) return false;
	return readFileSync(auditPath, "utf8").split("\n").some((line) => {
		if (!line.trim()) return false;
		const entry = parseJson(line, "review audit line");
		if (!isRecord(entry)) throw new Error("Invalid review audit line");
		return entry.attempt === attempt && isRecord(entry.pool);
	});
}

function runtimeDirectory(root: string, name: string): string {
	const directory = join(realpathSync(root), ".runtime", name);
	for (const path of [dirname(directory), directory]) {
		if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error("Runtime submission authority must contain real directories");
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	return directory;
}

/** Host-owned final receipt; mutable child files and assignment markers are not completion authority. */
export function primeProviderSubmission(root: string, childId: string, providerId?: string): {
	child_id: string; provider_id: string; ledger_path: string; ledger_sha256: string;
} | undefined {
	if (!/^sub-[A-Za-z0-9-]+$/u.test(childId)) throw new Error("Invalid Provider submission child identity");
	const directory = join(root, ".runtime", "provider-submissions", childId);
	if (!existsSync(directory)) return undefined;
	for (const path of [join(root, ".runtime"), dirname(directory), directory, join(directory, "receipt.json"), join(directory, "ledger.json")]) {
		if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error("Invalid Provider submission authority");
	}
	const receipt = parseJson(readFileSync(join(directory, "receipt.json"), "utf8"), "Provider submission receipt");
	const ledgerPath = join(directory, "ledger.json");
	const bytes = readFileSync(ledgerPath);
	if (!isRecord(receipt) || receipt.schema_version !== 1 || receipt.child_id !== childId
		|| typeof receipt.provider_id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(receipt.provider_id)
		|| receipt.ledger_sha256 !== sha256(bytes) || receipt.ledger_byte_count !== bytes.length) {
		throw new ResearchNodeError("Invalid or corrupted frozen Provider submission.", "permanent", false, { code: "provider_submission_corrupt" });
	}
	if (providerId !== undefined && receipt.provider_id !== providerId) return undefined;
	const expectedPath = `work/${receipt.provider_id}_candidates.json`;
	const draftPath = join(root, PROVIDER_EXECUTIONS_DIRECTORY, childId, expectedPath);
	if (!existsSync(draftPath) || !lstatSync(draftPath).isFile() || lstatSync(draftPath).isSymbolicLink()
		|| sha256(readFileSync(draftPath)) !== receipt.ledger_sha256) {
		throw new ResearchNodeError("The submitted Candidate Ledger was changed or removed after final submission. Restore its frozen contents; new evidence requires a new task.", "permanent", false, {
			code: "candidate_ledger_modified_after_submission", details: { child_id: childId, provider_id: receipt.provider_id, expected_path: expectedPath, next_action: "restore_frozen_ledger" },
		});
	}
	return { child_id: childId, provider_id: receipt.provider_id, ledger_path: ledgerPath, ledger_sha256: receipt.ledger_sha256 as string };
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

/** The downstream consumer reads only the host-owned result of successful validation. */
export function readAcceptedPrimeOrganizerIndex(organizerRoot: string): ReturnType<typeof validatePrimeSourceOrganizerIndex> {
	return validatePrimeSourceOrganizerIndex(parseJson(readFileSync(join(organizerRoot, ORGANIZER_ACCEPTED_INDEX), "utf8"), "Accepted Organizer index"));
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
		const submission = primeProviderSubmission(root, execution.name);
		return submission ? [{ childId: execution.name, providerId: submission.provider_id, workRoot, ledgerPath: submission.ledger_path }] : [];
	});
}


export function validatePrimeSearchCandidateLedger(
	root: string,
	providerId: string,
	ledgerPath: string,
	executionId?: string,
): Buffer {
	const resolvedRoot = realpathSync(root);
	if (!existsSync(ledgerPath)) throw new Error("Candidate Ledger file does not exist");
	const resolvedLedger = realpathSync(ledgerPath);
	if (!isInsideRoot(join(resolvedRoot, "work"), resolvedLedger)) {
		throw new Error("Candidate Ledger must stay under work/");
	}
	const ledger = parseJson(readFileSync(resolvedLedger, "utf-8"), "Candidate Ledger");
	if (!isRecord(ledger)) throw new Error("Candidate Ledger must be an object");
	const materialized = ledger.schema_version !== undefined || ledger.provider_id !== undefined;
	assertExactKeys(ledger, [
		...(materialized ? ["schema_version", "provider_id"] : []),
		"candidates",
		...(ledger.discovery !== undefined ? ["discovery"] : []),
	], "Candidate Ledger");
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
	if (ledger.discovery !== undefined) validateDiscoveryPools(ledger.discovery);
	if (materialized) {
		const bytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
		writeFileAtomic(ledgerPath, bytes);
		return bytes;
	}
	return writeMaterializedLedger(ledgerPath, providerId, ledger.candidates, executionId, ledger.discovery);
}

const MAX_DISCOVERY_POOLS = 16;

/** `discovery.pools` records the discovery pools the child was served and how far it read each; it is kept for evaluation. */
function validateDiscoveryPools(value: unknown): void {
	if (!isRecord(value)) throw new Error("discovery must be an object written by CandidateLedger");
	assertExactKeys(value, ["pools"], "discovery");
	if (!Array.isArray(value.pools) || value.pools.length > MAX_DISCOVERY_POOLS) throw new Error(`discovery.pools must be an array of at most ${MAX_DISCOVERY_POOLS} pools`);
	for (const [index, pool] of value.pools.entries()) {
		const label = `discovery.pools[${index}]`;
		if (!isRecord(pool)) throw new Error(`${label} must be an object`);
		assertExactKeys(pool, ["provider", "key", "size", "served", "urls"], label);
		requiredString(pool.provider, `${label}.provider`);
		requiredString(pool.key, `${label}.key`);
		if (!Array.isArray(pool.urls) || !Number.isSafeInteger(pool.size) || !Number.isSafeInteger(pool.served)
			|| pool.urls.length !== pool.size || (pool.served as number) < 0 || (pool.served as number) > pool.urls.length) {
			throw new Error(`${label} size, served and urls disagree`);
		}
		for (const [urlIndex, url] of pool.urls.entries()) {
			if (!/^https?:\/\//iu.test(requiredString(url, `${label}.urls[${urlIndex}]`))) throw new Error(`${label}.urls[${urlIndex}] must be HTTP(S)`);
		}
	}
}

function writeMaterializedLedger(
	path: string,
	providerId: string,
	candidates: readonly Record<string, unknown>[],
	executionId?: string,
	discovery?: unknown,
): Buffer {
	const bytes = Buffer.from(`${JSON.stringify({
		schema_version: 2,
		provider_id: providerId,
		candidates: candidates.map((candidate, index) => ({
			candidate_ref: candidateRef(providerId, index, executionId),
			...candidate,
		})),
		...(discovery !== undefined ? { discovery } : {}),
	}, null, 2)}\n`);
	writeFileAtomic(path, bytes);
	return bytes;
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
