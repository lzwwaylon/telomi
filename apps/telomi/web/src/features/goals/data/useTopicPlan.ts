import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeGoalEvents } from "@/shared/lib/goalsEventsStream";
import { refreshOnReconnect } from "@/shared/lib/sharedEventSource";

export interface TopicPlanTopic {
	id: string;
	title: string;
	intent: string;
	questions: string[];
	include: string[];
	exclude: string[];
}

export interface TopicPlan {
	revision: string;
	topics: TopicPlanTopic[];
}

export interface TopicPlanProposal {
	proposal_id: string;
	status: "proposed" | "activated" | "superseded";
	created_at: string;
	source: "main_agent";
	patch: { summary: string };
	candidate_plan: TopicPlan;
	diff: string[];
}

export interface TopicPlanVersion {
	revision: string;
	confirmedAt: string;
	active: boolean;
	wikiAvailable: boolean;
	plan: TopicPlan;
}

interface TopicPlanResponse {
	active: TopicPlan | null;
	proposal: TopicPlanProposal | null;
	history: TopicPlanVersion[];
	error?: string;
}

export function useTopicPlan(goalId: string | null) {
	const [state, setState] = useState<TopicPlanResponse>({ active: null, proposal: null, history: [] });
	const [loading, setLoading] = useState(Boolean(goalId));
	const [activating, setActivating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const refreshVersion = useRef(0);

	const refresh = useCallback(async () => {
		const version = ++refreshVersion.current;
		if (!goalId) {
			setState({ active: null, proposal: null, history: [] });
			setLoading(false);
			return;
		}
		try {
			const body = await apiClient.get<TopicPlanResponse>(`/api/goals/${encodeURIComponent(goalId)}/topic-plan`);
			if (version !== refreshVersion.current) return;
			setState({ active: body.active, proposal: body.proposal, history: body.history ?? [] });
			setError(null);
		} catch (cause) {
			if (version !== refreshVersion.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (version === refreshVersion.current) setLoading(false);
		}
	}, [goalId]);

	useEffect(() => {
		setLoading(Boolean(goalId));
		setState({ active: null, proposal: null, history: [] });
		void refresh();
		if (!goalId) return;
		return subscribeGoalEvents(goalId, (event) => {
			if (event.type === "topic-plan:changed") void refresh();
		}, refreshOnReconnect(() => void refresh()));
	}, [goalId, refresh]);

	const activate = useCallback(async (proposalId: string) => {
		if (!goalId || activating) return;
		setActivating(true);
		setError(null);
		try {
			await apiClient.post(`/api/goals/${encodeURIComponent(goalId)}/topic-plans/${encodeURIComponent(proposalId)}/activate`);
			await refresh();
			setActivating(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setActivating(false);
		}
	}, [activating, goalId, refresh]);

	useEffect(() => {
		if (!state.proposal) setActivating(false);
	}, [state.proposal]);

	return { ...state, loading, activating, error, activate };
}
