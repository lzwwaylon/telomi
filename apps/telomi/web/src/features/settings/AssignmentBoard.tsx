import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import type { ConnectionCapability, ConnectionSummary } from "@shared/connections.js";
import { uiText } from "@/app/ui-text";
import { cn } from "@/shared/lib/utils";
import { ConnectionTestButton, ListedInput } from "./ConnectionModelFields";
import { keptVoice } from "./audio-config";
import { SELECT_CLS } from "./settings-styles";

/** What one consumer runs: a connection, one of its models, and the capability's extra knobs. */
export interface BoardSelection {
  connection: string;
  model: string;
  voice?: string;
  rate?: number;
  depth?: string;
}

export type BoardColumn = "voice" | "rate" | "depth";

export interface BoardStage {
  key: string;
  label: string;
  /** `null` follows the row's depth. */
  own: string | null;
  resolved: string;
}

export interface BoardRow {
  id: string;
  label: string;
  hint?: string;
  /**
   * The row's own selection. `null` means it follows the first row; an `optional` row with `null`
   * has nothing selected at all.
   */
  own: Partial<BoardSelection> | null;
  /** What actually serves this row, own or inherited. */
  resolved: BoardSelection | null;
  optional?: boolean;
  /** Whether the row can follow something when it has no own selection; every row but the first does by default. */
  inherits?: boolean;
  /** Connections this row may pick from, when narrower than the board's. */
  connections?: ConnectionSummary[];
  /** `link` leads to where the user fixes what the status reports. */
  status?: { text: string; tone: "ok" | "pending" | "error" | "busy"; link?: { label: string; href: string } };
  /** Depth-only sub rows, e.g. the Run Stages of a task role. */
  stages?: BoardStage[];
}

export interface AssignmentBoardProps {
  capability: ConnectionCapability;
  rows: BoardRow[];
  connections: ConnectionSummary[];
  columns?: BoardColumn[];
  depthLevels?: string[];
  disabled?: boolean;
  /** A change is being validated and activated; the board waits for the answer. */
  busy?: boolean;
  /**
   * A change is being applied in the background: the cells stay usable and keep focus, and what the
   * user chose stays shown until the saving settles.
   */
  saving?: boolean;
  testId?: string;
  /** A complete selection, or `null` to follow the first row again. */
  onChange: (rowId: string, next: BoardSelection | null) => void;
  /**
   * A row's half-finished selection, or `null` once it is complete or reset. A page that holds
   * board edits until the user saves them needs these as well, so a row waiting for its model can
   * be shown as unsaved, kept out of what is saved, and dropped along with the rest.
   */
  onHalfEdit?: (rowId: string, half: Partial<BoardSelection> | null) => void;
  onStageDepthChange?: (key: string, level: string | null) => void;
  /** What a complete row offers beside its cells; the capability's connection test by default. */
  action?: (row: BoardRow, selection: BoardSelection) => ReactNode;
}

const INPUT_SM = cn(SELECT_CLS, "px-2 py-1.5 text-[0.85rem]");
const INHERITED = "text-muted-foreground";

function selectionComplete(value: Partial<BoardSelection> | null | undefined): value is BoardSelection {
  return Boolean(value?.connection && value.model);
}

/** A rate edited in place: it applies once, when the field is left or Enter is pressed; a value out of range goes back to the one held. */
function RateInput({ value, onCommit, className, disabled, label, testId }: { value: number; onCommit: (rate: number) => void; className: string; disabled?: boolean; label: string; testId: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const rate = Number(draft);
    if (!draft.trim() || !(rate >= 0.25 && rate <= 4)) { setDraft(String(value)); return; }
    if (rate !== value) onCommit(rate);
  };
  return <input type="number" min="0.25" max="4" step="0.05" className={className} value={draft} disabled={disabled} aria-label={label} data-testid={testId}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />;
}

/**
 * The first row is the capability's default; every other row follows it until the user changes
 * one of its cells, which makes the row its own. An inherited cell shows the inherited value
 * muted; the reset control takes the row back to following the default. A connection change
 * clears the model, and the row is written only once both are chosen. A row with nothing to
 * inherit (the default itself, or an `optional` extra) is simply set or empty.
 */
