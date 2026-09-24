import type { ExecutableReportPlan } from "./report-plan.js";
import type { AgentEvidenceHandles } from "./evidence-handles.js";
import { resolveAgentEvidenceHandle } from "./evidence-handles.js";
import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";

export interface ReportOutline {
	title: string;
	sections: Array<{
		title: string;
		purpose: string;
		cornell_notes_refs: string[];
		knowledge_refs: string[];
	}>;
}

export function buildFullReportWriterSystemPrompt(): string {
	return renderAgentPrompt("research", "report-writer", "system-append").content;
}

export const FULL_REPORT_WRITER_SYSTEM_PROMPT = buildFullReportWriterSystemPrompt();

export function buildFindOutReportWriterSystemPrompt(): string {
	return renderAgentPrompt("research", "find-out-report-writer", "system-append").content;
}

/**
 * 输入只有用户的问题与 Cornell Notes：没有事先的 Outline，Root 自己决定章节、自己派子 Agent，
 * 结构以它写出的 manifest 为准，Runtime 事后接住。少一次上下文交接，也少一遍对同一批笔记的重复通读。
 */
export function findOutSelfDirectedWriterUserPrompt(input: {
	language: string;
	currentDate: string;
	timeZone: string;
	priorReports?: string;
}): string {
	return renderAgentPrompt("research", "find-out-report-writer", "user", {
		language: input.language,
		current_date: input.currentDate,
		time_zone: input.timeZone,
		prior_reports: input.priorReports ?? "",
	}, "plan").content;
}

export function findOutSelfDirectedDelegationPrompt(childModel: string): string {
	return renderAgentPrompt("research", "find-out-report-writer", "user", {
		child_model: childModel,
	}, "delegate").content;
}

export function wikiSelfDirectedWriterUserPrompt(input: {
	language: string;
	currentDate: string;
	timeZone: string;
	priorReports?: string;
}): string {
	return renderAgentPrompt("research", "report-writer", "user", {
		language: input.language,
		current_date: input.currentDate,
		time_zone: input.timeZone,
		prior_reports: input.priorReports ?? "",
	}, "plan").content;
}

export function wikiSelfDirectedDelegationPrompt(childModel: string): string {
	return renderAgentPrompt("research", "report-writer", "user", {
		child_model: childModel,
	}, "delegate").content;
}

export function primeWriterFinalPrompt(mode: "wiki" | "findout" = "wiki", useChineseLint = false): string {
	return renderAgentPrompt("research", "report-writer", "user", {
		find_out_mode: mode === "findout",
		use_chinese_lint: useChineseLint,
	}, "final").content;
}

export function primeWriterFinalRepairPrompt(mode: "wiki" | "findout"): string {
	return renderAgentPrompt("research", "report-writer", "user", {
		mode_label: mode === "findout" ? "Find Out" : "Wiki-only",
	}, "final-repair").content;
}

export function primeWriterResumeContextPrompt(completedSections: readonly string[]): string {
	return renderAgentPrompt("research", "report-writer", "user", {
		completed_section_list: completedSections.map((id) => `- ${id}`).join("\n"),
	}, "resume-context").content;
}

export function primeWriterCompletedSectionsPrompt(completedSections: readonly string[]): string {
	return renderAgentPrompt("research", "report-writer", "user", {
		completed_sections_json: JSON.stringify(completedSections),
	}, "completed-sections").content;
}

export function validateWriterAuthoredOutline(
	value: unknown,
	handles: AgentEvidenceHandles,
	knowledgePaths?: ReadonlySet<string>,
): ReportOutline {
	const record = requireRecord(value, "Writer-authored Report Outline");
	requireExactKeys(record, ["title", "sections"], "Writer-authored Report Outline");
	if (!Array.isArray(record.sections) || record.sections.length === 0) {
		throw new Error("Writer-authored Report Outline requires at least one Section");
	}
	const titles = new Set<string>();
	const sections = record.sections.map((candidate, index) => {
		const section = requireRecord(candidate, `Writer-authored Outline Section ${index + 1}`);
		requireExactKeys(section, knowledgePaths
			? ["section_id", "title", "purpose", "knowledge_refs"]
			: ["section_id", "title", "purpose", "cornell_notes_refs"],
			`Writer-authored Outline Section ${index + 1}`);
		const expectedId = `section-${String(index + 1).padStart(3, "0")}`;
		if (requireString(section.section_id, `Writer-authored Outline Section ${index + 1} ID`) !== expectedId) {
			throw new Error(`Writer-authored Outline Section ${index + 1} must be '${expectedId}'`);
		}
		const title = requireString(section.title, `Writer-authored Outline Section ${index + 1} title`);
		if (title.toLocaleLowerCase() === "references") {
			throw new Error("Writer-authored Report Outline must not contain the Runtime-owned References Section");
		}
		if (titles.has(title)) throw new Error(`Duplicate Writer-authored Outline Section title '${title}'`);
		titles.add(title);
		const refs = knowledgePaths ? [] : requireStringArray(section.cornell_notes_refs,
			`Writer-authored Outline Section '${title}' cornell_notes_refs`)
			.map((reference) => resolveAgentEvidenceHandle(handles, reference));
		return {
			title,
			purpose: requireString(section.purpose, `Writer-authored Outline Section '${title}' purpose`),
			cornell_notes_refs: refs,
			knowledge_refs: knowledgePaths ? requireKnowledgeRefs(section.knowledge_refs, title, knowledgePaths) : [],
		};
	});
	return { title: requireString(record.title, "Writer-authored Report Outline title"), sections };
}

export function materializeReportPlan(
	outline: ReportOutline,
): ExecutableReportPlan {
	return {
		title: outline.title,
		sections: outline.sections.map((section, index) => {
			const sectionId = `section-${String(index + 1).padStart(3, "0")}`;
			return {
				section_id: sectionId,
				title: section.title,
				claims: section.cornell_notes_refs.length === 0 ? [] : [{
					claim_id: `${sectionId}-report-evidence`,
					content_intent: section.purpose,
					cornell_notes_refs: [...section.cornell_notes_refs],
				}],
			};
		}),
	};
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	const result = value.map((item, index) => requireString(item, `${label}[${index}]`));
	if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
	return result;
}

function requireKnowledgeRefs(
	value: unknown,
	sectionTitle: string,
	knowledgePaths: ReadonlySet<string>,
): string[] {
	if (!Array.isArray(value)) throw new Error(`Outline Section '${sectionTitle}' knowledge_refs must be an array`);
	const refs = value.map((item, index) => requireString(item,
		`Outline Section '${sectionTitle}' knowledge_refs[${index}]`));
	if (new Set(refs).size !== refs.length) {
		throw new Error(`Outline Section '${sectionTitle}' knowledge_refs contains duplicates`);
	}
	for (const ref of refs) {
		if (
			ref.startsWith("/")
			|| ref.includes("\\")
			|| ref.includes("\0")
			|| ref.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error(`Outline Section '${sectionTitle}' Knowledge Reference '${ref}' must be a safe relative path`);
		}
		if (!knowledgePaths.has(ref)) {
			throw new Error(`Outline Section '${sectionTitle}' Knowledge Reference '${ref}' is not present in the frozen Knowledge Snapshot`);
		}
	}
	return refs;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		const missing = expected.filter((key) => !actual.includes(key));
		const unexpected = actual.filter((key) => !expected.includes(key));
		throw new Error(`${label} fields are invalid; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; allowed: ${expected.join(", ")}`);
	}
}
