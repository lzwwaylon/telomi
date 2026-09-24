import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildKnowledgeCitationRegistry,
	buildFindOutReportWriterSystemPrompt,
	compileCanonicalMarkdown,
	createAgentEvidenceHandles,
	findOutSelfDirectedDelegationPrompt,
	findOutSelfDirectedWriterUserPrompt,
	FULL_REPORT_WRITER_SYSTEM_PROMPT,
	materializePrimeSources,
	materializeReportPlan,
	materializeWriterChapter,
	primeSearchBatchContractIdentity,
	primeProviderCatalog,
	stageProviderWorkerSkills,
	primeReportWriterContractIdentity,
	primeProviderArtifactWorkspace,
	primeProviderOperations,
	readProviderLogs,
	primeSourceOrganizerPrompt,
	primeSearchRootUserPrompt,
	primeWriterFinalPrompt,
	primeWriterFinalRepairPrompt,
	renderReportProseLintInput,
	planFromWriterManifest,
	validateWriterAuthoredOutline,
	validateWriterChapterOutput,
	validateWriterOutput,
	wikiSelfDirectedDelegationPrompt,
	wikiSelfDirectedWriterUserPrompt,
	type PrimeAvailableProvider,
} from "../../server/research/pipeline/index.js";
import { ExecutableReportPlanSchema } from "../../server/research/pipeline/report-plan.js";
import { hashRuntimeIdentityJson } from "../../server/research/runtime.js";
import { effectiveProviderWorkerSkills, goalPrimeSearchSkills } from "../../server/agent-runtime/provider-skills.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";
import {
	createPrimeOrganizerContractTools,
	createPrimeSearchContractTools,
	primeProviderAssignments,
	validatePrimeSearchCandidateLedger,
} from "../../server/research/pipeline/prime-search-contract.js";
import {
	emptyPrimeSourceOrganizerIndex,
	materializePrimeSourceOrganizerDecision,
	preparePrimeSourceOrganizerIndex,
	projectPrimeSourceOrganizerInput,
	projectPrimeSourceOrganizerMembers,
	projectPrimeSourceOrganization,
	validatePrimeSourceOrganizerIndex,
} from "../../server/research/pipeline/prime-source-organizer-index.js";
import { renderProviderApiReference } from "../../server/research/provider-sdk-assets.js";
import { bundledAgentSkillPath, snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import type { ResearchSourceCatalogEntry } from "../../server/providers/search-types.js";
import { createResearchSourceRegistry } from "../../server/research/sources/builtin-registry.js";
import { sha256 } from "../../server/lib/hash.js";

assert.deepEqual(primeProviderOperations([
	{ child_id: "sub-one", source: "browser", operation: "open", query: "one", status: "succeeded", result_count: 1 },
	{ child_id: "sub-two", source: "browser", operation: "open", query: "two", status: "failed", result_count: 0, error: "failed" },
], { provider_id: "browser", workspace_path: "provider-executions/sub-one" }), [{
	operation: "open", request_ref: "prime:1", response_count: 1, source_count: 1, status: "succeeded",
}], "same-Provider child logs must remain execution-scoped");

const containedLogRoot = mkdtempSync(join(tmpdir(), "pi-provider-contained-log-"));
try {
	const childWork = join(containedLogRoot, "provider-executions", "sub-arxiv", "work");
	mkdirSync(childWork, { recursive: true });
	writeFileSync(join(childWork, "provider.jsonl"), [
		{ source: "arxiv", operation: "categories", query: "tts", status: "succeeded", result_count: 5 },
		{ source: "arxiv", operation: "discover_papers.lane", query: "tts", status: "contained", result_count: 0, error: "arxiv returned HTTP 429" },
		{ source: "arxiv", operation: "download_pdf", query: "tts", status: "contained", result_count: 0 },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	assert.deepEqual(primeProviderOperations(readProviderLogs(containedLogRoot), { provider_id: "arxiv", workspace_path: "provider-executions/sub-arxiv" }), [
		{ operation: "categories", request_ref: "prime:1", response_count: 5, source_count: 5, status: "succeeded" },
		{ operation: "discover_papers.lane", request_ref: "prime:2", response_count: 0, source_count: 0, status: "failed", error: "arxiv returned HTTP 429" },
		{ operation: "download_pdf", request_ref: "prime:3", response_count: 0, source_count: 0, status: "failed", error: "Contained Tool failure" },
	], "contained SDK Tool failures must degrade the bundle instead of failing the Run");
} finally {
	rmSync(containedLogRoot, { recursive: true, force: true });
}

// The identity names the models and depth this execution froze, exactly as a Run states them.
assert.deepEqual(primeSearchBatchContractIdentity({
	TELOMI_PRIME_AGENT_ROOT_MODEL: "openai-codex/gpt-5.6-terra",
	TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna",
	TELOMI_PRIME_SEARCH_THINKING_LEVEL: "medium",
}, {}), {
	id: "prime-search-batch",
	version: 65,
	rootModel: "openai-codex/gpt-5.6-terra",
	childModel: "openai-codex/gpt-5.6-luna",
	thinkingLevel: "medium",
	autoRefine: false,
	autonomous: false,
	executionAdapter: "prime-sdk-rlm-quiescence-v2",
	candidateLedgerValidation: "sdk-custom-tool-candidate-materials-v6",
	providerWorkerSkills: "catalog-declared-bundled-skill-with-goal-override",
	organizerWorkspace: "metadata-only-ipython-no-rlm",
	promptBundle: {
		acquisition: "root-web-native-provider-children-v51",
		organizer: "incremental-source-group-patch-v7",
	},
	schema: {
		candidate_ledger: 2,
		organizer_decision: 2,
		organizer_index: 2,
		source_index: 2,
		source_record: 2,
		organizer_groups: 1,
	},
});

const organizerPrompt = primeSourceOrganizerPrompt(1);
assert.match(organizerPrompt, /Runtime-owned handles/u);
assert.doesNotMatch(organizerPrompt, /source:example|group_id|schema_version/u);
assert.match(primeWriterFinalRepairPrompt("findout"), /square-bracket numeric citation[\s\S]+`\[1\]`[\s\S]+<cite>/u);

const providerWorkspaceRoot = mkdtempSync(join(tmpdir(), "pi-provider-workspace-"));
try {
	const executionWorkspace = join(providerWorkspaceRoot, "provider-executions", "sub-browser-1");
	mkdirSync(executionWorkspace, { recursive: true });
	assert.equal(primeProviderArtifactWorkspace(providerWorkspaceRoot, executionWorkspace), realpathSync(executionWorkspace));
	assert.equal(primeProviderArtifactWorkspace(providerWorkspaceRoot, providerWorkspaceRoot), realpathSync(providerWorkspaceRoot));
	const unassigned = join(providerWorkspaceRoot, "provider-executions", "manual");
	mkdirSync(unassigned, { recursive: true });
	assert.throws(() => primeProviderArtifactWorkspace(providerWorkspaceRoot, unassigned), /Runtime-assigned execution workspace/u);
} finally {
	rmSync(providerWorkspaceRoot, { recursive: true, force: true });
}

const ledgerHookRoot = mkdtempSync(join(tmpdir(), "pi-prime-ledger-hook-"));
const previousArtifactWorkspace = process.env.PRIME_AGENT_ARTIFACT_WORKSPACE;
try {
	process.env.PRIME_AGENT_ARTIFACT_WORKSPACE = ledgerHookRoot;
	const huggingFacePaperBundle = join(ledgerHookRoot, "work", "materials", "huggingface", "paper");
	mkdirSync(huggingFacePaperBundle, { recursive: true });
	writeFileSync(join(huggingFacePaperBundle, "paper.md"), "# Paper\n");
	writeFileSync(join(huggingFacePaperBundle, "metadata.json"), "{}\n");
	const ledgerPath = join(ledgerHookRoot, "work", "huggingface_candidates.json");
	const validLedger = {
		candidates: [{
			title: "Qwen3-TTS",
			url: "https://huggingface.co/papers/2601.15621",
			query: "multilingual TTS",
			summary: "Primary paper record.",
			metadata: {},
			material_paths: ["work/materials/huggingface/paper"],
		}],
	};
	writeFileSync(ledgerPath, `${JSON.stringify({
		...validLedger,
		candidates: [
			validLedger.candidates[0],
			{
				...validLedger.candidates[0],
				title: "Another model",
				url: "https://huggingface.co/another/model",
			},
		],
	})}\n`);
	assert.throws(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "huggingface", ledgerPath),
		/material_paths\[0\].*already belongs to candidates\[0\]/iu);
	// A material directory is checked against the Source limits at submission, so the child Agent
	// hears about an empty or oversized directory while it can still narrow the material.
	mkdirSync(join(ledgerHookRoot, "work", "materials", "huggingface", "empty-clone"), { recursive: true });
	writeFileSync(ledgerPath, `${JSON.stringify({
		candidates: [{ ...validLedger.candidates[0], material_paths: ["work/materials/huggingface/empty-clone"] }],
	})}\n`);
	assert.throws(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "huggingface", ledgerPath),
		/material_paths\[0\].*must not be empty.*subdirectory/iu);
	writeFileSync(ledgerPath, `${JSON.stringify({
		candidates: [{ ...validLedger.candidates[0], material_paths: ["work/materials/huggingface/paper/metadata.json"] }],
	})}\n`);
	assert.throws(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "huggingface", ledgerPath),
		/must use huggingface\.download_paper\(\).*paper\.md plus metadata\.json/iu);
	writeFileSync(ledgerPath, `${JSON.stringify(validLedger)}\n`);
	assert.doesNotThrow(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "huggingface", ledgerPath));
	const materializedLedger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as Record<string, unknown>;
	assert.equal(materializedLedger.schema_version, 2);
	assert.equal(materializedLedger.provider_id, "huggingface");
	assert.equal((materializedLedger.candidates as Array<Record<string, unknown>>)[0]?.candidate_ref,
		"C-huggingface-001");
	writeFileSync(ledgerPath, `${JSON.stringify({
		...validLedger,
		candidates: [{ ...validLedger.candidates[0], summary: "x".repeat(2_001) }],
	})}\n`);
	assert.throws(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "huggingface", ledgerPath),
		/summary cannot exceed 2000 characters/iu);
	writeFileSync(ledgerPath, `${JSON.stringify({
		...validLedger,
		candidates: [{ ...validLedger.candidates[0], material_paths: ["https://huggingface.co/papers/2601.15621.md"] }],
	})}\n`);
	assert.throws(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "huggingface", ledgerPath),
		/material_paths\[0\].*local existing file or directory.*URL/iu);

	const arxivMaterialRoot = join(ledgerHookRoot, "work", "materials", "arxiv");
	mkdirSync(arxivMaterialRoot, { recursive: true });
	writeFileSync(join(arxivMaterialRoot, "paper.json"), "{}\n");
	const arxivLedgerPath = join(ledgerHookRoot, "work", "arxiv_candidates.json");
	const arxivLedger = {
		candidates: [{
			title: "FireRedTTS3",
			url: "https://arxiv.org/abs/2608.17492v2",
			query: "speech generation",
			summary: "Primary paper record.",
			metadata: {},
			material_paths: ["work/materials/arxiv/paper.json"],
		}],
	};
	writeFileSync(arxivLedgerPath, `${JSON.stringify(arxivLedger)}\n`);
	assert.throws(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "arxiv", arxivLedgerPath),
		/arxiv\.download_pdf\(\).*converted Markdown/iu);
	const convertedPaperRoot = join(ledgerHookRoot, "artifacts", "arxiv", "papers", "paper");
	mkdirSync(convertedPaperRoot, { recursive: true });
	writeFileSync(join(convertedPaperRoot, "paper.md"), "# FireRedTTS3\n");
	writeFileSync(join(convertedPaperRoot, "parser-manifest.json"), '{"assets":[]}\n');
	writeFileSync(arxivLedgerPath, `${JSON.stringify({
		...arxivLedger,
		candidates: [{
			...arxivLedger.candidates[0],
			material_paths: ["/workspace/artifacts/arxiv/papers/paper/paper.md"],
		}],
	})}\n`);
	assert.doesNotThrow(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "arxiv", arxivLedgerPath));
	const broadArxivCandidates = Array.from({ length: 21 }, (_, index) => {
		const material = join(convertedPaperRoot, `paper-${index}.md`);
		writeFileSync(material, `# Paper ${index}\n`);
		return {
			...arxivLedger.candidates[0],
			title: `Paper ${index}`,
			url: `https://arxiv.org/abs/2608.${String(index).padStart(5, "0")}`,
			material_paths: [`/workspace/artifacts/arxiv/papers/paper/paper-${index}.md`],
		};
	});
	writeFileSync(arxivLedgerPath, `${JSON.stringify({ candidates: broadArxivCandidates })}\n`);
	assert.doesNotThrow(() => validatePrimeSearchCandidateLedger(ledgerHookRoot, "arxiv", arxivLedgerPath),
		"arXiv Candidate Ledgers must not have a fixed semantic shortlist limit");
	const contractTools = createPrimeSearchContractTools(ledgerHookRoot);
	const candidateTool = contractTools.find((tool) => tool.name === "submit_candidate_ledger")!;
	const providerContext = { sessionManager: {
		getSessionDir: () => join(ledgerHookRoot, "sessions", "sub-tool-provider"),
	} } as never;
	const submittedWork = join(ledgerHookRoot, "provider-executions", "sub-tool-provider", "work");
	mkdirSync(join(submittedWork, "materials", "huggingface"), { recursive: true });
	writeFileSync(join(submittedWork, "materials", "huggingface", "model.md"), "# Model\n");
	const submittedLedgerPath = join(submittedWork, "huggingface_candidates.json");
	writeFileSync(submittedLedgerPath, "{}\n");
	await assert.rejects(candidateTool.execute(
		"candidate-invalid", { provider_id: "huggingface" }, undefined, undefined, providerContext,
	), /Candidate Ledger must contain exactly/iu);
	assert.equal(existsSync(join(submittedWork, ".provider-assignment")), false);
	writeFileSync(submittedLedgerPath, `${JSON.stringify({ candidates: [{
		...validLedger.candidates[0],
		url: "https://huggingface.co/example/model",
		material_paths: ["work/materials/huggingface/model.md"],
	}] })}\n`);
	await candidateTool.execute(
		"candidate-valid", { provider_id: "huggingface" }, undefined, undefined, providerContext,
	);
	assert.equal(readFileSync(join(submittedWork, ".provider-assignment"), "utf-8"), "huggingface\n");

	const staleLedgerDirectory = join(ledgerHookRoot, "provider-executions", "sub-stale", "work");
	mkdirSync(staleLedgerDirectory, { recursive: true });
	writeFileSync(join(staleLedgerDirectory, "huggingface_candidates.json"), `${JSON.stringify({
		...materializedLedger,
		candidates: (materializedLedger.candidates as Array<Record<string, unknown>>).map((candidate) => ({
			...candidate,
			candidate_ref: "C-huggingface-stale-001",
		})),
	})}\n`);
	const rootLedgerDirectory = join(ledgerHookRoot, "provider-executions", "sub-huggingface", "work");
	mkdirSync(rootLedgerDirectory, { recursive: true });
	writeFileSync(join(rootLedgerDirectory, ".provider-assignment"), "huggingface\n");
	writeFileSync(join(rootLedgerDirectory, "huggingface_candidates.json"), `${JSON.stringify(materializedLedger)}\n`);
	const assignedChildren = primeProviderAssignments(ledgerHookRoot).map((assignment) => assignment.childId);
	assert.ok(assignedChildren.includes("sub-huggingface"));
	assert.ok(!assignedChildren.includes("sub-stale"), "a failed child Ledger without a Provider assignment marker must be ignored");
	assert.equal(contractTools.some((tool) => tool.name === "submit_prime_selection"), false);
} finally {
	if (previousArtifactWorkspace === undefined) delete process.env.PRIME_AGENT_ARTIFACT_WORKSPACE;
	else process.env.PRIME_AGENT_ARTIFACT_WORKSPACE = previousArtifactWorkspace;
	rmSync(ledgerHookRoot, { recursive: true, force: true });
}

