import { renderAgentPrompt, type RenderedAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import type { ScheduledResearchContext } from "../scheduled-research-context.js";
import { goalTopicReferences, type GoalTopicPlan } from "../../goals/topic-plan/index.js";

export function buildNoteAgentSystemPrompt(
	scheduledResearch?: ScheduledResearchContext,
): string {
	return renderNoteAgentSystemPrompt(scheduledResearch).content;
}

export function renderNoteAgentSystemPrompt(
	_scheduledResearch?: ScheduledResearchContext,
	variant: "default" | "deep-search" = "default",
): RenderedAgentPrompt {
	const scope = renderAgentPrompt("research", "cornell-note", "system-append", {}, variant);
	const quality = renderAgentPrompt("research", "cornell-note", "reference", {}, "evidence-reading-quality");
	return { ...scope, content: `${scope.content}\n\n${quality.content}` };
}

export function buildNoteAgentUserPrompt(
	request: NoteAgentPromptRequest,
	scheduledResearch?: ScheduledResearchContext,
): string {
	return renderNoteAgentUserPrompt(request, scheduledResearch).content;
}

export function renderNoteAgentUserPrompt(
	request: NoteAgentPromptRequest,
	_scheduledResearch?: ScheduledResearchContext,
): RenderedAgentPrompt {
	return renderAgentPrompt("research", "cornell-note", "user", {
		question: request.question,
		goal_title: request.goal.title,
		goal_description: request.goal.description,
		discovery_enabled: request.discoveryEnabled,
		topic_plan_context: request.topicPlan ? renderTopicPlan(request.topicPlan) : "",
		note_focus: request.noteFocus ?? "",
		source_update_context: request.sourceUpdate ? renderSourceUpdate(request.sourceUpdate) : "",
	});
}

interface NoteAgentPromptRequest {
	question: string;
	goal: { title: string; description: string };
	discoveryEnabled: boolean;
	topicPlan?: GoalTopicPlan;
	/** What this Run's notes should record in most detail; empty when the user expressed no focus. */
	noteFocus?: string;
	sourceUpdate?: { newMemberPaths: string[]; changedMemberPaths: string[] };
}

export function renderPrimeNoteAgentUserPrompt(taskPrompt: string, variant: "prime-execution" | "deep-search" = "prime-execution"): string {
	return renderAgentPrompt("research", "cornell-note", "user", {
		task_prompt: taskPrompt,
	}, variant).content;
}

function renderTopicPlan(plan: GoalTopicPlan): string {
	return [
		`Revision: ${plan.revision}`,
		"Use the short Topic references exactly as shown in topic_refs; Runtime maps them to canonical Topic IDs.",
		...goalTopicReferences(plan).flatMap(({ ref, topic }) => [
			`- ${ref} | ${topic.title}`,
			`  Intent: ${topic.intent}`,
			...(topic.include.length ? [`  Include: ${topic.include.join(" | ")}`] : []),
			...(topic.exclude.length ? [`  Exclude: ${topic.exclude.join(" | ")}`] : []),
		]),
	].join("\n");
}

function renderSourceUpdate(update: NonNullable<NoteAgentPromptRequest["sourceUpdate"]>): string {
	return [
		...(update.newMemberPaths.length ? [`New member paths: ${update.newMemberPaths.join(" | ")}`] : []),
		...(update.changedMemberPaths.length ? [`Changed member paths: ${update.changedMemberPaths.join(" | ")}`] : []),
	].join("\n");
}
