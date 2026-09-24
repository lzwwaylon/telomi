import { HINDSIGHT_LOCAL_CONNECTION, type EmbeddingSelection } from "../../shared/embedding-configuration.js";

/** Every `HINDSIGHT_API_EMBEDDINGS_*` value the User Memory service and its migration read comes from here. */
export function memoryEmbeddingEnv(selection: EmbeddingSelection & { baseUrl: string }, apiKey?: string): NodeJS.ProcessEnv {
	if (selection.connection === HINDSIGHT_LOCAL_CONNECTION) {
		return { HINDSIGHT_API_EMBEDDINGS_PROVIDER: "local", HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: selection.model };
	}
	if (!selection.baseUrl) throw new Error(`Embedding connection '${selection.connection}' is unknown`);
	return {
		HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai",
		HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: selection.model,
		HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: selection.baseUrl,
		...(apiKey ? { HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: apiKey } : {}),
		...(selection.dimensions ? { HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS: String(selection.dimensions) } : {}),
	};
}
