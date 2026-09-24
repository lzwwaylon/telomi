import { resolveStageThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { accountManagerFor } from "../../accounts/manager.js";
import { classifyProviderError } from "../../accounts/error-classify.js";
import { freezeModelDefinitions, pinTaskModelSelection, trackTaskModelSelection, resolvePrimeAgentModels } from "../../agent-runtime/model-policy.js";
import { spawnPrimeWorker } from "../../agent-runtime/prime-worker.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../../agent-runtime/skill-registry.js";

const WORKER = fileURLToPath(new URL("./writer-worker.ts", import.meta.url));

export interface PrimePodcastWritingSection {
	sectionId: string;
	title: string;
	text: string;
}

export interface PrimePodcastWritingResult {
	title: string;
	sections: PrimePodcastWritingSection[];
	artifactRoot: string;
	rootModel: string;
	childModel: string;
}

async function executeWritePrimePodcast(input: {
	sourceText: string;
	sessionDir: string;
	title: string;
	language: string;
	audience: string;
	generationBrief: {
		durablePreference: string | null;
		generationInstruction: string | null;
	};
	emitProgress: (next: string) => void;
	observe: (line: string) => void;
	signal: AbortSignal;
	env?: NodeJS.ProcessEnv;
	skillWorkspaceDirectory?: string;
}): Promise<PrimePodcastWritingResult> {
	const env = input.env ?? process.env;
	const thinkingLevel = resolveStageThinkingLevel("primeRoot", "podcastWriter", env).thinkingLevel;
	const models = resolvePrimeAgentModels(env);
	const workspaceRoot = join(input.sessionDir, "media/podcast/writer");
	const agentRoot = join(workspaceRoot, "agent-workspace");
	const inputsRoot = join(agentRoot, "inputs");
	const runtimeRoot = join(workspaceRoot, "runtime");
	mkdirSync(inputsRoot, { recursive: true });
	mkdirSync(runtimeRoot, { recursive: true });
	const configuredSkills = bundledAgentSkillPaths("main", "podcast-writer");
	if (configuredSkills.length !== 1) throw new Error("Podcast Writer must declare exactly one Skill");
	const expectedSkill = basename(configuredSkills[0]!);
	const goalSkillRoot = input.skillWorkspaceDirectory
		? join(input.skillWorkspaceDirectory, "skills", "podcast-writer")
		: undefined;
	const stagedSkills = materializeSkills(
		snapshotSkills([
			...configuredSkills,
			...(goalSkillRoot ? [goalSkillRoot] : []),
		], { allowOverrides: true }),
		join(runtimeRoot, "skills"),
	);
	const stagedSkill = stagedSkills.get(expectedSkill);
	if (!stagedSkill) throw new Error(`Podcast Writer Skill '${expectedSkill}' did not materialize`);
	writeFileSync(join(inputsRoot, "canonical-report.md"), input.sourceText);
	// Runtime 交付分段子 Agent 的契约文件；Root 只引用它，不转述。
	writeFileSync(join(inputsRoot, "segment-contract.md"), `${renderAgentPrompt("main", "podcast-writer", "reference", {}, "segment-contract").content}\n`);
	writeFileSync(join(inputsRoot, "request.json"), `${JSON.stringify({
		title: input.title,
		language: input.language,
		audience: input.audience,
		generationBrief: input.generationBrief,
		childModel: models.child.selector,
	}, null, 2)}\n`);

	const accountManager = accountManagerFor(models.root.provider);
	await accountManager.load();
	let lastError = "Prime podcast writer was not started";
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		input.signal.throwIfAborted();
		const active = accountManager.getActiveSummary();
		input.emitProgress(attempt === 1 ? "Prime 规划与分段写作" : "重试播客写作");
		try {
			// 启动器每次重新 stage Agent Directory，账号切换后的凭证因此在下一次尝试生效。
			await spawnPrimeWorker({
				name: "Prime podcast writer",
				worker: WORKER,
				agentRoot,
				runtimeRoot,
				readonlyRoots: [stagedSkill],
				env,
				extraEnv: {
					PRIME_PODCAST_THINKING_LEVEL: thinkingLevel,
					PRIME_PODCAST_CWD: agentRoot,
					PRIME_PODCAST_RUNTIME: runtimeRoot,
					PRIME_PODCAST_SKILL: stagedSkill,
					PRIME_PODCAST_EXPECTED_SKILL: expectedSkill,
					PRIME_PODCAST_ROOT_MODEL: models.root.selector,
					PRIME_PODCAST_CHILD_MODEL: models.child.selector,
				},
				signal: input.signal,
				onStdoutLine: input.observe,
			});
			return readOutput(agentRoot, runtimeRoot, models.root.selector, models.child.selector);
		} catch (error) {
			if (!(error instanceof ResearchNodeError) || error.failureClass === "cancelled") throw error;
			lastError = error.message;
		}
		const errorClass = classifyProviderError(lastError);
		if (errorClass === "transient" && attempt < 2) {
			input.observe("podcast_prime_transient_retry");
			continue;
		}
		if (!active || !["quota", "auth"].includes(errorClass)) break;
		await accountManager.recordFailure(active.id, errorClass, lastError);
		const replacement = accountManager.getActiveSummary();
		if (!replacement || replacement.id === active.id) break;
		input.observe(`podcast_prime_account_fallback from=${active.id} to=${replacement.id}`);
	}
	throw new Error(`Prime podcast writer failed: ${lastError}`);
}

