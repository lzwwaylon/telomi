/** Validate Section child results after the SDK reaches RLM quiescence. */

export type SectionChildStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface SectionChildSnapshot {
	id: string;
	label?: string;
	status?: SectionChildStatus;
	model?: string;
	error?: string;
}

export type SectionChildDecision =
	| { kind: "ready" }
	| { kind: "failed"; message: string };

export function decideSectionChildren(input: {
	children: readonly SectionChildSnapshot[];
	expected: number;
}): SectionChildDecision {
	const failed = input.children.find((child) => child.status === "error" || child.status === "cancelled");
	if (failed) {
		return {
			kind: "failed",
			message: `Section child ${describeSectionChild(failed)} ended '${failed.status}'${
				failed.error ? `: ${failed.error}` : " without a reason"}`,
		};
	}
	if (input.children.length !== input.expected) {
		return {
			kind: "failed",
			message: `Prime Report Writer root spawned ${input.children.length} Section children for ${input.expected} Sections`,
		};
	}
	if (input.children.every((child) => child.status === "done")) return { kind: "ready" };
	return { kind: "failed", message: "Prime Report Writer child state was not terminal after RLM quiescence" };
}

export function describeSectionChild(child: SectionChildSnapshot): string {
	return child.label?.trim() ? `'${child.label.trim()}'` : child.id;
}
