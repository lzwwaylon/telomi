import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { SOURCE_DESCRIPTORS } from "../../server/providers/source-descriptors.js";
import { resolveWorkerPythonTool } from "../../server/research/provider-sdk-assets.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpResearchSourceServiceClient, ResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import { ResearchNodeError, retryDecision } from "../../server/agent-runtime/retry-policy.js";
import {
	ResearchSourceRegistry,
	builtInFastApiRuntimePolicy,
	canonicalArxivQuery,
	canonicalHuggingFaceQuery,
	canonicalTwitterQuery,
	canonicalYouTubeQuery,
	createResearchSourceRegistry,
	fastApiResearchProvider,
	parseArxivProviderRequest,
	parseGitHubProviderRequest,
	parseHuggingFaceProviderRequest,
	parseTwitterProviderRequest,
	parseYouTubeProviderRequest,
	validateArxivQueryParameters,
} from "../../server/research/index.js";
import { writeStoredCredential } from "../../server/accounts/stored-credentials.js";
import { resolveAgentPath } from "../../server/config/agent-directory.js";
import { SEARCH_AUTH_FILE } from "../../server/providers/search-credentials.js";
import { loadProjectEnvironment } from "../../server/config/environment.js";
import { materializeProviderSdkAssets } from "../../server/research/provider-sdk-assets.js";
import type { ResearchProviderRequest, ResearchSearchRequest } from "../../server/providers/search-types.js";

const root = mkdtempSync(join(tmpdir(), "telomi-research-sources-"));
const pythonToolsRoot = fileURLToPath(new URL(
	"../../server/research/python-tools",
	import.meta.url,
));
const projectPython = fileURLToPath(new URL(
	"../../services/research-source-service/.venv/bin/python",
	import.meta.url,
));

const providerRequest = (operation: string, parameters: Record<string, unknown>): ResearchProviderRequest =>
	({ operation, parameters });

function request(query: string, signal = new AbortController().signal): ResearchSearchRequest {
	return {
		query,
		maxResults: 5,
		criterionIds: ["C1"],
		purpose: "test",
		signal,
		workspaceDir: root,
	};
}