export function readPrimePodcastOutput(
	agentRoot: string,
	runtimeRoot: string,
	rootModel: string,
	childModel: string,
): PrimePodcastWritingResult {
	return readOutput(agentRoot, runtimeRoot, rootModel, childModel);
}

function readOutput(agentRoot: string, runtimeRoot: string, rootModel: string, childModel: string): PrimePodcastWritingResult {
	const outputRoot = join(agentRoot, "writer-output");
	const manifestPath = join(outputRoot, "manifest.json");
	const completePath = join(outputRoot, ".complete");
	if (!existsSync(manifestPath) || !existsSync(completePath)) throw new Error("Prime podcast writer output is incomplete");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
		version?: unknown;
		title?: unknown;
		sections?: Array<{ sectionId?: unknown; title?: unknown; path?: unknown }>;
	};
	if (manifest.version !== 1 || typeof manifest.title !== "string" || !manifest.title.trim() || !Array.isArray(manifest.sections) || manifest.sections.length < 3) {
		throw new Error("Prime podcast writer manifest is invalid");
	}
	const sections = manifest.sections.map((section, index) => {
		const expectedId = `segment-${String(index + 1).padStart(3, "0")}`;
		const expectedPath = `sections/${expectedId}.txt`;
		if (section.sectionId !== expectedId || section.path !== expectedPath || typeof section.title !== "string" || !section.title.trim()) {
			throw new Error(`Prime podcast writer manifest segment ${index + 1} is invalid`);
		}
		const textPath = join(outputRoot, expectedPath);
		if (!existsSync(textPath)) throw new Error(`Prime podcast writer is missing ${expectedPath}`);
		const text = readFileSync(textPath, "utf-8").trim();
		if (!text) throw new Error(`Prime podcast writer ${expectedId} is empty`);
		return { sectionId: expectedId, title: section.title.trim(), text };
	});
	if (!existsSync(join(runtimeRoot, "result.json"))) throw new Error("Prime podcast writer produced no runtime result");
	return { title: manifest.title.trim(), sections, artifactRoot: outputRoot, rootModel, childModel };
}

export async function writePrimePodcast(input: Parameters<typeof executeWritePrimePodcast>[0]): ReturnType<typeof executeWritePrimePodcast> {
	const env = freezeModelDefinitions(pinTaskModelSelection(["primeRoot", "primeChild"], input.env ?? process.env), join(input.sessionDir, "media", "podcast", "writer", "runtime"));
	const release = trackTaskModelSelection(["primeRoot", "primeChild"], env, ["primeRoot.podcastWriter"]);
	try { return await executeWritePrimePodcast({ ...input, env }); } finally { release(); }
}
