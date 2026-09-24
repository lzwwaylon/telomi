import type { Express } from "express";

import type { CapabilityAlert, CapabilityAlertsResponse, CapabilityArea } from "../../shared/capability-alerts.js";
import { HINDSIGHT_LOCAL_CONNECTION } from "../../shared/embedding-configuration.js";
import { classifyProviderError } from "../accounts/error-classify.js";
import { modelRejection, needsUserAction } from "../agent-runtime/model-config/model-verdicts.js";
import { resolveAudioGeneration } from "../audio/configuration.js";
import { loadSettings } from "../config/settings.js";
import { describeEmbedding } from "../embedding/configuration.js";
import type { HindsightRuntimeManager } from "../goals/memory/hindsight-runtime.js";
import { MEMORY_ROLES } from "../goals/memory/model-settings.js";
import { resolveSpeechConfiguration } from "../voice/configuration.js";
import { describeConsumers, type ProviderConfigDependencies } from "./config-api.js";
import { SOURCE_DESCRIPTORS } from "./source-descriptors.js";
import type { SourceStatusMonitor } from "./source-status.js";

export interface CapabilityAlertDependencies {
	mainAgent: ProviderConfigDependencies["mainAgent"];
	memory?: Pick<HindsightRuntimeManager, "describeConfiguration">;
	sources: Pick<SourceStatusMonitor, "lacksCredential" | "isEnabled">;
	describeEmbedding?: typeof describeEmbedding;
}

/**
 * Every capability that cannot work until the user changes something, read from the state each
 * capability already keeps: its selection, its own service status, the source verification and
 * the Provider's last verdict on each model it uses. A model refused for several capabilities is
 * reported once, under the first of them, since one fix serves them all.
 */
export async function describeCapabilityAlerts(deps: CapabilityAlertDependencies): Promise<CapabilityAlert[]> {
	const settings = loadSettings();
	const alerts: CapabilityAlert[] = [];
	const models: Array<{ area: Exclude<CapabilityArea, "general_web">; model: string }> = [];

	const consumers = describeConsumers(settings, { mainAgent: deps.mainAgent });
	if (!consumers.find((consumer) => consumer.id === "mainAgent")?.effectiveModel) alerts.push({ kind: "unset", area: "chat" });
	for (const consumer of consumers) models.push({ area: "chat", model: consumer.effectiveModel });

	if (deps.memory) {
		const memory = deps.memory.describeConfiguration();
		const serving = memory.active ?? memory.target;
		// Memory cannot start before it has its models; the unset conversation or embedding alert says what to choose.
		const configured = memory.embeddingSelected && MEMORY_ROLES.every((role) => serving[role].model);
		if (configured && memory.status === "failed") alerts.push({ kind: "failed", area: "memory", ...(memory.error ? { error: memory.error } : {}) });
		for (const role of MEMORY_ROLES) models.push({ area: "memory", model: serving[role].model ?? "" });
	}

	const embedding = await (deps.describeEmbedding ?? describeEmbedding)();
	if (!embedding.effective.wiki && !embedding.effective.memory) alerts.push({ kind: "unset", area: "embedding" });
	if (embedding.status === "failed" || embedding.consumers.some((consumer) => consumer.status === "failed" || consumer.status === "unavailable")) {
		const error = embedding.error ?? embedding.consumers.find((consumer) => consumer.error)?.error;
		alerts.push({ kind: "failed", area: "embedding", ...(error ? { error } : {}) });
	}
	for (const selection of Object.values(embedding.effective)) {
		if (selection && selection.connection !== HINDSIGHT_LOCAL_CONNECTION) models.push({ area: "embedding", model: `${selection.connection}/${selection.model}` });
	}

	for (const consumer of ["playback", "local", "podcast"] as const) {
		const selection = resolveAudioGeneration(consumer);
		if (selection) models.push({ area: "tts", model: `${selection.connection}/${selection.model}` });
	}

	const speech = resolveSpeechConfiguration(settings);
	for (const selection of [speech.recognition, speech.local, speech.fallback]) {
		if (selection) models.push({ area: "stt", model: `${selection.connection}/${selection.model}` });
	}
	if (speech.cleanupEnabled && speech.cleanupModel) models.push({ area: "stt", model: speech.cleanupModel });

	const reported = new Set<string>();
	for (const { area, model } of models) {
		if (!model || reported.has(model)) continue;
		reported.add(model);
		const rejection = modelRejection(model);
		if (!rejection || !needsUserAction(rejection.error)) continue;
		// A Codex login or quota failure is the Codex account's alert, with its own way out.
		if (model.startsWith("openai-codex/") && ["auth", "quota"].includes(classifyProviderError(rejection.error))) continue;
		alerts.push({ kind: "rejected", area, model, error: rejection.error, at: rejection.at });
	}

	const generalWeb = SOURCE_DESCRIPTORS.filter((source) => source.provider.catalog.capabilities?.includes("general_web"));
	if (generalWeb.every((source) => !deps.sources.isEnabled(source.id) || deps.sources.lacksCredential(source.id))) {
		alerts.push({ kind: "unset", area: "general_web" });
	}
	return alerts;
}

export function mountCapabilityAlertsApi(app: Express, deps: CapabilityAlertDependencies): void {
	app.get("/api/capability-alerts", async (_req, res) => {
		try {
			const body: CapabilityAlertsResponse = { alerts: await describeCapabilityAlerts(deps) };
			res.json(body);
		} catch {
			res.status(500).json({ error: "Unable to read capability alerts" });
		}
	});
}
