import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ConnectionCapability } from "@shared/connections.js";
import { apiClient } from "@/shared/lib/api-client";
import { uiText } from "@/app/ui-text";
import { BTN_PRIMARY, SELECT_CLS } from "./settings-styles";
import { connectionTestFailureText } from "./use-test-model";

const MANUAL = "__manual__";

/**
 * A value from a known list, shown as a real select so every option is visible at a glance; a
 * value the list lacks is typed after choosing "manual". The current value stays selectable when
 * the list no longer holds it, and an empty list is plain text.
 */
export function ListedInput({ options, value, onChange, listId, disabled, className, placeholder, emptyLabel, label }: {
  options: Array<{ id: string; name?: string }>;
  value: string;
  onChange: (value: string) => void;
  listId: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /** What an empty value means where it is a valid choice; "choose one" otherwise. */
  emptyLabel?: string;
  /**
   * What this field chooses, and for which row. A table cell has no visible label of its own, so
   * without this a screen reader announces a row of unnamed comboboxes.
   */
  label?: string;
}) {
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState(value);
  const signature = options.map((option) => option.id).join("\n");
  useEffect(() => { setManual(false); }, [signature]);
  useEffect(() => { setDraft(value); }, [value]);
  if (options.length === 0 || manual) {
    // Typing is not choosing: a change applies the value, so it is sent once the field is left or Enter is pressed, never half typed.
    const commit = () => { if (draft.trim() !== value) onChange(draft.trim()); };
    return <input className={className ?? SELECT_CLS} value={draft} disabled={disabled} placeholder={placeholder} autoFocus={manual} aria-label={label} data-testid={`${listId}-manual`}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />;
  }
  const listed = options.some((option) => option.id === value);
  return (
    <select className={className ?? SELECT_CLS} value={value} disabled={disabled} aria-label={label} data-testid={listId}
      onChange={(event) => { if (event.target.value === MANUAL) { setManual(true); return; } onChange(event.target.value); }}>
      {!value && <option value="">{emptyLabel ?? uiText("settings.connections.chooseOne")}</option>}
      {value && !listed && <option value={value}>{value} · {uiText("settings.connections.unlisted")}</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.name && option.name !== option.id ? `${option.name} · ${option.id}` : option.id}</option>)}
      <option value={MANUAL}>{uiText("settings.connections.manual")}</option>
    </select>
  );
}

type ProbeResult = { ok: true; durationMs: number; detail: string } | { ok: false; durationMs: number; error: string };

/**
 * Run the capability once against the chosen connection and model, the way its consumer will,
 * and show the answer inline. The result belongs to the selection it was made for; changing any
 * field clears it.
 */
export function ConnectionTestButton({ capability, connection, model, voice, disabled, testId, className, onSettled }: {
  capability: ConnectionCapability;
  connection: string;
  model: string;
  voice?: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
  /** Called once the probe answered; a row whose status reflects the verdict re-reads it here. */
  onSettled?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  useEffect(() => { setResult(null); }, [capability, connection, model, voice]);
  const run = async () => {
    setBusy(true); setResult(null);
    try {
      setResult(await apiClient.post<ProbeResult>(`/api/connections/${encodeURIComponent(connection)}/test`, { capability, model, voice }));
    } catch (error) {
      setResult({ ok: false, durationMs: 0, error: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); onSettled?.(); }
  };
  return (
    <span className={`flex flex-wrap items-center gap-2 text-xs ${className ?? ""}`.trim()} data-testid={testId}>
      <button type="button" className={`${BTN_PRIMARY} whitespace-nowrap`} disabled={disabled || busy || !connection || !model.trim()} onClick={() => void run()}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
        {uiText(busy ? "settings.connections.testing" : "settings.page.test")}
      </button>
      {result && (
        <span role="status" className={result.ok ? "text-emerald-600 dark:text-emerald-400 break-all" : "text-destructive break-all"}>
          {result.ok ? uiText("settings.connections.testOk", { detail: result.detail, ms: result.durationMs }) : connectionTestFailureText(result.error)}
        </span>
      )}
    </span>
  );
}
