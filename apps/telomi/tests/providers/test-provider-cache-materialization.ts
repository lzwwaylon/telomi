/**
 * 会往工作区写文件的 Provider 操作，绝不能进 Provider 缓存。
 *
 * 这类操作把产物写进当前 Run 的工作区，并把绝对路径放进结果。Provider 缓存命中
 * 时原样返回存下来的结果、不重新物化，所以一旦进缓存，后续命中拿到的就是指向
 * 已经被删除的工作区的路径。
 *
 * github / huggingface / arxiv 一直有这道排除，youtube 的 get_transcript 漏了。
 * 这个测试覆盖全部 Provider，避免以后新增操作时再漏。
 */

import assert from "node:assert/strict";

import { builtInFastApiRuntimePolicy } from "../../server/research/sources/providers/fastapi.js";
import { youtubeResearchProvider } from "../../server/research/sources/providers/youtube/index.js";
import type { ResearchSearchRequest } from "../../server/providers/search-types.js";

function request(providerRequest: unknown): ResearchSearchRequest {
	return {
		query: "probe",
		maxResults: 5,
		workspaceDir: "/tmp/pi-provider-cache-probe",
		signal: new AbortController().signal,
		providerRequest,
	} as unknown as ResearchSearchRequest;
}

const env = {
	SOURCE_SERVICE_GITHUB_TOKEN: "probe-token",
	SOURCE_SERVICE_HUGGINGFACE_TOKEN: "probe-token",
	GH_TOKEN: "probe-token",
	HF_TOKEN: "probe-token",
} as NodeJS.ProcessEnv;

const cases: Array<{
	label: string;
	policy: (request: ResearchSearchRequest) => { cacheScope?: string; cacheTtlMs?: number };
	materializing: unknown[];
	searching: unknown[];
	/** 按天稳定的检索源，TTL 必须至少一天：一次调研本身就要二十分钟以上，
	 *  更短的 TTL 会让同一主题重试时缓存必然全部过期。 */
	dailyCache?: boolean;
}> = [
	{
		label: "github",
		policy: builtInFastApiRuntimePolicy({ sourceId: "github", env }),
		materializing: [
			{ operation: "clone_repository", parameters: { repository: "a/b" } },
			{ operation: "download_file", parameters: { repository: "a/b", path: "README.md" } },
			{ operation: "download_release", parameters: { repository: "a/b", tag: "v1.0.0" } },
		],
		searching: [{ operation: "search_repositories", parameters: { query: "kimi", limit: 5 } }],
		dailyCache: true,
	},
	{
		label: "huggingface",
		policy: builtInFastApiRuntimePolicy({ sourceId: "huggingface", env }),
		materializing: [
			{ operation: "models_card", parameters: { repo_id: "a/b" } },
			{ operation: "papers_download", parameters: { paper_id: "2504.18425" } },
		],
		searching: [{ operation: "models_info", parameters: { repo_id: "a/b" } }],
		dailyCache: true,
	},
	{
		label: "arxiv",
		policy: builtInFastApiRuntimePolicy({ sourceId: "arxiv", env }),
		materializing: [{ operation: "download_pdf", parameters: { arxiv_id: "2504.18425v1" } }],
		searching: [{ operation: "query", parameters: { search_query: "all:kimi audio", max_results: 5 } }],
		dailyCache: true,
	},
	{
		label: "youtube",
		policy: youtubeResearchProvider().runtimePolicy!,
		materializing: [{ operation: "get_transcript", parameters: { video_id: "dQw4w9WgXcQ" } }],
		searching: [{ operation: "capabilities", parameters: {} }],
	},
];

let checked = 0;
for (const entry of cases) {
	for (const providerRequest of entry.materializing) {
		const policy = entry.policy(request(providerRequest));
		const operation = (providerRequest as { operation: string }).operation;
		assert.equal(
			policy.cacheScope,
			undefined,
			`${entry.label}.${operation} 会写工作区，不能进 Provider 缓存`,
		);
		checked += 1;
	}
	for (const providerRequest of entry.searching) {
		const policy = entry.policy(request(providerRequest));
		const operation = (providerRequest as { operation: string }).operation;
		assert.ok(
			policy.cacheScope,
			`${entry.label}.${operation} 是纯检索，应当可缓存`,
		);
		if (entry.dailyCache) {
			assert.ok(
				(policy.cacheTtlMs ?? 0) >= 24 * 60 * 60_000,
				`${entry.label}.${operation} 的检索结果按天稳定，TTL 不应短于一天`
					+ `（当前 ${Math.round((policy.cacheTtlMs ?? 0) / 60_000)} 分钟）`,
			);
		}
		checked += 1;
	}
}

console.log(`provider cache materialization: ok (${checked} 个操作)`);