// The credential scope checks below write and delete managed search credentials. Point the agent
// directory at this test's own scratch space so they never touch a real `search-auth.json`.
const previousAgentDirForFile = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "isolated-agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
try {
	const envRoot = join(root, "env-loader");
	mkdirSync(envRoot, { recursive: true });
	writeFileSync(join(envRoot, ".env"), "TAVILY_API_KEY=base-key\nEXA_API_KEY=base-exa\n", "utf-8");
	writeFileSync(join(envRoot, ".env.local"), "TAVILY_API_KEY='local-key'\nEXA_API_KEY=local-exa\n", "utf-8");
	const isolatedEnv: Record<string, string | undefined> = { EXA_API_KEY: "parent-exa" };
	assert.deepEqual(loadProjectEnvironment(envRoot, isolatedEnv).sort(), ["TAVILY_API_KEY"]);
	assert.equal(isolatedEnv.TAVILY_API_KEY, "local-key");
	assert.equal(isolatedEnv.EXA_API_KEY, "parent-exa");

	const registry = createResearchSourceRegistry(process.env);
	assert.deepEqual(registry.ids().sort(), [
		"arxiv", "browser", "general_web", "github", "huggingface", "twitter", "user_documents", "youtube",
	]);
	// The registry is the descriptor list: every non general-web descriptor registers under its
	// Provider id, and every Python-backed Provider ships the SDK module it names.
	assert.deepEqual(
		registry.ids().sort(),
		[...new Set(SOURCE_DESCRIPTORS.map((source) => source.provider.id.startsWith("general_web_") ? "general_web" : source.provider.id))].sort(),
	);
	for (const source of registry.catalog()) {
		if (source.workerPython) assert.equal(resolveWorkerPythonTool(source).module, source.workerPython.module);
	}
	const browserRegistry = createResearchSourceRegistry({ TELOMI_BROWSER_PROVIDER_ENABLED: "0" });
	assert.deepEqual(browserRegistry.catalog().find((entry) => entry.id === "browser")?.workerTool, {
		name: "browser",
		skill: "prime-browser-provider-skill",
		tools: ["browser", "materialize_source"],
	});
	assert.deepEqual(browserRegistry.catalog().find((entry) => entry.id === "browser")?.workerSkills,
		["prime-browser-provider-skill"]);
	assert.ok(registry.catalog().every((entry) => entry.implementationVersion && entry.capability));
	assert.ok(
		registry.ids().filter((id) => id !== "browser").every((id) => registry.get(id)?.runtimePolicy),
		"every SDK-backed Provider must declare its Host Runtime policy; Browser uses its session registry",
	);
	const arxivRuntimePolicy = builtInFastApiRuntimePolicy({
		sourceId: "arxiv",
		env: {},
		minIntervalMs: 4_000,
	})({
		...request("unused"),
		providerRequest: providerRequest("query", { search_query: "all:test", max_results: 5 }),
	});
	assert.equal(arxivRuntimePolicy.accessScope, "fastapi:arxiv:public");
	assert.equal(arxivRuntimePolicy.cacheScope, "fastapi:arxiv:public");
	assert.equal(arxivRuntimePolicy.minIntervalMs, 4_000);
	assert.equal(arxivRuntimePolicy.maxAttempts, 1);
	assert.equal(arxivRuntimePolicy.overloadCooldownMs, 15 * 60_000);
	assert.equal(arxivRuntimePolicy.overloadBudgetWindowMs, 15 * 60_000);
	assert.equal(arxivRuntimePolicy.overloadBudgetMs, 60_000);
	assert.ok(arxivRuntimePolicy.cacheTtlMs);

	const githubToken = "github-secret";
	const githubPolicy = builtInFastApiRuntimePolicy({
		sourceId: "github",
		env: { GITHUB_TOKEN: githubToken },
	})({
		...request("agent runtime"),
		providerRequest: providerRequest("search_repositories", { query: "agent runtime", limit: 5 }),
	});
	const otherGithubPolicy = builtInFastApiRuntimePolicy({
		sourceId: "github",
		env: { GITHUB_TOKEN: "different-secret" },
	})({
		...request("agent runtime"),
		providerRequest: providerRequest("search_repositories", { query: "agent runtime", limit: 5 }),
	});
	assert.ok(githubPolicy.cacheScope);
	assert.notEqual(githubPolicy.cacheScope, otherGithubPolicy.cacheScope);
	assert.doesNotMatch(githubPolicy.cacheScope ?? "", /github-secret/);

	const huggingFacePolicy = builtInFastApiRuntimePolicy({
		sourceId: "huggingface",
		env: { HF_TOKEN: "hf-secret" },
	})({
		...request("unused"),
		providerRequest: providerRequest("models_list", {
			search: "retrieval",
			limit: 5,
		}),
	});
	assert.ok(huggingFacePolicy.cacheScope);
	assert.match(String(huggingFacePolicy.cacheKey), /^huggingface:models_list:/);
	const huggingFaceModelCardPolicy = builtInFastApiRuntimePolicy({
		sourceId: "huggingface",
		env: {},
	})({
		...request("unused"),
		providerRequest: providerRequest("models_card", {
			repo_id: "openai/whisper-large-v3",
		}),
	});
	assert.equal(huggingFaceModelCardPolicy.cacheKey, undefined);

	const twitterUnscopedPolicy = builtInFastApiRuntimePolicy({
		sourceId: "twitter",
		env: {},
	})({
		...request("unused"),
		providerRequest: providerRequest("search", {
			query: "agent",
			product: "latest",
			limit: 5,
		}),
	});
	assert.equal(twitterUnscopedPolicy.cacheScope, undefined);
	const twitterScopedPolicy = builtInFastApiRuntimePolicy({
		sourceId: "twitter",
		env: { TWITTER_COOKIE: "account-cookie" },
	})({
		...request("unused"),
		providerRequest: providerRequest("search", {
			query: "agent",
			product: "latest",
			limit: 5,
		}),
	});
	assert.ok(twitterScopedPolicy.cacheScope);
	assert.doesNotMatch(twitterScopedPolicy.cacheScope ?? "", /account-cookie/);

	const webPolicy = builtInFastApiRuntimePolicy({
		sourceId: "general_web_tavily",
		env: { TAVILY_API_KEY: "tavily-secret" },
	})(request("current agent research"));
	assert.ok(webPolicy.cacheScope);
	assert.doesNotMatch(webPolicy.cacheScope ?? "", /tavily-secret/);
	assert.deepEqual(webPolicy.cacheKey, {
		implementation: "general_web_tavily-v3",
		query: "current agent research",
		maxResults: 5,
	});
	assert.equal(
		builtInFastApiRuntimePolicy({ sourceId: "user_documents", env: {} })(request("notes")).cacheScope,
		undefined,
	);

	// Unified settings own search credentials, so the identity a request is scoped by must come from
	// the same value the Source Service authenticates with rather than from whatever `.env*` left in
	// the ambient environment. Resolving it per request is what lets an activated rotation move the
	// cache scope in the same step it changes the credential in use.
	// Both the canonical variable and the legacy alias are present, which is what a `.env*` left over
	// from before the unified entry point actually looks like.
	const staleEnv = {
		SOURCE_SERVICE_TAVILY_API_KEY: "stale-environment-key",
		TAVILY_API_KEY: "stale-legacy-key",
	};
	const ambientScope = builtInFastApiRuntimePolicy({ sourceId: "general_web_tavily", env: staleEnv })(
		request("current agent research"),
	).cacheScope;
	writeStoredCredential(resolveAgentPath(SEARCH_AUTH_FILE), "tavily_api_key", {
		type: "api_key",
		key: "managed-tavily-key",
	});
	const managedScope = builtInFastApiRuntimePolicy({ sourceId: "general_web_tavily", env: staleEnv })(
		request("current agent research"),
	).cacheScope;
	assert.notEqual(managedScope, ambientScope, "a managed credential outranks the ambient environment");
	assert.equal(
		builtInFastApiRuntimePolicy({ sourceId: "general_web_tavily", env: {} })(request("current agent research")).cacheScope,
		managedScope,
		"the managed credential alone decides the scope",
	);
	assert.doesNotMatch(managedScope ?? "", /managed-tavily-key/u);
	// A request is answered with the credential its scope was derived from, even when the
	// configuration changes while it waits in the Provider queue. The Runtime states that one
	// capture on the request instead of letting the service answer from settings it cached, so a
	// result can never be filed under a cache scope naming a different credential.
	const requestedCredentials: Array<Record<string, string | null> | undefined> = [];
	const tavilyProvider = fastApiResearchProvider({
		id: "general_web",
		serviceSourceId: "general_web_tavily",
		client: {
			async search(_sourceId, _searchRequest, credential) {
				requestedCredentials.push(credential);
				return [];
			},
		},
		runtimePolicy: builtInFastApiRuntimePolicy({ sourceId: "general_web_tavily", env: {} }),
	});
	const storeKey = (value: string | null) =>
		writeStoredCredential(resolveAgentPath(SEARCH_AUTH_FILE), "tavily_api_key",
			value === null ? null : { type: "api_key", key: value });
	storeKey("first-tavily-key");
	const inFlight = tavilyProvider.runtimePolicy!(request("current agent research"));
	storeKey("second-tavily-key");
	await tavilyProvider.search(request("current agent research"), { credential: inFlight.credential });
	assert.deepEqual(
		requestedCredentials,
		[{ SOURCE_SERVICE_TAVILY_API_KEY: "first-tavily-key" }],
		"a request already dispatched is answered with the credential it was scoped by",
	);
	const afterRotation = tavilyProvider.runtimePolicy!(request("current agent research"));
	assert.deepEqual(afterRotation.credential, { SOURCE_SERVICE_TAVILY_API_KEY: "second-tavily-key" });
	assert.notEqual(afterRotation.cacheScope, inFlight.cacheScope, "the rotation moves the cache scope with it");
	// A deleted credential is stated as absent rather than omitted, so a long-lived service cannot
	// answer from a key the user removed.
	storeKey(null);
	assert.deepEqual(
		tavilyProvider.runtimePolicy!(request("current agent research")).credential,
		{ SOURCE_SERVICE_TAVILY_API_KEY: null },
	);
	assert.equal(
		builtInFastApiRuntimePolicy({ sourceId: "general_web_tavily", env: staleEnv })(request("current agent research")).cacheScope,
		ambientScope,
		"without a managed credential the ambient environment still scopes the request",
	);
	// A separately hosted Source Service owns its own credentials; the local entry point leaves it alone.
	assert.equal(
		builtInFastApiRuntimePolicy({
			sourceId: "general_web_tavily",
			env: { TELOMI_RESEARCH_SOURCE_BASE_URL: "http://127.0.0.1:9/remote" },
		})(request("current agent research")).credential,
		undefined,
	);
	const generalWebCatalog = registry.catalog().find((entry) => entry.id === "general_web");
	assert.ok(generalWebCatalog);
	assert.equal(generalWebCatalog?.implementationVersion, "general-web-firecrawl-v2");
	assert.match(generalWebCatalog?.capability ?? "", /through firecrawl/u);
	assert.equal(generalWebCatalog?.workerPython, undefined);
	const arxivCatalog = registry.catalog().find((entry) => entry.id === "arxiv");
	assert.equal(arxivCatalog?.implementationVersion, "arxiv-fastapi-atom-html-document-runtime-v5");
	assert.equal(arxivCatalog?.queryContract?.input, "provider_syntax");
	assert.deepEqual(arxivCatalog?.workerPython, { module: "tools.arxiv", files: ["links.py"] });
	assert.deepEqual(arxivCatalog?.workerSkills, ["prime-arxiv-selection-skill"]);
	const huggingFaceCatalog = registry.catalog().find((entry) => entry.id === "huggingface");
	assert.equal(huggingFaceCatalog?.implementationVersion, "huggingface-hub-http-v5");
	assert.equal(huggingFaceCatalog?.queryContract?.input, "provider_syntax");
	assert.deepEqual(huggingFaceCatalog?.workerPython, { module: "tools.huggingface" });
	assert.deepEqual(huggingFaceCatalog?.workerSkills, ["prime-huggingface-selection-skill"]);
	assert.ok(huggingFaceCatalog?.supportedFields?.includes("submitted_at"));
	assert.match(
		JSON.stringify(huggingFaceCatalog?.queryContract?.instructions),
		/assignment's deterministic feed and time boundary/iu,
	);
	const twitterCatalog = registry.catalog().find((entry) => entry.id === "twitter");
	assert.equal(twitterCatalog?.implementationVersion, "twitter-web-session-graphql-v1");
	assert.equal(twitterCatalog?.queryContract?.input, "provider_syntax");
	assert.equal(twitterCatalog?.credentialRequirement, "required");
	assert.deepEqual(twitterCatalog?.workerPython, { module: "tools.twitter" });
	assert.deepEqual(twitterCatalog?.workerSkills, ["prime-twitter-provider-skill"]);
	assert.deepEqual(twitterCatalog?.operations, [
		"search", "profile", "tweets", "thread", "article", "timeline", "following",
		"followers", "likes", "bookmarks",
		"lists", "list_tweets", "device_follow", "notifications", "trending", "media",
	]);
	const youtubeCatalog = registry.catalog().find((entry) => entry.id === "youtube");
	assert.equal(youtubeCatalog?.implementationVersion, "youtube-provider-v5");
	assert.equal(youtubeCatalog?.queryContract?.input, "provider_syntax");
	assert.equal(youtubeCatalog?.credentialRequirement, "required");
	assert.deepEqual(youtubeCatalog?.workerPython, { module: "tools.youtube" });
	assert.deepEqual(youtubeCatalog?.workerSkills, ["prime-youtube-provider-skill"]);
	assert.deepEqual(youtubeCatalog?.operations, [
		"capabilities", "list_subscriptions", "list_subscription_uploads",
		"list_channel_videos", "list_playlist_videos", "search_videos",
		"get_video", "get_transcript", "snapshot_home_recommendations",
		"list_watch_later", "list_history",
	]);
	const githubCatalog = registry.catalog().find((entry) => entry.id === "github");
	assert.deepEqual(githubCatalog?.workerPython, { module: "tools.github" });
	assert.deepEqual(githubCatalog?.workerSkills, ["prime-github-selection-skill"]);
	assert.deepEqual(githubCatalog?.operations, [
		"search_topics", "search_repositories", "get_repository", "search_code", "search_issues",
		"get_issue", "clone_repository", "download_release", "download_file",
	]);
	assert.doesNotMatch(JSON.stringify(registry.catalog()), /\bCLI\b|arxiv -h|gh search/i);

	const generalWebWorkspace = join(root, "general-web-worker");
	mkdirSync(generalWebWorkspace, { recursive: true });
	assert.throws(() => materializeProviderSdkAssets(generalWebWorkspace, generalWebCatalog, []),
		/does not have a dedicated Prime Search Python interface/);

	assert.ok(githubCatalog);
	assert.deepEqual(parseGitHubProviderRequest(
		providerRequest("search_topics", { query: "text-to-speech", curated_only: true, limit: 20 }),
		"unused",
		20,
	), {
		operation: "search_topics",
		parameters: { query: "text-to-speech", curated_only: true, limit: 20 },
	});
	assert.deepEqual(parseGitHubProviderRequest(
		providerRequest("search_repositories", {
			query: "",
			topics: ["text-to-speech"],
			language: "Python",
			min_stars: 500,
			created_after: "2026-01-01",
			created_before: "2026-08-31",
			pushed_after: "2026-07-01",
			sort: "updated",
			order: "asc",
			limit: 5,
		}),
		"unused",
		5,
	), {
		operation: "search_repositories",
		parameters: {
			query: "",
			topics: ["text-to-speech"],
			language: "Python",
			min_stars: 500,
			created_after: "2026-01-01",
			created_before: "2026-08-31",
			pushed_after: "2026-07-01",
			sort: "updated",
			order: "asc",
			limit: 5,
		},
	});
	assert.deepEqual(parseGitHubProviderRequest(
		providerRequest("search_issues", {
			query: "connection reset",
			repository: "owner/repo",
			match: "comments",
			state: "all",
			limit: 25,
		}),
		"unused",
		25,
	), {
		operation: "search_issues",
		parameters: {
			query: "connection reset",
			repository: "owner/repo",
			match: "comments",
			state: "all",
			limit: 25,
		},
	});
	assert.throws(() => parseGitHubProviderRequest(
		providerRequest("download_file", {
			repository: "owner/repo",
			path: "../secret",
		}),
		"unused",
		1,
	), /relative repository path/);
	const githubWorkspace = join(root, "github-worker");
	mkdirSync(githubWorkspace, { recursive: true });
	materializeProviderSdkAssets(githubWorkspace, githubCatalog);
	assert.ok(existsSync(join(githubWorkspace, "tools", "github.py")));
	const githubToolsReadme = readFileSync(join(githubWorkspace, "tools", "README.md"), "utf-8");
	assert.match(githubToolsReadme, /^## github$/mu);
	assert.doesNotMatch(githubToolsReadme, /^## arxiv$/mu);

	assert.ok(arxivCatalog);
	const arxivWorkspace = join(root, "arxiv-worker");
	mkdirSync(arxivWorkspace, { recursive: true });
	materializeProviderSdkAssets(arxivWorkspace, arxivCatalog);
	assert.ok(existsSync(join(arxivWorkspace, "tools", "arxiv.py")));
	assert.ok(existsSync(join(arxivWorkspace, "tools", "links.py")));
	assert.equal(existsSync(join(arxivWorkspace, "tools", "document.py")), false);
	assert.equal(existsSync(join(arxivWorkspace, "tools", "examples", "search_and_parse.py")), false);
	assert.equal(existsSync(join(arxivWorkspace, "tools", "github.py")), false);
	assert.equal(existsSync(join(arxivWorkspace, "tools", "source_config.json")), false);
	assert.equal(
		readFileSync(join(arxivWorkspace, "tools", "arxiv.py"), "utf-8"),
		readFileSync(join(pythonToolsRoot, "tools", "arxiv.py"), "utf-8"),
		"arXiv SDK must be copied from the standalone Python package",
	);
	assert.equal(
		readFileSync(join(arxivWorkspace, "research_runtime.py"), "utf-8"),
		readFileSync(join(pythonToolsRoot, "research_runtime.py"), "utf-8"),
	);
	assert.match(readFileSync(join(arxivWorkspace, "research_runtime.py"), "utf-8"), /_post\("\/v1\/search"/u);
	assert.doesNotMatch(
		readFileSync(join(arxivWorkspace, "research_runtime.py"), "utf-8"),
		/\/v1\/sources\/search|\/v1\/browser\/publish/u,
	);
	const readme = readFileSync(join(arxivWorkspace, "tools", "README.md"), "utf-8");
	assert.match(readme, /## arxiv/u);
	assert.match(readme, /arxiv\.search\(query/u);
	assert.doesNotMatch(readme, /## huggingface/u);
	const arxivHelp = execFileSync(
		projectPython,
		[join(arxivWorkspace, "tools", "arxiv.py"), "--help"],
		{ encoding: "utf-8", env: { ...process.env, PYTHONPATH: arxivWorkspace } },
	);
	assert.match(arxivHelp, /return list\[Paper\]/);

	assert.ok(huggingFaceCatalog);
	const huggingFaceWorkspace = join(root, "huggingface-worker");
	mkdirSync(huggingFaceWorkspace, { recursive: true });
	materializeProviderSdkAssets(huggingFaceWorkspace, huggingFaceCatalog);
	assert.ok(existsSync(join(huggingFaceWorkspace, "tools", "huggingface.py")));
	assert.equal(existsSync(join(huggingFaceWorkspace, "tools", "document.py")), false);
	assert.equal(existsSync(join(huggingFaceWorkspace, "tools", "arxiv.py")), false);
	assert.equal(
		readFileSync(join(huggingFaceWorkspace, "tools", "huggingface.py"), "utf-8"),
		readFileSync(join(pythonToolsRoot, "tools", "huggingface.py"), "utf-8"),
		"Hugging Face SDK must be copied from the standalone Python package",
	);
	const huggingFaceHelp = execFileSync(
		projectPython,
		[join(huggingFaceWorkspace, "tools", "huggingface.py"), "--help"],
		{ encoding: "utf-8", env: { ...process.env, PYTHONPATH: huggingFaceWorkspace } },
	);
	assert.match(huggingFaceHelp, /return list\[HuggingFaceRecord\]/);
	assert.ok(twitterCatalog);
	const userDocumentsCatalog = registry.catalog().find((entry) => entry.id === "user_documents");
	assert.ok(userDocumentsCatalog);
	assert.deepEqual(userDocumentsCatalog.workerSkills, ["prime-user-documents-provider-skill"]);
	const twitterWorkspace = join(root, "twitter-worker");
	mkdirSync(twitterWorkspace, { recursive: true });
	materializeProviderSdkAssets(twitterWorkspace, twitterCatalog);
	assert.ok(existsSync(join(twitterWorkspace, "tools", "twitter.py")));
	assert.equal(existsSync(join(twitterWorkspace, "tools", "document.py")), false);
	assert.equal(existsSync(join(twitterWorkspace, "tools", "arxiv.py")), false);
	assert.equal(existsSync(join(twitterWorkspace, "tools", "huggingface.py")), false);
	assert.equal(
		readFileSync(join(twitterWorkspace, "tools", "twitter.py"), "utf-8"),
		readFileSync(join(pythonToolsRoot, "tools", "twitter.py"), "utf-8"),
		"Twitter SDK must be copied from the standalone Python package",
	);
	const twitterReadme = readFileSync(join(twitterWorkspace, "tools", "README.md"), "utf-8");
	assert.match(twitterReadme, /## twitter/u);
	assert.doesNotMatch(twitterReadme, /## arxiv|## huggingface/u);
	const twitterHelp = execFileSync(
		projectPython,
		[join(twitterWorkspace, "tools", "twitter.py"), "--help"],
		{ encoding: "utf-8", env: { ...process.env, PYTHONPATH: twitterWorkspace } },
	);
	assert.match(twitterHelp, /Every operation is read-only/u);
	const userDocumentsWorkspace = join(root, "user-documents-worker");
	mkdirSync(userDocumentsWorkspace, { recursive: true });
	materializeProviderSdkAssets(userDocumentsWorkspace, userDocumentsCatalog);
	assert.ok(existsSync(join(userDocumentsWorkspace, "tools", "user_documents.py")));

	assert.ok(youtubeCatalog);
	const youtubeWorkspace = join(root, "youtube-worker");
	mkdirSync(youtubeWorkspace, { recursive: true });
	materializeProviderSdkAssets(youtubeWorkspace, youtubeCatalog);
	assert.ok(existsSync(join(youtubeWorkspace, "tools", "youtube.py")));
	assert.equal(existsSync(join(youtubeWorkspace, "tools", "document.py")), false);
	assert.equal(existsSync(join(youtubeWorkspace, "tools", "arxiv.py")), false);
	assert.equal(existsSync(join(youtubeWorkspace, "tools", "twitter.py")), false);
	assert.equal(
		readFileSync(join(youtubeWorkspace, "tools", "youtube.py"), "utf-8"),
		readFileSync(join(pythonToolsRoot, "tools", "youtube.py"), "utf-8"),
		"YouTube SDK must be copied from the standalone Python package",
	);
	const youtubeReadme = readFileSync(join(youtubeWorkspace, "tools", "README.md"), "utf-8");
	assert.match(youtubeReadme, /## youtube/u);
	assert.doesNotMatch(youtubeReadme, /## arxiv|## huggingface|## twitter/u);
	const youtubeHelp = execFileSync(
		projectPython,
		[join(youtubeWorkspace, "tools", "youtube.py"), "--help"],
		{ encoding: "utf-8", env: { ...process.env, PYTHONPATH: youtubeWorkspace } },
	);
	assert.match(youtubeHelp, /Local browser cookies, yt-dlp, STT, artifacts/u);

	const native = validateArxivQueryParameters({
		search_query: "ti:\"agent skill\"",
		start: 20,
		max_results: 50,
		sortBy: "relevance",
		sortOrder: "descending",
		http_method: "auto",
	});
	assert.equal(canonicalArxivQuery(native),
		"search_query=ti%3A%22agent+skill%22&start=20&max_results=50&sortBy=relevance&sortOrder=descending");
	assert.deepEqual(providerRequest("query", { ...native }), { operation: "query", parameters: native });
	assert.deepEqual(
		providerRequest("categories", { search: ["speech", "sound"], max_results: 25 }),
		{ operation: "categories", parameters: { search: ["speech", "sound"], max_results: 25 } },
	);
	assert.deepEqual(
		providerRequest("download_pdf", { arxiv_id: "2401.00001v2" }),
		{ operation: "download_pdf", parameters: { arxiv_id: "2401.00001v2" } },
	);
	assert.deepEqual(
		parseArxivProviderRequest(providerRequest("paper_front", {
			arxiv_id: "2401.00001v2",
			max_bytes: 2_000_000,
		})),
		{ arxiv_id: "2401.00001v2", max_bytes: 2_000_000 },
	);
	const arxivDownloadPolicy = builtInFastApiRuntimePolicy({ sourceId: "arxiv", env: {} })({
		...request("unused"),
		providerRequest: providerRequest("download_pdf", { arxiv_id: "2401.00001v2" }),
	});
	assert.equal(arxivDownloadPolicy.cacheKey, undefined);
	assert.throws(() => validateArxivQueryParameters({ search_query: "all:agent", unsupported: true }),
		/Unsupported arXiv API parameter/);
	assert.throws(() => validateArxivQueryParameters({ search_query: "all:agent", max_results: 51 }),
		/arXiv max_results must be an integer from 1 to 50/);
	const huggingFaceNative = parseHuggingFaceProviderRequest(providerRequest("models_list", {
		search: "retrieval",
		filters: ["transformers"],
		pipeline_tag: "text-to-speech",
		base_model_relation: "base",
		sort: "trending_score",
		limit: 50,
		cursor: "opaque==",
	}), "unused", 50);
	assert.equal(
		canonicalHuggingFaceQuery(huggingFaceNative),
		'huggingface:models_list:{"search":"retrieval","filters":["transformers"],"sort":"trending_score","limit":50,"cursor":"opaque==","pipeline_tag":"text-to-speech","base_model_relation":"base"}',
	);
	assert.deepEqual(
		parseHuggingFaceProviderRequest(providerRequest("model_tags", {
			tag_type: "pipeline_tag",
			search: "speech",
			limit: 50,
		}), "unused", 50),
		{
			operation: "model_tags",
			parameters: { tag_type: "pipeline_tag", search: "speech", limit: 50 },
		},
	);
	assert.throws(
		() => parseHuggingFaceProviderRequest({
			operation: "models_list",
			parameters: { search: "agent", unsupported: true },
		}, "unused", 20),
		/Unsupported Hugging Face models_list parameter/,
	);
	assert.deepEqual(
		parseHuggingFaceProviderRequest(providerRequest("models_info", {
			repo_id: "openai/whisper-large-v3",
			revision: "main",
		}), "unused", 1),
		{
			operation: "models_info",
			parameters: { repo_id: "openai/whisper-large-v3", revision: "main" },
		},
	);
	assert.deepEqual(
		parseHuggingFaceProviderRequest(providerRequest("models_card", {
			repo_id: "openai/whisper-large-v3",
			revision: "main",
		}), "unused", 1),
		{
			operation: "models_card",
			parameters: { repo_id: "openai/whisper-large-v3", revision: "main" },
		},
	);
	assert.deepEqual(
		parseHuggingFaceProviderRequest(providerRequest("papers_download", {
			paper_id: "2607.01234",
		}), "unused", 1),
		{
			operation: "papers_download",
			parameters: { paper_id: "2607.01234" },
		},
	);
	assert.deepEqual(
		parseHuggingFaceProviderRequest(providerRequest("datasets_leaderboard", {
			dataset_id: "SWE-bench/SWE-bench_Verified",
			limit: 5,
		}), "unused", 5),
		{
			operation: "datasets_leaderboard",
			parameters: { dataset_id: "SWE-bench/SWE-bench_Verified", limit: 5 },
		},
	);
	assert.throws(
		() => parseHuggingFaceProviderRequest({
			operation: "spaces_list",
			parameters: { sort: "downloads" },
		}, "unused", 20),
		/Hugging Face spaces_list sort.*created_at.*trending_score/,
	);
	const twitterNative = parseTwitterProviderRequest(providerRequest("search", {
		query: '"agent evaluation" lang:en',
		product: "latest",
		limit: 50,
		cursor: "opaque==",
	}), "unused", 50);
	assert.equal(
		canonicalTwitterQuery(twitterNative),
		'twitter:search:{"query":"\\"agent evaluation\\" lang:en","product":"latest","limit":50,"cursor":"opaque=="}',
	);
	assert.throws(
		() => parseTwitterProviderRequest({
			operation: "search",
			parameters: { query: "agent", mutation: "post" },
		}, "unused", 20),
		/Unsupported Twitter search parameter/,
	);
	for (const operation of ["bookmark_folders", "bookmark_folder"]) {
		assert.throws(
			() => parseTwitterProviderRequest({ operation, parameters: {} }, "unused", 20),
			/Unsupported Twitter operation/,
		);
	}
	const youtubeNative = parseYouTubeProviderRequest(providerRequest(
		"list_subscription_uploads",
		{
			limit: 100,
			published_after: "2026-07-19T00:00:00Z",
			channel_ids: ["UC1234567890123456789012"],
			include_shorts: true,
			include_live: false,
		},
	), "unused", 100);
	assert.equal(
		canonicalYouTubeQuery(youtubeNative),
		'youtube:list_subscription_uploads:{"limit":100,"published_after":"2026-07-19T00:00:00.000Z","channel_ids":["UC1234567890123456789012"],"include_shorts":true,"include_live":false}',
	);
	assert.throws(
		() => parseYouTubeProviderRequest({
			operation: "get_transcript",
			parameters: { video_id: "dQw4w9WgXcQ", unsafe_shell_args: ["--exec"] },
		}, "unused", 1),
		/Unsupported YouTube get_transcript parameter/,
	);

	let active = 0;
	let maxActive = 0;
	let releaseFirst!: () => void;
	const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const scheduled = new ResearchSourceRegistry().register({
		id: "scheduled",
		policy: { maxConcurrency: 1, minIntervalMs: 0 },
		async search(searchRequest) {
			active++;
			maxActive = Math.max(maxActive, active);
			if (searchRequest.query === "first") await blocked;
			active--;
			return [{
				id: searchRequest.query,
				title: searchRequest.query,
				url: `https://example.com/${searchRequest.query}`,
				snippet: "",
			}];
		},
	});
	assert.throws(() => scheduled.catalog(), /research source 'scheduled' has no catalog/u);
	const first = scheduled.search("scheduled", request("first"));
	const abort = new AbortController();
	const second = scheduled.search("scheduled", request("second", abort.signal));
	abort.abort();
	await assert.rejects(second,
		(error: unknown) => error instanceof ResearchNodeError && error.failureClass === "cancelled");
	releaseFirst();
	await first;
	assert.equal(maxActive, 1);

	const requests: Array<{ url: string; init: RequestInit }> = [];
	const client = new HttpResearchSourceServiceClient({
		baseUrl: "http://127.0.0.1:8791",
		token: "runtime-secret",
		fetcher: async (input, init = {}) => {
			requests.push({ url: String(input), init });
			return new Response(JSON.stringify({
				schema_version: 1,
				source_id: "github",
				results: [{
					id: "github-record",
					title: "openai/example",
					url: "https://github.com/openai/example",
					snippet: "Example repository",
					published_at: "2026-01-02T03:04:05Z",
					authors: ["openai"],
					metadata: {
						provider_implementation: "github_rest_repository_search_v1",
						stars: 42,
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		},
	});
	const github = await client.search("github", {
		...request("agent skill repository"),
		temporalRange: { startDate: "2026-01-01", endDate: "2026-07-17" },
	});
	assert.equal(requests[0]?.url, "http://127.0.0.1:8791/v1/search");
	assert.equal((requests[0]?.init.headers as Record<string, string>).authorization, "Bearer runtime-secret");
	const sent = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
	assert.equal(sent.source_id, "github");
	assert.equal(sent.workspace_dir, root);
	assert.deepEqual(sent.temporal_range, { start_date: "2026-01-01", end_date: "2026-07-17" });
	assert.equal(github[0]?.title, "openai/example");
	assert.equal(github[0]?.publishedAt, "2026-01-02T03:04:05Z");

	const citationClient = new HttpResearchSourceServiceClient({
		baseUrl: "http://127.0.0.1:8791",
		token: "runtime-secret",
		fetcher: async (input, init = {}) => {
			assert.equal(String(input), "http://127.0.0.1:8791/v1/citations/validate-urls");
			assert.deepEqual(JSON.parse(String(init.body)), {
				schema_version: 1,
				markdown: "See https://example.com/missing.",
			});
			return new Response(JSON.stringify({
				schema_version: 1,
				unavailable_urls: ["https://example.com/missing"],
			}), { headers: { "content-type": "application/json" } });
		},
	});
	assert.deepEqual(
		[...await citationClient.validateCitationUrls(
			"See https://example.com/missing.",
			new AbortController().signal,
		)],
		["https://example.com/missing"],
	);

	const invalidClient = new HttpResearchSourceServiceClient({
		baseUrl: "http://127.0.0.1:8791",
		fetcher: async () => new Response(JSON.stringify({
			schema_version: 1,
			source_id: "github",
			results: [{ id: "bad", title: "bad", url: "file:///etc/passwd", snippet: "" }],
		}), { headers: { "content-type": "application/json" } }),
	});
	await assert.rejects(invalidClient.search("github", request("bad")),
		(error: unknown) => error instanceof ResearchNodeError && error.failureClass === "validation");

	let permanentCalls = 0;
	const permanentClient = new HttpResearchSourceServiceClient({
		baseUrl: "http://127.0.0.1:8791",
		fetcher: async () => {
			permanentCalls += 1;
			return new Response(JSON.stringify({
				error: {
					code: "missing_credentials",
					failure_class: "permanent",
					message: "Provider credentials are unavailable",
					retryable: false,
				},
			}), { status: 401, headers: { "content-type": "application/json" } });
		},
	});
	await assert.rejects(permanentClient.search("general_web_tavily", request("q")),
		(error: unknown) => error instanceof ResearchNodeError
			&& error.failureClass === "permanent"
			&& !error.retryable);
	assert.equal(permanentCalls, 1, "structured permanent failures must not retry");

	const limitClient = new HttpResearchSourceServiceClient({
		baseUrl: "http://127.0.0.1:8791",
		fetcher: async () => new Response(JSON.stringify({
			error: {
				code: "max_results_exceeded",
				failure_class: "validation",
				message: "max_results cannot exceed the service limit of 100",
				retryable: false,
				details: {
					provided: 200,
					maximum: 100,
					parameter: "max_results",
				},
			},
		}), { status: 400, headers: { "content-type": "application/json" } }),
	});
	await assert.rejects(limitClient.search("arxiv", request("q")),
		(error: unknown) => error instanceof ResearchNodeError
			&& error.code === "max_results_exceeded"
			&& error.failureClass === "validation"
			&& !error.retryable
			&& error.details?.maximum === 100);

	assert.equal(
		retryDecision(new ResearchNodeError("rate limited", "rate_limit", true, { retryAfterMs: 12_000 }), 1, 3).delayMs,
		12_000,
		"Runtime must honor the Source service Retry-After value",
	);
	await assert.rejects(
		new ResearchSourceServiceManager({ TELOMI_RESEARCH_SOURCE_PORT: "invalid" }).ensureReady(),
		/TELOMI_RESEARCH_SOURCE_PORT must be an integer from 1 to 65535/u,
	);

	console.log("FastAPI source adapter and Runtime policy tests passed");
} finally {
	if (previousAgentDirForFile === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirForFile;
	rmSync(root, { recursive: true, force: true });
}

/** Configuration API to the existing Source Service consumer seam, using a local HTTP upstream. */
async function testSearchCredentialConsumers(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "search-consumers-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const { mountSearchCredentialsApi } = await import("../../server/providers/search-credentials-api.js");
	const { importLegacySearchCredentials } = await import("../../server/providers/search-credentials.js");
	const { HttpResearchSourceServiceClient } = await import("../../server/providers/source-service-client.js");
	const { ProviderRuntime } = await import("../../server/research/sources/provider-runtime.js");
	const { fastApiResearchProvider, builtInFastApiRuntimePolicy } = await import("../../server/research/sources/providers/fastapi.js");
	const { createResearchSourceRegistry } = await import("../../server/research/sources/builtin-registry.js");
	const runtime = new ProviderRuntime({ databasePath: join(root, "runtime.sqlite") });
	const env: NodeJS.ProcessEnv = {};
	const app = express();
	app.use(express.json());
	const seen: Array<Record<string, string | null> | undefined> = [];
	let pause: (() => Promise<void>) | undefined;
	app.post("/v1/credentials/verify", (req, res) => {
		if (Object.values(req.body.credential).includes("rejected-key")) {
			res.status(401).json({ error: { message: "invalid rejected-key", retryable: false } });
		} else res.json({ schema_version: 1 });
	});
	app.post("/v1/search", async (req, res) => {
		const credential = req.body.credential as Record<string, string | null> | undefined;
		seen.push(credential);
		if (req.body.query === "upstream failure") {
			res.status(401).json({ error: { code: "invalid_key", message: `Rejected ${credential?.SOURCE_SERVICE_TAVILY_API_KEY}`, details: { key: credential?.SOURCE_SERVICE_TAVILY_API_KEY }, retryable: false } });
			return;
		}
		const wait = pause;
		pause = undefined;
		if (wait) await wait();
		// The upstream exposes an account-specific result, never the credential itself.
		const account = !credential ? "remote-account"
			: Object.values(credential).includes("replacement-key") ? "replacement-account"
			: Object.values(credential).some(Boolean) ? "initial-account" : "anonymous";
		res.json({ schema_version: 1, results: [{ id: account, title: account, url: "https://example.test/result", snippet: "result" }] });
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const client = new HttpResearchSourceServiceClient({ baseUrl });
	mountSearchCredentialsApi(app, { env, sourceService: client });
	async function call(method = "GET", provider = "", values?: Record<string, string>, mode = "apply") {
		const response = await fetch(`${baseUrl}/api/search-credentials${provider ? `/${provider}` : ""}`, {
			method,
			headers: { "content-type": "application/json" },
			...(values ? { body: JSON.stringify({ values, mode }) } : {}),
		});
		return { status: response.status, body: await response.json() };
	}
	function provider(sourceId: string) {
		return { ...fastApiResearchProvider({ id: sourceId, client, runtimePolicy: builtInFastApiRuntimePolicy({ sourceId, env }) }),
			catalog: createResearchSourceRegistry(env, "tavily", runtime).get(sourceId.startsWith("general_web_") ? "general_web" : sourceId)!.catalog };
	}
	const request = (query = "same query") => ({ query, maxResults: 1, criterionIds: [], purpose: "test", signal: new AbortController().signal, workspaceDir: root });
	const search = (sourceId: string, query?: string) => runtime.search(provider(sourceId), {
		...request(query),
		...(sourceId === "twitter" ? { providerRequest: { operation: "search", parameters: { query: query ?? "same query", limit: 1 } } } : {}),
	});
	try {
		env.TELOMI_RESEARCH_SOURCE_BASE_URL = baseUrl;
		env.TAVILY_API_KEY = "ambient-key";
		assert.deepEqual(importLegacySearchCredentials(env), [], "an unmanaged remote service must not adopt local ambient credentials");
		assert.equal((await search("general_web_tavily")).results[0]?.id, "remote-account");
		assert.equal(seen.at(-1), undefined, "wholly unmanaged remote requests omit the override");
		process.env.TELOMI_RESEARCH_SOURCE_BASE_URL = baseUrl;
		delete env.TELOMI_RESEARCH_SOURCE_BASE_URL;
		assert.equal((await search("general_web_tavily", "goal snapshot without service address")).results[0]?.id, "remote-account");
		assert.equal(seen.at(-1), undefined, "Goal env snapshots omit process-level Source Service configuration");
		delete process.env.TELOMI_RESEARCH_SOURCE_BASE_URL;
		env.TELOMI_RESEARCH_SOURCE_BASE_URL = baseUrl;
		assert.equal((await call("PUT", "tavily", { tavily_api_key: "initial-key" }, "pending")).status, 200);
		assert.equal((await search("general_web_tavily")).results[0]?.id, "remote-account", "saving for later cannot take over remote authentication");
		assert.equal((await call("PUT", "tavily", {})).status, 200);
		assert.equal((await search("general_web_tavily")).results[0]?.id, "initial-account");
		assert.equal(seen.at(-1)?.SOURCE_SERVICE_TAVILY_API_KEY, "initial-key");
		assert.equal((await search("general_web_tavily")).cache.status, "hit");

		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { release = resolve; });
		pause = async () => { entered(); await held; };
		const inflight = search("general_web_tavily", "rotation query");
		await started;
		try {
			assert.equal((await call("PUT", "tavily", { tavily_api_key: "replacement-key" })).status, 200);
			assert.equal((await search("general_web_tavily", "rotation query")).results[0]?.id, "replacement-account");
		} finally { release(); }
		assert.equal((await inflight).results[0]?.id, "initial-account", "rotation leaves the dispatched request alone");
		assert.equal((await search("general_web_tavily", "rotation query")).results[0]?.id, "replacement-account", "the late old response cannot poison the new cache revision");
		assert.equal((await call("PUT", "tavily", { tavily_api_key: "rejected-key" })).status, 422);
		assert.equal((await search("general_web_tavily", "after rejection")).results[0]?.id, "replacement-account");
		await assert.rejects(search("general_web_tavily", "upstream failure"), (error: Error) => {
			assert.ok(!JSON.stringify(error).includes("replacement-key"));
			assert.ok(!error.message.includes("replacement-key"));
			return true;
		});
		assert.ok(!JSON.stringify(runtime.recentEvents()).includes("replacement-key"));
		assert.equal((await call("PUT", "tavily", { tavily_api_key: "replacement-key" }, "pending")).status, 200);
		const reapplied = await call("PUT", "tavily", {});
		assert.equal(reapplied.body.providers.find((row: { id: string }) => row.id === "tavily").fields[0].pendingConfigured, false);
		assert.equal((await call("DELETE", "tavily")).status, 200);
		env.TAVILY_API_KEY = "ambient-key";
		assert.deepEqual(importLegacySearchCredentials(env), []);
		assert.equal((await search("general_web_tavily")).results[0]?.id, "anonymous");
		assert.deepEqual(seen.at(-1), { SOURCE_SERVICE_TAVILY_API_KEY: null });

		// The production Prime SDK bridge routes through the same captured Runtime credentials.
		const { startPrimeSourceBridge } = await import("../../server/research/pipeline/prime-search-batch.js");
		const { ResearchSourceRegistry } = await import("../../server/research/sources/registry.js");
		const { readProviderCallRecords } = await import("../../server/providers/provider-call-record.js");
		const artifactWorkspace = join(root, "artifacts");
		const childWorkspace = join(artifactWorkspace, "provider-executions", "sub-child");
		mkdirSync(childWorkspace, { recursive: true });
		const recorder = { runDir: join(root, "run"), nodeId: "prime-search", attemptId: "1" };
		const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(runtime).register(provider("github")), new Set(["github"]), {
			workspaceDirectory: root, temporalContext: { schemaVersion: 1, currentDate: "2026-09-11", timeZone: "Asia/Singapore" },
			signal: new AbortController().signal,
		}, artifactWorkspace, recorder);
		try {
			for (const [key, account] of [["initial-key", "initial-account"], ["replacement-key", "replacement-account"]]) {
				assert.equal((await call("PUT", "github", { github_token: key! })).status, 200);
				const response = await fetch(`${bridge.baseUrl}/v1/search`, {
					method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${primeExecutionToken(bridge.token, "sub-child")}` },
					body: JSON.stringify({ agent_session_id: "sub-child", source_id: "github", query: "bridge query", max_results: 1, workspace_dir: childWorkspace,
						provider_request: { operation: "search_repositories", parameters: { query: "bridge query", limit: 1 } } }),
				});
				assert.equal(response.status, 200);
				assert.equal((await response.json()).results[0].title, account);
				assert.equal(seen.at(-1)?.SOURCE_SERVICE_GITHUB_TOKEN, key);
			}
			const records = JSON.stringify(readProviderCallRecords(recorder.runDir));
			assert.ok(!records.includes("replacement-key") && !records.includes("initial-key"));
		} finally { await bridge.close(); }

		const cookiePath = join(root, "cookies.txt");
		const cookie = '# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tcookie-token\n.x.com\tTRUE\t/\tTRUE\t0\tct0\tcsrf-token';
		writeFileSync(cookiePath, cookie);
		env.X_COOKIE_FILE = cookiePath;
		assert.deepEqual(importLegacySearchCredentials(env), [], "a remote cookie file is not owned by this runtime");
		const external = (await call()).body.providers.find((row: { id: string }) => row.id === "twitter");
		assert.equal(external.fields[0].configured, false);
		assert.equal(external.status, "pending");
		assert.equal((await search("twitter")).results[0]?.id, "remote-account");

		delete env.TELOMI_RESEARCH_SOURCE_BASE_URL;
		env.X_COOKIE_FILE = join(root, "missing-cookies");
		assert.deepEqual(importLegacySearchCredentials(env), []);
		const unreadable = (await call()).body.providers.find((row: { id: string }) => row.id === "twitter");
		assert.equal(unreadable.fields[0].configured, false);
		assert.equal(unreadable.fields[0].provenance, null);
		assert.match(unreadable.fields[0].locationError, /could not be read/);
		env.X_COOKIE_FILE = cookiePath;
		env.TWITTER_BEARER_TOKEN = "bearer-key";
		assert.deepEqual(importLegacySearchCredentials(env), ["twitter_cookie", "twitter_bearer_token"]);
		const imported = (await call()).body.providers.find((row: { id: string }) => row.id === "twitter");
		assert.equal(imported.status, "active");
		assert.equal(imported.fields[0].provenance, "imported");
		assert.equal(imported.fields[0].locationEnv, null);
		await search("twitter");
		assert.deepEqual(seen.at(-1), { SOURCE_SERVICE_TWITTER_COOKIE: cookie, SOURCE_SERVICE_TWITTER_COOKIE_FILE: null, SOURCE_SERVICE_TWITTER_BEARER_TOKEN: "bearer-key" });
		writeFileSync(cookiePath, "changed-after-import");
		assert.deepEqual(importLegacySearchCredentials(env), []);
		assert.equal((await search("twitter")).cache.status, "hit", "file edits do not change a managed cache revision");
		await search("twitter", "uncached query");
		assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_COOKIE, cookie, "file edits do not change the actual credential either");
		// Real store lock failures after verification preserve the previously usable credential set.
		assert.equal((await call("PUT", "twitter", { twitter_cookie: "replacement-key", twitter_bearer_token: "replacement-bearer" }, "pending")).status, 200);
		for (const filename of ["search-auth.json", "search-auth-pending.json"]) {
			// The request waits synchronously for this lock. A separate process must own its
			// refresh timer, otherwise the blocked server loop lets the fixture lock go stale.
			const holder = spawn(process.execPath, ["-e", `
const { lockSync } = require("proper-lockfile");
const unlock = lockSync(process.argv[1], { realpath: false, update: 1000 });
process.once("disconnect", () => { unlock(); });
process.send("locked");
`, join(root, "agent", filename)], {
				cwd: join(import.meta.dirname, "../.."),
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				timeout: 30_000,
				killSignal: "SIGKILL",
			});
			let stderr = "";
			let startupError: Error | undefined;
			holder.stderr!.setEncoding("utf8");
			holder.stderr!.on("data", (chunk: string) => { stderr += chunk; });
			holder.once("error", (error) => { startupError = error; });
			// Node's IPC channel can keep the stdio-level close event pending after a normal exit.
			const exited = new Promise<number | null>((resolve) => {
				holder.once("exit", resolve);
				holder.once("error", () => resolve(null));
			});
			try {
				await new Promise<void>((resolve, reject) => {
					holder.once("message", (message) => message === "locked"
						? resolve() : reject(new Error(`Unexpected lock holder message: ${String(message)}`)));
					holder.once("error", reject);
					holder.once("exit", (code) => reject(new Error(`Lock holder exited before readiness (${code}): ${stderr}`)));
				});
				assert.equal((await call("PUT", "twitter", {})).status, 500);
			} finally {
				if (holder.connected) holder.disconnect();
				const code = await exited;
				assert.equal(startupError, undefined);
				assert.equal(code, 0, `Lock holder must release normally: ${stderr}`);
			}

			await search("twitter", `after ${filename} failure`);
			assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_COOKIE, cookie);
			assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_BEARER_TOKEN, "bearer-key");
		}
		assert.equal((await call("DELETE", "twitter")).status, 200);
		env.X_COOKIE_FILE = cookiePath;
		assert.deepEqual(importLegacySearchCredentials(env), []);
		await search("twitter");
		assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_COOKIE_FILE, null);
		assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_COOKIE, null);
		assert.ok(!JSON.stringify(runtime.recentEvents()).includes("cookie-token"));
		for (const name of Object.keys(env)) delete env[name];
		for (const [index, content] of [
			"auth_token=header-token; ct0=header-csrf",
			JSON.stringify([{ name: "auth_token", value: "json-token", domain: ".x.com" }, { name: "ct0", value: "json-csrf", domain: ".x.com" }]),
		].entries()) {
			process.env.PI_CODING_AGENT_DIR = join(root, `format-${index}`);
			writeFileSync(cookiePath, content);
			env.TELOMI_RESEARCH_SOURCE_SERVICE_DIR = root;
			env.X_COOKIE_FILE = "cookies.txt";
			assert.deepEqual(importLegacySearchCredentials(env), ["twitter_cookie"]);
			await search("twitter", `format ${index}`);
			assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_COOKIE, content, "legacy formats are imported without reinterpretation");
			assert.equal(seen.at(-1)?.SOURCE_SERVICE_TWITTER_COOKIE_FILE, null);
		}
		console.log("Configuration API reaches remote and local search consumers with coherent cache revisions");
	} finally {
		delete process.env.TELOMI_RESEARCH_SOURCE_BASE_URL;
		runtime.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

await testSearchCredentialConsumers();
