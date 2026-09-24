export const EMBEDDING_CONSUMERS = ["wiki", "memory"] as const;
export type EmbeddingConsumer = typeof EMBEDDING_CONSUMERS[number];
/** `hindsight-local` runs sentence-transformers inside the User Memory service; only Memory can use it. */
export const HINDSIGHT_LOCAL_CONNECTION = "hindsight-local";
export interface EmbeddingSelection {
  connection: string;
  model: string;
  dimensions?: number;
}
/** Nothing is preselected: an index without its own selection or a default has no embedding model. */
export interface EmbeddingConfiguration {
  default?: EmbeddingSelection;
  wiki?: EmbeddingSelection;
  memory?: EmbeddingSelection;
}
export interface EmbeddingProgress { done: number; total: number }
/** Work the rebuild will send to the embedding model; the cost hint the page shows. */
export interface EmbeddingEstimate { units: number; characters: number }
export interface EmbeddingConsumerStatus {
  id: EmbeddingConsumer;
  /** `active`: serving the active selection. `rebuilding`: new index building while the old one serves. `unconfigured`: no model chosen. */
  status: "active" | "rebuilding" | "failed" | "unavailable" | "unconfigured";
  serving: EmbeddingSelection | null;
  progress?: EmbeddingProgress;
  estimate?: EmbeddingEstimate;
  error?: string;
}
export interface EmbeddingResponse {
  active: EmbeddingConfiguration;
  pending: EmbeddingConfiguration | null;
  /** The selection a rebuild is moving toward; absent when nothing is rebuilding or failed. */
  target: EmbeddingConfiguration | null;
  effective: Record<EmbeddingConsumer, (EmbeddingSelection & { baseUrl: string }) | null>;
  sources: Record<EmbeddingConsumer, "default" | "override" | null>;
  consumers: EmbeddingConsumerStatus[];
  status: "saved" | "active" | "validating" | "rebuilding" | "failed";
  error?: string;
}
