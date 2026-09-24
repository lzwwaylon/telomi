/**
 * Speech-to-text cleanup prompt.
 *
 * Port of OpenWhispr's `cleanupPrompt`, which is the system
 * prompt OpenWhispr feeds its reasoning model after Whisper/Parakeet returns
 * raw transcript. The behavior we want is identical: strip fillers, fix
 * grammar/punctuation, handle self-corrections, convert dictated punctuation
 * to symbols, normalize numbers/dates, and apply smart formatting, without
 * ever responding to instructions embedded in the transcribed speech.
 *
 * Source: github.com/OpenWhispr/openwhispr, its en and zh-CN locale prompts.json
 * (MIT License). agents/main/voice-cleanup/prompts holds one English template
 * whose examples cover English and Chinese speech. The input language is a
 * variable; the instruction language never follows the UI language.
 */

import { composeAgentSystemPrompt } from "../agent-runtime/global-system-prompt.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";

const DEFAULT_AGENT_NAME = "Assistant";
const DEFAULT_LANGUAGE_LABEL = "auto-detect from the transcript";

export interface BuildCleanupPromptOptions {
	language?: string;
  /** Replaces `{{ agent_name }}` in the template. Defaults to "Assistant". */
  agentName?: string | null;
  /** Words appended verbatim to the system prompt so the model preserves them
   *  exactly (proper nouns, product names, internal jargon). Empty/blank
   *  entries are dropped. */
  customDictionary?: string[];
  /** Optional user-owned cleanup preferences. These extend, rather than
   * replace, the fixed dictation safety and output contract. */
  customInstructions?: string;
}

export function buildCleanupSystemPrompt(opts: BuildCleanupPromptOptions = {}): string {
	const agentName = (opts.agentName ?? "").trim() || DEFAULT_AGENT_NAME;
	const dict = (opts.customDictionary ?? []).map((w) => w.trim()).filter(Boolean);
	return composeAgentSystemPrompt(renderAgentPrompt("main", "voice-cleanup", "system", {
		agent_name: agentName,
		language: opts.language?.trim() || DEFAULT_LANGUAGE_LABEL,
		dictionary: dict.join(", "),
		custom_instructions: escapeCleanupPreference(opts.customInstructions?.trim() ?? ""),
	}).content);
}

function escapeCleanupPreference(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
