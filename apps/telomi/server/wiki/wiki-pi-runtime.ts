import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime, type ModelRuntimeAuthOverrides } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { modelDefinitionHash } from '../agent-runtime/model-policy.js';
import { resolveLLMConfig, resolveStageThinkingLevel } from '../agent-runtime/model-config/resolve.js';
import { resolveAgentDir } from '../config/agent-directory.js';
import { isProviderCredentialDeleted } from '../config/credential-tombstones.js';
import { refreshConnectionRuntime } from '../providers/custom-models.js';

/** The Update pins this role once; every file stage and classification uses it. */
export function wikiModelSelection(env: NodeJS.ProcessEnv) {
 const selector = resolveLLMConfig({ taskModelRole: 'wikiCompilation',
  envVarName: 'TELOMI_WIKI_COMPILATION_MODEL', envOverride: env }).model;
 const slash = selector?.indexOf('/') ?? -1;
 if (!selector || slash <= 0 || slash === selector.length - 1) throw new Error('Wiki Compilation requires a configured provider/model');
 return { selector, provider: selector.slice(0, slash), modelId: selector.slice(slash + 1),
  thinking: resolveStageThinkingLevel('wikiCompilation', 'maintenance', env).thinkingLevel };
}

/** Native Pi transport keeps frozen connections while resolving live host-only credentials. */
export async function createWikiModelRuntime(env: NodeJS.ProcessEnv, signal: AbortSignal) {
 const selection = wikiModelSelection(env);
 const canonical = env.PI_CODING_AGENT_DIR?.trim() || resolveAgentDir(env.TELOMI_DATA_DIR);
 const connectionEnv = { ...env, PRIME_AGENT_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: canonical };
 const liveEnv = { ...connectionEnv, TELOMI_PRIME_MODEL_DEFINITIONS: undefined };
 const definition = modelDefinitionHash(selection.selector, connectionEnv);
 const assertConnection = () => {
  signal.throwIfAborted();
  if (isProviderCredentialDeleted(selection.provider)) throw new Error('Wiki Provider credential was deleted');
  if (modelDefinitionHash(selection.selector, liveEnv) !== definition)
   throw new Error('Wiki Provider connection changed; start a new Update');
 };
 assertConnection();
 const paths = { authPath: join(canonical, 'auth.json'), modelsPath: join(canonical, 'models.json'), signal, allowModelNetwork: false };
 const modelRuntime = await ModelRuntime.create(paths);
 await refreshConnectionRuntime(modelRuntime);
 assertConnection();
 const model = modelRuntime.getModel(selection.provider, selection.modelId);
 if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) throw new Error(`Pi model is unavailable: ${selection.selector}`);
 // Every native model turn resolves current keys and secret headers, including tool-loop turns.
 modelRuntime.getAuth = async (selected: string | Model<Api>, options?: ModelRuntimeAuthOverrides) => {
  assertConnection();
  const live = await ModelRuntime.create({ ...paths, refreshOnCreate: false });
  await refreshConnectionRuntime(live);
  assertConnection();
  const auth = await (typeof selected === 'string' ? live.getAuth(selected, options) : live.getAuth(selected, options));
  assertConnection();
  return auth;
 };
 return { modelRuntime, model, modelRegistry: new ModelRegistry(modelRuntime) };
}
