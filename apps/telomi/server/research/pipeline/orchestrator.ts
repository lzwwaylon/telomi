import type { ResolvedOutputLanguage } from "../../../shared/languages.js";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { TASK_MODEL_ROLE_INFO, taskModelStages } from "../../config/settings.js";
import { PRIME_MODEL_DEFINITIONS_ENV } from "../../agent-runtime/prime-agent-paths.js";
import { RUN_MODEL_ROLES } from "../run-model-selection.js";
import { resolvePrimeAgentModels } from "../../agent-runtime/model-policy.js";
import {
	createGoalLlmWikiTools,
	type WikiCompilationResult,
} from "../../wiki/index.js";

import type { SandboxMountSpec } from "../../../../extensions/telomi-srt/sandbox-spec.js";
import type { publishCompilation } from "../../wiki/publication.js";
import { startWikiUpdateActivity } from "../../wiki/update-runner.js";
import type { WikiCompilationRequest } from "../../wiki/index.js";
import { sha256 } from "../../lib/hash.js";
import { appendRuntimeContext, readAgentNodeUsage } from "../../observability/run-records.js";
import type {
	ScheduledResearchContext,
	ScheduledResearchSkipReason,
} from "../scheduled-research-context.js";
import type { ResearchExecutionResult, ResearchNodeStatus } from "../types.js";
import type { ResearchSourceCatalogEntry } from "../../providers/search-types.js";
import type { LogicalSource, ResearchTemporalContext } from "../research-types.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import type { AgentStageActivity, AgentStageRunner, ValidatedStageArtifact } from "../../agent-runtime/agent-stage-runtime.js";
import { primeReportWriterStageModelPolicy, REPORT_WRITER_REQUEST_FILE } from "./prime-report-writer.js";
import { loadReportNoteWorkspace } from "../notes/workspace.js";
import {
	type PublishedArtifactDirectoryRef,
	type PublishedArtifactRef,
	RunArtifactStore,
} from "../../agent-runtime/artifact-store.js";
import {
	buildKnowledgeCitationRegistry,
	compileCanonicalMarkdown,
	normalizeCitationSource,
	resolveUnavailableCitationUrls,
	validateCanonicalMarkdown,
	validateChapterCandidate,
} from "./citation-compiler.js";
import { validateCornellNotesSnapshot, type CornellNotesSnapshot } from "../../cornell/contracts.js";
import { validateSearchExecutionRecord, type ProviderExecution } from "../../providers/search-contracts.js";
import type { ExecutableReportPlan } from "./report-plan.js";
import {
	type CornellNotesMaterializer,
	type CornellNotesMaterializeRequest,
} from "./cornell-notes.js";
import {
	createAgentEvidenceHandles,
	requireAgentEvidenceHandle,
	type AgentEvidenceHandles,
} from "./evidence-handles.js";
import { StageInputView } from "./input-view.js";
import { listPriorReports, stagePriorReports } from "./prior-reports.js";
import {
	buildFindOutReportWriterSystemPrompt,
	buildFullReportWriterSystemPrompt,
	findOutSelfDirectedWriterUserPrompt,
	materializeReportPlan,
	validateWriterAuthoredOutline,
	wikiSelfDirectedWriterUserPrompt,
	type ReportOutline,
} from "./report-prompts.js";
import type { SearchBatchExecutor, SearchBatchResult } from "./search-batch.js";
import { validateSourceBundleDirectory } from "./source-bundle.js";
import { materializeFindOutReportView, materializeReportKnowledgeView } from "./report-knowledge-view.js";
import { createWikiReportReferenceAdapter } from "./wiki-report-references.js";
import {
	filterProcessedSources,
	scheduledSourceContentSha256,
	scheduledSourceIdentity,
} from "./source-version.js";
import type { RunArtifactRef } from "../../agent-runtime/artifact-store.js";
import { loadFindOutSources } from "./find-out-sources.js";
import {
	RUN_WORKFLOW_ID,
	RUN_WORKFLOW_VERSION,
	RunStateStore,
	type RunIdentityPins,
	type RunStateV2,
	type RunStatus,
} from "../run-state.js";
import {
	materializeWriterChapter,
	planFromWriterManifest,
	validateWriterChapterOutput,
	type WriterOutput,
} from "./writer-output.js";
import { GoalTopicPlanStore, validateGoalTopicPlan, type GoalTopicPlan } from "../../goals/topic-plan/index.js";
import { publish } from "../../events/event-bus.js";
import { readJson } from "../../lib/fs.js";
import { toErrorMessage } from "../../lib/values.js";

export interface RunRequest {
	runId: string;
	goalId: string;
	goalTitle?: string;
	goalDescription?: string;
	/** Goal-level output language for the Wiki, which outlives this Run. */
	goalLanguage?: ResolvedOutputLanguage;
	question: string;
	reportContext: string;
	discoveryEnabled: boolean;
	language: string;
	workspaceDirectory: string;
	controlDirectory: string;
	skillWorkspaceDirectory?: string;
	goalWorkspaceDirectory?: string;
	workspaceRootDirectory?: string;
	organizerStorageRoot?: string;
	providerCatalog: Array<ResearchSourceCatalogEntry & { id: string }>;
	temporalContext: ResearchTemporalContext;
	pipeline: CornellNotesMaterializeRequest["pipeline"];
	identityPins: RunIdentityPins;
	topicPlan?: GoalTopicPlan;
	env: Record<string, string | undefined>;
	signal: AbortSignal;
	/**
	 * 只跑 Report Flow：Cornell Notes 已经冻结，直接从它开始。
	 * 没有 wikiCompilation 就是 Find Out 模式，Knowledge 视图当场从 Notes 物化。
	 */
	reportInput?: {
		sourceRunId: string;
		cornellNotesArtifact: PublishedArtifactRef;
		wikiCompilation?: WikiCompilationResult;
		knowledgeInput?: { ref: string; sha256: string; byteLength: number };
	};
	reportTools?: readonly AgentTool[];
	wikiTools?: readonly AgentTool[];
	scheduledResearch?: ScheduledResearchContext;
	onProgress?: (event: {
		stage: string;
		status: "running" | "succeeded" | "failed" | "cancelled";
		sequence?: number;
		detail?: string;
	}) => void;
	onAgentOutput?: (activity: AgentStageActivity) => void;
}

export interface RunResult {
	execution: ResearchExecutionResult;
	state: RunStateV2;
	finalReportPath: string;
}

export interface RunDependencies {
	stageRunner: AgentStageRunner;
	searchBatchExecutor: SearchBatchExecutor;
	evidenceMaterializer: CornellNotesMaterializer;
	validateCitationUrls(markdown: string, signal: AbortSignal): Promise<ReadonlySet<string>>;

	wikiAgent?: { compile(request: WikiCompilationRequest): Promise<WikiCompilationResult> };
	publishWikiCompilation?: typeof publishCompilation;
}

function trace(
	request: Pick<RunRequest, "controlDirectory">,
	event: { type: string; [key: string]: unknown },
): void {
	appendRuntimeContext(request.controlDirectory, "research", event);
}

interface HydratedCheckpoint {
	documents: LogicalSource[];
	bundleRefs: string[];
	evidence: Array<{ snapshot: CornellNotesSnapshot; artifact: PublishedArtifactRef }>;
}

type RunTransition = (status: RunStatus, update?: (draft: RunStateV2) => void) => void;
type RunEmit = (
	stage: string,
	status: "running" | "succeeded" | "failed" | "cancelled",
	sequence?: number,
	detail?: string,
) => void;

interface SearchCycleResult {
	evidence: CornellNotesSnapshot;
	cornellNotesArtifact: PublishedArtifactRef;
}

class ScheduledResearchSkipped extends Error {
	constructor(readonly reason: ScheduledResearchSkipReason) {
		super(`scheduled_research_skipped:${reason}`);
		this.name = "ScheduledResearchSkipped";
	}
}

