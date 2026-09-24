/** How an external source authenticates. Decides what the settings page shows for it. */
export type SourceAuth = "api_key" | "browser_session" | "none";

/** The last verification outcome for one external source. */
export type SourceState = "ok" | "needs_login" | "error" | "unconfigured";

/** The Runtime's own explanations, so the page can state them in the user's language. */
export type SourceReasonCode =
  | "no_login"
  | "login_rejected"
  | "browser_unavailable"
  | "service_unavailable"
  | "not_registered"
  | "timeout";

export interface SourceStatus {
  state: SourceState;
  /** ISO timestamp of the verification this status came from. */
  checkedAt: string;
  /** Which of the Runtime's own explanations applies, when one does. */
  code?: SourceReasonCode;
  /** Detail from the Provider or the failure itself. Never a credential. */
  reason?: string;
}

/** One external source as the settings page lists it. `credential` is present only for sources managed by API key or a browser cookie override. */
export interface SourceSummary<Credential = unknown> {
  id: string;
  auth: SourceAuth;
  /** The research registry ids this source serves. */
  sourceIds: string[];
  /** Null until the first verification has run. */
  status: SourceStatus | null;
  /** Off means the source leaves the Provider Catalog and is not verified. */
  enabled: boolean;
  credential: Credential | null;
}

/** States in which a source is left out of the Provider Catalog. */
export function sourceUnavailable(status: SourceStatus | null): boolean {
  return status?.state === "needs_login" || status?.state === "error";
}

export interface SourcesResponse<Credential = unknown> {
  sources: SourceSummary<Credential>[];
  /** Whether a verification is running right now. */
  verifying: boolean;
  /** The general web backend a Run tries first; the other configured backends are its fallbacks. */
  generalWebBackend: string;
}
