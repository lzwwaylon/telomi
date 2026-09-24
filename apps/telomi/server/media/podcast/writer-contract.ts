import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toErrorMessage } from "../../lib/values.js";

export type PodcastWorkspacePhase = "segments" | "initial-review" | "final-audit";

/** Runtime 写入 Worker Workspace 的分段契约；assignment 必须引用它，ledger 字段以它为准。 */
export const SEGMENT_CONTRACT = "inputs/segment-contract.md";
export const LEDGER_ARRAY_FIELDS = [
	"source_anchors_used",
	"concepts_closed",
	"numeric_claims",
	"qualifications_preserved",
	"visual_relationships_preserved",
	"unresolved",
] as const;
/** Plan fields describing how segments join; Root keeps them for the merge. */
const SEGMENT_TRANSITION_FIELDS = ["transition_in", "transition_out"] as const;

interface PodcastPlan {
	title: string;
	segments: Array<{ segment_id: string; title: string }>;
}

export function podcastWorkspaceReady(cwd: string, phase: PodcastWorkspacePhase): boolean {
	if (phase === "segments") {
		try {
			return readPlan(cwd).segments.every(({ segment_id }) => ["assignment.json", "draft.txt", "ledger.json"]
				.every((name) => nonEmpty(join(cwd, "work", "segments", segment_id, name))));
		} catch {
			return false;
		}
	}
	const files = phase === "initial-review"
		? ["grounded-script.txt", "source-audit-initial.json", "listener-review.json"]
		: ["source-audit-final.json"];
	return files.every((name) => nonEmpty(join(cwd, "work", name)));
}

export function validatePodcastWorkspace(cwd: string, phase: PodcastWorkspacePhase): PodcastPlan {
	if (phase === "segments") return validateSegments(cwd);
	if (phase === "initial-review") {
		validateInitialReview(cwd);
		return readPlan(cwd);
	}
	validateFinalAudit(cwd);
	return readPlan(cwd);
}

