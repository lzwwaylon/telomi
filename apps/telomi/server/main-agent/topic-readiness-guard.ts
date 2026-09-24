import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { GoalTopicPlanStore, type DiscoveryCandidate } from "../goals/topic-plan/index.js";
import { findLogicalSourceInRun, readSourceEvidenceAnchors, type SourceEvidenceExcerpt } from "../workspaces/source-view.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";

export function buildTopicPlanConfirmedEvent(revision: string, proposalId: string): string {
	return renderAgentPrompt("main", "router", "user", {
		revision,
		proposal_id: proposalId,
	}, "topic-confirmed-event").content;
}

export function buildDiscoveryDiscussionContext(candidate: DiscoveryCandidate, excerpts: SourceEvidenceExcerpt[] = []): string {
	return renderAgentPrompt("main", "router", "system-append", {
		candidate_json: JSON.stringify({
			id: candidate.id,
			finding: candidate.finding,
			run_id: candidate.run_id,
			source_id: candidate.source_id,
			cue: candidate.cue,
			note: candidate.note,
			evidence: candidate.evidence,
			evidence_excerpts: excerpts.map((excerpt) => ({
				path: excerpt.path,
				start_line: excerpt.startLine,
				end_line: excerpt.endLine,
				content: excerpt.content,
			})),
		}),
	}, "discovery-context").content;
}

export function registerTopicReadinessGuard(
	pi: ExtensionAPI,
	workspaceDir: string,
	goalId: string,
	getDiscoveryCandidateId: () => string | undefined = () => undefined,
	getActiveTopicId: () => string | undefined = () => undefined,
): void {
	pi.on("before_agent_start", (event) => {
		const store = new GoalTopicPlanStore(goalId, workspaceDir);
		const active = store.readActive();
		const guard = !active
			? renderAgentPrompt("main", "router", "system-append", {}, "topic-guard-unconfirmed").content
			: store.hasPendingRequiredConfirmation()
				? renderAgentPrompt("main", "router", "system-append", { revision: active.revision }, "topic-guard-pending").content
				: renderAgentPrompt("main", "router", "system-append", { revision: active.revision }, "topic-guard-confirmed").content;

		const discoveryCandidateId = getDiscoveryCandidateId();
		const discovery = discoveryCandidateId ? store.readDiscovery(discoveryCandidateId) : undefined;
		const activeTopicId = getActiveTopicId();
		const activeTopic = activeTopicId ? active?.topics.find((topic) => topic.id === activeTopicId) : undefined;
		return {
			systemPrompt: [
				event.systemPrompt,
				guard,
				activeTopic ? renderAgentPrompt("main", "router", "system-append", {
					topic_json: JSON.stringify(activeTopic),
				}, "topic-focus").content : undefined,
				discovery ? buildDiscoveryDiscussionContext(discovery,
					readDiscoveryEvidence(workspaceDir, goalId, discovery)) : undefined,
			].filter(Boolean).join("\n\n"),
		};
	});
}

function readDiscoveryEvidence(workspaceDir: string, goalId: string, candidate: DiscoveryCandidate): SourceEvidenceExcerpt[] {
	try {
		const source = findLogicalSourceInRun(
			join(workspaceDir, goalId, "wiki", "runs", candidate.run_id),
			candidate.source_id,
		);
		return source ? readSourceEvidenceAnchors(source, candidate.evidence.map((entry) => ({
			path: entry.source_path,
			startLine: entry.start_line,
			endLine: entry.end_line,
			sha256: entry.content_sha256,
		}))) : [];
	} catch {
		return [];
	}
}
