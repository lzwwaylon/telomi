import type { AgentTool } from "@earendil-works/pi-agent-core";
import { dirname } from "node:path";
import type { ExtraEnvGetter } from "../extra-env.js";
import { asTerminalTool } from "./terminal-action.js";
import { createResearchScheduleTool } from "./research-schedule.js";
import { createGoalLlmWikiTools } from "../../wiki/index.js";
import { createGenerateReportTool } from "./generate-report.js";
import { createMainResearchTool, createResearchHistoryTool } from "./research.js";
import { createWikiUpdateTool } from "./wiki-update.js";
import { createGeneratePodcastTool, type PodcastGenerationDispatchHandler } from "./generate-podcast.js";
import type { OutputLanguage } from "../../../shared/languages.js";

export interface CreateMainAgentToolsOptions {
	goalId: string;
	workspaceDir?: string;
	title?: string;
	description?: string;
	getGoalTitle?: () => string;
	getGoalDescription?: () => string;
	getDiscoveryEnabled?: () => boolean;
	getOutputLanguage?: () => OutputLanguage;
	getExtraEnv?: ExtraEnvGetter;
	getOriginalQuestion?: () => string | undefined;
	generatePodcast?: PodcastGenerationDispatchHandler;
	wikiTools?: AgentTool[];
}

export function createMainAgentTools(
	goalDir: string,
	_getAttachments: () => Array<{
		id: string;
		fileName: string;
		mimeType: string;
		size: number;
		content: string;
		extractedText?: string;
	}>,
	_opts: CreateMainAgentToolsOptions,
): AgentTool<any>[] {
	return [
		createResearchHistoryTool(_opts),
		asTerminalTool(createMainResearchTool(goalDir, _opts), "research", "external_research_requested"),
		asTerminalTool(createGenerateReportTool(goalDir, _opts), "generate_report", "wiki_report_generated"),
		asTerminalTool(createGeneratePodcastTool(_opts.goalId, (request) => {
			if (!_opts.generatePodcast) throw new Error("Podcast generation is not configured");
			return _opts.generatePodcast(request);
		}), "generate_podcast", "podcast_generation_requested"),
		...(_opts.wikiTools ?? createGoalLlmWikiTools({ goalDir })),
		createWikiUpdateTool({
			goalId: _opts.goalId,
			goalDir,
			workspaceDir: _opts.workspaceDir ?? dirname(goalDir),
			goalTitle: _opts.title,
			goalDescription: _opts.description,
			getGoalTitle: _opts.getGoalTitle,
			getGoalDescription: _opts.getGoalDescription,
			getOutputLanguage: _opts.getOutputLanguage,
			getEnv: () => _opts.getExtraEnv?.() ?? {},
		}),
		createResearchScheduleTool({
			goalId: _opts.goalId,
			workspaceDir: _opts.workspaceDir ?? dirname(goalDir),
		}),
	];
}
