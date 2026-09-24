import {
	registerBrowserMaterialScope,
	releaseBrowserTool,
	resumeBrowserTool,
	releaseBrowserToolScope,
	type BrowserToolClientConfig,
} from "../../providers/browser/tool-router.js";
import type { BrowserReleaseReason } from "../../providers/browser/session-registry.js";
import type { ResearchSourceCatalogEntry } from "../../providers/search-types.js";

export interface ProviderToolRuntime {
	toolNames: string[];
	env: NodeJS.ProcessEnv;
	registerWorkspace(root: string): () => void;
	release(reason: BrowserReleaseReason): Promise<void>;
	onChildEvent(event: unknown): void;
	signal: AbortSignal;
}

/** Resolve Runtime Tool mechanics from Provider catalog metadata, outside Prime orchestration. */
export function providerToolRuntime(
	sources: readonly ResearchSourceCatalogEntry[],
	request: { goalId: string; runId: string },
	scopeId: string,
	env: NodeJS.ProcessEnv = process.env,
): ProviderToolRuntime | undefined {
	const names = [...new Set(sources.flatMap((source) => source.workerTool?.name ?? []))];
	if (names.length === 0) return undefined;
	if (names.length > 1 || names[0] !== "browser") {
		throw new Error(`Unsupported Provider Runtime Tool set: ${names.join(", ")}`);
	}
	const config = browserConfig(request, scopeId, env);
	const failure = new AbortController();
	const releases = new Map<string, Promise<void>>();
	return {
		signal: failure.signal,
		onChildEvent(event) {
			const value = event as { type?: string; child?: { id?: string; status?: string; activity?: unknown } } | null;
			const child = value?.child;
			if (value?.type !== "rlm_child_update" || !child?.id || !/^sub-[A-Za-z0-9-]+$/u.test(child.id)) return;
			// Prime retains finished children. Follow-up work keeps status="done" and exposes activity.
			if (["queued", "running"].includes(child.status ?? "") || child.activity != null) {
				if (releases.delete(child.id)) resumeBrowserTool(config, child.id);
				return;
			}
			if (!["done", "completed", "failed", "cancelled", "error"].includes(child.status ?? "") || releases.has(child.id)) return;
			const reason = child.status === "cancelled" ? "aborted" : ["failed", "error"].includes(child.status!) ? "error" : "completed";
			// The host consumes SDK lifecycle events. No fire-and-forget HTTP request from the Worker.
			const release = releaseBrowserTool(config, child.id, reason).catch((error) => {
				console.error("[telomi][browser] Child cleanup failed", error);
				failure.abort(error);
			});
			releases.set(child.id, release);
		},
		toolNames: ["browser", "materialize_source"],
		env: {
			TELOMI_BROWSER_TOOL_URL: config.baseUrl,
			TELOMI_BROWSER_TOOL_TOKEN: config.token,
			TELOMI_BROWSER_TOOL_SCOPE: config.scopeId,
			TELOMI_BROWSER_TOOL_GOAL_ID: config.goalId,
			TELOMI_BROWSER_TOOL_RUN_ID: config.runId,
		},
		registerWorkspace: (root) => registerBrowserMaterialScope(config, root),
		async release(reason) {
			await Promise.all([releaseBrowserToolScope(config, reason), ...releases.values()]);
			if (failure.signal.aborted) throw failure.signal.reason;
		},
	};
}

function browserConfig(
	request: { goalId: string; runId: string },
	scopeId: string,
	env: NodeJS.ProcessEnv,
): BrowserToolClientConfig {
	const baseUrl = env.TELOMI_BROWSER_TOOL_URL?.trim();
	const token = env.TELOMI_BROWSER_TOOL_TOKEN?.trim();
	if (!baseUrl || !token) throw new Error("Browser Provider requires the Runtime Browser Tool bridge");
	return { baseUrl, token, scopeId, goalId: request.goalId, runId: request.runId };
}
