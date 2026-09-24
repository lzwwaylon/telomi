import { uiText } from "@/app/ui-text";
import { BTN_PRIMARY } from "./settings-styles";

const DISCARD = "rounded-[0.45rem] border border-border px-2.5 py-1 text-[0.82rem] hover:bg-muted disabled:opacity-60";

/**
 * Board edits the page is still holding: the board shows them, this says they have changed nothing
 * yet and offers to keep them for later, to activate them, or to drop them and go back to what is
 * saved. A row still waiting for its model leaves nothing to save, so only dropping them stays
 * open until it is chosen.
 */
export function UnsavedChangesNotice({ busy, incomplete, onSave, onApply, onDiscard, testId }: {
  busy: boolean;
  /** A row has no complete selection yet, so nothing can be saved. */
  incomplete?: boolean;
  onSave: () => void;
  onApply: () => void;
  onDiscard: () => void;
  testId: string;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-[0.55rem] border border-[var(--warm-line)] bg-[var(--warm-soft)] px-3 py-2 text-[0.85rem]" data-testid={testId}>
      <span className="flex-1 min-w-[12rem]">{uiText(incomplete ? "settings.board.unsavedIncomplete" : "settings.board.unsavedHint")}</span>
      <button type="button" className={BTN_PRIMARY} disabled={busy || incomplete} onClick={onSave} data-testid={`${testId}-save`}>{uiText("settings.board.saveForLater")}</button>
      <button type="button" className={`${BTN_PRIMARY} border-[var(--warm-line)]`} disabled={busy || incomplete} onClick={onApply} data-testid={`${testId}-apply`}>{uiText("settings.board.saveAndApply")}</button>
      <button type="button" className={DISCARD} disabled={busy} onClick={onDiscard} data-testid={`${testId}-discard`}>{uiText("settings.board.discardChanges")}</button>
    </div>
  );
}

/**
 * A draft the server kept: the board already shows the draft's selections; this says the active
 * configuration is still the old one and offers to apply or drop the draft. It reads as a failed
 * attempt unless the page says how the draft was saved.
 */
export function PendingConfigNotice({ busy, onApply, onDiscard, testId, hint }: {
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  testId: string;
  /** Why the draft is waiting, when it is not the last attempt that failed. */
  hint?: string;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-[0.55rem] border border-border bg-muted/40 px-3 py-2 text-[0.85rem]" data-testid={testId}>
      <span className="flex-1 min-w-[12rem]">{hint ?? uiText("settings.board.savedForLater")}</span>
      <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onApply} data-testid={`${testId}-apply`}>{uiText("settings.board.applyPending")}</button>
      <button type="button" className={DISCARD} disabled={busy} onClick={onDiscard} data-testid={`${testId}-discard`}>{uiText("settings.board.discardPending")}</button>
    </div>
  );
}
