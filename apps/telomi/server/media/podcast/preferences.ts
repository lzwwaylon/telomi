import {
	HindsightClient,
	resolvePiUserMemoryConfig,
	type PiUserMemoryConfig,
} from "pi-user-memory";
import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";

export interface PodcastGenerationBrief {
	schemaVersion: 1;
	goalId: string;
	resolvedAt: string;
	resolution: "resolved" | "unavailable";
	durablePreference: string | null;
	generationInstruction: string | null;
	evidenceRefs: Array<{ memoryId: string; documentId?: string }>;
}

export async function resolvePodcastGenerationBrief(input: {
	goalId: string;
	generationInstruction?: string;
	memory?: PiUserMemoryConfig;
}): Promise<PodcastGenerationBrief> {
	const goalId = input.goalId.trim();
	if (!goalId) throw new Error("Podcast generation requires a Goal id");
	const generationInstruction = input.generationInstruction?.trim().slice(0, 2_000) || null;
	const resolvedAt = new Date().toISOString();
	const memory = resolvePiUserMemoryConfig({ ...input.memory, goalId });
	try {
		const result = await new HindsightClient(memory.baseUrl, memory.bankId)
			.reflect(renderAgentPrompt("main", "podcast-writer", "user", {}, "preference-query").content,
				{ goalId });
		return {
			schemaVersion: 1,
			goalId,
			resolvedAt,
			resolution: "resolved",
			durablePreference: result.text.trim() || null,
			generationInstruction,
			evidenceRefs: (result.based_on?.memories ?? []).map((item) => ({
				memoryId: item.id,
				...(item.document_id ? { documentId: item.document_id } : {}),
			})),
		};
	} catch {
		return {
			schemaVersion: 1,
			goalId,
			resolvedAt,
			resolution: "unavailable",
			durablePreference: null,
			generationInstruction,
			evidenceRefs: [],
		};
	}
}
