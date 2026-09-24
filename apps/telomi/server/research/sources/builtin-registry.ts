import { ResearchSourceRegistry } from "./registry.js";
import { getDefaultProviderRuntime, type ProviderRuntime } from "./provider-runtime.js";
import {
	builtInFastApiRuntimePolicy,
	fastApiResearchProvider,
} from "./providers/fastapi.js";
import type { ResearchSearchProvider, ResearchSourceCatalogEntry } from "../../providers/search-types.js";
import type { ResearchHarnessSnapshot } from "../harness/snapshot.js";
import { GENERAL_WEB_BACKENDS, type GeneralWebBackend } from "../harness/prime-search.js";
import { generalWebWithFallback } from "./general-web-fallback.js";
import { youtubeResearchProvider } from "./providers/youtube/index.js";
import { SOURCE_DESCRIPTORS, type SourceProviderDefinition } from "../../providers/source-descriptors.js";
import { generalWebCatalog } from "../../providers/sources/general-web.js";

function catalog(provider: ResearchSearchProvider, entry: ResearchSourceCatalogEntry): ResearchSearchProvider {
	return {
		...provider,
		catalog: {
			...entry,
			...(entry.queryContract ? {
				queryContract: {
					...entry.queryContract,
					instructions: [
						...entry.queryContract.instructions,
						"Use Provider pagination only as needed by the assigned evidence requirements and shared stopping rule. Preserve unique Provider records and their provenance unchanged; Runtime validates and enriches them after execution.",
					],
				},
			} : {}),
		},
	};
}

const DEFAULT_GENERAL_WEB_BACKEND: GeneralWebBackend = "firecrawl";
const GENERAL_WEB_PREFIX = "general_web_";

export function createResearchSourceRegistry(
	env: Record<string, string | undefined>,
	generalWebBackend: GeneralWebBackend = DEFAULT_GENERAL_WEB_BACKEND,
	providerRuntime: ProviderRuntime = getDefaultProviderRuntime(),
): ResearchSourceRegistry {
	return registerBuiltinProviders(new ResearchSourceRegistry(providerRuntime), {
		env,
		generalWebBackend,
		providerRuntime,
	});
}

export function createHarnessResearchSourceRegistry(
	snapshot: ResearchHarnessSnapshot,
	env: Record<string, string | undefined>,
	providerRuntime: ProviderRuntime = getDefaultProviderRuntime(),
): ResearchSourceRegistry {
	return createResearchSourceRegistry(env, snapshot.primeSearch.policy.generalWebBackend, providerRuntime);
}

function createProvider(definition: SourceProviderDefinition, env: Record<string, string | undefined>): ResearchSearchProvider {
	const { runtime } = definition;
	switch (runtime.kind) {
		case "source_service": {
			const maxConcurrency = runtime.maxConcurrency ?? 1;
			return fastApiResearchProvider({
				id: definition.id,
				policy: { maxConcurrency, minIntervalMs: 0 },
				minStartIntervalMs: runtime.minIntervalMs,
				runtimePolicy: builtInFastApiRuntimePolicy({
					sourceId: definition.id,
					env,
					maxConcurrency,
					minIntervalMs: runtime.minIntervalMs,
				}),
			});
		}
		case "youtube":
			return youtubeResearchProvider();
		case "browser":
			return {
				id: definition.id,
				policy: { maxConcurrency: 1, minIntervalMs: 0 },
				async search() {
					throw new Error("Browser Provider executes through the Runtime-owned browser Tool");
				},
			};
	}
}

/**
 * Every descriptor registers its Provider in descriptor order. General web backends are not
 * registered on their own: the first one encountered registers the `general_web` composite that
 * prefers the configured backend and falls back to the others.
 */
function registerBuiltinProviders(
	registry: ResearchSourceRegistry,
	options: {
		env: Record<string, string | undefined>;
		generalWebBackend: GeneralWebBackend;
		providerRuntime: ProviderRuntime;
	},
): ResearchSourceRegistry {
	const backends = new Map<GeneralWebBackend, ResearchSearchProvider>();
	for (const source of SOURCE_DESCRIPTORS) {
		if (source.provider.id.startsWith(GENERAL_WEB_PREFIX)) {
			const backend = source.provider.id.slice(GENERAL_WEB_PREFIX.length) as GeneralWebBackend;
			if (!GENERAL_WEB_BACKENDS.includes(backend)) throw new Error(`unknown general web backend '${backend}'`);
			backends.set(backend, catalog(createProvider(source.provider, options.env), source.provider.catalog));
			continue;
		}
		registry.register(catalog(createProvider(source.provider, options.env), source.provider.catalog));
	}
	const missing = GENERAL_WEB_BACKENDS.filter((backend) => !backends.has(backend));
	if (missing.length > 0) throw new Error(`general web backends without a source descriptor: ${missing.join(", ")}`);
	const generalWeb = generalWebWithFallback(
		options.generalWebBackend,
		Object.fromEntries(backends) as Record<GeneralWebBackend, ResearchSearchProvider>,
		options.providerRuntime,
	);
	return registry.register(catalog(generalWeb, generalWebCatalog(options.generalWebBackend)));
}