const organizerItems = [{
	candidateId: "github:qwen3-tts",
	sourceId: "source:github-qwen3",
	providerId: "github",
	title: "Qwen3-TTS",
	url: "https://github.com/QwenLM/Qwen3-TTS",
	summary: "Official implementation.",
	revisionSha256: "1".repeat(64),
	snapshotPath: "snapshots/github/qwen3",
}, {
	candidateId: "arxiv:2601.15621",
	sourceId: "source:arxiv-qwen3",
	providerId: "arxiv",
	title: "Qwen3-TTS Technical Report",
	url: "https://arxiv.org/abs/2601.15621",
	summary: "Primary technical paper.",
	revisionSha256: "2".repeat(64),
	snapshotPath: "snapshots/arxiv/qwen3",
}];
const firstOrganizer = preparePrimeSourceOrganizerIndex(emptyPrimeSourceOrganizerIndex(), organizerItems);
assert.deepEqual(firstOrganizer.newSourceIds.sort(), ["source:arxiv-qwen3", "source:github-qwen3"]);
assert.deepEqual(projectPrimeSourceOrganizerInput(firstOrganizer.index, firstOrganizer.newSourceIds), {
	new_sources: [{
		source_ref: "S001", provider: "arxiv", title: "Qwen3-TTS Technical Report",
		url: "https://arxiv.org/abs/2601.15621", summary: "Primary technical paper.",
	}, {
		source_ref: "S002", provider: "github", title: "Qwen3-TTS",
		url: "https://github.com/QwenLM/Qwen3-TTS", summary: "Official implementation.",
	}],
	ungrouped_sources: [],
	cached_groups: [],
});
const runtimeGroupedOrganizer = materializePrimeSourceOrganizerDecision(firstOrganizer.index, {
	groups: [{
		title: "Qwen3-TTS",
		identity: "The official implementation and primary technical paper describe the same Qwen3-TTS release.",
		members: ["S001", "S002"],
	}],
	ungrouped: [],
}, firstOrganizer.newSourceIds);
assert.match(runtimeGroupedOrganizer.sources["source:github-qwen3"]!.group_id!, /^qwen3-tts-[a-f0-9]{12}$/u);
assert.deepEqual(Object.keys(runtimeGroupedOrganizer.groups),
	[runtimeGroupedOrganizer.sources["source:github-qwen3"]!.group_id]);
// Same-Provider members are a semantic call for the Organizer (size variants of one release); Runtime checks only size.
const sameProviderOrganizer = preparePrimeSourceOrganizerIndex(emptyPrimeSourceOrganizerIndex(), ["0.6B", "1.7B"].map((size) => ({
	candidateId: `huggingface:qwen3-tts-${size}`,
	sourceId: `source:huggingface-qwen3-${size}`,
	providerId: "huggingface",
	title: `Qwen3-TTS-${size}`,
	url: `https://huggingface.co/Qwen/Qwen3-TTS-${size}`,
	summary: `${size} weights.`,
	revisionSha256: "3".repeat(64),
	snapshotPath: `snapshots/huggingface/qwen3-${size}`,
})));
const sameProviderGrouped = materializePrimeSourceOrganizerDecision(sameProviderOrganizer.index, {
	groups: [{ title: "Qwen3-TTS", identity: "Size variants of the Qwen3-TTS release line.", members: ["S001", "S002"] }],
	ungrouped: [],
}, sameProviderOrganizer.newSourceIds);
assert.equal(new Set(Object.values(sameProviderGrouped.sources).map((source) => source.group_id)).size, 1);
assert.throws(() => materializePrimeSourceOrganizerDecision(sameProviderOrganizer.index, {
	groups: [{ title: "Qwen3-TTS", identity: "Size variants of the Qwen3-TTS release line.", members: ["S001"] }],
	ungrouped: ["S002"],
}, sameProviderOrganizer.newSourceIds), /at least two members/u);