export function materializePodcastOutput(cwd: string): void {
	const plan = readPlan(cwd);
	const outputRoot = join(cwd, "writer-output");
	const finalScriptPath = join(cwd, "work", "podcast-script.txt");
	if (!nonEmpty(finalScriptPath)) throw violation("final-output", "work/podcast-script.txt", "$", "required file is missing or empty");
	const finalScript = readFileSync(finalScriptPath, "utf-8").trim();
	validateSpokenText(finalScript, "final-output", "work/podcast-script.txt");
	const sectionTexts = plan.segments.map(({ segment_id, title }) => {
		const relativePath = `writer-output/sections/${segment_id}.txt`;
		const path = join(cwd, relativePath);
		if (!nonEmpty(path)) throw violation("final-output", relativePath, "$", "required file is missing or empty");
		const text = readFileSync(path, "utf-8").trim();
		validateSpokenText(text, "final-output", relativePath);
		return { sectionId: segment_id, title, path: `sections/${segment_id}.txt`, text };
	});
	if (normalize(sectionTexts.map((section) => section.text).join("\n\n")) !== normalize(finalScript)) {
		throw violation("final-output", "writer-output/sections/*.txt", "$", "concatenated section text does not reconstruct work/podcast-script.txt");
	}
	const reviewPath = "writer-output/review.json";
	if (!nonEmpty(join(cwd, reviewPath))) throw violation("final-output", reviewPath, "$", "required file is missing or empty");
	const review = readStageJson<Record<string, unknown>>(cwd, "final-output", reviewPath);
	if (review.passed !== true) throw violation("final-output", reviewPath, "passed", "must equal true");
	for (const field of ["unsupported_claims", "numeric_mismatches", "missing_qualifications", "remaining_issues"]) {
		if (!Array.isArray(review[field])) throw violation("final-output", reviewPath, field, "must be an array");
		if ((review[field] as unknown[]).length > 0) throw violation("final-output", reviewPath, field, "must be empty before publication");
	}
	const plannedIds = plan.segments.map((segment) => segment.segment_id);
	if (!Array.isArray(review.segment_children)) throw violation("final-output", reviewPath, "segment_children", "must be an array");
	if (review.segment_children.join("|") !== plannedIds.join("|")) {
		throw violation("final-output", reviewPath, "segment_children", `must equal planned segment IDs ${plannedIds.join(", ")}`);
	}
	mkdirSync(outputRoot, { recursive: true });
	copyFileSync(finalScriptPath, join(outputRoot, "podcast-script.txt"));
	copyFileSync(join(cwd, "work", "episode-plan.json"), join(outputRoot, "episode-plan.json"));
	copyFileSync(join(cwd, "work", "source-audit-final.json"), join(outputRoot, "source-audit-final.json"));
	writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
		version: 1,
		title: plan.title,
		sections: sectionTexts.map(({ sectionId, title, path }) => ({ sectionId, title, path })),
	}, null, 2)}\n`);
	writeFileSync(join(outputRoot, ".complete"), "");
}

function readPlan(cwd: string): PodcastPlan {
	const file = "work/episode-plan.json";
	const value = readStageJson<{ title?: unknown; segments?: unknown }>(cwd, "plan", file);
	if (typeof value.title !== "string" || !value.title.trim()) throw violation("plan", file, "title", "must be a non-empty string");
	if (!Array.isArray(value.segments) || value.segments.length < 3) throw violation("plan", file, "segments", "must contain at least three segment objects");
	const segments = value.segments.map((raw, index) => {
		const field = `segments[${index}]`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw violation("plan", file, field, "must be an object");
		const segment = raw as { segment_id?: unknown; title?: unknown };
		const expected = `segment-${String(index + 1).padStart(3, "0")}`;
		if (segment.segment_id !== expected) throw violation("plan", file, `${field}.segment_id`, `must equal Runtime ID '${expected}', received '${String(segment.segment_id)}'`);
		if (typeof segment.title !== "string" || !segment.title.trim()) throw violation("plan", file, `${field}.title`, "must be a non-empty string");
		return { segment_id: expected, title: segment.title.trim() };
	});
	return { title: value.title.trim(), segments };
}

function validateSegments(cwd: string): PodcastPlan {
	const plan = readPlan(cwd);
	for (const { segment_id } of plan.segments) {
		const root = `work/segments/${segment_id}`;
		for (const name of ["assignment.json", "draft.txt", "ledger.json"]) {
			if (!nonEmpty(join(cwd, root, name))) throw violation("segments", `${root}/${name}`, "$", "required file is missing or empty");
		}
		const assignmentFile = `${root}/assignment.json`;
		const assignment = readStageJson<{ contract?: unknown } & Record<string, unknown>>(cwd, "segments", assignmentFile);
		if (assignment.contract !== SEGMENT_CONTRACT) throw violation("segments", assignmentFile, "contract", `must equal '${SEGMENT_CONTRACT}'`);
		// Root owns the joins between segments and the episode's single closing. A child handed a
		// transition writes it, and the last segment's `transition_out` has no next segment to hand
		// on to, so it carries the ending instead and the episode concludes more than once.
		for (const field of SEGMENT_TRANSITION_FIELDS) {
			if (field in assignment) throw violation("segments", assignmentFile, field, "belongs to Root's merge and must not reach a segment child");
		}
		const ledgerFile = `${root}/ledger.json`;
		const ledger = readStageJson<Record<string, unknown>>(cwd, "segments", ledgerFile);
		if (ledger.segment_id !== segment_id) throw violation("segments", ledgerFile, "segment_id", `must equal '${segment_id}', received '${String(ledger.segment_id)}'`);
		for (const field of LEDGER_ARRAY_FIELDS) {
			if (!Array.isArray(ledger[field])) throw violation("segments", ledgerFile, field, "must be an array");
		}
		validateSpokenText(readFileSync(join(cwd, root, "draft.txt"), "utf-8"), "segments", `${root}/draft.txt`);
	}
	return plan;
}

function validateInitialReview(cwd: string): void {
	validateSpokenText(readRequired(cwd, "initial-review", "work/grounded-script.txt"), "initial-review", "work/grounded-script.txt");
	const auditFile = "work/source-audit-initial.json";
	const audit = readStageJson<{ passed?: unknown }>(cwd, "initial-review", auditFile);
	if (typeof audit.passed !== "boolean") throw violation("initial-review", auditFile, "passed", "must be a boolean");
	const listenerFile = "work/listener-review.json";
	const listener = readStageJson<{ verdict?: unknown; blockers?: unknown }>(cwd, "initial-review", listenerFile);
	if (!new Set(["PASS", "FAIL"]).has(String(listener.verdict))) throw violation("initial-review", listenerFile, "verdict", "must equal 'PASS' or 'FAIL'");
	if (!Array.isArray(listener.blockers)) throw violation("initial-review", listenerFile, "blockers", "must be an array");
}

function validateFinalAudit(cwd: string): void {
	const file = "work/source-audit-final.json";
	const audit = readStageJson<Record<string, unknown>>(cwd, "final-audit", file);
	if (audit.passed !== true) throw violation("final-audit", file, "passed", "must equal true");
	for (const field of ["unsupported_claims", "numeric_mismatches", "missing_qualifications", "missing_concept_closures", "visual_relationship_errors"]) {
		if (!Array.isArray(audit[field])) throw violation("final-audit", file, field, "must be an array");
		if ((audit[field] as unknown[]).length > 0) throw violation("final-audit", file, field, "must be empty before finalization");
	}
}

function readRequired(cwd: string, stage: string, file: string): string {
	const path = join(cwd, file);
	if (!nonEmpty(path)) throw violation(stage, file, "$", "required file is missing or empty");
	return readFileSync(path, "utf-8");
}

function readStageJson<T>(cwd: string, stage: string, file: string): T {
	const text = readRequired(cwd, stage, file);
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw violation(stage, file, "$", `must be valid JSON: ${toErrorMessage(error)}`);
	}
}

function validateSpokenText(text: string, stage: string, file: string): void {
	const checks: Array<[RegExp, string]> = [
		[/https?:\/\//u, "must not contain raw URLs"],
		[/\[CITE:/u, "must not contain citation markers"],
		[/^#{1,6}\s/mu, "must not contain Markdown headings"],
		[/^\s*\|/mu, "must not contain Markdown tables"],
		[/<break/iu, "must not contain SSML break tags"],
		[/^(?:host|guest|主播|嘉宾)\s*[:：]/imu, "must not contain speaker labels"],
	];
	if (!text.trim()) throw violation(stage, file, "$", "must contain non-empty TTS-ready prose");
	const failed = checks.find(([pattern]) => pattern.test(text));
	if (failed) throw violation(stage, file, "$", failed[1]);
}

function violation(stage: string, file: string, field: string, issue: string): Error {
	return new Error(`[podcast-writer:${stage}] file '${file}', field '${field}': ${issue}`);
}

function normalize(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function nonEmpty(path: string): boolean {
	return existsSync(path) && readFileSync(path, "utf-8").trim().length > 0;
}
