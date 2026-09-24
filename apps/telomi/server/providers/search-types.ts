export interface ResearchSearchRequest {
	query: string;
	maxResults: number;
	criterionIds: string[];
	purpose: string;
	signal: AbortSignal;
	workspaceDir: string;
	/** Runtime-resolved inclusive target range. Only professional Providers whose
	 * native filter has matching semantics may apply it. General-web discovery
	 * Providers must keep it as context and search without hard date filters. */
	temporalRange?: { startDate: string; endDate: string };
	/** Optional Provider-native operation. Runtime transports and audits this
	 * value, while the selected Provider owns its schema and validation. */
	providerRequest?: ResearchProviderRequest;
}

export interface ResearchProviderRequest {
	operation: string;
	parameters: Record<string, unknown>;
}

export interface ResearchSearchResult {
	id: string;
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
	authors?: string[];
	metadata?: Record<string, unknown>;
}

/**
 * The credential the Runtime resolved for this one request, carried beside the request rather
 * than inside it: the request is what gets recorded in a Provider call record and a Trace, and a
 * credential must never appear there.
 */
export interface ProviderSearchCredentials {
	credential?: Record<string, string | null>;
}

export interface ResearchSearchProvider {
	id: string;
	catalog?: ResearchSourceCatalogEntry;
	policy?: ResearchProviderPolicy;
	runtimePolicy?: (request: ResearchSearchRequest) => ResearchProviderRuntimePolicy;
	search(request: ResearchSearchRequest, credentials?: ProviderSearchCredentials): Promise<ResearchSearchResult[]>;
}

export interface ResearchProviderRuntimePolicy extends ResearchProviderPolicy {
	accessScope: string;
	maxAttempts?: number;
	overloadCooldownMs?: number;
	overloadBudgetWindowMs?: number;
	/**
	 * Overload budget one Provider Child shares across all its requests to this Provider: the
	 * Retry-After waits plus overloaded and controlled attempts it may spend. One controlled retry is
	 * allowed per Child; once the budget or that retry is spent, the Child stops calling the Provider.
	 */
	overloadBudgetMs?: number;
	cacheScope?: string;
	cacheKey?: unknown;
	cacheTtlMs?: number;
	/**
	 * The exact credential values the access and cache scopes above were derived from. The Runtime
	 * hands this same capture to the Provider, so one request cannot be answered with a credential
	 * different from the one its cache entry is filed under, however the configuration changes
	 * while the request is queued.
	 */
	credential?: Record<string, string | null>;
}

export interface ProviderSearchOutcome {
	results: ResearchSearchResult[];
	cache: {
		status: "hit" | "miss" | "bypass" | "coalesced";
		ageMs: number;
	};
	execution: {
		upstreamCalled: boolean;
		attempts: number;
		queueWaitMs: number;
		/** Ordinary minimum-interval spacing between requests. */
		intervalWaitMs: number;
		/** Cooldown after an upstream overload or Retry-After. */
		rateLimitWaitMs: number;
	};
}

export interface ProviderRuntimeEvent {
	id: number;
	providerId: string;
	accessScopeHash: string;
	cacheStatus: ProviderSearchOutcome["cache"]["status"] | "error";
	outcomeStatus: "succeeded" | "failed";
	upstreamCalled: boolean;
	attempts: number;
	queueWaitMs: number;
	rateLimitWaitMs: number;
	failureClass?: string;
	errorCode?: string;
	errorMessage?: string;
	startedAt: number;
	finishedAt: number;
}

export interface ResearchSourceCatalogEntry {
	implementationVersion: string;
	capability: string;
	/**
	 * Python module exposed inside the isolated Source Worker workspace.
	 * The module is only mounted when Runtime assigns this Provider to the
	 * Worker. Provider network access still remains behind Runtime.
	 */
	workerPython?: {
		/** A `tools.<name>` module shipped in `server/research/python-tools/tools`. */
		module: string;
		/** Helper modules from the same directory the Provider module imports. */
		files?: readonly string[];
	};
	/** Runtime-owned structured Tool exposed only through the Prime extension seam. */
	workerTool?: {
		name: "browser";
		skill: "prime-browser-provider-skill";
		tools: readonly ["browser", "materialize_source"];
	};
	/**
	 * Names of server-owned bundled Provider worker Skills that always follow this Provider into
	 * its isolated workspace and must be read before the Worker can mutate its
	 * workspace or execute code.
	 */
	workerSkills?: string[];
	/** How Runtime should position this source during source planning. */
	sourceClass?: "specialized" | "general" | "workspace";
	/** Provider-owned input contract shown to the Research Planner and its isolated Worker. */
	queryContract?: {
		input: "natural_language" | "provider_syntax";
		schemaVersion: 1;
		instructions: string[];
		examples?: string[];
		/** Literal fragments rejected before a query reaches the Provider. */
		forbiddenSyntax?: string[];
	};
	supportedContentTypes: string[];
	fullTextAvailability: "full_text" | "metadata_only" | "mixed" | "browser_render";
	credentialRequirement: "none" | "optional" | "required";
	reliabilityTier: 1 | 2 | 3;
	freshness: "realtime" | "daily" | "index_dependent" | "static";
	costClass: "free" | "low" | "medium" | "high";
	latencyClass: "low" | "medium" | "high";
	capabilities?: string[];
	/** Stable output fields the provider can produce without semantic inference. */
	supportedFields?: string[];
	/** Query-time filters the provider applies deterministically. */
	supportedFilters?: string[];
	/** Evidence classes that can be traced to a primary or authoritative source. */
	evidenceTypes?: string[];
	/** Reusable semantic or deterministic operations implemented by this provider. */
	operations?: string[];
}

export interface ResearchProviderPolicy {
	maxConcurrency: number;
	minIntervalMs: number;
}