// The Organizer submits through a Tool that reports the precise validation error and only then writes .complete.
const organizerToolRoot = mkdtempSync(join(tmpdir(), "pi-organizer-tool-"));
try {
	mkdirSync(join(organizerToolRoot, ".runtime"), { recursive: true });
	writeFileSync(join(organizerToolRoot, ".runtime", "index.json"), JSON.stringify({
		index: sameProviderOrganizer.index,
		new_source_ids: sameProviderOrganizer.newSourceIds,
	}));
	const [organizerTool] = createPrimeOrganizerContractTools(organizerToolRoot);
	assert.equal(organizerTool!.name, "submit_organizer_decision");
	await assert.rejects(organizerTool!.execute("no-file", {}, undefined, undefined, {} as never), /decision\.json does not exist/u);
	writeFileSync(join(organizerToolRoot, "decision.json"), "{\"groups\": [}");
	await assert.rejects(organizerTool!.execute("bad-json", {}, undefined, undefined, {} as never), /decision\.json must be valid JSON/u);
	writeFileSync(join(organizerToolRoot, "decision.json"), JSON.stringify({ groups: [], ungrouped: ["S001"] }));
	await assert.rejects(organizerTool!.execute("incomplete", {}, undefined, undefined, {} as never), /every newly observed Source exactly once/u);
	assert.equal(existsSync(join(organizerToolRoot, ".decision-submitted")), false);
	writeFileSync(join(organizerToolRoot, "decision.json"), JSON.stringify({
		groups: [{ title: "Qwen3-TTS", identity: "Size variants of the Qwen3-TTS release line.", members: ["S001", "S002"] }],
		ungrouped: [],
	}));
	await organizerTool!.execute("valid", {}, undefined, undefined, {} as never);
	assert.equal(existsSync(join(organizerToolRoot, ".decision-submitted")), true);
} finally {
	rmSync(organizerToolRoot, { recursive: true, force: true });
}
const groupedOrganizer = validatePrimeSourceOrganizerIndex({
	...firstOrganizer.index,
	sources: Object.fromEntries(Object.entries(firstOrganizer.index.sources).map(([id, source]) => [
		id,
		{ ...source, group_id: "qwen3-tts" },
	])),
	groups: {
		"qwen3-tts": {
			title: "Qwen3-TTS",
			identity: "Qwen3-TTS model family, including its official implementation, paper, weights, and model cards.",
		},
	},
}, firstOrganizer.index.sources);
assert.deepEqual(projectPrimeSourceOrganization(groupedOrganizer, organizerItems), {
	groups: [{
		id: "qwen3-tts",
		title: "Qwen3-TTS",
		members: ["arxiv:2601.15621", "github:qwen3-tts"],
		evidence: "Qwen3-TTS model family, including its official implementation, paper, weights, and model cards.",
	}],
	ungrouped: [],
});
const repeatedOrganizer = preparePrimeSourceOrganizerIndex(groupedOrganizer, organizerItems);
assert.deepEqual(repeatedOrganizer.newSourceIds, []);
const modelCardItem = {
	candidateId: "huggingface:qwen3-tts",
	sourceId: "source:huggingface-qwen3",
	providerId: "huggingface",
	title: "Qwen3-TTS Model Card",
	url: "https://huggingface.co/Qwen/Qwen3-TTS",
	summary: "Official model weights and Model Card.",
	revisionSha256: "3".repeat(64),
	snapshotPath: "snapshots/huggingface/qwen3",
};
const incrementalOrganizer = preparePrimeSourceOrganizerIndex(groupedOrganizer, [...organizerItems, modelCardItem]);
assert.deepEqual(incrementalOrganizer.newSourceIds, ["source:huggingface-qwen3"]);
assert.equal(incrementalOrganizer.index.sources["source:github-qwen3"]?.group_id, "qwen3-tts");
assert.equal(incrementalOrganizer.index.sources["source:huggingface-qwen3"]?.group_id, null);
const incrementalInput = projectPrimeSourceOrganizerInput(
	incrementalOrganizer.index,
	incrementalOrganizer.newSourceIds,
) as { new_sources: unknown[]; cached_groups: Array<{ group_ref: string; members: unknown[] }> };
assert.equal(incrementalInput.new_sources.length, 1);
assert.equal(incrementalInput.cached_groups[0]?.members.length, 2);
const extendedOrganizer = materializePrimeSourceOrganizerDecision(incrementalOrganizer.index, {
	groups: [{ group_ref: incrementalInput.cached_groups[0]!.group_ref, members: ["S003"] }],
	ungrouped: [],
}, incrementalOrganizer.newSourceIds);
assert.equal(extendedOrganizer.sources["source:huggingface-qwen3"]?.group_id, "qwen3-tts");
assert.deepEqual(projectPrimeSourceOrganization(extendedOrganizer, [modelCardItem]).groups[0]?.members,
	["arxiv:2601.15621", "github:qwen3-tts", "huggingface:qwen3-tts"]);
assert.deepEqual(projectPrimeSourceOrganizerMembers(
	extendedOrganizer,
	[modelCardItem],
	"/goal/source-organizer",
	incrementalOrganizer.newSourceIds,
	[],
).map((member) => [member.candidateId, member.changeKind]), [
	["arxiv:2601.15621", "unchanged"],
	["github:qwen3-tts", "unchanged"],
	["huggingface:qwen3-tts", "new"],
]);
assert.throws(() => validatePrimeSourceOrganizerIndex({
	...groupedOrganizer,
	groups: { "group_123": { title: "Bad", identity: "System-generated identifier." } },
}, groupedOrganizer.sources), /semantic kebab-case/iu);
const selectionRoot = mkdtempSync(join(tmpdir(), "pi-prime-selection-"));
try {
	const materialRoot = join(selectionRoot, "artifacts", "github-repo");
	const redundantReadme = join(selectionRoot, "artifacts", "github-file", "README.md");
	const paperRoot = join(selectionRoot, "artifacts", "arxiv-paper");
	const paperFileRoot = join(selectionRoot, "artifacts", "arxiv-paper-file");
	mkdirSync(join(materialRoot, ".git"), { recursive: true });
	mkdirSync(join(selectionRoot, "artifacts", "github-file"), { recursive: true });
	mkdirSync(paperRoot, { recursive: true });
	mkdirSync(join(paperRoot, "assets"), { recursive: true });
	mkdirSync(join(paperFileRoot, "assets"), { recursive: true });
	mkdirSync(join(selectionRoot, "work"), { recursive: true });
	writeFileSync(join(materialRoot, "README.md"), "# Kimi-Audio\n");
	writeFileSync(join(materialRoot, ".gitmodules"), "[submodule \"tokenizer\"]\n");
	writeFileSync(join(materialRoot, "record.json"), "{\"provider\":true}\n");
	writeFileSync(join(materialRoot, ".git", "config"), "must not escape Runtime filtering\n");
	writeFileSync(redundantReadme, "redundant standalone download\n");
	writeFileSync(join(paperRoot, "paper.md"), "# Kimi-Audio paper\n");
	writeFileSync(join(paperRoot, "paper.pdf"), "%PDF-1.7\nprivate original\n");
	const paperAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
	writeFileSync(join(paperRoot, "assets", "figure.png"), paperAsset);
	writeFileSync(join(paperRoot, "parser-manifest.json"), documentParserManifest(paperAsset));
	writeFileSync(join(paperFileRoot, "paper.md"), "# Second paper\n");
	writeFileSync(join(paperFileRoot, "paper.pdf"), "%PDF-1.7\nsecond private original\n");
	writeFileSync(join(paperFileRoot, "assets", "figure.png"), paperAsset);
	writeFileSync(join(paperFileRoot, "parser-manifest.json"), documentParserManifest(paperAsset));
	writeFileSync(join(selectionRoot, "work", "github_candidates.json"), JSON.stringify({
		candidates: [{
			title: "MoonshotAI/Kimi-Audio",
			url: "https://github.com/MoonshotAI/Kimi-Audio",
			query: "exact repository",
			summary: "official implementation",
			metadata: { owner: "MoonshotAI" },
			material_paths: [materialRoot, redundantReadme],
		}],
	}));
	writeFileSync(join(selectionRoot, "work", "arxiv_candidates.json"), JSON.stringify({
		candidates: [{
			title: "Kimi-Audio Technical Report",
			url: "https://arxiv.org/abs/2504.18425",
			query: "exact paper",
			summary: "primary paper",
			metadata: {},
			material_paths: [paperRoot],
		}, {
			title: "Second Technical Report",
			url: "https://arxiv.org/abs/2504.18426",
			query: "exact second paper",
			summary: "second primary paper",
			metadata: {},
			material_paths: [join(paperFileRoot, "paper.md")],
		}],
	}));
	const selected = materializePrimeSources(selectionRoot, [
		{ execution_id: "provider-execution:1:github", provider_id: "github" },
		{ execution_id: "provider-execution:1:arxiv", provider_id: "arxiv" },
	]);
	assert.equal(selected.length, 3);
	const selectedRoot = join(selectionRoot, selected.find((item) => item.provider_id === "github")!.directory);
	for (const paper of selected.filter((item) => item.provider_id === "arxiv")) {
		const root = join(selectionRoot, paper.directory);
		assert.ok(existsSync(join(root, "paper.md")));
		assert.ok(existsSync(join(root, "assets", "figure.png")));
		assert.equal(existsSync(join(root, "paper.pdf")), false);
		assert.equal(existsSync(join(root, "parser-manifest.json")), false);
	}
	assert.ok(existsSync(join(selectionRoot, "source", ".complete")));
	assert.ok(existsSync(join(selectedRoot, "README.md")));
	assert.ok(existsSync(join(selectedRoot, "gitmodules.txt")));
	assert.ok(existsSync(join(selectedRoot, "provider-record.json")));
	assert.ok(!existsSync(join(selectedRoot, ".git")));
	const selectedRecord = JSON.parse(readFileSync(join(selectedRoot, "record.json"), "utf-8")) as Record<string, unknown>;
	assert.match(String(selectedRecord.candidate_id), /^candidate:[a-f0-9]{24}$/u);
	assert.equal(selectedRecord.provider_execution_id, "provider-execution:1:github");
	assert.equal("job_id" in selectedRecord, false);
} finally {
	rmSync(selectionRoot, { recursive: true, force: true });
}

