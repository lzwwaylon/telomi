import type { AgentTool } from "@earendil-works/pi-agent-core";
import { dirname } from "node:path";
import type { ExtraEnvGetter } from "../extra-env.js";
import type { WikiMainSessionContext } from '../wiki-context.js';
import { asTerminalTool } from "./terminal-action.js";
import { createResearchScheduleTool } from "./research-schedule.js";
import { createResearchHistoryTool } from "./research.js";
import { createDeliverInvestigationTool, createInvestigateTool } from "./investigate.js";
import { createWikiUpdateTool } from "./wiki-update.js";
import { createGeneratePodcastTool, type PodcastGenerationDispatchHandler } from "./generate-podcast.js";
import type { OutputLanguage } from "../../../shared/languages.js";
import type { RunArtifactRef } from "../../agent-runtime/artifact-store.js";

export interface CreateMainAgentToolsOptions {
	goalId: string;
	workspaceDir?: string;
	title?: string;
	description?: string;
	getGoalTitle?: () => string;
	getGoalDescription?: () => string;
	getOutputLanguage?: () => OutputLanguage;
	getExtraEnv?: ExtraEnvGetter;
	exposeInvestigationResult?: (artifact: RunArtifactRef) => void;
	generatePodcast?: PodcastGenerationDispatchHandler;
	/** Main node Replay captures the turn and durable Cues; Wiki has its own Replay boundary. */
	deferCueWikiUpdates?: boolean;
	getWikiMainContext?: () => WikiMainSessionContext;
}

export function createMainAgentTools(
	goalDir: string,
	options: CreateMainAgentToolsOptions,
): AgentTool<any>[] {
	return [
		createResearchHistoryTool(options),
		createInvestigateTool(goalDir, options),
		asTerminalTool(createDeliverInvestigationTool(goalDir), "deliver_investigation", "local_knowledge_delivered"),
		asTerminalTool(createGeneratePodcastTool(options.goalId, goalDir, (request) => {
			if (!options.generatePodcast) throw new Error("Podcast generation is not configured");
			return options.generatePodcast(request);
		}), "generate_podcast", "podcast_generation_requested"),
		createWikiUpdateTool({
			goalId: options.goalId,
			goalDir,
			workspaceDir: options.workspaceDir ?? dirname(goalDir),
			goalTitle: options.title,
			goalDescription: options.description,
			getGoalTitle: options.getGoalTitle,
			getGoalDescription: options.getGoalDescription,
			getOutputLanguage: options.getOutputLanguage,
			getEnv: () => options.getExtraEnv?.() ?? {},
			deferCueWikiUpdates: options.deferCueWikiUpdates,
			getMainSession: options.getWikiMainContext,
		}),
		createResearchScheduleTool({
			goalId: options.goalId,
			workspaceDir: options.workspaceDir ?? dirname(goalDir),
		}),
	];
}
