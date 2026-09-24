interface RefreshEventTarget {
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
}

interface RefreshDocumentTarget extends RefreshEventTarget {
  visibilityState: DocumentVisibilityState;
}

interface VoiceHistoryRefreshTargets {
  windowTarget: RefreshEventTarget;
  documentTarget: RefreshDocumentTarget;
}

export function subscribeVoiceHistoryForegroundRefresh(
  onRefresh: () => void,
  targets?: VoiceHistoryRefreshTargets,
): () => void {
  const windowTarget = targets?.windowTarget ?? window;
  const documentTarget = targets?.documentTarget ?? document;
  let active = true;
  let scheduled = false;

  const requestRefresh = () => {
    if (!active || documentTarget.visibilityState !== "visible" || scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (active) onRefresh();
    });
  };

  windowTarget.addEventListener("focus", requestRefresh);
  documentTarget.addEventListener("visibilitychange", requestRefresh);

  return () => {
    active = false;
    windowTarget.removeEventListener("focus", requestRefresh);
    documentTarget.removeEventListener("visibilitychange", requestRefresh);
  };
}