const parallelProviderRoot = mkdtempSync(join(tmpdir(), "pi-prime-parallel-provider-"));
try {
	mkdirSync(join(parallelProviderRoot, "work"), { recursive: true });
	// The third execution repeats the first URL: one object, so it merges into the first record instead of failing.
	const executions = ["sub-browser-1", "sub-browser-2", "sub-browser-3"].map((childId, index) => {
		const workspacePath = `provider-executions/${childId}`;
		const workspace = join(parallelProviderRoot, workspacePath);
		const materialPath = `work/materials/browser/page-${index + 1}`;
		mkdirSync(join(workspace, materialPath), { recursive: true });
		writeFileSync(join(workspace, materialPath, "document.md"), `# Browser page ${index + 1}\n`);
		writeFileSync(join(workspace, "work", "browser_candidates.json"), JSON.stringify({
			candidates: [{
				title: `Browser page ${index + 1}`,
				url: `https://example.com/page-${index === 2 ? 1 : index + 1}`,
				query: `page ${index + 1}`,
				summary: `Independent Browser execution ${index + 1}.`,
				metadata: {},
				material_paths: [materialPath],
			}],
		}));
		return {
			execution_id: `provider-execution:1:browser:${childId}`,
			provider_id: "browser",
			workspace_path: workspacePath,
		};
	});
	const duplicates: string[] = [];
	const selected = materializePrimeSources(parallelProviderRoot, executions, (duplicate) => duplicates.push(duplicate.candidate_ref));
	assert.equal(selected.length, 2);
	assert.deepEqual(duplicates, ["C-browser-sub-browser-3-001"]);
	assert.deepEqual(selected.map((item) => item.provider_execution_id).sort(),
		executions.slice(0, 2).map((execution) => execution.execution_id).sort());
} finally {
	rmSync(parallelProviderRoot, { recursive: true, force: true });
}

// A Browser candidate may retain several converted pages with identical parser filenames.
const multiMaterialRoot = mkdtempSync(join(tmpdir(), "pi-prime-multi-material-"));
try {
	const workspacePath = "provider-executions/sub-browser-multi";
	const workspace = join(multiMaterialRoot, workspacePath);
	const materialPaths = ["work/materials/browser/first", "work/materials/browser/second"];
	for (const [index, path] of materialPaths.entries()) {
		mkdirSync(join(workspace, path, "assets"), { recursive: true });
		writeFileSync(join(workspace, path, "document.md"), `# Page ${index}\n![figure](assets/figure.svg)\n`);
		writeFileSync(join(workspace, path, "document.canonical.json"), JSON.stringify({ page: index }));
		writeFileSync(join(workspace, path, "assets/figure.svg"), `<svg>${index}</svg>`);
	}
	const supportingFile = "work/materials/browser/supporting.txt";
	writeFileSync(join(workspace, supportingFile), "Standalone evidence from the child workspace\n");
	writeFileSync(join(workspace, "work/browser_candidates.json"), JSON.stringify({ candidates: [{
		title: "Technical article and supporting product page", url: "https://example.com/article",
		query: "technical article", summary: "Original materials", metadata: {}, material_paths: [...materialPaths, supportingFile],
	}] }));
	const [source] = materializePrimeSources(multiMaterialRoot, [{
		execution_id: "provider-execution:1:browser:sub-browser-multi", provider_id: "browser",
		workspace_path: workspacePath,
	}]);
	for (const index of [0, 1]) {
		const material = join(multiMaterialRoot, source.directory, "materials", String(index + 1));
		assert.equal(readFileSync(join(material, "document.md"), "utf8"), `# Page ${index}\n![figure](assets/figure.svg)\n`);
		assert.deepEqual(JSON.parse(readFileSync(join(material, "document.canonical.json"), "utf8")), { page: index });
		assert.equal(readFileSync(join(material, "assets/figure.svg"), "utf8"), `<svg>${index}</svg>`);
	}
	assert.equal(readFileSync(join(multiMaterialRoot, source.directory, "materials/3/supporting.txt"), "utf8"),
		"Standalone evidence from the child workspace\n");
} finally {
	rmSync(multiMaterialRoot, { recursive: true, force: true });
}

function documentParserManifest(asset: Buffer): string {
	return `${JSON.stringify({
		assets: [{
			markdown_path: "assets/figure.png",
			media_type: "image/png",
			sha256: sha256(asset),
			byte_length: asset.byteLength,
		}],
	})}\n`;
}

const providerSkillRoot = fileURLToPath(new URL("../../agents/research/prime-search/skills", import.meta.url));
const reportWriterSkillRoot = fileURLToPath(new URL("../../agents/research/report-writer/skills", import.meta.url));
const providerToolRoot = fileURLToPath(new URL("../../server/research/python-tools", import.meta.url));
const projectPython = fileURLToPath(new URL("../../services/research-source-service/.venv/bin/python", import.meta.url));
const providerSkills = [
	["prime-github-selection-skill", "prime_github_selection_skill", "get_repository", "tools.github",
		["download_file", "download_release", "get_issue", "search_issues"]],
	["prime-arxiv-selection-skill", "prime_arxiv_selection_skill", "fetch_ids", "tools.arxiv",
		["categories", "discover_papers", "field", "submitted_date"]],
	["prime-huggingface-selection-skill", "prime_huggingface_selection_skill", "model_info", "tools.huggingface",
		["dataset_leaderboard", "discover_models", "download_paper", "list_daily_papers", "model_tags", "models_created_between", "paginate_datasets", "paginate_daily_papers", "paginate_models", "paginate_spaces", "paper_profile", "papers_search"]],
	["prime-twitter-provider-skill", "prime_twitter_provider_skill", "search", "tools.twitter",
		["profile", "thread"]],
	["prime-youtube-provider-skill", "prime_youtube_provider_skill", "subscription_uploads", "tools.youtube",
		["next_page_token", "transcript"]],
	["prime-user-documents-provider-skill", "prime_user_documents_provider_skill", "search", "tools.user_documents", []],
	["prime-browser-provider-skill", "prime_browser_provider_skill", "materialize_page", "tools.browser", ["click", "find", "help", "read"]],
] as const;
for (const [directory, importName, operation, module, formerlyMissing] of providerSkills) {
	const skillRoot = join(providerSkillRoot, directory);
	assert.ok(existsSync(join(skillRoot, "pyproject.toml")), `${directory} must be Python-backed`);
	assert.ok(existsSync(join(skillRoot, "src", importName, "__init__.py")), `${directory} must expose ${importName}`);
	const content = readFileSync(join(skillRoot, "SKILL.md"), "utf-8");
	assert.match(content, new RegExp(`name: ${directory}`, "u"));
	assert.match(content, new RegExp(`import ${importName}`, "u"));
	assert.match(content, /references\/API\.md/u);
	assert.match(content, new RegExp(operation, "u"));
	assert.doesNotMatch(content, /within (?:five|eight|twelve)|at most \d+|stay within \d+/iu);
	const reference = renderProviderApiReference(module, projectPython);
	assert.match(reference, /Generated from [`]tools\.[a-z_]+\.__all__[`]/u);
	for (const name of formerlyMissing) assert.match(reference, new RegExp("## `" + name + "`", "u"));
}
const githubProviderSkill = readFileSync(join(providerSkillRoot, "prime-github-selection-skill", "SKILL.md"), "utf-8");
const arxivProviderSkill = readFileSync(join(providerSkillRoot, "prime-arxiv-selection-skill", "SKILL.md"), "utf-8");
const arxivCategoryFiltering = readFileSync(
	join(providerSkillRoot, "prime-arxiv-selection-skill", "references", "category-filtering.md"), "utf-8",
);
const arxivNativeSearch = readFileSync(
	join(providerSkillRoot, "prime-arxiv-selection-skill", "references", "native-search.md"), "utf-8",
);
const huggingFaceSkillRoot = join(providerSkillRoot, "prime-huggingface-selection-skill");
const huggingFaceProviderSkill = readFileSync(join(huggingFaceSkillRoot, "SKILL.md"), "utf-8");
const huggingFaceTagFiltering = readFileSync(join(huggingFaceSkillRoot, "references", "tag-filtering.md"), "utf-8");
const huggingFaceNativeSearch = readFileSync(join(huggingFaceSkillRoot, "references", "native-search.md"), "utf-8");
const huggingFaceModelDiscovery = readFileSync(join(huggingFaceSkillRoot, "references", "model-discovery.md"), "utf-8");
const huggingFacePaperWorkflow = readFileSync(join(huggingFaceSkillRoot, "references", "paper-workflow.md"), "utf-8");
const huggingFaceModelWorkflow = readFileSync(join(huggingFaceSkillRoot, "references", "model-workflow.md"), "utf-8");
const huggingFaceDatasetWorkflow = readFileSync(join(huggingFaceSkillRoot, "references", "dataset-workflow.md"), "utf-8");
const huggingFaceSpaceWorkflow = readFileSync(join(huggingFaceSkillRoot, "references", "space-workflow.md"), "utf-8");
const browserSkillRoot = join(providerSkillRoot, "prime-browser-provider-skill");
const browserProviderSkill = readFileSync(join(browserSkillRoot, "SKILL.md"), "utf-8");
for (const required of ["import prime_browser_provider_skill as browser", "browser.open(", "browser.snapshot()", "browser.materialize_page()", "browser.read_skill(", "browser.help()", "references/dynamic-feeds.md", "work/browser_candidates.json"]) {
	assert.ok(browserProviderSkill.includes(required), `Browser Provider Skill must include ${required}`);
}
assert.doesNotMatch(browserProviderSkill, /agent-browser|Bash|shell|CDP|namespace|Trace files|cookies|storage|cleanup|Runtime assigns/iu);
assert.ok(existsSync(join(browserSkillRoot, "references", "dynamic-feeds.md")));

