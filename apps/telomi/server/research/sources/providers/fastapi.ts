import { createSha256 } from "../../../lib/hash.js";

import {
	canonicalArxivQuery,
	parseArxivProviderRequest,
} from "../contracts/arxiv.js";
import {
	canonicalGitHubQuery,
	githubOperationMaterializesWorkspace,
	parseGitHubProviderRequest,
} from "../contracts/github.js";
import {
	canonicalHuggingFaceQuery,
	huggingFaceOperationMaterializesWorkspace,
	parseHuggingFaceProviderRequest,
} from "../contracts/huggingface.js";
import {
	canonicalTwitterQuery,
	parseTwitterProviderRequest,
} from "../contracts/twitter.js";
import type { ResearchSourceServiceClient } from "../../../providers/source-service-client.js";
import { getResearchSourceServiceClient } from "../../../providers/source-service-client.js";
import { firstEnvValue } from "../../../lib/env.js";
import { searchCredentialAliasGroups } from "../../../providers/search-credential-catalog.js";
import { captureSearchCredential } from "../../../providers/search-credentials.js";
import type {
	ResearchProviderPolicy,
	ResearchProviderRuntimePolicy,
	ResearchSearchProvider,
	ResearchSearchRequest,
} from "../../../providers/search-types.js";

export interface FastApiResearchProviderOptions {
	id: string;
	serviceSourceId?: string;
	client?: ResearchSourceServiceClient;
	policy?: ResearchProviderPolicy;
	minStartIntervalMs?: number;
	runtimePolicy?: (request: ResearchSearchRequest) => ResearchProviderRuntimePolicy;
}

export interface BuiltInFastApiRuntimePolicyOptions {
	sourceId: string;
	env: Record<string, string | undefined>;
	maxConcurrency?: number;
	minIntervalMs?: number;
}

export function fastApiResearchProvider(options: FastApiResearchProviderOptions): ResearchSearchProvider {
	const client = options.client ?? getResearchSourceServiceClient();
	const serviceSourceId = options.serviceSourceId ?? options.id;
	const policy = options.policy ?? { maxConcurrency: 1, minIntervalMs: 0 };
	return {
		id: options.id,
		policy,
		runtimePolicy: options.runtimePolicy ?? (() => ({
			accessScope: `fastapi:${serviceSourceId}`,
			maxConcurrency: policy.maxConcurrency,
			minIntervalMs: options.minStartIntervalMs ?? policy.minIntervalMs,
		})),
		async search(request, credentials) {
			return await client.search(serviceSourceId, request, credentials?.credential);
		},
	};
}

/**
 * arXiv、HuggingFace 与 GitHub 的检索结果按天稳定：论文一经发布不再变，模型卡与
 * 仓库元数据的变动以天计。原本 HuggingFace 15 分钟、GitHub 10 分钟，而一次调研本身
 * 就要二十分钟以上，失败重试往往隔更久——同一个主题重跑时缓存必然已经全部过期，
 * 等于每次都重新付一遍网络往返。
 *
 * 这里只覆盖纯检索操作。会往工作区写文件的获取类操作另有排除（见各分支的
 * ...MaterializesWorkspace 判断），它们走内容寻址的素材缓存而不是这里。
 */
const DAILY_SOURCE_CACHE_TTL_MS = 24 * 60 * 60_000;

