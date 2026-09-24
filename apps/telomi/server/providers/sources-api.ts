/**
 * The external sources as the settings page lists them: descriptor, last verified status, and the
 * managed credential entry when there is one. Verification on request runs the same check the
 * startup and daily passes do.
 */
import type { Express, Request, Response } from "express";

import type { SourcesResponse } from "../../shared/sources.js";
import { toErrorMessage } from "../lib/values.js";
import { describeSearchProvider, type SearchProviderStatus } from "./search-credentials-api.js";
import { searchCredentialProvider } from "./search-credential-catalog.js";
import { SOURCE_DESCRIPTORS, sourceDescriptor } from "./source-descriptors.js";
import type { SourceStatusMonitor } from "./source-status.js";
import { resyncBrowserProfile } from "./browser/startup.js";
import { DEFAULT_PRIME_SEARCH_ASSET } from "../research/harness/prime-search.js";

/** How long a freshly started browser host gets to rotate its sessions before a login is judged lost. */
export const BROWSER_SETTLE_RETRY_MS = 20_000;

export interface SourcesApiDependencies {
	monitor: SourceStatusMonitor;
	env?: NodeJS.ProcessEnv;
	/** Live browser sessions; the profile is not replaced under one. */
	liveBrowserSessions?: () => string[];
	resyncBrowserProfile?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

export function listSources(monitor: SourceStatusMonitor, env: NodeJS.ProcessEnv): SourcesResponse<SearchProviderStatus> {
	return {
		// Workspace sources read what the user handed the Run; they are not external and not listed.
		sources: SOURCE_DESCRIPTORS.filter((source) => source.provider.catalog.sourceClass !== "workspace").map((source) => {
			const provider = searchCredentialProvider(source.id);
			return {
				id: source.id,
				auth: source.auth,
				sourceIds: [source.provider.id],
				status: monitor.status(source.id),
				enabled: monitor.isEnabled(source.id),
				credential: provider ? describeSearchProvider(provider, env) : null,
			};
		}),
		verifying: monitor.verifying,
		generalWebBackend: DEFAULT_PRIME_SEARCH_ASSET.generalWebBackend,
	};
}

export function mountSourcesApi(app: Express, deps: SourcesApiDependencies): void {
	const { monitor } = deps;
	const env = deps.env ?? process.env;
	app.get("/api/sources", (_req: Request, res: Response) => {
		try {
			res.json(listSources(monitor, env));
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});

	app.post("/api/sources/verify", async (_req: Request, res: Response) => {
		try {
			await monitor.verifyAll();
			res.json(listSources(monitor, env));
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});

	app.put("/api/sources/:id/enabled", (req: Request, res: Response) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
		if (!sourceDescriptor(id) || typeof enabled !== "boolean") {
			res.status(400).json({ error: sourceDescriptor(id) ? "enabled must be a boolean" : `unknown source '${id}'` });
			return;
		}
		try {
			monitor.setEnabled(id, enabled);
			res.json(listSources(monitor, env));
			// A source switched back on is checked right away; the page refreshes when that lands.
			if (enabled) void monitor.verify(id).catch(() => undefined);
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});

	/**
	 * Copy the user's browser profile into the managed browser again and re-check every
	 * browser-backed source. Refused while a research browser session is running.
	 */
	app.post("/api/sources/browser/sync", async (_req: Request, res: Response) => {
		const live = deps.liveBrowserSessions?.() ?? [];
		if (live.length > 0) {
			res.status(409).json({ error: `${live.length} browser session(s) are running; try again when they finish` });
			return;
		}
		try {
			await (deps.resyncBrowserProfile ?? resyncBrowserProfile)(env);
			await monitor.verifyAll({ settleRetryMs: BROWSER_SETTLE_RETRY_MS });
			res.json(listSources(monitor, env));
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});

	app.post("/api/sources/:id/verify", async (req: Request, res: Response) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		if (!sourceDescriptor(id)) {
			res.status(400).json({ error: `unknown source '${id}'` });
			return;
		}
		try {
			await monitor.verify(id);
			res.json(listSources(monitor, env));
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});
}