// Provider worker Skills resolve as the bundled default plus an optional same-name Goal override.
const skillResolutionRoot = mkdtempSync(join(tmpdir(), "telomi-provider-skill-resolution-"));
try {
	const browserProvider: ResearchSourceCatalogEntry & { id: string } = {
		id: "browser",
		implementationVersion: "skill-resolution-fixture",
		capability: "authenticated and dynamic website exploration",
		workerTool: { name: "browser", skill: "prime-browser-provider-skill", tools: ["browser", "materialize_source"] },
		workerSkills: ["prime-browser-provider-skill"],
		supportedContentTypes: ["text/html"],
		fullTextAvailability: "browser_render",
		credentialRequirement: "optional",
		reliabilityTier: 2,
		freshness: "realtime",
		costClass: "free",
		latencyClass: "high",
		capabilities: ["browser_navigation"],
	};
	assert.deepEqual(effectiveProviderWorkerSkills([browserProvider]),
		{ browser: [bundledAgentSkillPath("research", "prime-search", "prime-browser-provider-skill")] },
		"Without a Goal override the bundled Browser Provider Skill stays effective");

	const goalSkillRoot = join(skillResolutionRoot, "skills", "prime-search");
	const override = join(goalSkillRoot, "prime-browser-provider-skill");
	mkdirSync(join(override, "references"), { recursive: true });
	writeFileSync(join(override, "SKILL.md"), ["---", "name: prime-browser-provider-skill",
		"description: Goal override of the Browser Provider Skill.", "---", "",
		"For a Goal feed, read [Goal feed](references/goal-feed.md).", ""].join("\n"));
	writeFileSync(join(override, "references", "goal-feed.md"), "# Goal feed\n");
	const rootOnlySkill = join(goalSkillRoot, "goal-root-skill");
	mkdirSync(rootOnlySkill, { recursive: true });
	writeFileSync(join(rootOnlySkill, "SKILL.md"), ["---", "name: goal-root-skill",
		"description: Goal Skill that stays with the Prime Search Root.", "---", ""].join("\n"));

	const goalSkills = goalPrimeSearchSkills(goalSkillRoot);
	assert.deepEqual(effectiveProviderWorkerSkills([browserProvider], goalSkills),
		{ browser: [realpathSync(override)] },
		"A same-name Goal Skill fully overrides the bundled Browser Provider Skill");

	const staged = stageProviderWorkerSkills(
		join(skillResolutionRoot, "agent"),
		effectiveProviderWorkerSkills([browserProvider], goalSkills),
		[browserProvider],
		"python3",
	);
	assert.equal(readFileSync(join(staged.browser![0]!, "references", "goal-feed.md"), "utf-8"), "# Goal feed\n",
		"Provider child staging must carry the Goal override, not the bundled Skill");
	assert.deepEqual(primeProviderCatalog([browserProvider], staged)[0]!.worker_interface.required_skills,
		["prime-browser-provider-skill"], "Provider child required Skills keep the effective Skill name");
	assert.deepEqual(primeProviderCatalog([browserProvider], staged)[0]!.worker_interface.required_skill_paths,
		["skills/provider-workers/browser/prime-browser-provider-skill/SKILL.md"],
		"Provider child receives the exact staged Skill path instead of searching the workspace");
	assert.deepEqual(primeProviderCatalog([browserProvider], staged)[0]!.capabilities,
		["browser_navigation"], "Root receives structured Provider capability tags for fallback routing");

	// Prime receives one root per Skill name; a strict snapshot rejects a duplicate registration.
	const registeredRoots = [
		...Object.values(staged).flat(),
		...[...goalSkills].filter(([name]) => name !== "prime-browser-provider-skill").map(([, path]) => path),
	];
	const registered = snapshotSkills(registeredRoots);
	assert.deepEqual(registered.skills.map((skill) => skill.name), ["goal-root-skill", "prime-browser-provider-skill"],
		"A Goal override must not register the Browser Provider Skill twice");
	assert.equal(
		registered.skills.find((skill) => skill.name === "prime-browser-provider-skill")!.sha256,
		snapshotSkills([override]).skills[0]!.sha256,
		"Recorded launch conditions must carry the Goal override hash");
	assert.notEqual(
		snapshotSkills([override]).skills[0]!.sha256,
		snapshotSkills([browserSkillRoot]).skills[0]!.sha256,
		"The Goal override fixture must differ from the bundled Browser Provider Skill");
} finally {
	rmSync(skillResolutionRoot, { recursive: true, force: true });
}
for (const content of [githubProviderSkill, arxivProviderSkill, huggingFaceProviderSkill]) {
	assert.match(content, /CandidateLedger[\s\S]+ledger\.write/u);
	assert.match(content, /Do not enumerate the module[\s\S]+references\/API\.md/iu);
}
assert.match(arxivProviderSkill,
	/Choose a path[\s\S]+references\/category-filtering\.md[\s\S]+remembered category IDs[\s\S]+discover_papers[\s\S]+references\/native-search\.md[\s\S]+category filtering as the primary recall path[\s\S]+Deduplicate versions/iu);