export function builtInFastApiRuntimePolicy(
	options: BuiltInFastApiRuntimePolicyOptions,
): (request: ResearchSearchRequest) => ResearchProviderRuntimePolicy {
	const maxConcurrency = options.maxConcurrency ?? 1;
	const minIntervalMs = options.minIntervalMs ?? 0;
	return (request) => {
		// Resolved per request, and managed values outrank the ambient environment: unified settings
		// are the authority, and an activated rotation has to move this identity in the same step it
		// changes what the Source Service authenticates with. A Run that started earlier keeps its
		// Provider selection either way; only the credential it presents follows the user's decision.
		const capture = captureSearchCredential(options.sourceId, options.env);
		const env = capture.env;
		// A scope may only claim a credential this request actually states. When the entry point
		// leaves a source to a separately hosted service, nothing here knows what answered, so the
		// request stays unscoped and uncached rather than filed under a local value.
		const identityEnv = Object.fromEntries(
			Object.entries(capture.credential ?? {}).map(([name, value]) => [name, value ?? undefined]),
		);
		const base = {
			// Captured with the scopes below and handed to the Provider unchanged, so an activation
			// that lands while this request is queued can neither change what answers it nor leave
			// the answer filed under a scope naming a different credential.
			credential: capture.credential,
			maxConcurrency,
			minIntervalMs,
			maxAttempts: options.sourceId === "arxiv" ? 1 : options.sourceId === "huggingface" ? 4 : 3,
			...(options.sourceId === "arxiv" ? {
				overloadCooldownMs: 15 * 60_000,
				overloadBudgetWindowMs: 15 * 60_000,
				// arXiv throttles per client for minutes: a Child gives up instead of waiting month by month.
				overloadBudgetMs: 60_000,
			} : {}),
		};
		if (options.sourceId === "user_documents") {
			return { ...base, accessScope: "fastapi:user_documents" };
		}
		if (options.sourceId === "arxiv") {
			const parameters = parseArxivProviderRequest(
				request.providerRequest,
			);
			return {
				...base,
				accessScope: "fastapi:arxiv:public",
				...("arxiv_id" in parameters ? {} : {
					cacheScope: "fastapi:arxiv:public",
					cacheKey: canonicalArxivQuery({
						...parameters,
						max_results: Math.min(parameters.max_results ?? request.maxResults, request.maxResults),
					}),
					cacheTtlMs: DAILY_SOURCE_CACHE_TTL_MS,
				}),
			};
		}
		if (options.sourceId === "huggingface") {
			const identity = credentialIdentity(identityEnv, searchCredentialAliasGroups(options.sourceId));
			const scope = authenticatedOrAnonymousScope(options, identity, env);
			const parsed = parseHuggingFaceProviderRequest(
				request.providerRequest,
				request.query,
				request.maxResults,
			);
			return {
				...base,
				accessScope: scope.access,
				...(scope.cache && !huggingFaceOperationMaterializesWorkspace(parsed.operation) ? {
					cacheScope: scope.cache,
					cacheKey: canonicalHuggingFaceQuery(parsed),
					cacheTtlMs: DAILY_SOURCE_CACHE_TTL_MS,
				} : {}),
			};
		}
		if (options.sourceId === "twitter") {
			const identity = twitterIdentity(identityEnv);
			const accessScope = `fastapi:twitter:${identity ?? "unscoped"}`;
			const parsed = parseTwitterProviderRequest(
				request.providerRequest,
				request.query,
				request.maxResults,
			);
			return {
				...base,
				accessScope,
				...(identity ? {
					cacheScope: accessScope,
					cacheKey: canonicalTwitterQuery(parsed),
					cacheTtlMs: 2 * 60_000,
				} : {}),
			};
		}
		if (options.sourceId === "github") {
			const identity = credentialIdentity(identityEnv, searchCredentialAliasGroups(options.sourceId));
			const scope = authenticatedOrAnonymousScope(options, identity, env);
			const parsed = parseGitHubProviderRequest(
				request.providerRequest,
				request.query,
				request.maxResults,
			);
			return {
				...base,
				accessScope: scope.access,
				...(scope.cache && !githubOperationMaterializesWorkspace(parsed.operation) ? {
					cacheScope: scope.cache,
					cacheKey: canonicalGitHubQuery(parsed),
					cacheTtlMs: DAILY_SOURCE_CACHE_TTL_MS,
				} : {}),
			};
		}
		if (options.sourceId.startsWith("general_web_")) {
			const identity = credentialIdentity(identityEnv, searchCredentialAliasGroups(options.sourceId));
			const accessScope = `fastapi:${options.sourceId}:${identity ?? "unscoped"}`;
			return {
				...base,
				accessScope,
				...(identity ? {
					cacheScope: accessScope,
					cacheKey: {
						implementation: `${options.sourceId}-v3`,
						query: request.query.trim(),
						maxResults: request.maxResults,
					},
					cacheTtlMs: 15 * 60_000,
				} : {}),
			};
		}
		return { ...base, accessScope: `fastapi:${options.sourceId}` };
	};
}

function authenticatedOrAnonymousScope(
	options: BuiltInFastApiRuntimePolicyOptions,
	identity: string | undefined,
	env: Record<string, string | undefined>,
): { access: string; cache?: string } {
	if (identity) {
		const scope = `fastapi:${options.sourceId}:${identity}`;
		return { access: scope, cache: scope };
	}
	const remoteService = env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim();
	const access = `fastapi:${options.sourceId}:${remoteService ? credentialHash([remoteService]) : "anonymous"}`;
	return remoteService ? { access } : { access, cache: access };
}

/** A service-side file is mutable outside the request snapshot, so it cannot name a cache revision. */
function twitterIdentity(env: Record<string, string | undefined>): string | undefined {
	if (env.SOURCE_SERVICE_TWITTER_COOKIE_FILE) return undefined;
	return credentialIdentity(env, searchCredentialAliasGroups("twitter"));
}

function credentialIdentity(
	env: Record<string, string | undefined>,
	aliasGroups: string[][],
): string | undefined {
	const values = aliasGroups
		.map((aliases) => firstEnvValue(env, aliases))
		.filter((value): value is string => Boolean(value));
	return values.length > 0 ? credentialHash(values) : undefined;
}

function credentialHash(values: readonly string[]): string {
	const hash = createSha256();
	for (const value of values) {
		hash.update(String(Buffer.byteLength(value)));
		hash.update("\0");
		hash.update(value);
		hash.update("\0");
	}
	return hash.digest("hex");
}
