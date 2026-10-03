import { toErrorMessage } from "../lib/values.js";

export class AgentOutputValidationError extends Error {}

/** Model/transport failures escape promptTurn; only output violations receive repair turns. */
export async function acceptAgentOutput<T>(options: {
	promptTurn: (text: string, repair: boolean) => Promise<void>;
	validate: () => T | Promise<T>;
	initialPrompt: string;
	onRejected?: (attempt: number, error: string) => void;
	maxAttempts?: number;
}): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 3;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
		throw new Error("Agent output validation allows 1 to 3 attempts");
	}
	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		await options.promptTurn(attempt === 1 ? options.initialPrompt
			: `Runtime rejected your output. This is attempt ${attempt} of ${maxAttempts}, including the initial attempt. Repair the existing output files in this same session, preserve valid content, and address every listed violation. When finished, reply with one brief confirmation. Exact validation feedback:\n${lastError}`, attempt > 1);
		try { return await options.validate(); }
		catch (error) {
			lastError = toErrorMessage(error);
			options.onRejected?.(attempt, lastError);
		}
	}
	throw new AgentOutputValidationError(`Agent output remains invalid after ${maxAttempts} attempts: ${lastError}`);
}