assert.match(arxivProviderSkill,
	/discover_papers[\s\S]+paper_profile\(arxiv_ids, depth="metadata"\)[\s\S]+every pool record[\s\S]+metadata\["arxiv_id"\][\s\S]+paper_profile\(arxiv_ids, depth="front"\)[\s\S]+publisher[\s\S]+download_pdf\(\)` only for retained records[\s\S]+`materials`[\s\S]+Do not serialize/iu);
assert.match(arxivCategoryFiltering,
	/category set supplied by domain knowledge[\s\S]+verifies every proposed ID[\s\S]+targeted taxonomy lookup[\s\S]+categories\(search=domain_concepts, max_results=10[\s\S]+`cat:` query matches either/iu);
assert.match(arxivCategoryFiltering,
	/flat list of equivalent research-object `concepts`[\s\S]+matched with OR/iu);
assert.match(arxivCategoryFiltering,
	/Keep priorities[\s\S]+out of `concepts`[\s\S]+returned title[\s\S]+abstract[\s\S]+nested concept lists[\s\S]+check every proposed concept[\s\S]+research object[\s\S]+not how it is modeled[\s\S]+dimension-only terms/iu);
assert.match(arxivCategoryFiltering,
	/discover_papers[\s\S]+results across calendar months[\s\S]+opaque cursor[\s\S]+caches that pool[\s\S]+do not repeat taxonomy validation or monthly Provider queries[\s\S]+paper_profile\(depth="metadata"\)[\s\S]+research themes semantically[\s\S]+Regex and keyword matches[\s\S]+not[\s\S]+relevance evidence[\s\S]+next_cursor[\s\S]+unique_count[\s\S]+final page[\s\S]+saturated_lanes[\s\S]+guidance[\s\S]+rejects native search/iu);
assert.match(arxivNativeSearch,
	/`ti:`[\s\S]+`abs:`[\s\S]+complementary expressions[\s\S]+cross-category search[\s\S]+explicit larger `limit`[\s\S]+paper_profile\(depth="metadata"\)[\s\S]+not relevance evidence[\s\S]+every expression/iu);
assert.match(huggingFaceProviderSkill,
	/Route the assignment[\s\S]+references\/paper-workflow\.md[\s\S]+references\/model-workflow\.md[\s\S]+references\/dataset-workflow\.md[\s\S]+references\/space-workflow\.md[\s\S]+Read that reference only when/iu);
assert.doesNotMatch(huggingFaceProviderSkill,
	/lane_counts|discovery_lanes|huggingface_page\.next_cursor|base_model_relation|papers_search|download_paper|dataset_leaderboard|paginate_spaces/iu);
assert.match(huggingFacePaperWorkflow,
	/papers_search[\s\S]+Daily Papers[\s\S]+paper_profile[\s\S]+depth="metadata"[\s\S]+depth="front"[\s\S]+download_paper[\s\S]+paper\.md[\s\S]+metadata\.json[\s\S]+GitHub/iu);
assert.match(huggingFacePaperWorkflow,
	/native AI semantic discovery[\s\S]+relevance-ranked rather than\s+chronological[\s\S]+sort or filter[\s\S]+`published_at`/iu);
assert.match(huggingFaceModelWorkflow,
	/model-discovery\.md[\s\S]+tag-filtering\.md[\s\S]+native-search\.md[\s\S]+model_info[\s\S]+model_card[\s\S]+download_path/iu);
assert.match(huggingFaceDatasetWorkflow,
	/datasets\(\)[\s\S]+dataset_info[\s\S]+dataset_leaderboard[\s\S]+Provider-reported submission/iu);
assert.match(huggingFaceSpaceWorkflow,
	/spaces\(\)[\s\S]+linked models[\s\S]+linked datasets[\s\S]+does not by itself prove model quality/iu);
assert.match(huggingFaceTagFiltering,
	/model_tags[\s\S]+returned `tag_id`[\s\S]+pipeline_tag[\s\S]+assigned task boundary[\s\S]+language-only query/iu);
assert.match(huggingFaceNativeSearch,
	/models\(\)[\s\S]+author[\s\S]+base_model_relation[\s\S]+models\(search=[\s\S]+repository IDs[\s\S]+not Model Card prose/iu);
assert.match(huggingFaceNativeSearch,
	/opaque `huggingface_page\.next_cursor`[\s\S]+paginate_models[\s\S]+model_info[\s\S]+model_card/iu);
assert.match(huggingFaceModelDiscovery,
	/discover_models[\s\S]+validates task tags[\s\S]+trending[\s\S]+complete date-range[\s\S]+likes[\s\S]+downloads[\s\S]+merges them by[\s\S]+`repo_id`/iu);
assert.match(huggingFaceModelDiscovery,
	/records[\s\S]+lane_counts[\s\S]+unique_count[\s\S]+discovery_lanes[\s\S]+rerank the pool[\s\S]+hand-written/iu);
assert.match(huggingFaceModelDiscovery,
	/start with `discover_models\(\)` without a cursor[\s\S]+returned_count[\s\S]+unique_count[\s\S]+next_cursor[\s\S]+same discovery arguments[\s\S]+until `next_cursor` is null/iu);
assert.match(huggingFaceModelDiscovery,
	/discover_models\(\)[\s\S]+partial result[\s\S]+recovery details/iu);
assert.match(huggingFaceProviderSkill,
	/summary[\s\S]+concise[\s\S]+Provider record in `materials`[\s\S]+ledger\.write/iu);
for (const content of [
	githubProviderSkill,
	arxivProviderSkill,
	huggingFaceProviderSkill,
	huggingFacePaperWorkflow,
	huggingFaceModelWorkflow,
	huggingFaceDatasetWorkflow,
	huggingFaceSpaceWorkflow,
	readFileSync(join(providerSkillRoot, "prime-twitter-provider-skill", "SKILL.md"), "utf-8"),
	readFileSync(join(providerSkillRoot, "prime-youtube-provider-skill", "SKILL.md"), "utf-8"),
	readFileSync(join(providerSkillRoot, "prime-user-documents-provider-skill", "SKILL.md"), "utf-8"),
]) {
	assert.doesNotMatch(content, /material_paths\s*=/u, "Provider Skill must use Tool records, not Agent-authored paths");
}
assert.equal(existsSync(
	join(providerSkillRoot, "prime-huggingface-selection-skill", "references", "discovery-program.md")), false);
assert.equal(existsSync(
	join(providerSkillRoot, "prime-huggingface-selection-skill", "references", "inventory.md")), false);
assert.equal(existsSync(join(providerSkillRoot, "prime-huggingface-importance-skill", "SKILL.md")), false);
const pythonPath = [
	providerToolRoot,
	...providerSkills.map(([directory]) => join(providerSkillRoot, directory, "src")),
].join(":");
execFileSync(projectPython, ["-c", [
	"import prime_github_selection_skill as github",
	"import prime_arxiv_selection_skill as arxiv",
	"import prime_huggingface_selection_skill as huggingface",
	"import prime_twitter_provider_skill as twitter",
	"import prime_youtube_provider_skill as youtube",
	"import prime_user_documents_provider_skill as user_documents",
	"assert callable(github.get_repository)",
	"assert callable(github.CandidateLedger)",
	"assert callable(arxiv.fetch_ids)",
	"assert callable(arxiv.CandidateLedger)",
	"assert callable(huggingface.model_info)",
	"assert callable(huggingface.CandidateLedger)",
	"assert callable(huggingface.model_tags)",
	"assert callable(huggingface.models_created_between)",
	"assert callable(huggingface.inventory.models_created_between)",
	"assert callable(twitter.search)",
	"assert callable(twitter.CandidateLedger)",
	"assert callable(youtube.subscription_uploads)",
	"assert callable(youtube.CandidateLedger)",
	"assert callable(user_documents.search)",
	"assert callable(user_documents.CandidateLedger)",
].join("; ")], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: pythonPath } });

execFileSync(projectPython, ["-c", [
	"import tools.huggingface as hf",
	"pages = {None: ([{'id':'new','repo_id':'org/new','created_at':'2026-09-01T00:00:00Z'},{'id':'in','repo_id':'org/in','created_at':'2026-06-01T00:00:00Z'}], 'next'), 'next': ([{'id':'old','repo_id':'org/old','created_at':'2025-12-31T23:59:59Z'}], None)}",
	"def fake_models(**kwargs):",
	"    rows, cursor = pages[kwargs.get('cursor')]",
	"    return [dict(row, metadata={'huggingface_page': {'next_cursor': cursor}}) for row in rows]",
	"hf.models = fake_models",
	"rows = hf.models_created_between('2026-01-01', '2026-08-20')",
	"assert [row['repo_id'] for row in rows] == ['org/in']",
].join("\n")], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: pythonPath } });

const primeSearchBatchSource = readFileSync(
	fileURLToPath(new URL("../../server/research/pipeline/prime-search-batch.ts", import.meta.url)),
	"utf-8",
);
const primeSearchSdkWorkerSource = readFileSync(
	fileURLToPath(new URL("../../server/research/pipeline/prime-search-sdk-worker.ts", import.meta.url)),
	"utf-8",
);
const primeReportWriterWorkerSource = readFileSync(
	fileURLToPath(new URL("../../server/research/pipeline/prime-report-writer-worker.ts", import.meta.url)),
	"utf-8",
);
const availableProvider: PrimeAvailableProvider = {
	provider_id: "github",
	capability: "Search and acquire GitHub repositories.",
	capabilities: ["github_repositories"],
	evidence_types: ["official_repository"],
	full_text_availability: "full_text",
	worker_interface: {
		kind: "python_skill",
		required_skills: ["prime-github-selection-skill"],
	},
	candidate_ledger: "work/github_candidates.json",
};
const nativeSelectorPrompt = primeSearchRootUserPrompt({
	question: "Find primary evidence",
	temporalContext: { schemaVersion: 1, currentDate: "2026-09-04", timeZone: "Asia/Singapore" },
	childModel: "openai-codex/gpt-5.6-luna",
	availableProviders: [availableProvider],
	rootAgentSkills: [],
});
assert.match(nativeSelectorPrompt,
	/Root owns discovery and source routing[\s\S]+Multiple children may use the same Provider[\s\S]+Root may call `research_runtime\.search_general_web`/iu);
assert.match(nativeSelectorPrompt, /Every candidate a Provider child keeps in its Ledger becomes a Source/iu);
assert.doesNotMatch(nativeSelectorPrompt, /Selector|selection_contract|submit_prime_selection|selection\.json/iu);
assert.match(nativeSelectorPrompt,
	/Provider child prompt: `OUTPUT BUDGET: Keep each IPython cell below 8000 output characters[\s\S]+Print at most 10 compact records or a 500-character excerpt/iu);
