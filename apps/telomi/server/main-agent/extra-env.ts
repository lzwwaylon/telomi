/** Goal-scoped environment values resolved lazily before an Agent run. */
export type ExtraEnvGetter = () => Record<string, string>;
