/**
 * What a capability needs from the user before it works again. The Runtime states the fact; the
 * inbox words it and links to the settings page that fixes it.
 */
export type CapabilityArea = "chat" | "memory" | "embedding" | "tts" | "stt" | "general_web";

export type CapabilityAlert =
	/** Nothing is chosen: no conversation model, no embedding model, or no general web search backend. */
	| { kind: "unset"; area: "chat" | "embedding" | "general_web" }
	/** The Provider refused a model this capability uses, for its credential, balance or the model itself. */
	| { kind: "rejected"; area: Exclude<CapabilityArea, "general_web">; model: string; error: string; at: string }
	/** The capability's own service could not apply its configuration or reach its connection. */
	| { kind: "failed"; area: "memory" | "embedding"; error?: string };

export interface CapabilityAlertsResponse {
	alerts: CapabilityAlert[];
}

/** The settings page where each capability is configured; Memory's models live beside embedding. */
export const CAPABILITY_SETTINGS_SECTION = {
	chat: "chat",
	memory: "embedding",
	embedding: "embedding",
	tts: "tts",
	stt: "stt",
	general_web: "sources",
} as const satisfies Record<CapabilityArea, string>;
