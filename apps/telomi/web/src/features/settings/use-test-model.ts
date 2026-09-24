import { uiText } from "@/app/ui-text";

/**
 * The verdict of one connection probe, as product copy. The frame is localized; an upstream
 * diagnostic is carried through verbatim, because it is the only text that says what to fix.
 */
export function connectionTestFeedback(
  result: { ok?: boolean; error?: string; durationMs?: number },
  modelId: string,
): { kind: "ok" | "err"; text: string } {
  if (result.ok) {
    return {
      kind: "ok",
      text: uiText("settings.connections.testOkModel", { ms: result.durationMs ?? 0, model: modelId }),
    };
  }
  return {
    kind: "err",
    text: connectionTestFailureText(result.error),
  };
}

/** A failure line the user can read even when the Provider answers in another language. */
export function connectionTestFailureText(error: string | undefined): string {
  return uiText("settings.connections.testFailed", {
    error: error?.trim() || uiText("settings.codexaccountsinline.unknownError"),
  });
}
