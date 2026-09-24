/**
 * Compatibility boundary for models resolved by pi-coding-agent's ModelRegistry.
 *
 * Pi 0.80 still registers arbitrary models.json providers in the legacy API
 * registry. Keep those execution calls centralized here so the rest of the
 * application can use the new provider/model APIs and this file can disappear
 * when pi-coding-agent completes its ModelManager migration.
 */
export {
	completeSimple as completeRegistryModel,
	findEnvKeys as findRegistryEnvKeys,
	getEnvApiKey as getRegistryEnvApiKey,
	streamSimple as streamRegistryModel,
} from "@earendil-works/pi-ai/compat";