export function AssignmentBoard({ capability, rows, connections, columns = [], depthLevels = [], disabled, busy, saving, testId, onChange, onHalfEdit, onStageDepthChange, action }: AssignmentBoardProps) {
  // What the user chose stays shown here: a half-finished selection until it is complete or its row changes
  // on the server, a complete one until saving settles and the server answers with the rows it holds,
  // whether it took the change or refused it.
  const [drafts, setDrafts] = useState<Record<string, Partial<BoardSelection>>>({});
  const held = useRef(new Map<string, string>());
  useEffect(() => {
    if (busy || saving) return;
    const before = held.current;
    const now = new Map(rows.map((row) => [row.id, JSON.stringify(row.own)]));
    held.current = now;
    setDrafts((current) => {
      const kept = Object.entries(current).filter(([id, draft]) => !selectionComplete(draft) && before.get(id) === now.get(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [rows, busy, saving]);
  // A background save shows itself only once it takes long enough to notice.
  const [slowSave, setSlowSave] = useState(false);
  useEffect(() => {
    if (!saving) { setSlowSave(false); return; }
    const timer = window.setTimeout(() => setSlowSave(true), 400);
    return () => window.clearTimeout(timer);
  }, [saving]);
  const [first, ...rest] = rows;
  const gridCols = `minmax(170px,1.2fr) minmax(130px,0.8fr) minmax(170px,1.3fr)${columns.map((column) => column === "rate" ? " 84px" : column === "depth" ? " 110px" : " minmax(130px,0.9fr)").join("")} auto minmax(96px,0.6fr)`;

  const commit = (row: BoardRow, patch: Partial<BoardSelection>) => {
    const base = drafts[row.id] ?? row.own ?? row.resolved ?? {};
    const next: Partial<BoardSelection> = { ...base, ...patch };
    // A voice survives a connection or model change only where the new model lists it.
    if (columns.includes("voice") && next.voice && ("connection" in patch || "model" in patch)) {
      const listed = connections.find((item) => item.id === next.connection)?.models[capability]?.find((model) => model.id === next.model)?.supportedVoices ?? [];
      next.voice = keptVoice(next.voice, listed);
    }
    setDrafts((current) => ({ ...current, [row.id]: next }));
    const complete = selectionComplete(next);
    onHalfEdit?.(row.id, complete ? null : next);
    if (complete) onChange(row.id, next);
  };

  const reset = (row: BoardRow) => { onHalfEdit?.(row.id, null); onChange(row.id, null); };

  const renderRow = (row: BoardRow, isDefault: boolean) => {
    const draft = drafts[row.id];
    const shown: Partial<BoardSelection> | null = draft ?? row.own ?? row.resolved;
    // Only connections that can serve now are offered; a saved value no longer among them stays visible.
    const offered = (row.connections ?? connections).filter((item) => item.capabilities.includes(capability) && item.status === "connected");
    const inherits = row.inherits ?? !isDefault;
    const inherited = inherits && !draft && row.own === null && row.resolved !== null;
    const connection = connections.find((item) => item.id === shown?.connection);
    const models = connection?.models[capability] ?? [];
    const voices = models.find((model) => model.id === shown?.model)?.supportedVoices ?? [];
    const cellCls = cn(INPUT_SM, inherited && INHERITED);
    // A cell has no visible label of its own and the column header repeats down every row, so each
    // control names both what it chooses and the row it belongs to.
    const cellLabel = (column: Parameters<typeof uiText>[0]) => uiText("settings.board.cellLabel", { column: uiText(column), row: row.label });
    const cell = (column: BoardColumn): ReactNode => {
      if (column === "voice") return <ListedInput key={column} options={voices.map((voice) => ({ id: voice }))} value={shown?.voice ?? ""} listId={`${testId ?? capability}-voice-${row.id}`} disabled={disabled || busy} className={cellCls} label={cellLabel("settings.page.voice")} placeholder={uiText("settings.audioGeneration.serverDefault")} emptyLabel={uiText("settings.audioGeneration.serverDefault")} onChange={(voice) => commit(row, { voice })} />;
      if (column === "rate") return <RateInput key={column} className={cellCls} value={shown?.rate ?? 1} disabled={disabled || busy} label={cellLabel("settings.audioGeneration.rate")} testId={`${testId ?? capability}-rate-${row.id}`} onCommit={(rate) => commit(row, { rate })} />;
      return (
        <select key={column} className={cellCls} value={shown?.depth ?? ""} disabled={disabled || busy} aria-label={cellLabel("settings.board.depth")} data-testid={`${testId ?? capability}-depth-${row.id}`} onChange={(event) => commit(row, { depth: event.target.value })}>
          {!shown?.depth && <option value="">{uiText("settings.connections.chooseOne")}</option>}
          {depthLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      );
    };
    return (
      <div key={row.id} className="contents" data-testid={`${testId ?? capability}-row-${row.id}`} data-inherited={inherited || undefined}>
        <div className={cn("grid gap-0.5 min-w-0 self-center", isDefault && "font-medium")}>
          <span className="text-[0.88rem] text-foreground">{row.label}</span>
          {row.hint && <span className="text-[0.76rem] font-normal text-muted-foreground">{row.hint}</span>}
        </div>
        <select className={cellCls} value={shown?.connection ?? ""} disabled={disabled || busy} aria-label={cellLabel("settings.board.connection")} data-testid={`${testId ?? capability}-connection-${row.id}`}
          onChange={(event) => commit(row, { connection: event.target.value, model: "" })}>
          {!shown?.connection && <option value="">{row.optional ? uiText("settings.board.none") : uiText("settings.connections.chooseOne")}</option>}
          {shown?.connection && !offered.some((item) => item.id === shown.connection) && <option value={shown.connection}>{shown.connection}</option>}
          {offered.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select>
        <ListedInput options={models} value={shown?.model ?? ""} listId={`${testId ?? capability}-model-${row.id}`} disabled={disabled || busy || !shown?.connection} className={cellCls} label={cellLabel("common.model")} placeholder={uiText("settings.connections.modelId")} onChange={(model) => commit(row, { model })} />
        {columns.map(cell)}
        <div className="flex items-center gap-1 self-center">
          {selectionComplete(shown) && (action ? action(row, shown) : <ConnectionTestButton capability={capability} connection={shown.connection} model={shown.model} voice={shown.voice} disabled={disabled || busy} testId={`${testId ?? capability}-test-${row.id}`} />)}
          {row.own !== null && (row.optional || inherits) && (
            <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-[0.45rem] text-muted-foreground hover:bg-[var(--foreground-5)] hover:text-foreground disabled:opacity-50" disabled={disabled || busy}
              onClick={() => reset(row)} aria-label={uiText(row.optional ? "settings.board.clear" : "settings.board.followDefault")} title={uiText(row.optional ? "settings.board.clear" : "settings.board.followDefault")} data-testid={`${testId ?? capability}-reset-${row.id}`}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        <div className={cn("self-center text-[0.78rem] break-words", row.status?.tone === "error" ? "text-destructive" : row.status?.tone === "ok" ? "text-[var(--success-text)]" : "text-muted-foreground")} data-testid={`${testId ?? capability}-status-${row.id}`}>
          {row.status?.tone === "busy" && <Loader2 className="inline h-3 w-3 animate-spin mr-1" aria-hidden />}
          {row.status?.text}
          {row.status?.link && <a href={row.status.link.href} className="mt-0.5 block underline hover:text-foreground" data-testid={`${testId ?? capability}-status-link-${row.id}`}>{row.status.link.label}</a>}
        </div>
        {row.stages?.map((stage) => (
          <div key={stage.key} className="contents" data-testid={`${testId ?? capability}-stage-${stage.key}`}>
            <div className="min-w-0 self-center pl-4 text-[0.8rem] text-muted-foreground" style={{ gridColumn: `1 / ${4 + columns.indexOf("depth")}` }}>└ {stage.label}</div>
            <select className={cn(INPUT_SM, stage.own === null && INHERITED)} value={stage.own ?? stage.resolved} disabled={disabled || busy} aria-label={uiText("settings.board.depth")} data-testid={`${testId ?? capability}-depth-${stage.key}`}
              onChange={(event) => onStageDepthChange?.(stage.key, event.target.value)}>
              {depthLevels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
            <div className="self-center">
              {stage.own !== null && (
                <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-[0.45rem] text-muted-foreground hover:bg-[var(--foreground-5)] hover:text-foreground disabled:opacity-50" disabled={disabled || busy}
                  onClick={() => onStageDepthChange?.(stage.key, null)} aria-label={uiText("settings.board.followDefault")} title={uiText("settings.board.followDefault")}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
            <div />
          </div>
        ))}
      </div>
    );
  };

  // Below the columns' minimums the board scrolls sideways instead of crushing its labels.
  return (
    <div className="overflow-x-auto rounded-[0.55rem] border border-border bg-card">
    <div className="grid min-w-[760px] gap-x-3 gap-y-2.5 px-3 py-3 items-center" style={{ gridTemplateColumns: gridCols }} data-testid={testId ?? `board-${capability}`}>
      <div className="contents text-[0.72rem] uppercase tracking-wide text-[var(--foreground-40)]">
        <span>{uiText("settings.board.consumer")}</span>
        <span>{uiText("settings.board.connection")}</span>
        <span>{uiText("common.model")}</span>
        {columns.map((column) => <span key={column}>{uiText(column === "voice" ? "settings.page.voice" : column === "rate" ? "settings.audioGeneration.rate" : "settings.board.depth")}</span>)}
        <span />
        <span className="inline-flex items-center gap-1.5">
          {uiText("settings.board.status")}
          {(busy || slowSave) && <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[var(--warm)]" data-testid={`${testId ?? capability}-saving`}><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{uiText("settings.board.saving")}</span>}
        </span>
      </div>
      {first && renderRow(first, true)}
      {rest.length > 0 && <div className="col-span-full border-t border-border" />}
      {rest.map((row) => renderRow(row, false))}
    </div>
    </div>
  );
}
