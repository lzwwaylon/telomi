import type { ConnectionCapability, ConnectionSummary } from "@shared/connections.js";
import type { AudioGenerationConsumer } from "@shared/audio-generation.js";
import type { EmbeddingConsumer } from "@shared/embedding-configuration.js";
import { TASK_MODEL_ROLE_LABELS } from "@shared/task-model-roles.js";
import type { MessageId } from "@/app/locales/zh-CN";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";

export const CAPABILITY_LABEL: Record<ConnectionCapability, MessageId> = {
  chat: "settings.capability.chat",
  embedding: "settings.capability.embedding",
  tts: "settings.capability.tts",
  stt: "settings.capability.stt",
};

/** The settings page that selects models for a capability. */
export const CAPABILITY_SECTION: Record<ConnectionCapability, string> = {
  chat: "chat",
  embedding: "embedding",
  tts: "tts",
  stt: "stt",
};

/** The row names each capability page's model table uses; a task model role keeps its product name. */
const CONSUMER_LABEL: Record<ConnectionCapability, Record<string, MessageId>> = {
  chat: { default: "settings.board.default" },
  embedding: { wiki: "settings.embedding.wiki", memory: "settings.embedding.memory" } satisfies Record<EmbeddingConsumer, MessageId>,
  tts: { playback: "settings.audioGeneration.playback", local: "settings.audioGeneration.local", podcast: "settings.audioGeneration.podcast" } satisfies Record<AudioGenerationConsumer, MessageId>,
  stt: { recognition: "settings.speech.recognition", local: "settings.speech.local" },
};

/** Names a consumer as the page that assigns its model does, never by its internal id. */
export function consumerLabel(capability: ConnectionCapability, consumer: string): string {
  const message = CONSUMER_LABEL[capability][consumer];
  if (message) return uiText(message);
  if (capability === "chat" && Object.hasOwn(TASK_MODEL_ROLE_LABELS, consumer)) return TASK_MODEL_ROLE_LABELS[consumer as keyof typeof TASK_MODEL_ROLE_LABELS];
  return consumer;
}

/** What a connection can serve and who currently uses it; rendered under a connection's row. */
export function ConnectionBadges({ summary }: { summary: ConnectionSummary | undefined }) {
  if (!summary) return null;
  const used = new Map<ConnectionCapability, string[]>();
  for (const usage of summary.usedBy) used.set(usage.capability, [...(used.get(usage.capability) ?? []), usage.consumer]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.74rem] text-muted-foreground" data-testid={`connection-badges-${summary.id}`}>
      <span className="inline-flex gap-1">
        {summary.capabilities.map((capability) => (
          <span key={capability} className="rounded border border-border px-1.5 py-0.5" data-testid={`connection-capability-${summary.id}-${capability}`}>
            {uiText(CAPABILITY_LABEL[capability])}{summary.models[capability].length > 0 ? ` ${summary.models[capability].length}` : ""}
          </span>
        ))}
      </span>
      {used.size === 0 ? (
        <span>{uiText("settings.connections.unused")}</span>
      ) : (
        <span className="inline-flex min-w-0 gap-x-2">
          <span className="shrink-0">{uiText("settings.connections.usedBy")}</span>
          {/* A wrapped capability lines up under the first one, not under the label. */}
          <span className="inline-flex min-w-0 flex-wrap gap-x-2 gap-y-1">
            {[...used].map(([capability, consumers]) => (
              <a key={capability} href={`/settings?section=${CAPABILITY_SECTION[capability]}`} className="underline hover:text-foreground">
                {uiText(CAPABILITY_LABEL[capability])} · {new Intl.ListFormat(currentUiLocale(), { style: "narrow" }).format(consumers.map((consumer) => consumerLabel(capability, consumer)))}
              </a>
            ))}
          </span>
        </span>
      )}
    </div>
  );
}
