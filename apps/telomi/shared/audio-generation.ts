export type AudioGenerationConsumer = "playback" | "local" | "podcast";
/** The connection is the whole target; the wire protocol follows from it, not from a saved field. */
export interface AudioGenerationSelection {
  connection: string;
  model: string;
  voice: string;
  rate: number;
}
/** Nothing is preselected: a consumer without its own selection or a default has no speech model. */
export interface AudioGenerationConfiguration {
  default?: AudioGenerationSelection;
  playback?: AudioGenerationSelection;
  local?: AudioGenerationSelection;
  podcast?: AudioGenerationSelection;
}
export interface AudioGenerationResponse {
  active: AudioGenerationConfiguration;
  pending: AudioGenerationConfiguration | null;
  effective: Record<AudioGenerationConsumer, (AudioGenerationSelection & { baseUrl: string }) | null>;
  sources: Record<AudioGenerationConsumer, "default" | "override" | null>;
  consumers: Array<{ id: AudioGenerationConsumer; status: "active" | "pending" | "unavailable" | "unconfigured" }>;
  status: "saved" | "active" | "pending" | "validating" | "applying" | "failed";
  error?: string;
}
