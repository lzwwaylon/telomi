import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { getDefaultProviderRuntime, type ProviderRuntime, type ProviderSearchContext } from "./provider-runtime.js";
import type {
	ResearchSearchProvider,
	ResearchSearchRequest,
	ResearchSearchResult,
	ResearchSourceCatalogEntry,
} from "../../providers/search-types.js";

export class ResearchSourceRegistry {
	private readonly providers = new Map<string, ResearchSearchProvider>();

	constructor(private readonly runtime: ProviderRuntime = getDefaultProviderRuntime()) {}

	register(provider: ResearchSearchProvider): this {
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id)) throw new Error(`invalid research source id '${provider.id}'`);
		if (this.providers.has(provider.id)) throw new Error(`research source '${provider.id}' is already registered`);
		const policy = provider.policy ?? { maxConcurrency: 2, minIntervalMs: 0 };
		if (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency <= 0) {
			throw new Error(`research source '${provider.id}' maxConcurrency must be a positive integer`);
		}
		if (!Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 0) {
			throw new Error(`research source '${provider.id}' minIntervalMs must be non-negative`);
		}
		this.providers.set(provider.id, provider);
		return this;
	}

	get(id: string): ResearchSearchProvider | undefined {
		return this.providers.get(id);
	}

	search(id: string, request: ResearchSearchRequest, context?: ProviderSearchContext): Promise<ResearchSearchResult[]> {
		const provider = this.providers.get(id);
		if (!provider) throw new ResearchNodeError(`research source '${id}' is not registered`, "permanent", false);
		return this.runtime.search(provider, request, context).then((outcome) => outcome.results);
	}

	ids(): string[] {
		return [...this.providers.keys()];
	}

	catalog(): Array<ResearchSourceCatalogEntry & { id: string }> {
		return [...this.providers.values()].map((provider) => {
			if (!provider.catalog) throw new Error(`research source '${provider.id}' has no catalog`);
			return { id: provider.id, ...provider.catalog };
		});
	}
}