/** Persist admission before Runtime initialization can yield to another Run request. */
export function initializeRunState(request: Pick<RunRequest,
	"runId" | "goalId" | "question" | "language" | "identityPins" | "topicPlan" | "workspaceDirectory" | "controlDirectory"
>): RunStateV2 {
	const stateStore = new RunStateStore(request.controlDirectory);
	const existing = stateStore.load(request.identityPins);
	if (existing) return existing;
	const artifactStore = new RunArtifactStore(request.workspaceDirectory);
	const frozenTopicPlan = request.topicPlan ? validateGoalTopicPlan(request.topicPlan) : undefined;
	const topicPlanArtifact = frozenTopicPlan
		? artifactStore.publishText(`${JSON.stringify(frozenTopicPlan, null, 2)}\n`, "artifacts/input/topic-plan.json")
		: undefined;
	return stateStore.create({
		runId: request.runId,
		goalId: request.goalId,
		question: request.question,
		language: request.language,
		pins: request.identityPins,
		...(topicPlanArtifact ? { topicPlan: { revision: frozenTopicPlan!.revision, snapshot: artifactRef(topicPlanArtifact) } } : {}),
	});
}

export class Run {
	constructor(private readonly dependencies: RunDependencies) {}

	async run(request: RunRequest): Promise<RunResult> {
		if (!request.question.trim()) throw new Error("Run requires a non-empty question");
		if (typeof request.reportContext !== "string" || !request.reportContext.trim()) {
			throw new Error("Run requires non-empty reportContext");
		}
		mkdirSync(request.workspaceDirectory, { recursive: true });
		mkdirSync(request.controlDirectory, { recursive: true });
		const artifactStore = new RunArtifactStore(request.workspaceDirectory);
		const stateStore = new RunStateStore(request.controlDirectory);
		let state = stateStore.load(request.identityPins);
		const frozenTopicPlan = state?.topic_plan
			? validateGoalTopicPlan(JSON.parse(readFileSync(artifactStore.openFile(state.topic_plan.snapshot).absolutePath, "utf-8")))
			: request.topicPlan ? validateGoalTopicPlan(request.topicPlan) : undefined;
		if (frozenTopicPlan) request.topicPlan = frozenTopicPlan;
		if (state?.status === "published" && state.canonical_report) {
			const report = artifactStore.openFile(state.canonical_report);
			trace(request, {
				type: "runtime.published_run_checkpoint_reused",
				run_id: request.runId,
				report_ref: report.relativePath,
				report_sha256: report.sha256,
			});
			return this.result(request, state, {});
		}
		if (state?.status === "skipped") {
			return this.result(request, state, {});
		}
		if (state?.status === "failed" || state?.status === "cancelled") {
			throw new Error(`terminal_checkpoint_not_resumable:${state.status}`);
		}
		state = initializeRunState(request);
		const hydrated = hydrateCheckpoint(artifactStore, state, request.providerCatalog);
		const nodeStatuses: Record<string, ResearchNodeStatus> = {};
		const cumulativeSources = request.scheduledResearch
			? filterProcessedSources(
				hydrated.documents,
				request.scheduledResearch.processedSources,
			)
				: hydrated.documents;
			const cumulativeBundleRefs = hydrated.bundleRefs;
			let currentEvidence = hydrated.evidence.at(-1)?.snapshot;
		let currentEvidenceArtifact = hydrated.evidence.at(-1)?.artifact;
		for (const reference of currentEvidence?.source_bundle_refs ?? []) {
			if (!cumulativeBundleRefs.includes(reference)) cumulativeBundleRefs.push(reference);
		}

		const emit = (
			stage: string,
			status: "running" | "succeeded" | "failed" | "cancelled",
			sequence?: number,
			detail?: string,
		) => {
			nodeStatuses[sequence === undefined ? stage : `${stage}:${sequence}`] = status;
			request.onProgress?.({
				stage,
				status,
				...(sequence === undefined ? {} : { sequence }),
				...(detail ? { detail } : {}),
			});
		};
		const transition = (
			status: RunStatus,
			update?: (draft: RunStateV2) => void,
		) => {
			const previous = structuredClone(state!);
			update?.(state!);
			state!.status = status;
			state!.updated_at = new Date().toISOString();
			stateStore.save(previous, state!);
		};
		try {
			if (request.reportInput) {
				const reportInput = request.reportInput;
				const localCornellPath = "artifacts/report-run/cornell-notes.json";
				const localCornell = existsSync(join(request.workspaceDirectory, localCornellPath))
					? artifactStore.describeFile(localCornellPath)
					: artifactStore.publishFile(reportInput.cornellNotesArtifact.absolutePath, localCornellPath);
				if (localCornell.sha256 !== reportInput.cornellNotesArtifact.sha256
					|| localCornell.byteLength !== reportInput.cornellNotesArtifact.byteLength) {
					throw new Error("Report Cornell Notes changed while entering the Run Artifact Store");
				}
				const evidence = validateCornellNotesSnapshot(readJson(localCornell.absolutePath));
				artifactStore.publishText(`${JSON.stringify({
					schema_version: 1,
					run_id: request.runId,
					source_run_id: reportInput.sourceRunId,
					input_mode: reportInput.wikiCompilation ? "wiki" : "findout",
					...(reportInput.knowledgeInput ? { knowledge_input: reportInput.knowledgeInput } : {}),
					created_at: state.started_at,
				}, null, 2)}\n`, "artifacts/report-run/manifest.json");
				return await this.runReportFlow({
					request,
					artifactStore,
					state,
					transition,
					emit,
					evidence,
					cornellNotesArtifact: localCornell,
					cumulativeBundleRefs: [],
					nodeStatuses,
					...(reportInput.wikiCompilation ? { wikiCompilation: reportInput.wikiCompilation } : {}),
					skipWikiPublication: true,
				});
			}
			if (!currentEvidence || !currentEvidenceArtifact) {
				const initial = await this.runSearchCycle({
					request,
					artifactStore,
					state,
					transition,
					emit,
					sequence: hydrated.evidence.length + 1,
					cumulativeSources,
					cumulativeBundleRefs,
					skipSearchBatch: state.status === "evidence_materializing",
				});
				currentEvidence = initial.evidence;
				currentEvidenceArtifact = initial.cornellNotesArtifact;
			}
			if (!currentEvidence || !currentEvidenceArtifact) {
				throw new Error("Research Run has no current Evidence checkpoint");
			}
			// A resumed Run hydrates the snapshot a failed gate recorded, skipping the search cycle that
			// enforces the gate, so it is enforced again on whatever evidence reaches the report.
			if (!hasUsableEvidence(currentEvidence)) throw new Error(NO_USABLE_EVIDENCE);
			for (const reference of currentEvidence.source_bundle_refs) {
				if (!cumulativeBundleRefs.includes(reference)) cumulativeBundleRefs.push(reference);
			}
			this.startWikiUpdate({
				request,
				evidence: currentEvidence,
				cornellNotesArtifact: currentEvidenceArtifact,
			});
			return await this.runReportFlow({
				request,
				artifactStore,
				state,
				transition,
				emit,
				evidence: currentEvidence,
				cornellNotesArtifact: currentEvidenceArtifact,
				cumulativeBundleRefs,
					nodeStatuses,
			});
		} catch (error) {
			if (error instanceof ScheduledResearchSkipped) {
				return this.result(request, state, nodeStatuses);
			}
			const detail = toErrorMessage(error);
			const cancelled = request.signal.aborted;
			const message = cancelled ? "Research Run cancelled by request" : detail;
			if (
				state.status !== "published"
				&& state.status !== "skipped"
				&& state.status !== "failed"
				&& state.status !== "cancelled"
			) {
				transition(cancelled ? "cancelled" : "failed", (draft) => {
					synchronizeAgentUsage(
						draft,
						{ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
						request.controlDirectory,
					);
					draft.finished_at = new Date().toISOString();
					draft.failure = {
						failure_class: cancelled ? "cancelled" : classifyFailure(message),
						failed_stage: draft.status,
						message,
						...(cancelled ? { cancellation_source: "request_signal" as const } : {}),
					};
				});
			}
			emit("complete", request.signal.aborted ? "cancelled" : "failed", undefined, message);
			throw error;
		}
	}

	private async runReportFlow(args: {
		request: RunRequest;
		artifactStore: RunArtifactStore;
		state: RunStateV2;
		transition: RunTransition;
		emit: RunEmit;
		evidence: CornellNotesSnapshot;
		cornellNotesArtifact: PublishedArtifactRef;
		cumulativeBundleRefs: readonly string[];
		nodeStatuses: Record<string, ResearchNodeStatus>;
		wikiCompilation?: WikiCompilationResult;
		skipWikiPublication?: boolean;
	}): Promise<RunResult> {
		const { request, artifactStore, state, transition, emit, evidence } = args;
		const reportModelPolicy = primeReportWriterStageModelPolicy(request.env);
		const reportChild = resolvePrimeAgentModels(request.env).child;
		const knowledgeMode = args.wikiCompilation ? "wiki" as const : "findout" as const;
		const knowledgeSnapshot = this.reportKnowledgeSnapshot({ request, artifactStore, evidence,
			cornellNotesArtifact: args.cornellNotesArtifact, wikiCompilation: args.wikiCompilation });
		const availableReportTools = knowledgeMode === "wiki" ? request.reportTools ?? createGoalLlmWikiTools({
			goalDir: request.goalWorkspaceDirectory ?? request.workspaceDirectory,
			knowledgeRoot: join(knowledgeSnapshot.absolutePath, "wiki"),
		}) : [];
		const rawReportTools = availableReportTools.filter((tool) =>
			["wiki_search", "wiki_read_page", "wiki_graph_search"].includes(tool.name));
		const wikiRefs = knowledgeMode === "wiki"
			? createWikiReportReferenceAdapter(knowledgeSnapshot, rawReportTools)
			: undefined;
		const reportTools = wikiRefs?.tools ?? rawReportTools;
		const knowledgePaths = wikiRefs ? new Set(wikiRefs.pageRefs) : undefined;
		const handles = createAgentEvidenceHandles([evidence]);
		const citationRegistry = buildKnowledgeCitationRegistry({ knowledgeSnapshot, cornellNotes: evidence });
		{
			const registryPath = "artifacts/report-flow/knowledge-url-registry.json";
			const serializedRegistry = `${JSON.stringify(citationRegistry, null, 2)}\n`;
			if (existsSync(join(request.workspaceDirectory, registryPath))) {
				const existing = artifactStore.describeFile(registryPath);
				if (readFileSync(existing.absolutePath, "utf-8") !== serializedRegistry) {
					throw new Error("Frozen Knowledge citation registry changed after Report execution started");
				}
			} else {
				artifactStore.publishText(serializedRegistry, registryPath);
			}
		}
		if (
			state.status !== "plan_authoring"
			&& state.status !== "plan_selected"
			&& state.status !== "chapters_writing"
			&& state.status !== "citation_compiling"
			&& state.status !== "markdown_gating"
		) {
			transition("plan_authoring");
		}
		const scopePath = "artifacts/report-flow/task.md";
		const scopeArtifact = existsSync(join(request.workspaceDirectory, scopePath))
			? artifactStore.describeFile(scopePath)
			: artifactStore.publishText(`${request.reportContext}\n`, scopePath);
		const cornellFailures = reportCornellFailures(state, artifactStore);

		const outlinePath = "artifacts/report-flow/outline.json";
		let outline: ReportOutline | undefined;
		const planPath = "artifacts/report-flow/executable-plan.json";
		let plan: ExecutableReportPlan | undefined;

		const writerStageId = "writer-report";
		const writerPath = "artifacts/report-flow/writer";
		emit("report_writer", "running");
		const writerInput = new StageInputView(join(request.controlDirectory, "input-views", writerStageId));
		writerInput.writeText("task.md", `${request.reportContext}\n`);
		writerInput.writeText("search-question.md", `${request.question}\n`);
		writerInput.writeJson(REPORT_WRITER_REQUEST_FILE, { schema_version: 1, language: request.language });
		// 历史报告只是连续性与对比的上下文，事实仍必须引用当前知识接口；Writer 自己决定读哪几份。
		const priorReports = request.goalWorkspaceDirectory ? stagePriorReports(writerInput, listPriorReports({
			goalWorkspaceDirectory: request.goalWorkspaceDirectory,
			controlRunsRoot: dirname(request.controlDirectory),
			currentRunId: request.runId,
		})) : "";
		writerInput.writeJson("materials.json", {
			schema_version: 1,
			kind: knowledgeMode,
			refs: knowledgeMode === "wiki"
				? wikiRefs!.pageRefs
				: evidence.notes.filter((record) => record.note.sections.length > 0)
					.map((record) => requireAgentEvidenceHandle(handles, record.note.source_id)).sort(),
		});
		if (cornellFailures) writerInput.writeJson("cornell-failures.json", cornellFailures);
		if (knowledgeMode === "findout") copyFindOutView(writerInput, knowledgeSnapshot);
		let outlineEvidenceIds = new Set<string>();
		// N ref 一直保留到 final.json：同一 Source 的不同 Note 必须拥有不同 Citation identity。
		const noteWorkspaceForRefs = knowledgeMode === "findout"
			? loadReportNoteWorkspace(knowledgeSnapshot.absolutePath)
			: undefined;
		const resolveWriterRefs = (output: WriterOutput): WriterOutput => {
			if (!noteWorkspaceForRefs) return output;
			for (const ref of output.sections.flatMap((section) => noteCitationRefs(section.body_markdown))) {
				if (citationRegistry.entries.some((entry) => entry.ref === ref)) continue;
				const note = noteWorkspaceForRefs.citation(ref);
				if (!note) throw new Error(`Report cites unknown Note ref '${ref}'`);
				const url = normalizeCitationSource(note.source_urls[0]!);
				const source = citationRegistry.entries.find((entry) => !entry.ref
					&& entry.url === url && entry.evidenceId === note.source_id);
				if (!source) throw new Error(`Note ref '${ref}' is outside the frozen Knowledge Snapshot`);
				citationRegistry.entries.push({ ...source, ref });
			}
			return output;
		};
		const resolvePlan = (manifestPath: string): ExecutableReportPlan => {
			const manifestPlan = planFromWriterManifest(
				manifestPath,
				request.question.trim().split("\n")[0]!.slice(0, 120),
			);
			const authoredOutlinePath = join(dirname(manifestPath), "outline.json");
			if (!existsSync(authoredOutlinePath)) {
				throw new Error("Writer-authored Report output is missing outline.json");
			}
			const submittedOutline = validateWriterAuthoredOutline(readJson(authoredOutlinePath), handles, knowledgePaths);
			const authoredOutline = wikiRefs ? {
				...submittedOutline,
				sections: submittedOutline.sections.map((section) => ({
					...section,
					knowledge_refs: section.knowledge_refs.map((ref) => wikiRefs.resolvePageRef(ref)),
				})),
			} : submittedOutline;
			const authoredPlan = materializeReportPlan(authoredOutline);
			if (authoredPlan.sections.some((section, index) =>
				section.section_id !== manifestPlan.sections[index]?.section_id
				|| section.title !== manifestPlan.sections[index]?.title)) {
				throw new Error("Writer-authored Outline does not match the final chapter manifest");
			}
			outline = authoredOutline;
			plan = authoredPlan;
			outlineEvidenceIds = new Set(authoredPlan.sections
				.flatMap((section) => section.claims.flatMap((claim) => claim.cornell_notes_refs)));
			return authoredPlan;
		};
		const validateWriter = async (resolved: ExecutableReportPlan, rawOutput: WriterOutput) => {
			const output = resolveWriterRefs(rawOutput);
			if (wikiRefs) {
				const refs = output.sections.flatMap((section) => wikiCitationRefs(section.body_markdown));
				await wikiRefs.hydrateCitationRefs(refs, request.signal);
				for (const ref of refs) {
					if (citationRegistry.entries.some((entry) => entry.ref === ref)) continue;
					const citation = wikiRefs.resolveCitationRef(ref);
					citationRegistry.entries.push({
						ref,
						url: citation.entry.source.url,
						title: citation.entry.source.title,
						provenance: citation.entry.source.id,
						fileRefs: [citation.page.path],
						evidenceId: citation.entry.source.id,
						wiki: citation,
					});
				}
			}
			for (const section of resolved.sections) {
				const markdown = materializeWriterChapter(section, output);
				validateChapterCandidate(section, markdown, evidence, citationRegistry, outlineEvidenceIds);
			}
			compileCanonicalMarkdown({
				plan: resolved,
				cornellNotes: evidence,
				chapters: resolved.sections.map((section) => ({
					sectionId: section.section_id,
					markdown: materializeWriterChapter(section, output),
				})),
				citationRegistry,
				outlineEvidenceIds,
			});
		};
		const existingWriter = existsSync(join(request.workspaceDirectory, writerPath))
			? artifactStore.describeDirectory(writerPath)
			: undefined;
		let finalOutput: WriterOutput;
		if (existingWriter) {
			const manifestPath = join(existingWriter.absolutePath, "manifest.json");
			const resumed = resolvePlan(manifestPath);
			plan = resumed;
			finalOutput = resolveWriterRefs(validateWriterChapterOutput(manifestPath, resumed.sections));
			await validateWriter(resumed, finalOutput);
			if (!state.writer_outputs.some((checkpoint) => checkpoint.assignment_id === "report")) {
				transition("plan_selected", (draft) => {
					draft.writer_outputs.push({ assignment_id: "report", output: artifactRef(existingWriter) });
				});
			}
		} else {
			const stage = await this.dependencies.stageRunner.runStage({
				runId: request.runId,
				stageId: writerStageId,
				attemptId: "1",
				role: "report_writer",
				session: { key: writerStageId, policy: "fresh" },
				modelPolicy: reportModelPolicy,
				systemPrompt: knowledgeMode === "findout"
					? buildFindOutReportWriterSystemPrompt()
					: buildFullReportWriterSystemPrompt(),
				userPrompt: (knowledgeMode === "findout"
					? findOutSelfDirectedWriterUserPrompt
					: wikiSelfDirectedWriterUserPrompt)({
						language: request.language,
						currentDate: request.temporalContext.currentDate,
						timeZone: request.temporalContext.timeZone,
						priorReports,
					}),
				// 已完成的 Section 草稿留在盘上，Writer Stage 自己决定复用哪些。
				workDirectory: this.workDirectory(request, writerStageId, { preserve: true }),
				sandbox: { env: {
					TELOMI_PRIME_AGENT_CHILD_MODEL: reportChild.selector,
				} },
				readonlyMounts: [
					writerInput.mount(),
					...this.workspaceCapabilityMounts(request, "report-writer"),
				],
				fileToolPolicy: reportWriterFileToolPolicy(),
				controlDirectory: request.controlDirectory,
				artifactStore,
				output: {
					kind: "writer_chapters",
					publishRelativePath: writerPath,
					validate: ({ entryPath }) => {
						const authored = resolvePlan(entryPath);
						plan = authored;
						return validateWriterChapterOutput(entryPath, authored.sections);
					},
					validateAsync: (output: WriterOutput) => validateWriter(plan!, output),
				},
				...(reportTools.length ? { additionalTools: reportTools } : {}),
				signal: request.signal,
			});
			applyStageUsage(state, stage, request.controlDirectory);
			finalOutput = resolveWriterRefs(stage.value);
			const artifact = stage.artifact as PublishedArtifactRef | PublishedArtifactDirectoryRef;
			transition("plan_selected", (draft) => {
				draft.writer_outputs.push({
					assignment_id: "report",
					output: artifactRef(artifact),
				});
			});
		}
		// 唯一的 Prime Report Root 产出 Outline 与章节。Runtime 只在这里校验并发布结构产物。
		if (!plan) throw new Error("Report Flow finished the Writer Stage without an executable Plan");
		const reportPlan = plan;
		if (!outline) throw new Error("Report Flow finished without an authoritative Outline");
		const reportOutline = outline;
		const outlineText = `${JSON.stringify(persistedOutline(reportOutline, handles, knowledgeMode), null, 2)}\n`;
		const reportOutlineArtifact = existsSync(join(request.workspaceDirectory, outlinePath))
			? artifactStore.describeFile(outlinePath)
			: artifactStore.publishText(outlineText, outlinePath);
		if (readFileSync(reportOutlineArtifact.absolutePath, "utf-8") !== outlineText) {
			throw new Error("Published Report Outline does not match the Prime Report Root output");
		}
		const planText = `${JSON.stringify(reportPlan, null, 2)}\n`;
		const reportPlanArtifact = existsSync(join(request.workspaceDirectory, planPath))
			? artifactStore.describeFile(planPath)
			: artifactStore.publishText(planText, planPath);
		if (readFileSync(reportPlanArtifact.absolutePath, "utf-8") !== planText) {
			throw new Error("Published Report Plan does not match the Prime Report Root output");
		}
		if (state.status !== "chapters_writing") transition("chapters_writing");
		emit("report_writer", "succeeded");

		for (const [index, section] of reportPlan.sections.entries()) {
			if (index < state.accepted_chapters.length) {
				if (state.accepted_chapters[index]?.section_id !== section.section_id) {
					throw new Error("Accepted Chapter checkpoints must remain an Outline-order prefix");
				}
				continue;
			}
				const markdown = materializeWriterChapter(section, finalOutput);
				const path = `artifacts/accepted-chapters/${section.section_id}.md`;
				const artifact = existsSync(join(request.workspaceDirectory, path))
					? artifactStore.describeFile(path)
					: artifactStore.publishText(markdown, path);
				transition("chapters_writing", (draft) => {
					draft.accepted_chapters.push({
						section_id: section.section_id,
						chapter: artifactRef(artifact),
					});
				});
		}

		transition("citation_compiling");
		emit("citation_compiler", "running");
		const chapters = reportPlan.sections.map((section) => ({
			sectionId: section.section_id,
			markdown: materializeWriterChapter(section, finalOutput!),
		}));
		let citationValidationFailure: string | undefined;
		const unavailableUrls = await resolveUnavailableCitationUrls(
			chapters,
			request.signal,
			this.dependencies.validateCitationUrls,
			citationRegistry,
			(error) => {
				citationValidationFailure = toErrorMessage(error);
			},
		);
		const compiled = compileCanonicalMarkdown({
			plan: reportPlan,
			cornellNotes: evidence,
			chapters,
			unavailableUrls,
			citationRegistry,
			outlineEvidenceIds,
		});
		transition("markdown_gating");
		validateCanonicalMarkdown(compiled.markdown);
		const reportArtifact = existsSync(join(request.workspaceDirectory, "report/final.md"))
			? artifactStore.describeFile("report/final.md")
			: artifactStore.publishText(compiled.markdown, "report/final.md");
		if (readFileSync(reportArtifact.absolutePath, "utf-8") !== compiled.markdown) {
			throw new Error("Published canonical Markdown does not match report flow compilation");
		}
		const structuredReport = `${JSON.stringify({
			markdown: compiled.markdown,
			citations: compiled.citations,
		}, null, 2)}\n`;
		const structuredReportArtifact = existsSync(join(request.workspaceDirectory, "report/final.json"))
			? artifactStore.describeFile("report/final.json")
			: artifactStore.publishText(structuredReport, "report/final.json");
		if (readFileSync(structuredReportArtifact.absolutePath, "utf-8") !== structuredReport) {
			throw new Error("Published structured report does not match report flow compilation");
		}
		emit(
			"citation_compiler",
			"succeeded",
			undefined,
			citationValidationFailure
				? `${compiled.citationCount} citations; URL validation skipped: ${citationValidationFailure}`
				: `${compiled.citationCount} citations`,
		);

		if (args.wikiCompilation && !args.skipWikiPublication) {
			if (!request.goalWorkspaceDirectory || !request.workspaceRootDirectory || !this.dependencies.publishWikiCompilation) {
				throw new Error("Wiki publication requires the Goal Workspace and publisher");
			}
			emit("wiki_publish", "running");
			const publication = await this.dependencies.publishWikiCompilation({
				goalId: request.goalId,
				goalDir: request.goalWorkspaceDirectory,
				workspaceDir: request.workspaceRootDirectory,
				compilation: args.wikiCompilation,
				env: request.env,
				signal: request.signal,
			});
			emit("wiki_publish", "succeeded", undefined, `${publication.changedPaths.length} changed paths`);
		}
		transition("published", (draft) => {
			draft.canonical_report = artifactRef(reportArtifact);
				draft.report_flow = {
					task: artifactRef(scopeArtifact),
				outline: artifactRef(reportOutlineArtifact),
				execution_plan: artifactRef(reportPlanArtifact),
				knowledge_input: {
					mode: knowledgeMode,
					ref: knowledgeSnapshot.relativePath,
					sha256: knowledgeSnapshot.sha256,
					byte_length: knowledgeSnapshot.byteLength,
				},
				cornell_notes_snapshot: artifactRef(args.cornellNotesArtifact),
			};
			draft.finished_at = new Date().toISOString();
		});
		trace(request, {
			type: "runtime.report_flow_completed",
			run_id: request.runId,
			outline_ref: reportOutlineArtifact.relativePath,
			input_mode: knowledgeMode,
			knowledge_ref: knowledgeSnapshot.relativePath,
		});
		emit("complete", "succeeded");
		return this.result(request, state, args.nodeStatuses);
	}

	private reportKnowledgeSnapshot(input: {
		request: RunRequest;
		artifactStore: RunArtifactStore;
		evidence: CornellNotesSnapshot;
		cornellNotesArtifact: PublishedArtifactRef;
		wikiCompilation?: WikiCompilationResult;
	}): PublishedArtifactDirectoryRef {
		if (!input.wikiCompilation) {
			return materializeFindOutReportView({
				targetStore: input.artifactStore,
				evidence: input.evidence,
				cornellNotesArtifact: input.cornellNotesArtifact,
				targetRelativePath: "artifacts/report-flow/findout-snapshot",
			});
		}
		if (input.request.reportInput?.knowledgeInput) {
			const expected = input.request.reportInput.knowledgeInput;
			return input.artifactStore.openDirectory({
				relative_path: expected.ref, sha256: expected.sha256, byte_length: expected.byteLength,
			});
		}
		if (input.evidence.schema_version !== 1) throw new Error("Layered Report knowledge requires Cornell Notes");
		return materializeReportKnowledgeView({
			targetStore: input.artifactStore,
			sourceStore: input.artifactStore,
			wiki: input.wikiCompilation.knowledge,
			evidence: input.evidence,
			cornellNotesArtifact: input.cornellNotesArtifact,
			targetRelativePath: "artifacts/report-flow/knowledge-snapshot",
			baseView: this.previousReportKnowledgeSnapshot(input.request),
		});
	}

	private previousReportKnowledgeSnapshot(request: RunRequest): PublishedArtifactDirectoryRef | undefined {
		const relativePath = "artifacts/report-flow/knowledge-snapshot";
		const runDirectory = this.previousPublishedRunDirectory(request, `${relativePath}/manifest.json`);
		if (!runDirectory) return undefined;
		const store = new RunArtifactStore(runDirectory);
		return store.describeDirectory(relativePath);
	}

	private previousPublishedRunDirectory(request: RunRequest, requiredPath: string): string | undefined {
		if (!request.goalWorkspaceDirectory) return undefined;
		const runsRoot = join(request.goalWorkspaceDirectory, "wiki", "runs");
		if (!existsSync(runsRoot)) return undefined;
		for (const entry of readdirSync(runsRoot, { withFileTypes: true })
			.filter((item) => item.isDirectory() && item.name !== request.runId)
			.sort((left, right) => right.name.localeCompare(left.name))) {
			const statePath = join(dirname(request.controlDirectory), entry.name, "run-state.json");
			if (existsSync(statePath)
				&& (JSON.parse(readFileSync(statePath, "utf-8")) as { status?: unknown }).status === "published"
				&& existsSync(join(runsRoot, entry.name, requiredPath))) {
				return join(runsRoot, entry.name);
			}
		}
		return undefined;
	}

	private startWikiUpdate(input: {
		request: RunRequest;
		evidence: CornellNotesSnapshot;
		cornellNotesArtifact: PublishedArtifactRef;
	}): void {
		if (!this.dependencies.wikiAgent
			|| !this.dependencies.publishWikiCompilation
			|| !input.request.goalWorkspaceDirectory
				|| !input.request.workspaceRootDirectory
				|| !input.request.topicPlan
			|| input.evidence.schema_version !== 1
			|| !input.evidence.notes.some((record) => record.note.sections.length > 0)) return;
		const request = input.request;
		// Wiki Update is an independent execution, not a continuation of this Run.
		const wikiEnv = { ...request.env };
		for (const role of RUN_MODEL_ROLES) delete wikiEnv[TASK_MODEL_ROLE_INFO[role].legacyEnvVar];
		for (const { role, info } of taskModelStages()) {
			if (RUN_MODEL_ROLES.some((runRole) => runRole === role)) delete wikiEnv[info.envVar];
		}
		delete wikiEnv[PRIME_MODEL_DEFINITIONS_ENV];
		const started = startWikiUpdateActivity({
			workspaceDir: request.workspaceRootDirectory!,
			goalId: request.goalId,
			goalDir: request.goalWorkspaceDirectory!,
			goal: [request.goalTitle, request.goalDescription, request.question].filter(Boolean).join("\n\n"),
			goalContext: {
				title: request.goalTitle ?? request.goalId,
				description: request.goalDescription ?? "",
				...(request.goalLanguage ? { language: request.goalLanguage } : {}),
			},
				topicPlan: request.topicPlan!,
			sourceRunId: request.runId,
			sourceRunDirectory: request.workspaceDirectory,
			cornellNotes: artifactRef(input.cornellNotesArtifact),
			parentActivityId: `research:${request.runId}`,
			trigger: request.scheduledResearch
				? { kind: "schedule", schedule_id: request.scheduledResearch.scheduleId }
				: { kind: "system" },
			reason: "Research Run 产出新的 Cornell Notes",
			env: wikiEnv,
			dependencies: {
				compile: (compilation) => this.dependencies.wikiAgent!.compile(compilation),
				publish: this.dependencies.publishWikiCompilation!,
			},
		});
		if (started.reused) {
			trace(request, {
				type: "runtime.wiki_update_reused",
				run_id: request.runId,
				wiki_update_id: started.wikiUpdateId,
				status: started.status,
				cornell_notes_ref: input.cornellNotesArtifact.relativePath,
			});
			return;
		}
		trace(request, {
			type: "runtime.wiki_update_requested",
			run_id: request.runId,
			wiki_update_id: started.wikiUpdateId,
			cornell_notes_ref: input.cornellNotesArtifact.relativePath,
		});
		void started.execution.then((execution) => {
			trace(request, {
				type: "runtime.wiki_update_completed",
				run_id: request.runId,
				wiki_update_id: started.wikiUpdateId,
				compilation_id: execution.compilationId,
				publication_status: execution.publicationStatus,
				page_count: execution.pageCount,
			});
		}).catch((error) => {
			const message = toErrorMessage(error);
			trace(request, {
				type: "runtime.wiki_update_failed",
				run_id: request.runId,
				wiki_update_id: started.wikiUpdateId,
				message,
			});
		});
	}

	private skipScheduledResearch(args: {
		request: RunRequest;
		state: RunStateV2;
		transition(status: RunStatus, update?: (draft: RunStateV2) => void): void;
		emit(stage: string, status: "running" | "succeeded" | "failed", sequence?: number, detail?: string): void;
		reason: ScheduledResearchSkipReason;
		detail: string;
		update?: (draft: RunStateV2) => void;
	}): never {
		if (!args.request.scheduledResearch) {
			throw new Error("Scheduled Research skip requires scheduled context");
		}
		args.transition("skipped", (draft) => {
			args.update?.(draft);
			draft.skip_reason = args.reason;
			draft.finished_at = new Date().toISOString();
		});
		trace(args.request, {
			type: "runtime.scheduled_research_skipped",
			run_id: args.request.runId,
			schedule_id: args.request.scheduledResearch.scheduleId,
			occurrence_id: args.request.scheduledResearch.occurrenceId,
			reason: args.reason,
		});
		args.emit("complete", "succeeded", undefined, args.detail);
		throw new ScheduledResearchSkipped(args.reason);
	}

	private async runSearchCycle(args: {
		request: RunRequest;
		artifactStore: RunArtifactStore;
		state: RunStateV2;
		transition(status: RunStatus, update?: (draft: RunStateV2) => void): void;
		emit(stage: string, status: "running" | "succeeded" | "failed", sequence?: number, detail?: string): void;
		sequence: number;
		cumulativeSources: LogicalSource[];
		cumulativeBundleRefs: string[];
		skipSearchBatch?: boolean;
	}): Promise<SearchCycleResult> {
		if (!args.skipSearchBatch) {
			args.transition("search_batch_running");
			args.emit("search_batch", "running", args.sequence);
			const batch: SearchBatchResult = await this.dependencies.searchBatchExecutor.execute({
				goalId: args.request.goalId,
				runId: args.request.runId,
				sequence: args.sequence,
				question: args.request.question,
				...(args.request.topicPlan ? { topicPlan: args.request.topicPlan } : {}),
				...(args.request.scheduledResearch ? { scheduledResearch: args.request.scheduledResearch } : {}),
				availableProviderIds: args.request.providerCatalog.map((provider) => provider.id),
				workspaceDirectory: args.request.workspaceDirectory,
				controlDirectory: args.request.controlDirectory,
				artifactStore: args.artifactStore,
				temporalContext: args.request.temporalContext,
				...(args.request.organizerStorageRoot ? { organizerStorageRoot: args.request.organizerStorageRoot } : {}),
				signal: args.request.signal,
				onActivity: args.request.onAgentOutput,
			});
			synchronizeAgentUsage(args.state, batch.usage, args.request.controlDirectory);
			const incrementalSources = args.request.scheduledResearch
				? filterProcessedSources(
					batch.logicalSources,
					args.request.scheduledResearch.processedSources,
				)
				: batch.logicalSources;
			if (
				args.request.scheduledResearch
				&& args.cumulativeSources.length === 0
				&& incrementalSources.length === 0
			) {
				if (!searchBatchHasCompleteCoverage(batch)) {
					throw new Error("Scheduled Research could not establish complete Search coverage");
				}
				args.transition("evidence_materializing", (draft) => {
					draft.source_bundles.push(...batch.sourceBundles.map(artifactRef));
					draft.search_execution_records.push(...batch.executionRecords.map((item) => artifactRef(item.artifact)));
					recordDegradedSearches(draft, batch);
					draft.usage.search_attempts += batch.executionRecords.length;
					draft.usage.agent_stages += batch.agentStages;
				});
				args.emit(
					"search_batch",
					"succeeded",
					args.sequence,
					`0/${batch.logicalSources.length} incremental Sources`,
				);
				this.skipScheduledResearch({
					request: args.request,
					state: args.state,
					transition: args.transition,
					emit: args.emit,
					reason: "no_source_increment",
					detail: "No new sources",
				});
			}
			mergeLogicalSources(args.cumulativeSources, incrementalSources);
			args.cumulativeBundleRefs.push(...batch.sourceBundles.map((bundle) => bundle.relativePath));
			args.transition("evidence_materializing", (draft) => {
				draft.source_bundles.push(...batch.sourceBundles.map(artifactRef));
				(draft.find_out_sources ??= []).push(artifactRef(batch.findOutSources));
				draft.search_execution_records.push(...batch.executionRecords.map((item) => artifactRef(item.artifact)));
				recordDegradedSearches(draft, batch);
				draft.usage.search_attempts += batch.executionRecords.length;
				draft.usage.agent_stages += batch.agentStages;
			});
			args.emit(
				"search_batch",
				"succeeded",
				args.sequence,
				args.request.scheduledResearch
					? `${incrementalSources.length}/${batch.logicalSources.length} incremental Sources`
					: `${batch.logicalSources.length} logical Sources`,
			);
		} else {
			if (args.request.scheduledResearch && args.cumulativeSources.length === 0) {
				this.skipScheduledResearch({
					request: args.request,
					state: args.state,
					transition: args.transition,
					emit: args.emit,
					reason: "no_source_increment",
					detail: "No new sources",
				});
			}
			args.emit(
				"search_batch",
				"succeeded",
				args.sequence,
				`resumed ${args.cumulativeSources.length} cumulative Sources`,
			);
		}
		args.emit("cornell_notes", "running", args.sequence);
			const materialized = await this.dependencies.evidenceMaterializer.materialize({
				runId: args.request.runId,
				sequence: args.sequence,
				question: args.request.question,
				goal: {
					title: args.request.goalTitle ?? args.request.goalId,
					description: args.request.goalDescription ?? "",
				},
				discoveryEnabled: args.request.discoveryEnabled,
				sources: args.cumulativeSources,
				sourceBundleRefs: args.cumulativeBundleRefs,
				pipeline: args.request.pipeline,
				workspaceDir: args.request.workspaceDirectory,
				controlDir: args.request.controlDirectory,
				signal: args.request.signal,
				artifactStore: args.artifactStore,
				...(args.request.topicPlan ? { topicPlan: args.request.topicPlan } : {}),
				onAgentStageCompleted: (usage) => {
					args.transition(args.state.status, (draft) => {
						synchronizeAgentUsage(draft, usage, args.request.controlDirectory);
						draft.usage.agent_stages += 1;
					});
				},
			});
		const { evidence, failures } = materialized;
		if (args.request.discoveryEnabled && args.request.topicPlan && args.request.workspaceRootDirectory) {
			submitCornellDiscoveries(args.request, evidence);
		}
		const cornellNotesArtifact = args.artifactStore.publishText(
			`${JSON.stringify(evidence, null, 2)}\n`,
			`artifacts/cornell-notes/snapshot-${args.sequence}.json`,
		);
		const failuresArtifact = failures.length > 0 ? args.artifactStore.publishText(
			`${JSON.stringify({ schema_version: 1, run_id: args.request.runId, sequence: args.sequence, failures }, null, 2)}\n`,
			`artifacts/cornell-notes/failures-${args.sequence}.json`,
		) : undefined;
		if (evidence.notes.length === 0 && failures.length > 0) {
			args.transition(args.state.status, (draft) => {
				synchronizeAgentUsage(draft, { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, args.request.controlDirectory);
				draft.usage.agent_stages += failures.length;
				draft.cornell_note_failure_count = failures.length;
				if (failuresArtifact) (draft.cornell_note_failure_manifests ??= []).push(artifactRef(failuresArtifact));
			});
			throw new Error(`All ${failures.length} Cornell Note Agents failed`);
		}
		if (args.request.scheduledResearch
			&& !evidence.notes.some((record) => record.note.sections.length > 0)) {
			args.emit("cornell_notes", "succeeded", args.sequence, "0 Cornell Notes");
			this.skipScheduledResearch({
				request: args.request,
				state: args.state,
				transition: args.transition,
				emit: args.emit,
				reason: "no_qualifying_evidence",
				detail: "No Cornell Notes were produced",
				update: (draft) => {
					draft.cornell_note_failure_count = failures.length;
					draft.cornell_note_snapshots.push(artifactRef(cornellNotesArtifact));
					if (failuresArtifact) (draft.cornell_note_failure_manifests ??= []).push(artifactRef(failuresArtifact));
				},
			});
		}
		if (!hasUsableEvidence(evidence)) {
			args.transition(args.state.status, (draft) => {
				draft.cornell_note_snapshots.push(artifactRef(cornellNotesArtifact));
			});
			args.emit("cornell_notes", "succeeded", args.sequence, "0 usable Cornell Notes");
			throw new Error(NO_USABLE_EVIDENCE);
		}
		args.transition("plan_authoring", (draft) => {
			if (failures.length > 0) {
				synchronizeAgentUsage(draft, { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, args.request.controlDirectory);
				draft.usage.agent_stages += failures.length;
			}
			draft.cornell_note_failure_count = failures.length;
			draft.cornell_note_snapshots.push(artifactRef(cornellNotesArtifact));
			if (failuresArtifact) (draft.cornell_note_failure_manifests ??= []).push(artifactRef(failuresArtifact));
		});
		args.emit("cornell_notes", "succeeded", args.sequence,
			`${evidence.notes.length} Cornell Notes${failures.length ? `, ${failures.length} failed Sources` : ""}`);
		return { evidence, cornellNotesArtifact };
	}

	private workspaceCapabilityMounts(request: RunRequest, agentId: string): SandboxMountSpec[] {
		if (!request.skillWorkspaceDirectory && !request.goalWorkspaceDirectory) return [];
		const mounts: SandboxMountSpec[] = [];
		const hostPath = request.skillWorkspaceDirectory
			? join(request.skillWorkspaceDirectory, agentId)
			: join(request.goalWorkspaceDirectory!, `skills/${agentId}`);
		if (existsSync(hostPath)) mounts.push({ hostPath, guestPath: "/workspace/skills", access: "read-only" });
		return mounts;
	}

	/**
	 * `preserve` 留给自己拥有可复用中间产物的 Stage：它自己负责判定哪些能复用、哪些是草稿。
	 * 其余 Stage 每次从空目录开始，避免继承上一次的残留状态。
	 */
	private workDirectory(request: RunRequest, id: string, options: { preserve?: boolean } = {}): string {
		const path = join(request.controlDirectory, "workspaces", safeId(id));
		if (!options.preserve) rmSync(path, { recursive: true, force: true });
		mkdirSync(path, { recursive: true });
		return path;
	}

	private result(
		request: RunRequest,
		state: RunStateV2,
		nodeStatuses: Record<string, ResearchNodeStatus>,
	): RunResult {
		const usage = {
			inputTokens: state.usage.input_tokens,
			outputTokens: state.usage.output_tokens,
			costUsd: state.usage.cost_usd,
			items: state.accepted_chapters.length,
		};
		return {
				execution: {
				runId: request.runId,
				status: state.status === "published"
					? "succeeded"
					: state.status === "skipped"
						? "skipped"
						: state.status === "cancelled"
							? "cancelled"
							: "failed",
				workflowId: RUN_WORKFLOW_ID,
				workflowVersion: RUN_WORKFLOW_VERSION,
				startedAt: state.started_at,
				finishedAt: state.finished_at ?? new Date().toISOString(),
				nodeStatuses,
				usage,
				...(state.failure ? { error: state.failure.message } : {}),
			},
			state,
			finalReportPath: join(request.workspaceDirectory, "report", "final.md"),
		};
	}
}

const NO_USABLE_EVIDENCE = "Research produced no usable source evidence; report generation was not started";

function hasUsableEvidence(evidence: Pick<CornellNotesSnapshot, "notes">): boolean {
	return evidence.notes.some((record) => record.note.sections.length > 0);
}

function hydrateCheckpoint(
	artifactStore: RunArtifactStore,
	state: RunStateV2,
	providerCatalog: Array<ResearchSourceCatalogEntry & { id: string }>,
): HydratedCheckpoint {
	const providers = new Set(providerCatalog.map((provider) => provider.id));
	const bundleExecutions = new Map<string, ProviderExecution>();
	for (const reference of state.search_execution_records) {
		const artifact = artifactStore.openFile(reference);
		const raw = readJson(artifact.absolutePath);
		const execution = validateSearchExecutionRecord(raw, {
			runId: state.run_id,
		});
		if (!providers.has(execution.provider_id)) {
			throw new Error(`Search Execution checkpoint references unknown Provider '${execution.provider_id}'`);
		}
		const providerExecution: ProviderExecution = {
			execution_id: execution.execution_id,
			provider_id: execution.provider_id,
		};
		if (["valid_bundle", "degraded_bundle"].includes(execution.terminal_status) && execution.bundle_ref) {
			bundleExecutions.set(execution.bundle_ref, providerExecution);
		}
	}

	const documents: LogicalSource[] = [];
	const bundleRefs: string[] = [];
	for (const reference of state.source_bundles) {
		const artifact = artifactStore.openDirectory(reference);
		const execution = bundleExecutions.get(reference.relative_path);
		if (!execution) {
			throw new Error(
				`Source Bundle checkpoint '${reference.relative_path}' has no valid Search Execution`,
			);
		}
		const bundle = validateSourceBundleDirectory(artifact.absolutePath, execution);
		const incoming = bundle.sources.map((source): LogicalSource => ({
				id: source.source_id,
				title: source.title,
				url: source.url,
				providerId: execution.provider_id,
				sourceIdentity: scheduledSourceIdentity(source.url),
				revisionSha256: scheduledSourceContentSha256(
					source.files.map((file) => ({ path: file.relativePath, sha256: file.sha256 })),
				),
				directoryPath: source.sourceDirectoryPath,
				organizationKind: "ungrouped",
				members: [],
			}));
		mergeLogicalSources(documents, incoming);
		bundleRefs.push(artifact.relativePath);
	}

	const evidence = state.cornell_note_snapshots.map((reference) => {
		const artifact = artifactStore.openFile(reference);
		const snapshot = validateCornellNotesSnapshot(readJson(artifact.absolutePath));
		if (snapshot.run_id !== state.run_id) {
			throw new Error(`Evidence Snapshot '${snapshot.snapshot_id}' belongs to another Run`);
		}
		return { snapshot, artifact };
	});
	const findOutDocuments = (state.find_out_sources ?? []).flatMap((reference) =>
		loadFindOutSources(artifactStore.openDirectory(reference)));
	return {
		documents: findOutDocuments.length > 0 ? findOutDocuments : documents,
		bundleRefs,
		evidence,
	};
}

function artifactRef(
	artifact: PublishedArtifactRef | PublishedArtifactDirectoryRef,
): RunArtifactRef {
	return {
		relative_path: artifact.relativePath,
		sha256: artifact.sha256,
		byte_length: artifact.byteLength,
	};
}

/**
 * 把一批 Search Attempt 里获取部分失败的客观计数抽出来。
 *
 * terminal_status 为 degraded_bundle 表示这次尝试里至少有一个 Provider 操作失败。
 * 这个事实原本只存在于已发布的 Search Execution Record 中，不进入 Run 状态，也就
 * 不会对用户可见——一次所有 clone 都失败、只剩元数据的 Search 会和正常 Search
 * 一样报告成功。Runtime 在这里只做计数，不判断证据是否足够。
 */
function recordDegradedSearches(draft: RunStateV2, batch: SearchBatchResult): void {
	const degraded = collectDegradedSearches(batch);
	if (degraded.length > 0) (draft.degraded_searches ??= []).push(...degraded);
}

function collectDegradedSearches(
	batch: SearchBatchResult,
): NonNullable<RunStateV2["degraded_searches"]> {
	return batch.executionRecords
		.filter((item) => item.record.terminal_status === "degraded_bundle")
		.map((item) => {
			const failed = item.record.operations.filter((operation) => operation.status !== "succeeded");
			return {
				provider_execution_id: item.record.execution_id,
				provider_id: item.record.provider_id,
				attempt_id: item.record.attempt_id,
				operations_total: item.record.operations.length,
				operations_failed: failed.length,
				failed_operations: [...new Set(failed.map((operation) => operation.operation))],
			};
		});
}

function searchBatchHasCompleteCoverage(batch: SearchBatchResult): boolean {
	return batch.executionRecords.length > 0
		&& batch.executionRecords.every((item) => item.record.terminal_status === "valid_bundle");
}

function mergeLogicalSources(
	target: LogicalSource[],
	incoming: readonly LogicalSource[],
): void {
	const byId = new Map(target.map((document) => [document.id, document]));
	for (const document of incoming) {
		const existing = byId.get(document.id);
		if (existing) {
			if (logicalSourceIdentity(existing) !== logicalSourceIdentity(document)) {
				throw new Error(`Canonical Search source identity '${document.id}' changed across batches`);
			}
			target[target.indexOf(existing)] = document;
			byId.set(document.id, document);
			continue;
		}
		target.push(document);
		byId.set(document.id, document);
	}
	target.sort((left, right) => left.id.localeCompare(right.id));
}

function logicalSourceIdentity(source: LogicalSource): string {
	return identityHash({
		id: source.id,
		sourceIdentity: source.sourceIdentity,
		organizationKind: source.organizationKind,
		groupId: source.groupId,
	});
}

function applyStageUsage<T>(
	state: RunStateV2,
	stage: ValidatedStageArtifact<T>,
	controlDirectory: string,
): void {
	if (stage.session.id.startsWith("prime:")) {
		const traceUsage = readAgentNodeUsage(controlDirectory, "research");
		if (traceUsage.completeExecutions > 0 && traceUsage.incompleteExecutionIds.length === 0) {
			state.usage.input_tokens = traceUsage.inputTokens;
			state.usage.output_tokens = traceUsage.outputTokens;
			state.usage.cost_usd = traceUsage.costUsd;
			state.usage.model_calls = traceUsage.modelCalls;
		}
		addUsage(state, stage.usage);
	} else {
		synchronizeAgentUsage(state, stage.usage, controlDirectory);
	}
	state.usage.agent_stages += 1;
}

function synchronizeAgentUsage(state: RunStateV2, fallback: ResearchModelUsage, controlDirectory: string): void {
	const traceUsage = readAgentNodeUsage(controlDirectory, "research");
	if (traceUsage.completeExecutions === 0 || traceUsage.incompleteExecutionIds.length > 0) {
		addUsage(state, fallback);
		return;
	}
	state.usage.input_tokens = traceUsage.inputTokens;
	state.usage.output_tokens = traceUsage.outputTokens;
	state.usage.cost_usd = traceUsage.costUsd;
	state.usage.model_calls = traceUsage.modelCalls;
}

function addUsage(state: RunStateV2, usage: ResearchModelUsage): void {
	state.usage.input_tokens += usage.inputTokens;
	state.usage.output_tokens += usage.outputTokens;
	state.usage.cost_usd += usage.costUsd;
	state.usage.model_calls += usage.calls;
}

function reportCornellFailures(state: RunStateV2, artifactStore: RunArtifactStore): unknown | undefined {
	const reference = state.cornell_note_failure_manifests?.at(-1);
	if (!reference) return undefined;
	const value = readJson(artifactStore.openFile(reference).absolutePath);
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| !Array.isArray((value as { failures?: unknown }).failures)) {
		throw new Error("Cornell Note failure manifest is invalid");
	}
	const failures = (value as { failures: unknown[] }).failures.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`Cornell Note failure ${index + 1} is invalid`);
		}
		const record = item as Record<string, unknown>;
		if (typeof record.title !== "string" || typeof record.canonical_locator !== "string"
			|| typeof record.message !== "string") {
			throw new Error(`Cornell Note failure ${index + 1} is invalid`);
		}
		return { title: record.title, canonical_locator: record.canonical_locator, message: record.message };
	});
	return { failed_source_count: failures.length, failed_sources: failures };
}

