import { observeModelOutcome } from "../agent-runtime/model-config/model-verdicts.js";

/** One OpenAI-compatible embeddings call; every managed consumer that embeds over HTTP goes through it. */
export interface EmbeddingEndpoint {
	baseUrl: string;
	apiKey: string;
	model: string;
	dimensions?: number;
	fetchImpl?: typeof fetch;
	/** The connection the model is served by; the Provider's verdict on that model is recorded under it. */
	connection?: string;
}

export async function embedTexts(
	endpoint: EmbeddingEndpoint,
	input: string[],
	inputType: "search_document" | "search_query" = "search_document",
	signal?: AbortSignal,
): Promise<number[][]> {
	const response = await (endpoint.fetchImpl ?? fetch)(`${endpoint.baseUrl.replace(/\/+$/u, "")}/embeddings`, {
		method: "POST",
		headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: endpoint.model, input, input_type: inputType, ...(endpoint.dimensions ? { dimensions: endpoint.dimensions } : {}) }),
		signal,
	});
	const body = await response.text();
	const verdict = endpoint.connection ? `${endpoint.connection}/${endpoint.model}` : undefined;
	if (!response.ok) {
		if (verdict) observeModelOutcome(verdict, `${response.status}: ${body.slice(0, 2_000) || "status code (no body)"}`);
		throw new Error(`Embedding request failed with HTTP ${response.status}`);
	}
	if (verdict) observeModelOutcome(verdict);
	const value = JSON.parse(body) as { data?: Array<{ index?: number; embedding?: unknown }> };
	const vectors = [...(value.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
		.map((item) => item.embedding);
	if (vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector)
		|| vector.length === 0 || vector.some((number) => typeof number !== "number" || !Number.isFinite(number)))) {
		throw new Error("Embedding connection returned invalid vectors");
	}
	if (endpoint.dimensions && (vectors[0] as number[]).length !== endpoint.dimensions) {
		throw new Error(`Embedding model returned ${(vectors[0] as number[]).length} dimensions, not ${endpoint.dimensions}`);
	}
	return vectors as number[][];
}

/** The vector space is the model; a connection is only transport. Matches the identity legacy Wiki indexes recorded. */
export function embeddingIdentity(selection: { model: string; dimensions?: number }): string {
	return selection.dimensions ? `${selection.model}@${selection.dimensions}` : selection.model;
}
