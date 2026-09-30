import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentStageActivity, AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import type { ResearchModelPolicy } from "../agent-runtime/models/model-policy.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { sha256 } from "../lib/hash.js";
import { isRecord } from "../lib/values.js";
import { caseCapture } from "../observability/case-capture.js";
import { findLogicalSourceInRun } from "../workspaces/source-view.js";
import { materializeAgentSourceView } from "./pipeline/agent-source-view.js";
import { createProductionResearchStageRunner } from "./pipeline/production-stage-runner.js";
import { primeReportWriterStageModelPolicy } from "./pipeline/prime-report-writer.js";

export interface InvestigationAnswer {
	answer: string;
	citation_refs: string[];
	gaps: string[];
	coverage: Array<{ requirement_id: string; citation_refs: string[]; gap: string }>;
}

export interface InvestigationAnswerRequest {
	schema_version: 1;
	question: string;
	context: string;
	language: string;
	requirements: Array<{ id: string; question: string }>;
	evidence_refs: string[];
}

export interface InvestigationAnswerEvidence {
	ref: string;
	section_title: string;
	cue: string;
	note: string;
	evidence: Array<{
		source_path: string; start_line: number; end_line: number; excerpt: string;
		title?: string; url?: string; content_sha256?: string;
		source_run_id?: string; source_id?: string; source_revision_sha256?: string;
	}>;
}

const CITATION = /^[CN][1-9][0-9]*$/u;
const SAFE_RUN = /^[A-Za-z0-9._-]{1,200}$/u;

/** Freeze exactly the evidence assigned to one answer, with original Source context where available. */
export function writeInvestigationAnswerInput(input: {
	inputRoot: string; request: InvestigationAnswerRequest;
	evidence: readonly InvestigationAnswerEvidence[]; goalDir?: string;
}): void {
	mkdirSync(join(input.inputRoot, "evidence"), { recursive: true });
	const byRef = new Map(input.evidence.map((item) => [item.ref, item]));
	if (byRef.size !== input.evidence.length) throw new Error("Answer evidence refs must be unique");
	const sources = new Map<string, { ref: string; path: string; files: string[] }>();
	for (const ref of input.request.evidence_refs) {
		if (!CITATION.test(ref)) throw new Error("Answer evidence ref is invalid");
		const item = byRef.get(ref);
		if (!item) throw new Error(`Answer received unassigned evidence '${ref}'`);
		const evidence = item.evidence.map((anchor) => {
			let excerpt = anchor.excerpt;
			let originalSource: { ref: string; path: string; files: string[] } | undefined;
			if (input.goalDir && anchor.source_run_id && anchor.source_id && anchor.source_revision_sha256) {
				if (!SAFE_RUN.test(anchor.source_run_id)) throw new Error("Answer Source Run identity is invalid");
				const key = JSON.stringify([anchor.source_run_id, anchor.source_id, anchor.source_revision_sha256]);
				originalSource = sources.get(key);
				if (!originalSource) {
					const source = findLogicalSourceInRun(join(input.goalDir, "wiki", "runs", anchor.source_run_id), anchor.source_id);
					if (!source || source.source.revision_sha256 !== anchor.source_revision_sha256) {
						throw new Error("Answer Source revision is unavailable");
					}
					const sourceRef = `S${sources.size + 1}`;
					const path = `sources/${sourceRef}`;
					const view = materializeAgentSourceView(source.sourceRoot, join(input.inputRoot, path));
					originalSource = { ref: sourceRef, path, files: view.contentFiles.map((file) => file.relativePath) };
					sources.set(key, originalSource);
				}
				if (!originalSource.files.includes(anchor.source_path)) throw new Error("Answer evidence path is outside its Source view");
				const lines = readFileSync(join(input.inputRoot, originalSource.path, anchor.source_path), "utf-8")
					.replace(/\r\n?/gu, "\n").split("\n");
				if (!Number.isSafeInteger(anchor.start_line) || !Number.isSafeInteger(anchor.end_line)
					|| anchor.start_line < 1 || anchor.end_line < anchor.start_line || anchor.end_line > lines.length) {
					throw new Error("Answer evidence range is invalid");
				}
				// Cornell's display excerpt removes image markers and whitespace. Verify and freeze original line bytes.
				excerpt = lines.slice(anchor.start_line - 1, anchor.end_line).join("\n");
			}
			const digest = sha256(`${excerpt}\n`);
			if (anchor.content_sha256 && anchor.content_sha256 !== digest) throw new Error("Answer evidence bytes changed");
			return { ...anchor, excerpt, content_sha256: digest,
				context: originalSource ? { kind: "original_source" as const, ...originalSource } : { kind: "excerpt_only" as const } };
		});
		writeFileSync(join(input.inputRoot, "evidence", `${ref}.json`), `${JSON.stringify({ ...item, evidence }, null, 2)}\n`);
	}
	writeFileSync(join(input.inputRoot, "request.json"), `${JSON.stringify(input.request, null, 2)}\n`);
	readInvestigationAnswerRequest(input.inputRoot);
}