assert.match(nativeSelectorPrompt, /"provider_id": "github"[\s\S]+"prime-github-selection-skill"/u);
assert.match(nativeSelectorPrompt, /exact `required_skill_paths`[\s\S]+Do not ask a child to discover or search for Skill paths/iu);
assert.match(nativeSelectorPrompt, /Start all independent tasks whose prerequisites are satisfied before waiting[\s\S]+returned `rlm_child_id`[\s\S]+native child status/iu);
assert.match(nativeSelectorPrompt, /relative to the Root's initial working directory/iu);
assert.match(nativeSelectorPrompt, /`session_dir` identifies Prime session storage, not a Provider output directory/iu);
assert.match(nativeSelectorPrompt, /Root completes successfully only after every assigned responsibility has a submitted result[\s\S]+Root writes nothing itself/iu);
assert.match(nativeSelectorPrompt,
	/source_unavailable[\s\S]+current Provider Catalog[\s\S]+structured `capabilities` tag[\s\S]+already serving other responsibilities in this Run still qualifies[\s\S]+at most one replacement[\s\S]+shared `scholarly_papers` capability[\s\S]+report_provider_fallback[\s\S]+only the uncovered Evidence Need[\s\S]+real provenance[\s\S]+instead of cycling/iu);
assert.doesNotMatch(nativeSelectorPrompt, /asyncio\.gather|asyncio\.sleep|while True/iu);
assert.doesNotMatch(nativeSelectorPrompt, /agent_message/iu);
assert.doesNotMatch(primeSearchBatchSource, /prime-search-coordinator|agent-message/iu);
assert.match(primeSearchBatchSource, /mkdirSync\(join\(root, "work"\), \{ recursive: true \}\)/u);
assert.match(primeSearchBatchSource, /primeProviderAssignments/u,
	"Runtime must enumerate only deterministically submitted Provider Ledgers");
assert.doesNotMatch(primeSearchSdkWorkerSource, /additionalExtensionPaths|input\.extensions/u,
	"Prime Search SDK must not load Pi Extensions");
assert.match(primeReportWriterWorkerSource, /session\.waitForRlmQuiescence/u);
assert.doesNotMatch(primeReportWriterWorkerSource, /session\.hasRunningRlmChildren|session\.waitForIdle/u);
assert.match(primeReportWriterWorkerSource, /SessionManager\.create\(cwd, rootSessionDir\)/u);
assert.doesNotMatch(primeReportWriterWorkerSource, /SessionManager\.inMemory/u);
assert.match(arxivNativeSearch,
	/active[\s\S]+discover_papers[\s\S]+next_cursor[\s\S]+null[\s\S]+before[\s\S]+search\(\)/iu);
assert.match(arxivProviderSkill,
	/preserve[\s\S]+discovery query[\s\S]+before[\s\S]+download_pdf[\s\S]+downloaded record/iu);

for (const providerSkill of [
	["prime-github-selection-skill", "github"],
] as const) {
	const content = readFileSync(join(providerSkillRoot, providerSkill[0], "SKILL.md"), "utf-8");
	assert.match(content,
		new RegExp(`description:.*Prime Search child explicitly assigned Provider '${providerSkill[1]}'.*do not use for Root coordination or another Provider`, "iu"));
}
assert.match(arxivProviderSkill,
	/description: Use arXiv subject categories, native fielded search, exact paper lookup, and CandidateLedger/iu);
assert.doesNotMatch(arxivProviderSkill,
	/Prime Search child|Root coordination|smallest sufficient|distinct evidence contribution/iu);
assert.match(huggingFaceProviderSkill,
	/description: Use Hugging Face Hub discovery, native search, exact lookups, Model Cards, and CandidateLedger/iu);
assert.match(huggingFaceProviderSkill,
	/reference path relative to[\s\S]+Read `references\/API\.md`[\s\S]+only when/iu);
assert.match(huggingFaceModelDiscovery,
	/time-bounded[\s\S]+creation-date interval[\s\S]+model_tags/iu);
assert.match(huggingFacePaperWorkflow,
	/screening evidence[\s\S]+front_excerpt[\s\S]+Runtime-written directory[\s\S]+full-text bundle success/iu);
assert.doesNotMatch(huggingFaceProviderSkill,
	/Prime Search child|Root coordination|smallest sufficient|distinct evidence contribution/iu);

assert.match(arxivCategoryFiltering,
	/bounded pool[\s\S]+calendar months[\s\S]+opaque cursor[\s\S]+exact opaque `next_cursor`/iu);
assert.match(arxivProviderSkill,
	/source_unavailable: true[\s\S]+empty Ledger[\s\S]+completion reply start with `source_unavailable provider=arxiv`[\s\S]+Root, not this child/iu);

const rootUserPrompt = primeSearchRootUserPrompt({
	question: "Research multilingual TTS.",
	temporalContext: {
		schemaVersion: 1,
		currentDate: "2026-08-26",
		timeZone: "Asia/Singapore",
		resolvedRange: {
			kind: "year_to_date",
			startDate: "2026-01-01",
			endDate: "2026-08-26",
			inclusive: true,
			sourceText: "year to date",
		},
	},
	childModel: "openai-codex/gpt-5.6-luna",
	availableProviders: [availableProvider],
	rootAgentSkills: [],
});
assert.doesNotMatch(rootUserPrompt, /search_context/iu);
assert.match(rootUserPrompt, /Root-only tool/iu);
assert.doesNotMatch(rootUserPrompt, /coverage_requirements/u);
assert.doesNotMatch(rootUserPrompt, /report_outline/u);
assert.match(rootUserPrompt, /"temporal_context"[\s\S]+"resolved_range"/u);
assert.match(rootUserPrompt,
	/"current_run"[\s\S]+"available_providers"[\s\S]+"provider_child_output_contract"[\s\S]+"material_policy"/u);
assert.doesNotMatch(rootUserPrompt, /selection_contract|"retained"/u);
assert.doesNotMatch(rootUserPrompt,
	/research_constraints|questionSha256|constraintSetSha256|candidate_ledger_contract|selection_output|root_agent_skills/iu);
for (const source of createResearchSourceRegistry(process.env).catalog().filter((item) => item.workerPython)) {
	assert.match(renderProviderApiReference(source.workerPython!.module, projectPython), new RegExp(`^# ${source.id} Provider API`, "u"));
}

assert.match(FULL_REPORT_WRITER_SYSTEM_PROMPT, /frozen Goal Wiki/iu);
assert.doesNotMatch(FULL_REPORT_WRITER_SYSTEM_PROMPT, /writer-sections\.json|Evidence pool/iu);
assert.match(wikiSelfDirectedWriterUserPrompt({
	language: "en", currentDate: "2026-08-09", timeZone: "UTC",
}), /decide the report's structure[\s\S]+wiki-report Skill[\s\S]+Do not spawn children/iu);
assert.doesNotMatch(wikiSelfDirectedWriterUserPrompt({
	language: "en", currentDate: "2026-08-09", timeZone: "UTC",
}), /report-outline\.json.*inputs|\{\{CHILD_MODEL\}\}/iu);
assert.match(findOutSelfDirectedWriterUserPrompt({
	language: "zh-CN",
	currentDate: "2026-08-27",
	timeZone: "Asia/Singapore",
}), /decide the report's structure[\s\S]+Page the notes_report roster to the end[\s\S]+Do not spawn children/iu);
assert.doesNotMatch(findOutSelfDirectedWriterUserPrompt({
	language: "zh-CN", currentDate: "2026-08-27", timeZone: "Asia/Singapore",
}), /section-001|schema_version/iu);
assert.match(buildFindOutReportWriterSystemPrompt(), /<cite>N123<\/cite>[\s\S]+Runtime resolves/iu);
assert.doesNotMatch(buildFindOutReportWriterSystemPrompt(), /<cite>URL<\/cite>/iu);
assert.match(findOutSelfDirectedDelegationPrompt("test/child"),
	/Runtime validated[\s\S]+injected every Section ID[\s\S]+exactly one child per Section[\s\S]+test\/child/iu);
assert.match(findOutSelfDirectedDelegationPrompt("test/child"),
	/exact Skill paths[\s\S]+never search for Skill locations[\s\S]+must not inspect or call RLM emit/iu);
assert.match(findOutSelfDirectedDelegationPrompt("test/child"),
	/one bounded page at a time[\s\S]+final expression of its own IPython cell[\s\S]+must not fetch pages silently/iu);
assert.match(wikiSelfDirectedDelegationPrompt("test/child"),
	/Runtime validated[\s\S]+injected every Section ID[\s\S]+exactly one child per Section[\s\S]+test\/child/iu);
assert.match(primeWriterFinalPrompt("findout"), /Do not write[\s\S]+manifest\.json[\s\S]+Runtime creates/iu);
assert.doesNotMatch(primeWriterFinalPrompt("findout"), /"schema_version": 1|Create writer-output\/\.complete last/iu);
assert.match(primeWriterFinalPrompt("findout", true),
	/load the writing-skill[\s\S]+writing_skill\("work\/final-check\.md"\)/iu);
assert.match(primeWriterFinalPrompt("findout", true),
	/do not inspect[\s\S]+dir\(\)[\s\S]+signatures/iu);
assert.match(primeWriterFinalPrompt("findout", true), /do not target an exact character count[\s\S]+## <title>/iu);
assert.match(primeWriterFinalPrompt("findout", false), /not Chinese[\s\S]+skip[\s\S]+lint/iu);
assert.equal(renderReportProseLintInput([
	{ title: "First", body: "First body." },
	{ title: "Second", body: "Second body." },
]), "## First\n\nFirst body.\n\n## Second\n\nSecond body.\n");
assert.deepEqual(primeReportWriterContractIdentity({}, {
	rootModel: "test/root",
	childModel: "test/child",
	thinkingLevel: "low",
	}, {}), {
	id: "prime-report-writer",
	version: 5,
	rootModel: "test/root",
	childModel: "test/child",
	thinkingLevel: "low",
	knowledge: "frozen-material-adapter",
	orchestration: "root-plan-delegate-edit",
});
const writingSkill = readFileSync(join(reportWriterSkillRoot, "writing-skill", "SKILL.md"), "utf-8");
assert.match(writingSkill, /^---[\s\S]+name: writing-skill[\s\S]+Research Report Writing/mu);
assert.match(writingSkill, /Runtime independently reruns the same scanner/u);
assert.match(writingSkill, /unattended Report Writer stage[\s\S]+Do not ask the user/iu);
assert.doesNotMatch(writingSkill, /Antigravity|agy --print|Twitter|install the skill/iu);

const evidence: CornellNotesSnapshot = {
	schema_version: 1,
	snapshot_id: "snapshot:1",
	run_id: "run:1",
	pipeline: { id: "test", version: "1", sha256: "a".repeat(64) },
	source_bundle_refs: ["artifacts/source-bundles/source-1"],
	notes: [{
		note: { schema_version: 1, source_id: "source:1", sections: [{
			section_title: "Finding",
			summary: "The Source supports the result.",
			cue_notes: [{ cue: "Result + support", note: "The result is supported.", evidence: [{
				source_path: "document.md", start_line: 1, end_line: 1, content_sha256: "b".repeat(64),
			}] }],
		}] },
		title: "Primary source",
		canonical_locator: "https://example.com/source",
		provider_id: "test",
		provenance_ref: "provider:test:1",
		source_revision_sha256: "c".repeat(64),
		members: [],
	}],
};

const handles = createAgentEvidenceHandles([evidence]);
const outline = validateWriterAuthoredOutline({
	title: "Research report",
	sections: [{
		section_id: "section-001",
		title: "Findings",
		purpose: "Explain the supported result.",
		cornell_notes_refs: ["@1"],
	}],
}, handles);
assert.deepEqual(outline.sections[0]?.cornell_notes_refs, ["source:1"]);

const writerAuthoredOutline = validateWriterAuthoredOutline({
	title: "Research report",
	sections: [{
		section_id: "section-001",
		title: "Findings",
		purpose: "Explain the supported result.",
		cornell_notes_refs: ["@1"],
	}],
}, handles);
assert.deepEqual(writerAuthoredOutline, outline);
assert.throws(() => validateWriterAuthoredOutline({
	title: "Invalid",
	sections: [{ section_id: "section-001", title: "Findings", purpose: "Explain.", cornell_notes_refs: [] }],
}, handles), /must be a non-empty array/u);

const plan = materializeReportPlan(outline);
assert.equal(plan.sections[0]?.section_id, "section-001");
assert.deepEqual(plan.sections[0]?.claims[0]?.cornell_notes_refs, ["source:1"]);

const writer = validateWriterOutput({
	schema_version: 1,
	sections: [{
		section_id: "section-001",
		body_markdown: "The result is supported by the retained source <cite>https://example.com/source</cite>.",
	}],
}, plan.sections);
assert.match(materializeWriterChapter(plan.sections[0]!, writer), /^## Findings/u);

assert.throws(() => validateWriterAuthoredOutline({
	title: "Invalid",
	sections: [{ section_id: "section-001", title: "Findings", purpose: "Explain.", cornell_notes_refs: ["@99"] }],
}, handles), /unknown Evidence handle/u);
assert.throws(() => validateWriterOutput({
	schema_version: 1,
	sections: [{ section_id: "section-001", body_markdown: "## Runtime-owned heading" }],
}, plan.sections), /must not contain a level 1 or 2 heading/u);
assert.throws(() => validateWriterOutput({
	schema_version: 1,
	sections: [{ section_id: "section-001" }],
}, plan.sections), /\[report-writer:final-output\] file 'writer-output\/manifest\.json' has invalid fields: \/sections\/0\/body_markdown: required field is missing/u);

const wikiOutline = validateWriterAuthoredOutline({
	title: "Wiki report",
	sections: [{
		section_id: "section-001",
		title: "Findings",
		purpose: "Explain the supported result.",
		knowledge_refs: ["wiki/index.md"],
	}],
}, handles, new Set(["wiki/index.md"]));
assert.deepEqual(wikiOutline.sections[0]?.knowledge_refs, ["wiki/index.md"]);
assert.deepEqual(wikiOutline.sections[0]?.cornell_notes_refs, []);
assert.deepEqual(validateWriterAuthoredOutline({
	title: "Resumed Wiki report",
	sections: [{ section_id: "section-001", title: "Findings", purpose: "Explain.", knowledge_refs: ["wiki/index.md"] }],
}, handles, new Set(["wiki/index.md"])).sections[0]?.cornell_notes_refs, []);
assert.throws(() => validateWriterAuthoredOutline({
	title: "Missing starting point",
	sections: [{ section_id: "section-001", title: "Findings", purpose: "Explain." }],
}, handles, new Set(["wiki/index.md"])), /knowledge_refs/u);
for (const invalid of ["../outside.md", "/knowledge/wiki/index.md", "wiki/missing.md"]) {
	assert.throws(() => validateWriterAuthoredOutline({
		title: "Invalid starting point",
		sections: [{ section_id: "section-001", title: "Findings", purpose: "Explain.", knowledge_refs: [invalid] }],
	}, handles, new Set(["wiki/index.md"])), /Knowledge Reference/u);
}
assert.throws(() => validateWriterAuthoredOutline({
	title: "Duplicate starting point",
	sections: [{
		section_id: "section-001",
		title: "Findings",
		purpose: "Explain.",
		knowledge_refs: ["wiki/index.md", "wiki/index.md"],
	}],
}, handles, new Set(["wiki/index.md"])), /knowledge_refs contains duplicates/u);
const wikiPlan = materializeReportPlan(wikiOutline);
assert.deepEqual(wikiPlan.sections[0]?.claims, []);
assert.deepEqual(validateWriterAuthoredOutline({
	title: "Wiki report",
	sections: [{
		section_id: "section-001",
		title: "Findings",
		purpose: "Explain the supported result.",
		knowledge_refs: ["wiki/index.md"],
	}],
}, handles, new Set(["wiki/index.md"])), {
	title: "Wiki report",
	sections: [{
		title: "Findings",
		purpose: "Explain the supported result.",
		knowledge_refs: ["wiki/index.md"],
		cornell_notes_refs: [],
	}],
});

const root = mkdtempSync(join(tmpdir(), "telomi-report-contracts-"));
try {
	const knowledgeRoot = join(root, "knowledge");
	mkdirSync(join(knowledgeRoot, "wiki"), { recursive: true });
	writeFileSync(join(knowledgeRoot, "wiki", "index.md"), [
		"# Knowledge",
		"Canonical https://example.com/source",
		"Extra https://EXAMPLE.com:443/a#fragment",
		"Longer https://example.com/abc",
		"Unsafe javascript:alert(1)",
	].join("\n"));
	mkdirSync(join(knowledgeRoot, "sources", "meta"), { recursive: true });
	writeFileSync(join(knowledgeRoot, "sources", "meta", "source.json"), JSON.stringify({
		source_id: "source:meta",
		title: "Structured source title",
		canonical_locator: "https://meta.example/item",
	}));
	writeFileSync(join(knowledgeRoot, "sources", "meta", "structured.json"),
		'{"nested":{"external":"https:\\/\\/structured.example\\/path"}}');
	const knowledge = new RunArtifactStore(root).describeDirectory("knowledge");
	const registry = buildKnowledgeCitationRegistry({ knowledgeSnapshot: knowledge, cornellNotes: evidence });
	assert.equal(registry.entries.some((entry) => entry.url === "https://example.com/a"), true);
	assert.equal(registry.entries.some((entry) => entry.url === "https://example.com/abc"), true);
	assert.equal(registry.entries.some((entry) => entry.url.startsWith("javascript:")), false);
	assert.deepEqual(registry.entries.find((entry) => entry.url === "https://meta.example/item"), {
		url: "https://meta.example/item",
		title: "Structured source title",
		provenance: "source:meta",
		fileRefs: ["sources/meta/source.json"],
	});
	assert.equal(registry.entries.some((entry) => entry.url === "https://structured.example/path"), true);
	const compiled = compileCanonicalMarkdown({
		plan: wikiPlan,
		cornellNotes: evidence,
		citationRegistry: registry,
		chapters: [{
			sectionId: "section-001",
			markdown: "## Findings\n\nKnown <cite>https://example.com/source</cite>. Extra <cite>https://example.com/a</cite>.",
		}],
	});
	assert.equal(wikiOutline.sections[0]?.knowledge_refs.includes("sources/meta/source.json"), false);
	assert.match(compiled.markdown, /Primary source/u);
	assert.match(compiled.markdown, /^\d+\. \[[^\]]+\]\(https:\/\/example\.com\/a\)$/mu);
	assert.throws(() => compileCanonicalMarkdown({
		plan: wikiPlan,
		cornellNotes: evidence,
		citationRegistry: registry,
		chapters: [{ sectionId: "section-001", markdown: "## Findings\n\n<cite>https://example.com/ab</cite>" }],
	}), /not present in the frozen Knowledge Snapshot/u);
	assert.throws(() => compileCanonicalMarkdown({
		plan: wikiPlan,
		cornellNotes: evidence,
		citationRegistry: registry,
		chapters: [{ sectionId: "section-001", markdown: "## Findings\n\n<cite>javascript:alert(1)</cite>" }],
	}), /malformed inline Evidence citation/u);
	for (const unsafe of ["file:///etc/passwd", "data:text/plain,hello"]) {
		assert.throws(() => compileCanonicalMarkdown({
			plan: wikiPlan,
			cornellNotes: evidence,
			citationRegistry: registry,
			chapters: [{ sectionId: "section-001", markdown: `## Findings\n\n<cite>${unsafe}</cite>` }],
		}), /malformed inline Evidence citation/u);
	}
	assert.throws(() => compileCanonicalMarkdown({
		plan: wikiPlan,
		cornellNotes: evidence,
		citationRegistry: registry,
		chapters: [{ sectionId: "section-001", markdown: "## Findings\n\n<cite>https:\/\/[bad</cite>" }],
	}), /malformed inline Evidence citation/u);

	const writerRoot = join(root, "writer-output");
	mkdirSync(join(writerRoot, "sections"), { recursive: true });
	writeFileSync(join(writerRoot, "sections", "section-001.md"), "Known <cite>https://example.com/source</cite>.\n");
	writeFileSync(join(writerRoot, "manifest.json"), JSON.stringify({
		schema_version: 1,
		sections: [{ section_id: "section-001", path: "sections/section-001.md" }],
	}));
	const chapterOutput = validateWriterChapterOutput(join(writerRoot, "manifest.json"), wikiPlan.sections);
	assert.match(materializeWriterChapter(wikiPlan.sections[0]!, chapterOutput), /^## Findings/u);
	writeFileSync(join(writerRoot, "report.md"), "legacy duplicate\n");
	assert.throws(() => validateWriterChapterOutput(join(writerRoot, "manifest.json"), wikiPlan.sections),
		/\[report-writer:file-contract\] file 'writer-output', field '\$': contains unexpected files report\.md/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}


{
	const root = mkdtempSync(join(tmpdir(), "telomi-writer-manifest-"));
	try {
		const write = (value: unknown) => {
			writeFileSync(join(root, "manifest.json"), `${JSON.stringify(value)}\n`);
			return join(root, "manifest.json");
		};
		const plan = planFromWriterManifest(write({
			schema_version: 1,
			sections: [
				{ section_id: "section-001", path: "sections/section-001.md", title: "Conclusion" },
				{ section_id: "section-002", path: "sections/section-002.md", title: "Model landscape" },
			],
		}), "Speech model survey");
		assert.deepEqual(plan.sections.map((section) => section.section_id), ["section-001", "section-002"]);
		assert.deepEqual(plan.sections.map((section) => section.title), ["Conclusion", "Model landscape"]);
		assert.throws(() => planFromWriterManifest(write({
			schema_version: 1,
			sections: [{ section_id: "section-001", path: "sections/section-001.md" }],
		}), "t"), /field 'sections\[0\]\.title': must be a non-empty string/u);
		assert.throws(() => planFromWriterManifest(write({
			schema_version: 1,
			sections: [{ section_id: "section-002", path: "sections/section-002.md", title: "x" }],
		}), "t"), /field 'sections\[0\]\.section_id': must equal Runtime ID 'section-001'/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// The Executable Report Plan Schema is hashed into the `schema_bundle` Run identity pin, so
// changing its serialized bytes makes every existing Research Run checkpoint unresumable with
// checkpoint_identity_drift. Moving the Schema between modules must keep these bytes exact.
assert.equal(
	hashRuntimeIdentityJson(ExecutableReportPlanSchema),
	"1cc40ced107876ba4fb082230a74650cae7cbf16d05b2fc5bc397786bd0cc0d4",
	"Executable Report Plan Schema identity changed; existing Run checkpoints would stop resuming",
);

console.log("Research report flow contracts passed");
