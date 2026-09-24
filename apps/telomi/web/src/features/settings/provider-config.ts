
interface ModelInfo {
  id: string;
  name: string;
}

export interface ProviderInfo {
  id: string;
  models: ModelInfo[];
  dynamic?: boolean;
}

export interface ModelDefaultsView {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
}

/** What one consuming role runs right now, as the Runtime resolves it. */
export interface ProviderConsumerStatus {
  id: string;
  effectiveModel: string;
  /** `failed`: the Provider rejected the effective model on its last use; `error` says why. */
  status: "active" | "pending" | "failed";
  error?: string;
  /** Runs or Goals still on an earlier selection. */
  pendingCount: number;
  stages: Array<{ key: string; label: string; thinkingLevel: string; source: string }>;
}

export interface ProviderConfig extends ModelDefaultsView {
  consumers?: ProviderConsumerStatus[];
  /** The User Memory service follows the global default and replaces itself in the background. */
  memoryConfiguration?: { status: "pending" | "validating" | "applying" | "active" | "failed"; error: string | null; embeddingSelected?: boolean };
  enabledModels: string[];
  providerFallbackModels: string[];
  taskModels: Partial<Record<TaskModelRole, string>>;
  /** Explicit Run Stage reasoning depths, keyed `role.stage`; absent means it inherits. */
  stageThinkingLevels: Record<string, string>;
  taskModelRoles: TaskModelRoleInfo[];
  providers: ProviderInfo[];
  thinkingLevels: string[];
}

export type TaskModelRole =
  "cornellNote" | "primeRoot" | "primeChild" | "wikiMaintainer" | "browserEvolution";

interface TaskModelRoleInfo {
  id: TaskModelRole;
  label: string;
  description: string;
  legacyEnvVar: string;
  stages: Record<string, { label: string; envVar: string }>;
}

interface AuthEntrySummary {
  configured: boolean;
  type: "api_key" | "oauth" | "unknown" | null;
  keyHint: string | null;
}

export interface CloudProviderEntry {
  id: string;
  envName: string | null;
  envSet: boolean;
  authEntry: AuthEntrySummary;
  /** Prepared but not in use until it is applied. */
  pendingEntry: AuthEntrySummary;
}

export interface CloudProvidersResponse {
  providers: CloudProviderEntry[];
}

/** One credential value of an already integrated search Provider. Never the secret itself. */
export interface SearchCredentialFieldStatus {
  id: string;
  env: string;
  optional: boolean;
  configured: boolean;
  keyHint: string | null;
  provenance: "user" | "imported" | "browser" | null;
  pendingConfigured: boolean;
  deleted: boolean;
  /** Legacy variables still set in the environment; they no longer override the managed value. */
  legacyEnvSet: string[];
  /** A file this credential would be read from while no value is managed here. */
  locationEnv: string | null;
  /** Why that file was not adopted, when it could not be. Never its contents. */
  locationError: string | null;
}

export interface SearchCredentialProviderStatus {
  id: string;
  sourceIds: string[];
  status: "active" | "pending" | "unconfigured";
  /** Why this entry point does not decide what the Provider authenticates with. */
  pendingReason: string | null;
  fields: SearchCredentialFieldStatus[];
}
