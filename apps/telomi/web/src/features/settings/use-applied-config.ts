import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/lib/api-client";

/**
 * A configuration the Runtime validates and activates as one unit. Every answer replaces local
 * state, so what the page shows is what the server holds. A rejected edit reports why and re-reads
 * the active configuration, which now carries the rejected draft as `pending`: pages build further
 * edits on it, and offer to retry or discard it. A page may also save a draft for later, which
 * keeps it as `pending` without activating it.
 *
 * An edit made while another applies waits for it, and only the latest waiting edit is sent. An
 * edit given as a function is built when it is sent, from what the server holds by then, so a
 * second quick edit neither collides with the first nor undoes it. Applying without an edit
 * retries the saved draft.
 */
export function useAppliedConfig<T extends { pending?: unknown }>(path: string, pollMs = 0) {
  const [state, setStateValue] = useState<T>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef<T>();
  const waiting = useRef<{ edit: object | ((current: T) => unknown) } | null>(null);
  const applying = useRef(false);

  const setState = useCallback((next: T) => { latest.current = next; setStateValue(next); }, []);

  const reload = useCallback(() => apiClient.get<T>(path)
    .then((next) => { setState(next); })
    .catch((err) => setError(err instanceof Error ? err.message : String(err))), [path, setState]);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const timer = window.setInterval(() => { void reload(); }, pollMs);
    return () => window.clearInterval(timer);
  }, [reload, pollMs]);

  const apply = useCallback(async (edit: object | ((current: T) => unknown) = {}) => {
    waiting.current = { edit };
    if (applying.current) return;
    applying.current = true;
    setBusy(true);
    try {
      while (waiting.current) {
        const next = waiting.current.edit;
        waiting.current = null;
        setError("");
        try {
          setState(await apiClient.post<T>(`${path}/apply`, typeof next === "function" ? next(latest.current as T) : next));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          await reload();
        }
      }
    } finally {
      applying.current = false;
      setBusy(false);
    }
  }, [path, reload, setState]);

  /** Keep a draft for later without activating it; the active configuration stays as it is. */
  const savePending = useCallback(async (config: object) => {
    setBusy(true);
    setError("");
    try {
      setState(await apiClient.post<T>(`${path}/pending`, config));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [path, setState]);

  /** Drop the saved draft; the active configuration stays as it is. */
  const discard = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setState(await apiClient.delete<T>(`${path}/pending`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [path, setState]);

  return { state, error, busy, apply, savePending, discard, reload };
}
