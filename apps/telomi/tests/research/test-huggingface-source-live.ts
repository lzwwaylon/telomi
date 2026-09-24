import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchSourceRegistry } from "../../server/research/sources/builtin-registry.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import type { ResearchProviderRequest } from "../../server/providers/search-types.js";

const root = mkdtempSync(join(tmpdir(), "telomi-huggingface-source-live-"));
const secondRoot = mkdtempSync(join(tmpdir(), "telomi-huggingface-source-live-second-"));
const registry = createResearchSourceRegistry(process.env);
const signal = AbortSignal.timeout(3 * 60 * 1_000);

async function search(
	query: string,
	providerRequest: ResearchProviderRequest,
	maxResults = 3,
	workspaceDir = root,
) {
	return registry.search("huggingface", {
		query,
		maxResults,
		criterionIds: ["live-huggingface-contract"],
		purpose: `Verify live Hugging Face operation ${providerRequest.operation}`,
		providerRequest,
		signal,
		workspaceDir,
	});
}

try {
	const papers = await search("transformer attention", {
		operation: "papers_search",
		parameters: { query: "transformer attention", limit: 3 },
	});
	assert.ok(papers.length > 0, "papers_search must return live paper metadata");
	assert.ok(papers.every((row) => row.metadata?.resource_type === "paper"));
	assert.ok(papers.every((row) => typeof row.metadata?.pdf_url === "string"));

	const paperInfo = await search("1706.03762", {
		operation: "papers_info",
		parameters: { paper_id: "1706.03762" },
	}, 1);
	assert.equal(paperInfo.length, 1);
	assert.match(paperInfo[0]!.title, /attention/i);
	const paperPreview = await search("1706.03762 preview", {
		operation: "papers_preview",
		parameters: { paper_id: "1706.03762" },
	}, 1);
	assert.match(String(paperPreview[0]!.metadata?.front_excerpt), /Attention|Transformer/iu);
	const paperDownload = await search("1706.03762 download", {
		operation: "papers_download",
		parameters: { paper_id: "1706.03762" },
	}, 1);
	const paperBundle = join(root, String(paperDownload[0]!.metadata?.artifact_path));
	assert.match(readFileSync(join(paperBundle, "paper.md"), "utf-8"), /Attention|Transformer/iu);
	assert.equal(JSON.parse(readFileSync(join(paperBundle, "metadata.json"), "utf-8")).paper_id, "1706.03762");

	const dailyPapers = await search("latest daily papers", {
		operation: "papers_list",
		parameters: { sort: "trending", page: 0, limit: 3 },
	});
	assert.ok(dailyPapers.length > 0, "papers_list must return live daily papers");

	const models = await search("retrieval models", {
		operation: "models_list",
		parameters: { search: "retrieval", sort: "trending_score", limit: 3 },
	});
	assert.ok(models.length > 0, "models_list must return live model repositories");
	assert.ok(models.every((row) => row.metadata?.resource_type === "model"));
	assert.ok(models.some((row) => typeof row.metadata?.document_url === "string"));

	const modelTags = await search("speech", {
		operation: "model_tags",
		parameters: { tag_type: "pipeline_tag", search: "speech", limit: 100 },
	}, 100);
	assert.ok(modelTags.some((row) => row.metadata?.tag_id === "text-to-speech"));
	assert.ok(modelTags.some((row) => row.metadata?.tag_id === "automatic-speech-recognition"));
	const languageTags = await search("Chinese", {
		operation: "model_tags",
		parameters: { tag_type: "language", search: "Chinese", limit: 100 },
	}, 100);
	assert.ok(languageTags.some((row) => row.metadata?.tag_id === "zh"));
	await assert.rejects(
		() => search("invalid speech tag", {
			operation: "models_list",
			parameters: { pipeline_tag: "text-to-speach", limit: 10 },
		}, 10),
		/Replace pipeline_tag='text-to-speach' with 'text-to-speech'/iu,
	);
	await assert.rejects(
		() => search("combined language tag", {
			operation: "model_tags",
			parameters: { tag_type: "language", search: "Chinese English", limit: 100 },
		}, 100),
		/model_tags\(tag_type='language', search='Chinese'\)[\s\S]+model_tags\(tag_type='language', search='English'\)/iu,
	);
	await assert.rejects(
		() => search("prefixed language filters", {
			operation: "models_list",
			parameters: {
				pipeline_tag: "text-to-speech",
				filters: ["language:zh", "language:en"],
				limit: 10,
			},
		}, 10),
		/Replace filters\[0\]='language:zh' with 'zh'[\s\S]+Replace filters\[1\]='language:en' with 'en'/iu,
	);

	const baseTtsModels = await search("base text-to-speech models", {
		operation: "models_list",
		parameters: {
			pipeline_tag: "text-to-speech",
			base_model_relation: "base",
			sort: "trending_score",
			limit: 10,
		},
	}, 10);
	assert.ok(baseTtsModels.length > 0, "Base-only text-to-speech lane must return models");
	assert.ok(baseTtsModels.every((row) => !(row.metadata?.tags as string[] | undefined)
		?.some((tag) => tag.startsWith("base_model:"))));

	const modelInfo = await search("openai/whisper-large-v3", {
		operation: "models_info",
		parameters: { repo_id: "openai/whisper-large-v3" },
	}, 1);
	assert.equal(modelInfo.length, 1);
	assert.equal(modelInfo[0]!.metadata?.repo_id, "openai/whisper-large-v3");
	assert.equal(modelInfo[0]!.metadata?.pipeline_tag, "automatic-speech-recognition");

	const modelCard = await search("openai/whisper-large-v3 model card", {
		operation: "models_card",
		parameters: { repo_id: "openai/whisper-large-v3", revision: modelInfo[0]!.metadata?.sha },
	}, 1);
	assert.equal(modelCard.length, 1);
	assert.equal(modelCard[0]!.metadata?.resource_type, "model_card");
	assert.match(
		readFileSync(join(root, String(modelCard[0]!.metadata?.artifact_path)), "utf-8"),
		/Whisper large-v3/iu,
	);
	const cachedModelCard = await search("openai/whisper-large-v3 model card", {
		operation: "models_card",
		parameters: { repo_id: "openai/whisper-large-v3", revision: modelInfo[0]!.metadata?.sha },
	}, 1, secondRoot);
	assert.equal(cachedModelCard[0]!.metadata?.material_cache_hit, true);
	assert.match(
		readFileSync(join(secondRoot, String(cachedModelCard[0]!.metadata?.artifact_path)), "utf-8"),
		/Whisper large-v3/iu,
	);

	const datasets = await search("squad datasets", {
		operation: "datasets_list",
		parameters: { search: "squad", sort: "downloads", limit: 3 },
	});
	assert.ok(datasets.length > 0, "datasets_list must return live dataset repositories");
	assert.ok(datasets.every((row) => row.metadata?.resource_type === "dataset"));

	const datasetInfo = await search("SWE-bench/SWE-bench_Verified", {
		operation: "datasets_info",
		parameters: { repo_id: "SWE-bench/SWE-bench_Verified" },
	}, 1);
	assert.equal(datasetInfo.length, 1);
	assert.equal(datasetInfo[0]!.metadata?.repo_id, "SWE-bench/SWE-bench_Verified");

	const datasetLeaderboard = await search("SWE-bench/SWE-bench_Verified leaderboard", {
		operation: "datasets_leaderboard",
		parameters: { dataset_id: "SWE-bench/SWE-bench_Verified", limit: 3 },
	}, 3);
	assert.ok(datasetLeaderboard.length > 0, "datasets_leaderboard must return live scores");
	assert.ok(datasetLeaderboard.every((row) => row.metadata?.dataset_id === "SWE-bench/SWE-bench_Verified"));
	assert.ok(datasetLeaderboard.every((row) => typeof row.metadata?.score === "number"));
	assert.equal(new Set(datasetLeaderboard.map((row) => row.url)).size, datasetLeaderboard.length);
	assert.deepEqual(datasetLeaderboard.map((row) => row.metadata?.rank), [1, 2, 3]);

	const spaces = await search("image generation spaces", {
		operation: "spaces_list",
		parameters: { search: "image", sort: "trending_score", limit: 3 },
	});
	assert.ok(spaces.length > 0, "spaces_list must return live Space repositories");
	assert.ok(spaces.every((row) => row.metadata?.resource_type === "space"));

	console.log(JSON.stringify({
		event: "huggingface_source_live_passed",
		counts: {
			papers_search: papers.length,
			papers_info: paperInfo.length,
			papers_preview: paperPreview.length,
			papers_download: paperDownload.length,
			papers_list: dailyPapers.length,
			models_list: models.length,
			model_tags: modelTags.length,
			language_tags: languageTags.length,
			base_tts_models: baseTtsModels.length,
			models_info: modelInfo.length,
			models_card: modelCard.length,
			datasets_list: datasets.length,
			datasets_info: datasetInfo.length,
			datasets_leaderboard: datasetLeaderboard.length,
			spaces_list: spaces.length,
		},
		samples: {
			paper: papers[0]?.url,
			model: models[0]?.url,
			model_card: modelCard[0]?.metadata?.artifact_path,
			dataset: datasets[0]?.url,
			leaderboard: datasetLeaderboard[0]?.url,
			space: spaces[0]?.url,
		},
	}, null, 2));
} finally {
	await getResearchSourceServiceManager().close();
	rmSync(root, { recursive: true, force: true });
	rmSync(secondRoot, { recursive: true, force: true });
}
