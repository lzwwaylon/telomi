/**
 * Connection ids reference the existing Pi models/auth catalog, never another credential store.
 * The connection is the whole target: the wire protocol follows from it, not from a saved field.
 */
export interface SpeechSelection {
  connection: string;
  model: string;
}

/** Nothing is preselected: a consumer without its own selection or a default has no recognition model. */
export interface SpeechConfiguration {
  default?: SpeechSelection;
  recognition?: SpeechSelection;
  local?: SpeechSelection;
  fallback?: SpeechSelection;
  cleanupModel?: string;
  cleanupEnabled: boolean;
  cleanupInstructions: string;
}

export interface SpeechExecutionConfiguration {
  /** Absent while the user has not chosen a recognition model for it. */
  recognition?: SpeechSelection & { baseUrl: string };
  local?: SpeechSelection & { baseUrl: string };
  fallback?: SpeechSelection & { baseUrl: string };
  cleanupModel: string | null;
  cleanupBaseUrl?: string | null;
  cleanupEnabled: boolean;
  cleanupInstructions: string;
}

export interface SpeechConfigurationResponse {
  active: SpeechConfiguration;
  pending: SpeechConfiguration | null;
  effective: SpeechExecutionConfiguration;
  sources: Record<"recognition" | "local" | "cleanupModel", "override" | "default">;
  consumers: Array<{ id: "recognition" | "local" | "cleanupModel"; status: "active" | "pending" | "unavailable" | "unconfigured"; boundary: "next-recording" }>;
  status: "saved" | "active" | "pending" | "validating" | "applying" | "failed";
  error?: string;
  boundary: "next-recording";
}
