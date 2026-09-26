import { renderAgentPrompt, type RenderedAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import type { ScheduledResearchContext } from "../scheduled-research-context.js";
import { goalTopicReferences, type GoalTopicPlan } from "../../goals/topic-plan/index.js";

export function buildCornellNoteAgentSystemPrompt(
	scheduledResearch?: ScheduledResearchContext,
): string {
	return renderCornellNoteAgentSystemPrompt(scheduledResearch).content;
}

export function renderCornellNoteAgentSystemPrompt(
	_scheduledResearch?: ScheduledResearchContext,
): RenderedAgentPrompt {
	return renderAgentPrompt("research", "cornell-note", "system-append");
}

export function buildCornellNoteAgentUserPrompt(
	request: CornellPromptRequest,
	scheduledResearch?: ScheduledResearchContext,
): string {
	return renderCornellNoteAgentUserPrompt(request, scheduledResearch).content;
}

export function renderCornellNoteAgentUserPrompt(
	request: CornellPromptRequest,
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

interface CornellPromptRequest {
	question: string;
	goal: { title: string; description: string };
	discoveryEnabled: boolean;
	topicPlan?: GoalTopicPlan;
	/** What this Run's notes should record in most detail; empty when the user expressed no focus. */
	noteFocus?: string;
	sourceUpdate?: { newMemberPaths: string[]; changedMemberPaths: string[] };
}

export function renderPrimeCornellNoteUserPrompt(taskPrompt: string): string {
	return renderAgentPrompt("research", "cornell-note", "user", {
		task_prompt: taskPrompt,
	}, "prime-execution").content;
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

function renderSourceUpdate(update: NonNullable<CornellPromptRequest["sourceUpdate"]>): string {
	return [
		...(update.newMemberPaths.length ? [`New member paths: ${update.newMemberPaths.join(" | ")}`] : []),
		...(update.changedMemberPaths.length ? [`Changed member paths: ${update.changedMemberPaths.join(" | ")}`] : []),
	].join("\n");
}