function safeId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "stage";
}

function classifyFailure(message: string): string {
	if (/cancel|abort/iu.test(message)) return "cancelled";
	if (/identity.*drift/iu.test(message)) return "identity_drift";
	if (/schema|validation|json|anchor|citation|evidence/iu.test(message)) return "deterministic_gate";
	if (/timeout|rate|provider|network/iu.test(message)) return "provider";
	return "runtime_invariant";
}

function copyFindOutView(input: StageInputView, snapshot: PublishedArtifactDirectoryRef): void {
	for (const file of snapshot.files) {
		input.copyFile(`findout/${file.relativePath}`, join(snapshot.absolutePath, file.relativePath));
	}
}

function persistedOutline(
	outline: ReportOutline,
	handles: AgentEvidenceHandles,
	mode: "wiki" | "findout",
): unknown {
	if (mode === "wiki") return outline;
	return {
		title: outline.title,
		sections: outline.sections.map((section) => ({
			title: section.title,
			purpose: section.purpose,
			cornell_notes_refs: section.cornell_notes_refs.map((id) => requireAgentEvidenceHandle(handles, id)),
		})),
	};
}

function reportWriterFileToolPolicy() {
	return {
		deniedReadPrefixes: ["/wiki", "/work/wiki"],
		deniedReadMessage: "Wiki Page refs are not filesystem paths. Use wiki_read_page with the P-number returned by Wiki Tools.",
	};
}

