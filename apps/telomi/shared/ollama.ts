/** The address Ollama listens on by default; the connection preset starts from it. */
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

/** Embedding models worth suggesting for a pull; anything else is typed by name. */
export const OLLAMA_EMBEDDING_SUGGESTIONS = ["embeddinggemma", "nomic-embed-text", "mxbai-embed-large", "bge-m3", "qwen3-embedding:0.6b", "snowflake-arctic-embed2", "all-minilm"];

/** Whether a connection points at an Ollama server, by its default port or host name. */
export function looksLikeOllama(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		// ponytail: port and host name heuristic; probe /api/version if a non-default deployment shows up.
		return url.port === "11434" || /ollama/iu.test(url.hostname);
	} catch {
		return false;
	}
}
