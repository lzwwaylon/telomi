/**
 * Research Schedule Reviewer 的确定性输出契约。
 *
 * Reviewer 只判断"这个 Schedule 还在声明用户关心的东西吗"，因此契约只接受两种决定，
 * 并且只允许它改写监控范围与 Report Context。cadence、时区、标题这类字段属于未知字段，
 * 在这里直接拒绝：畸形的 Proposal 必须在到达用户之前失败。
 */

const NO_CHANGE_FIELDS = new Set(["decision", "rationale"]);
const PROPOSE_FIELDS = new Set([
	"decision",
	"monitoringScope",
	"reportContext",
	"summary",
	"rationale",
	"evidence",
]);

export interface ScheduleReviewProposalOutput {
	monitoringScope: string;
	reportContext: string;
	summary: string;
	rationale: string;
	evidence: string[];
}

export type ScheduleReviewOutput =
	| { decision: "no_change"; rationale?: string }
	| ({ decision: "propose" } & ScheduleReviewProposalOutput);

export function parseScheduleReviewOutput(
	value: unknown,
	current: { monitoringScope: string; reportContext: string },
): ScheduleReviewOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Research Schedule Review output must be a JSON object");
	}
	const output = value as Record<string, unknown>;
	const decision = output.decision;
	if (decision !== "no_change" && decision !== "propose") {
		throw new Error("Research Schedule Review decision must be 'no_change' or 'propose'");
	}
	rejectUnknownFields(output, decision === "propose" ? PROPOSE_FIELDS : NO_CHANGE_FIELDS);
	if (decision === "no_change") {
		return {
			decision,
			...(output.rationale === undefined ? {} : { rationale: text(output.rationale, "rationale") }),
		};
	}
	const monitoringScope = text(output.monitoringScope, "monitoringScope");
	const reportContext = text(output.reportContext, "reportContext");
	if (monitoringScope === current.monitoringScope.trim() && reportContext === current.reportContext.trim()) {
		throw new Error("A proposed Research Schedule must change its monitoringScope or its reportContext");
	}
	return {
		decision,
		monitoringScope,
		reportContext,
		summary: text(output.summary, "summary"),
		rationale: text(output.rationale, "rationale"),
		evidence: evidenceRefs(output.evidence),
	};
}

function rejectUnknownFields(output: Record<string, unknown>, allowed: ReadonlySet<string>): void {
	const unknown = Object.keys(output).filter((key) => !allowed.has(key)).sort();
	if (unknown.length > 0) {
		throw new Error(`Research Schedule Review output rejects unknown fields: ${unknown.join(", ")}`);
	}
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Research Schedule Review ${name} must be a non-empty string`);
	}
	return value.trim();
}

function evidenceRefs(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Research Schedule Review evidence must list the memory entries and Wiki pages consulted");
	}
	return value.map((ref, index) => text(ref, `evidence[${index}]`));
}