function wikiCitationRefs(markdown: string): string[] {
	return [...new Set([...markdown.matchAll(/<cite>\s*(C[1-9][0-9]*)\s*<\/cite>/gu)].map((match) => match[1]!))];
}

function noteCitationRefs(markdown: string): string[] {
	return [...new Set([...markdown.matchAll(/<cite>\s*(N[1-9][0-9]*)\s*<\/cite>/gu)].map((match) => match[1]!))];
}

// Literal key order is fixed at both call sites; stableJson would change persisted discovery ids.
function identityHash(value: unknown): string {
	return sha256(JSON.stringify(value));
}

function submitCornellDiscoveries(request: RunRequest, evidence: CornellNotesSnapshot): void {
	const plan = request.topicPlan!;
	const store = new GoalTopicPlanStore(request.goalId, request.workspaceRootDirectory!);
	const known = new Set(store.listDiscoveries().map((candidate) => candidate.id));
	for (const record of evidence.notes) {
		for (const [sectionIndex, section] of record.note.sections.entries()) {
			for (const [noteIndex, note] of section.cue_notes.entries()) {
				if (!note.discovery) continue;
				const candidate = store.submitDiscovery({
					schema_version: 1,
					id: `discovery_${identityHash({ run: request.runId, source: record.note.source_id, section: sectionIndex, note: noteIndex }).slice(0, 24)}`,
					goal_id: request.goalId,
					topic_plan_revision: plan.revision,
					finding: note.discovery.finding,
					run_id: request.runId,
					source_id: record.note.source_id,
					section_index: sectionIndex,
					cue_index: noteIndex,
					cue: note.cue,
					note: note.note,
					evidence: note.evidence.map((anchor) => ({
						source_path: anchor.source_path,
						start_line: anchor.start_line,
						end_line: anchor.end_line,
						content_sha256: anchor.content_sha256,
					})),
					status: "open",
					created_at: new Date().toISOString(),
				});
				if (known.has(candidate.id)) continue;
				known.add(candidate.id);
				publish({ type: "discovery:changed", goalId: request.goalId, candidateId: candidate.id,
					status: "open", ts: candidate.created_at });
			}
		}
	}
}
