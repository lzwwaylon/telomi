import { ResearchNodeError, type ResearchFailureClass } from "../retry-policy.js";
import { toErrorMessage } from "../../lib/values.js";

const SECRET_PATTERNS = [
	/\b(?:sk|key|token|bearer)[-_][A-Za-z0-9._-]{12,}\b/gi,
	/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
	/\b(?:api[_-]?key|authorization|secret)\s*[:=]\s*[^\s,;]+/gi,
];

/** Redact credential-shaped text without shortening it. */
export function redactResearchSecrets(value: unknown): string {
	let text = toErrorMessage(value);
	for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
	return text;
}

export function scrubResearchModelError(value: unknown): string {
	return redactResearchSecrets(value).slice(0, 2_000);
}

export function classifyResearchModelFailure(value: unknown): ResearchFailureClass {
	const message = scrubResearchModelError(value);
	if (/abort(?:ed)?|cancelled/i.test(message)) return "cancelled";
	if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "timeout";
	if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limit";
	if (/\b(?:401|402|403)\b|insufficient (?:balance|credits?)|billing|payment required|unauthori[sz]ed|forbidden|(?:invalid|missing|no).*?(?:api )?(?:key|token)|login/i.test(message)) return "permanent";
	return "provider";
}

export function researchModelError(value: unknown, modelRef: string): ResearchNodeError {
	const failureClass = classifyResearchModelFailure(value);
	return new ResearchNodeError(
		`model '${modelRef}' failed: ${scrubResearchModelError(value)}`,
		failureClass,
		failureClass === "timeout" || failureClass === "rate_limit" || failureClass === "provider",
		value instanceof Error ? { cause: value } : undefined,
	);
}
