import type { ResearchSearchProvider } from "../../providers/search-types.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { GENERAL_WEB_BACKENDS, type GeneralWebBackend } from "../harness/prime-search.js";
import type { ProviderRuntime } from "./provider-runtime.js";

/** Failures that say "this backend cannot answer now", not "this query is wrong". */
const BACKEND_UNAVAILABLE_CODES = new Set([
	"provider_credentials", "provider_rate_limit", "provider_error", "provider_timeout", "provider_network_error",
]);

function backendUnavailable(error: unknown): boolean {
	if (!(error instanceof ResearchNodeError)) return false;
	if (error.code && BACKEND_UNAVAILABLE_CODES.has(error.code)) return true;
	return error.failureClass !== "validation" && error.failureClass !== "cancelled" && error.failureClass !== "budget";
}

/**
 * `general_web` tries the preferred backend first and then every other configured backend, in
 * a fixed order, whenever a backend is unavailable (no credential, exhausted credits, rate
 * limited, upstream error or timeout). A rejected query is not retried elsewhere. Each backend
 * keeps its own Runtime policy (rate limit, credential scope, cache); the composite carries
 * none, so nothing is filed under a backend that did not answer.
 */
export function generalWebWithFallback(
	preferred: GeneralWebBackend,
	backends: Record<GeneralWebBackend, ResearchSearchProvider>,
	runtime: ProviderRuntime,
): ResearchSearchProvider {
	const order = [preferred, ...GENERAL_WEB_BACKENDS.filter((backend) => backend !== preferred)];
	return {
		id: "general_web",
		policy: backends[preferred].policy,
		// One attempt and no cache at this level: each backend retries, throttles and caches under its
		// own scope, and a fallback answer must not be filed under the preferred backend's credential.
		runtimePolicy: () => ({
			accessScope: "general_web",
			maxConcurrency: backends[preferred].policy?.maxConcurrency ?? 1,
			minIntervalMs: 0,
			maxAttempts: 1,
		}),
		async search(request) {
			const attempts: string[] = [];
			for (const backend of order) {
				try {
					const outcome = await runtime.search(backends[backend], request);
					return outcome.results.map((row) => attempts.length === 0 ? row : {
						...row,
						metadata: { ...row.metadata, general_web_fallback_from: order.slice(0, attempts.length) },
					});
				} catch (error) {
					if (!backendUnavailable(error)) throw error;
					attempts.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			throw new ResearchNodeError(
				`General Web is unavailable on every backend: ${attempts.join(" | ")}`,
				"provider",
				true,
				{ code: "general_web_unavailable", details: { attempts } },
			);
		},
	};
}