export function readInvestigationAnswerRequest(inputRoot: string): InvestigationAnswerRequest {
	const value: unknown = JSON.parse(readFileSync(join(inputRoot, "request.json"), "utf-8"));
	if (!isRecord(value) || value.schema_version !== 1 || typeof value.question !== "string" || !value.question.trim()
		|| typeof value.context !== "string" || typeof value.language !== "string" || !value.language.trim()
		|| !Array.isArray(value.requirements) || !value.requirements.length
		|| !Array.isArray(value.evidence_refs) || value.evidence_refs.some((ref) => typeof ref !== "string" || !CITATION.test(ref))
		|| new Set(value.evidence_refs).size !== value.evidence_refs.length) {
		throw new Error("Answer request is invalid");
	}
	const ids = new Set<string>();
	for (const item of value.requirements) {
		if (!isRecord(item) || typeof item.id !== "string" || !/^Q[1-9][0-9]*$/u.test(item.id) || ids.has(item.id)
			|| typeof item.question !== "string" || !item.question.trim()) throw new Error("Answer requirement is invalid");
		ids.add(item.id);
	}
	return value as unknown as InvestigationAnswerRequest;
}

/** Structural coverage and citation checks; Agents still own interpretation of the original text. */
export function validateInvestigationAnswerFromInput(value: unknown, inputRoot: string): InvestigationAnswer {
	const request = readInvestigationAnswerRequest(inputRoot);
	if (!isRecord(value) || JSON.stringify(Object.keys(value).sort())
		!== JSON.stringify(["answer", "citation_refs", "coverage", "gaps"])
		|| typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > 32_000
		|| !Array.isArray(value.citation_refs) || !Array.isArray(value.gaps) || !Array.isArray(value.coverage)) {
		throw new Error("Answer output is invalid");
	}
	const refs = new Set(request.evidence_refs);
	const checkRefs = (items: unknown[]): void => {
		if (items.some((ref) => typeof ref !== "string" || !refs.has(ref)) || new Set(items).size !== items.length) {
			throw new Error("Answer cites unknown or duplicate evidence");
		}
	};
	checkRefs(value.citation_refs);
	const cited = [...value.answer.matchAll(/<cite>([^<>\s]+)<\/cite>/gu)].map((match) => match[1]!);
	if (JSON.stringify([...new Set(cited)].sort()) !== JSON.stringify([...value.citation_refs].sort())) {
		throw new Error("Answer and citation refs disagree");
	}
	if (value.gaps.some((gap) => typeof gap !== "string" || !gap.trim())) throw new Error("Answer gaps must be specific nonempty strings");
	const requirements = new Set(request.requirements.map((item) => item.id));
	for (const row of value.coverage) {
		if (!isRecord(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(["citation_refs", "gap", "requirement_id"])
			|| typeof row.requirement_id !== "string" || !requirements.delete(row.requirement_id)
			|| !Array.isArray(row.citation_refs) || typeof row.gap !== "string") throw new Error("Answer coverage is invalid");
		checkRefs(row.citation_refs);
		if (!row.gap.trim() && !row.citation_refs.length) throw new Error("Covered answer requirement needs evidence");
		if (row.citation_refs.some((ref) => !(value.citation_refs as unknown[]).includes(ref))) {
			throw new Error("Answer coverage evidence is absent from the answer");
		}
		if (row.gap && !(value.gaps as unknown[]).includes(row.gap)) throw new Error("Answer omitted a coverage gap");
	}
	if (requirements.size) throw new Error("Answer omitted requested coverage");
	return value as unknown as InvestigationAnswer;
}

/** One Writer delegation over frozen inputs, using the existing Report Writer execution and Capture. */
export async function executeInvestigationAnswer(input: {
	inputRoot: string; recordDirectory: string; goalDir: string; invocationId: string;
	env: NodeJS.ProcessEnv; signal: AbortSignal; onActivity?: (activity: AgentStageActivity) => void;
	stageRunner?: AgentStageRunner;
	modelPolicy?: ResearchModelPolicy;
}): Promise<InvestigationAnswer> {
	const system = renderAgentPrompt("research", "report-writer", "system-append", {}, "answer");
	const user = renderAgentPrompt("research", "report-writer", "user", {}, "answer");
	const runner = input.stageRunner ?? createProductionResearchStageRunner({ env: input.env });
	const capturedRunner = caseCapture()?.researchStages?.(runner, input.goalDir) ?? runner;
	const answerKey = sha256(input.invocationId).slice(0, 24);
	const result = await capturedRunner.runStage<InvestigationAnswer>({
		runId: input.invocationId, stageId: `writer-answer-${answerKey}`, attemptId: "attempt-1", role: "report_writer",
		promptConfig: { domain: "research", id: "report-writer", sandboxRole: "report.report_writer", userVariant: "answer",
			revisions: { system: system.revision, user: user.revision } },
		session: { key: `answer/${input.invocationId}`, policy: "fresh" },
		modelPolicy: input.modelPolicy ?? primeReportWriterStageModelPolicy(input.env),
		systemPrompt: system.content, userPrompt: user.content,
		workDirectory: join(input.recordDirectory, "answer-workspaces", answerKey),
		readonlyMounts: [{ hostPath: input.inputRoot, guestPath: "/inputs", access: "read-only" }],
		controlDirectory: input.recordDirectory, recordDirectory: input.recordDirectory,
		artifactStore: new RunArtifactStore(input.recordDirectory),
		output: { kind: "json_candidate", entryRelativePath: "work/answer.json", publishRelativePath: `artifacts/answers/${answerKey}.json`,
			validate: ({ entryPath }) => validateInvestigationAnswerFromInput(JSON.parse(readFileSync(entryPath, "utf-8")), input.inputRoot) },
		signal: input.signal, onActivity: input.onActivity,
	});
	return result.value;
}
