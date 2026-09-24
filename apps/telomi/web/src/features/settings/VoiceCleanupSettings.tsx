import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS,
  normalizeVoiceCleanupInstructions,
} from "@shared/voice-cleanup.js";
import { uiText } from "@/app/ui-text";

export function VoiceCleanupSettings({
  enabled,
  instructions,
  disabled,
  onPatch,
}: {
  enabled: boolean;
  instructions: string;
  disabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [instructionDraft, setInstructionDraft] = useState(instructions);
  useEffect(() => setInstructionDraft(instructions), [instructions]);

  // Preferences only reach the Runtime through the save button; typing alone never changes what recordings use.
  const normalizedDraft = normalizeVoiceCleanupInstructions(instructionDraft);
  const dirty = normalizedDraft !== instructions;
  const saveInstructions = () => {
    setInstructionDraft(normalizedDraft);
    if (dirty) onPatch({ sttCleanupInstructions: normalizedDraft });
  };

  return (
    <section
      className="grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 py-3"
      data-testid="voice-cleanup-settings"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 max-[640px]:grid-cols-1">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-[0.45rem] bg-[var(--foreground-5)] text-muted-foreground">
            <Sparkles className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 grid gap-1">
            <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.voicecleanupsettings.aiTextCleanup")}</h3>
            <p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">
              {uiText("settings.voicecleanupsettings.afterVocabularyCorrectionUseASmallModelToClean")}
            </p>
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-[0.82rem] text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) =>
              onPatch({ sttCleanupEnabled: event.target.checked })
            }
            data-testid="voice-cleanup-enabled"
          />
          {uiText("settings.voicecleanupsettings.enableCleanup")}
        </label>
      </div>

      <details className="grid gap-1.5 rounded-[0.5rem] border border-border bg-popover/40 px-2.5 py-2 text-[0.8rem] text-muted-foreground" data-testid="voice-cleanup-built-in-rules">
        <summary className="cursor-pointer select-none text-[0.82rem] font-medium text-foreground">
          {uiText("settings.voicecleanupsettings.builtInRules")}
        </summary>
        <span className="text-[0.74rem] leading-relaxed">{uiText("settings.voicecleanupsettings.builtInRulesHint")}</span>
        {/* A localized description of what the fixed rules do; the model instructions themselves live in the Agent Bundle. */}
        <ul className="m-0 mt-1.5 grid list-disc gap-1 pl-4 text-[0.78rem] leading-relaxed text-foreground">
          {uiText("settings.voicecleanupsettings.builtInRulesList").split("\n").map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </details>

      <label className="grid gap-1.5 text-[0.8rem] text-muted-foreground">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>{uiText("settings.voicecleanupsettings.customCleanupInstructionsOptional")}</span>
          <span aria-live="polite">
            {Array.from(instructionDraft).length} /{" "}
            {MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS}
          </span>
        </span>
        <textarea
          value={instructionDraft}
          onChange={(event) => setInstructionDraft(event.target.value)}
          maxLength={MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS}
          rows={4}
          placeholder={uiText("settings.voicecleanupsettings.forExamplePreserveTheOriginalSpellingOfMflowPostgresql")}
          aria-label={uiText("settings.voicecleanupsettings.customAiTextCleanupInstructions")}
          data-testid="voice-cleanup-instructions"
          disabled={disabled || !enabled}
          className="min-h-[6.5rem] w-full resize-y rounded-[0.5rem] border border-border bg-popover px-2.5 py-2 text-[0.82rem] leading-relaxed text-foreground outline-none transition-colors focus-visible:border-[var(--input)] disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="text-[0.74rem] leading-relaxed">
          {uiText("settings.voicecleanupsettings.useThisToRefineTerminologyFormattingAndStyleIt")}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={saveInstructions}
            disabled={disabled || !enabled || !dirty}
            data-testid="voice-cleanup-instructions-save"
            className="inline-flex min-h-8 items-center justify-center rounded-[0.5rem] border border-border bg-card px-3 py-1.5 text-[0.78rem] font-medium text-foreground transition-colors hover:bg-[var(--foreground-5)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uiText("settings.voicecleanupsettings.savePreferences")}
          </button>
          <button
            type="button"
            onClick={() => setInstructionDraft(instructions)}
            disabled={disabled || !enabled || !dirty}
            data-testid="voice-cleanup-instructions-discard"
            className="inline-flex min-h-8 items-center justify-center rounded-[0.5rem] px-2 py-1.5 text-[0.78rem] text-muted-foreground transition-colors hover:bg-[var(--foreground-5)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uiText("settings.voicecleanupsettings.discardChanges")}
          </button>
          {dirty && <span className="text-[0.74rem]" aria-live="polite">{uiText("settings.voicecleanupsettings.unsavedChanges")}</span>}
        </span>
      </label>

      <div className="rounded-[0.45rem] bg-[var(--foreground-5)] px-2.5 py-2 text-[0.78rem] leading-relaxed text-muted-foreground">
        {uiText("settings.voicecleanupsettings.thisIsADeterministicRuntimePostProcessingStepNot")}
      </div>
    </section>
  );
}
