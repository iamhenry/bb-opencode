import { unwrapPluginRpcResult } from "./rpc.js";

const REVERTED_ATTR = "data-oc-reverted";
const POLL_MS = 800;
const MAX_THREAD_IDS = 8;

type RevertProjection = { hiddenRowIds: string[] };

function threadIdFromPath(pathname = window.location.pathname): string | null {
  const match = decodeURIComponent(pathname).match(/\/threads\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function visibleThreadIds(): string[] {
  const ids = new Set<string>();
  const urlId = threadIdFromPath();
  if (urlId) ids.add(urlId);
  document
    .querySelectorAll<HTMLElement>(
      '[data-sidebar-thread-id][aria-current="page"]',
    )
    .forEach((anchor) => {
      const threadId = anchor.dataset.sidebarThreadId;
      if (threadId) ids.add(threadId);
    });
  return [...ids].slice(0, MAX_THREAD_IDS);
}

function project(hiddenRowIds: ReadonlySet<string>): void {
  document
    .querySelectorAll<HTMLElement>("[data-timeline-row-id]")
    .forEach((row) => {
      const hidden = hiddenRowIds.has(row.dataset.timelineRowId ?? "");
      if (hidden) row.setAttribute(REVERTED_ATTR, "true");
      else row.removeAttribute(REVERTED_ATTR);
    });
}

function clearProjection(): void {
  document
    .querySelectorAll<HTMLElement>(`[${REVERTED_ATTR}]`)
    .forEach((row) => row.removeAttribute(REVERTED_ATTR));
}

export function mountRevertTimeline(args: {
  pluginId: string;
  signal: AbortSignal;
}): () => void {
  let hiddenRowIds = new Set<string>();
  let inFlight = false;

  const refresh = async () => {
    if (args.signal.aborted || inFlight) return;
    const threadIds = visibleThreadIds();
    if (threadIds.length === 0) {
      hiddenRowIds = new Set();
      clearProjection();
      return;
    }
    inFlight = true;
    try {
      const results = await Promise.all(
        threadIds.map(async (threadId) => {
          const response = await fetch(
            `/api/v1/plugins/${encodeURIComponent(args.pluginId)}/rpc/revertState`,
            {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ threadId }),
              signal: args.signal,
            },
          );
          const envelope: unknown = await response.json();
          return unwrapPluginRpcResult<RevertProjection>(
            envelope,
            "revertState",
          ).hiddenRowIds;
        }),
      );
      hiddenRowIds = new Set(results.flat());
      project(hiddenRowIds);
    } catch {
      /* Keep the last authoritative projection through transient reconnects. */
    } finally {
      inFlight = false;
    }
  };

  void refresh();
  const timer = window.setInterval(() => void refresh(), POLL_MS);
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      project(hiddenRowIds);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    window.clearInterval(timer);
    if (frame) window.cancelAnimationFrame(frame);
    observer.disconnect();
    clearProjection();
  };
}
