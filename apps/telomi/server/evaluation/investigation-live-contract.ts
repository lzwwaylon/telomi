import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOutputLanguage, type OutputLanguage } from "../../shared/languages.js";
import { isThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { modelDefinitionHash, pinTaskModelSelection } from "../agent-runtime/model-policy.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { sha256, stableJson } from "../lib/hash.js";
import { isRecord } from "../lib/values.js";

export const LIVE_INVESTIGATION_RECIPE = { id: "prime-investigation", version: 2 } as const;
export type InvestigationProfile = "prime_ipython" | "pi_builtin";
export const INVESTIGATION_MODEL_KEYS = ["TELOMI_PRIME_AGENT_ROOT_MODEL", "TELOMI_PRIME_AGENT_CHILD_MODEL", "TELOMI_NOTE_AGENT_MODEL"] as const;
export const INVESTIGATION_THINKING_KEYS = ["TELOMI_PRIME_SEARCH_THINKING_LEVEL", "TELOMI_PRIME_REPORT_THINKING_LEVEL", "TELOMI_NOTE_AGENT_THINKING_LEVEL"] as const;

export interface LiveInvestigationRequest {
	schema_version: 2;
	source: { goal_id: string; main_case_ref: { sourceRunId: string; caseId: string }; tool_call_id: string; investigation_id: string };
	task: { question: string; context?: string; threadId?: string; title?: string; allowExternal: boolean; outputLanguage: OutputLanguage };
	model_env: Record<string, string>;
	model_definition_hashes: Record<string, string>;
	goal_sha256: string;
	wiki_sha256: string;
	business_input_sha256: string;
}

export function liveInvestigationProfile(env: NodeJS.ProcessEnv = process.env): InvestigationProfile {
	const profile = env.TELOMI_INVESTIGATION_REPLAY_PROFILE ?? "prime_ipython";
	if (profile !== "pi_builtin" && profile !== "prime_ipython") throw new Error("Invalid TELOMI_INVESTIGATION_REPLAY_PROFILE");
	if (profile === "pi_builtin" && env.TELOMI_EVAL_INSTANCE !== "1") throw new Error("Pi Investigation Replay requires TELOMI_EVAL_INSTANCE=1");
	return profile;
}

export function liveInvestigationPrompts(profile = liveInvestigationProfile()) {
	const variant = profile === "pi_builtin" ? "investigate-pi" : "investigate";
	return { userPrompt: renderAgentPrompt("research", "prime-search", "user", {
		run_input_json: JSON.stringify({ request_ref: "inputs/request.json" }),
	}, variant).content,
		systemPrompt: profile === "pi_builtin" ? renderAgentPrompt("research", "prime-search", "system", {}, variant).content : "" };
}

/** Freeze only model identities and reasoning settings; credentials remain outside Case inputs. */
export function freezeInvestigationModels(env: NodeJS.ProcessEnv = process.env) {
	const pinned = pinTaskModelSelection(["primeRoot", "primeChild", "noteAgent"], env);
	return { model_env: Object.fromEntries([...INVESTIGATION_MODEL_KEYS, ...INVESTIGATION_THINKING_KEYS].map(key => [key, pinned[key]!])),
		model_definition_hashes: Object.fromEntries(INVESTIGATION_MODEL_KEYS.map(key => [pinned[key]!, modelDefinitionHash(pinned[key]!, env)])) };
}

export function liveInvestigationBusinessHash(value: Omit<LiveInvestigationRequest, "business_input_sha256">): string {
	return sha256(stableJson(value));
}

export function readLiveInvestigationRequest(directory: string): LiveInvestigationRequest {
	const v: unknown = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
	const modelEnv = isRecord(v) && isRecord(v.model_env) ? v.model_env : {};
	if (!isRecord(v) || v.schema_version !== 2 || !isRecord(v.source) || !isRecord(v.source.main_case_ref)
		|| typeof v.source.goal_id !== "string" || !v.source.goal_id || typeof v.source.tool_call_id !== "string" || !v.source.tool_call_id
		|| typeof v.source.main_case_ref.sourceRunId !== "string" || typeof v.source.main_case_ref.caseId !== "string"
		|| typeof v.source.investigation_id !== "string" || !/^[a-f0-9]{24}$/u.test(v.source.investigation_id)
		|| !isRecord(v.task) || typeof v.task.question !== "string" || !v.task.question.trim() || v.task.question.length > 20_000
		|| typeof v.task.allowExternal !== "boolean" || !isOutputLanguage(v.task.outputLanguage) || v.task.outputLanguage === "auto"
		|| (v.task.context !== undefined && (typeof v.task.context !== "string" || v.task.context.length > 40_000))
		|| (v.task.title !== undefined && (typeof v.task.title !== "string" || !v.task.title.trim() || v.task.title.length > 120))
		|| (v.task.threadId !== undefined && (typeof v.task.threadId !== "string" || !/^[a-f0-9]{24}$/u.test(v.task.threadId)))
		|| !isRecord(v.model_env) || !isRecord(v.model_definition_hashes)
		|| JSON.stringify(Object.keys(v.model_env).sort()) !== JSON.stringify([...INVESTIGATION_MODEL_KEYS, ...INVESTIGATION_THINKING_KEYS].sort())
		|| INVESTIGATION_MODEL_KEYS.some(key => typeof modelEnv[key] !== "string" || !/^[^/\s]+\/.+$/u.test(modelEnv[key] as string))
		|| INVESTIGATION_THINKING_KEYS.some(key => !isThinkingLevel(modelEnv[key]))
		|| ![v.goal_sha256, v.wiki_sha256, v.business_input_sha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) {
		throw new Error("Live Investigation Case has invalid frozen inputs");
	}
	const request = v as unknown as LiveInvestigationRequest;
	if (Object.keys(request.model_definition_hashes).sort().join("\0") !== [...new Set(INVESTIGATION_MODEL_KEYS.map(key => request.model_env[key]!))].sort().join("\0")
		|| Object.values(request.model_definition_hashes).some(hash => !/^[a-f0-9]{64}$/u.test(hash))) throw new Error("Live Investigation model definitions are incomplete");
	const { business_input_sha256: digest, ...business } = request;
	if (liveInvestigationBusinessHash(business) !== digest) throw new Error("Live Investigation business input identity changed");
	if (new RunArtifactStore(directory).describeDirectory("goal").sha256 !== request.goal_sha256) throw new Error("Live Investigation prestate changed");
	return request;
}
