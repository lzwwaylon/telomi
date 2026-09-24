import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { createResearchSourceRegistry } from "../../server/research/index.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import type { ResearchProviderRequest, ResearchSearchRequest } from "../../server/providers/search-types.js";

const providerRequest = (operation: string, parameters: Record<string, unknown>): ResearchProviderRequest =>
	({ operation, parameters });

const root = mkdtempSync(join(tmpdir(), "telomi-live-source-providers-"));
const workspaceDir = join(root, "goal", "wiki", "runs", "run-1");
const attachmentsDir = join(root, "goal", "attachments");
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });
writeFileSync(
	join(attachmentsDir, "provider-runtime-notes.md"),
	"# Provider Runtime Notes\n\nAgent evaluation methodology must preserve source identity across Goals.",
	"utf-8",
);
const signal = new AbortController().signal;
const request = (query: string, maxResults: number): ResearchSearchRequest => ({
	query,
	maxResults,
	criterionIds: ["live-provider-verification"],
	purpose: "real Research Provider verification",
	signal,
	workspaceDir,
});

try {
	const registry = createResearchSourceRegistry(process.env);
	const configuredWebBackend = process.env.FIRECRAWL_API_KEY
		? "general_web_firecrawl"
		: process.env.TAVILY_API_KEY
			? "general_web_tavily"
			: process.env.EXA_API_KEY
				? "general_web_exa"
				: undefined;
	const generalWeb = configuredWebBackend
		? await registry.search("general_web", request("OpenAI official Agent Skills documentation", 3))
		: [];
	if (configuredWebBackend) {
		assert.ok(generalWeb.length > 0, "at least one configured FastAPI general-web backend must return a real result");
		assert.ok(generalWeb.every((item) => ["firecrawl", "tavily", "exa"].includes(String(item.metadata?.general_web_backend))));
	}

	const githubQuery = "GitHub official open source agent skill evolution repository 2026";
	const github = await registry.search("github", {
		...request(githubQuery, 3),
		providerRequest: providerRequest("search_repositories", {
			query: githubQuery,
			limit: 3,
		}),
	});
	assert.ok(github.length > 0, "FastAPI GitHub gh Source must return at least one real public repository");
	assert.ok(github.every((item) => /^https:\/\/github\.com\//.test(item.url)));
	assert.ok(github.every((item) => item.metadata?.provider_implementation === "github_gh_api_v3"));
	const repository = await registry.search("github", {
		...request("cli/cli", 1),
		providerRequest: providerRequest("get_repository", { repository: "cli/cli" }),
	});
	assert.equal(repository[0]?.metadata?.repository, "cli/cli");
	const code = await registry.search("github", {
		...request("authentication in cli/cli code", 3),
		providerRequest: providerRequest("search_code", {
			query: "authentication",
			repository: "cli/cli",
			limit: 3,
		}),
	});
	assert.ok(code.length > 0, "GitHub code search must return real files");
	assert.ok(code.every((item) => item.metadata?.resource_type === "code"));

	const issueSearchRequest = request("GitHub CLI authentication comments:>0", 5);
	const issues = await registry.search("github", {
		...issueSearchRequest,
		providerRequest: providerRequest("search_issues", {
			query: "authentication comments:>0",
			repository: "cli/cli",
			state: "all",
			match: "comments",
			limit: 5,
		}),
	});
	const issueNumber = Number(issues[0]?.metadata?.issue_number);
	assert.ok(Number.isInteger(issueNumber) && issueNumber > 0, "GitHub issue search must return a real Issue");
	const issueDetails = await registry.search("github", {
		...request(`cli/cli issue ${issueNumber}`, 1),
		providerRequest: providerRequest("get_issue", {
			repository: "cli/cli",
			number: issueNumber,
		}),
	});
	assert.ok(
		Array.isArray(issueDetails[0]?.metadata?.comments)
			&& issueDetails[0].metadata.comments.length > 0,
		"GitHub Issue detail must include real comments",
	);

	const clones = await registry.search("github", {
		...request("clone octocat/Hello-World", 1),
		providerRequest: providerRequest("clone_repository", {
			repository: "octocat/Hello-World",
			full_history: false,
		}),
	});
	const clonePath = String(clones[0]?.metadata?.artifact_path);
	assert.ok(existsSync(join(workspaceDir, clonePath, ".git")), "GitHub clone must materialize a real repository");

	const downloadedFiles = await registry.search("github", {
		...request("download octocat/Hello-World README", 1),
		providerRequest: providerRequest("download_file", {
			repository: "octocat/Hello-World",
			path: "README",
		}),
	});
	const downloadedFilePath = String(downloadedFiles[0]?.metadata?.artifact_path);
	assert.ok(existsSync(join(workspaceDir, downloadedFilePath)), "GitHub file download must materialize a real file");

	const releases = await registry.search("github", {
		...request("download latest cli/cli source archive", 100),
		providerRequest: providerRequest("download_release", {
			repository: "cli/cli",
			archive: "zip",
		}),
	});
	assert.ok(releases.length > 0, "GitHub release download must return a real source archive");
	assert.ok(
		releases.every((item) => existsSync(join(workspaceDir, String(item.metadata?.artifact_path)))),
		"Every GitHub release result must reference a real workspace file",
	);

	const arxivRequest = request("all:skill AND (all:agent OR all:language-model) AND submittedDate:[202601010000 TO 202612312359]", 3);
	const arxiv = await registry.search("arxiv", { ...arxivRequest, providerRequest: providerRequest("query", {
		search_query: arxivRequest.query,
		max_results: 3,
		sortBy: "submittedDate",
		sortOrder: "descending",
	}) });
	assert.ok(arxiv.length > 0, "arXiv must return at least one real paper");
	assert.ok(arxiv.every((item) => typeof item.metadata?.arxiv_id === "string"));
	assert.ok(arxiv.every((item) => Array.isArray(item.authors) && item.authors.length > 0));
	const arxivCategories = await registry.search("arxiv", {
		...request("speech and audio categories", 10),
		providerRequest: providerRequest("categories", { search: ["speech", "audio"], max_results: 10 }),
	});
	assert.ok(arxivCategories.length > 0, "arXiv categories must return the live official taxonomy");
	assert.ok(arxivCategories.every((item) => typeof item.metadata?.category_id === "string"));
	const arxivById = await registry.search("arxiv", {
		...request("2606.11435v1", 1),
		providerRequest: providerRequest("query", { id_list: ["2606.11435v1"], max_results: 1 }),
	});
	assert.equal(arxivById[0]?.metadata?.arxiv_version_id, "2606.11435v1");
	const arxivDocument = await registry.search("arxiv", {
		...request("2608.17492v2", 1),
		providerRequest: providerRequest("download_pdf", { arxiv_id: "2608.17492v2" }),
	});
	const arxivPdfPath = join(workspaceDir, String(arxivDocument[0]?.metadata?.pdf_path));
	const arxivMarkdownPath = join(workspaceDir, String(arxivDocument[0]?.metadata?.markdown_path));
	assert.ok(existsSync(arxivPdfPath), "arXiv download_pdf must preserve the original PDF");
	assert.ok(existsSync(arxivMarkdownPath), "arXiv download_pdf must materialize Markdown");
	assert.ok(existsSync(join(dirname(arxivMarkdownPath), "parser-manifest.json")),
		"arXiv download_pdf must materialize the parser manifest");

	const dailyPapers = await registry.search("huggingface", {
		...request("Hugging Face Daily Papers for 2026-08-04", 3),
		providerRequest: providerRequest("papers_list", {
			date: "2026-08-04",
			sort: "published_at",
			page: 0,
			limit: 3,
		}),
	});
	assert.ok(dailyPapers.length > 0, "Hugging Face must return real Daily Papers");
	assert.ok(
		dailyPapers.every((item) => String(item.metadata?.submitted_at).startsWith("2026-08-04")),
		"Daily Papers must preserve the feed appearance date separately from paper publication time",
	);
	assert.ok(
		dailyPapers.some((item) => item.publishedAt !== item.metadata?.submitted_at),
		"Daily Papers date filtering must not be represented as paper publication filtering",
	);

	const userDocuments = await registry.search(
		"user_documents",
		request("agent evaluation methodology", 3),
	);
	assert.equal(userDocuments.length, 1, "user_documents must return the real attached document");
	assert.equal(userDocuments[0]?.title, "provider-runtime-notes.md");
	assert.equal(userDocuments[0]?.metadata?.artifact_path, "attachments/provider-runtime-notes.md");
	assert.ok(
		typeof userDocuments[0]?.metadata?.provider_artifact_path === "string"
			&& isAbsolute(userDocuments[0].metadata.provider_artifact_path),
		"user_documents must materialize a Host-owned absolute artifact",
	);

	console.log(JSON.stringify({
		general_web: generalWeb.map((item) => ({
			title: item.title,
			url: item.url,
			backend: item.metadata?.general_web_backend,
		})),
		github: github.map((item) => ({ title: item.title, url: item.url })),
		github_repository: repository[0]?.url,
		github_code: code.map((item) => item.url),
		github_issue: issueDetails.map((item) => ({
			title: item.title,
			url: item.url,
			comments: Array.isArray(item.metadata?.comments) ? item.metadata.comments.length : 0,
		})),
		github_downloads: {
			clone: clonePath,
			file: downloadedFilePath,
			releases: releases.map((item) => item.metadata?.artifact_path),
		},
		arxiv: arxiv.map((item) => ({ title: item.title, url: item.url, authors: item.authors })),
		arxiv_categories: arxivCategories.map((item) => item.metadata?.category_id),
		arxiv_by_id: arxivById[0]?.url,
		arxiv_document: {
			url: arxivDocument[0]?.url,
			pdf_path: arxivDocument[0]?.metadata?.pdf_path,
			markdown_path: arxivDocument[0]?.metadata?.markdown_path,
		},
		huggingface_daily_papers: dailyPapers.map((item) => ({
			title: item.title,
			url: item.url,
			published_at: item.publishedAt,
			submitted_at: item.metadata?.submitted_at,
		})),
		user_documents: userDocuments.map((item) => ({
			title: item.title,
			url: item.url,
			artifact_path: item.metadata?.artifact_path,
		})),
	}, null, 2));
	console.log("Live FastAPI GitHub, general-web, arXiv, Hugging Face, and user_documents Source verification passed");
} finally {
	await getResearchSourceServiceManager().close();
	rmSync(root, { recursive: true, force: true });
}
