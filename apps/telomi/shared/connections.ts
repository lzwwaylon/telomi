/** The connection whose service Telomi bundles and may start itself; see `server/audio/README.md`. */
export const MANAGED_AUDIO_CONNECTION_ID = "telomi-audio";

/** Whether a connection id names the managed connection. Every check for it goes through here. */
export function isManagedAudioConnection(connection: unknown): boolean {
  return typeof connection === "string" && connection.trim().toLowerCase() === MANAGED_AUDIO_CONNECTION_ID;
}

/** What a connection can serve. A connection is one credential plus endpoint; capabilities pick models from it. */
export type ConnectionCapability = "chat" | "embedding" | "tts" | "stt";

/** One consumer's active selection, as the Runtime resolves it. */
export interface ConnectionUsage {
  capability: ConnectionCapability;
  consumer: string;
  connection: string;
  model: string;
}

export interface ConnectionModel {
  id: string;
  name?: string;
  supportedVoices?: string[];
}

/** Models a connection serves, grouped by capability; the source every model selector reads. */
export type ConnectionModels = Record<ConnectionCapability, ConnectionModel[]>;

export interface ConnectionSummary {
  id: string;
  kind: "cloud" | "custom";
  /** `pending`: a credential is prepared but not applied. */
  status: "connected" | "pending" | "unconfigured";
  auth: "api_key" | "oauth" | "env" | "anonymous" | null;
  keyHint: string | null;
  capabilities: ConnectionCapability[];
  models: ConnectionModels;
  usedBy: ConnectionUsage[];
}

export interface ConnectionsResponse {
  connections: ConnectionSummary[];
  /** Every capability selection, including ones pointing at a connection that no longer exists. */
  selections: ConnectionUsage[];
}
