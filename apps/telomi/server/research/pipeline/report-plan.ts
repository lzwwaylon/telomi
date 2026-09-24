/** The Executable Report Plan a Report Planner publishes and the Writer stage executes. */
import { Type, type Static } from "@sinclair/typebox";

const NonEmptyString = Type.String({ minLength: 1 });
const StableId = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});
const RuntimeId = Type.String({
	minLength: 1,
	maxLength: 200,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const ExecutableReportClaimSchema = Type.Object({
	claim_id: StableId,
	content_intent: NonEmptyString,
	cornell_notes_refs: Type.Array(RuntimeId, { uniqueItems: true }),
}, { additionalProperties: false });

const ExecutableReportSectionSchema = Type.Object({
	section_id: StableId,
	title: NonEmptyString,
	claims: Type.Array(ExecutableReportClaimSchema),
}, { additionalProperties: false });

export const ExecutableReportPlanSchema = Type.Object({
	title: NonEmptyString,
	sections: Type.Array(ExecutableReportSectionSchema, { minItems: 1 }),
}, { additionalProperties: false });

export type ExecutableReportSection = Static<typeof ExecutableReportSectionSchema>;
export type ExecutableReportPlan = Static<typeof ExecutableReportPlanSchema>;
