import { unwrapPluginRpcResult } from "./rpc.js";

const REVERTED_ATTR = "data-oc-reverted";
const POLL_MS = 800;
const MAX_THREAD_IDS = 8;
const ASSISTANT_ROW_SELECTOR =
  '[data-timeline-row-id*=":assistant:"]';
const REVERT_ACTION_SELECTOR =
  'button[aria-label="Revert from here"], button[title="Revert from here"]';
const REVERT_ICON_SELECTOR = "span[data-plugin-icon-asset]";
const BACK_ARROW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';
const BACK_ARROW_MASK = `url("data:image/svg+xml,${encodeURIComponent(BACK_ARROW_SVG)}")`;

type RevertProjection = { hiddenRowIds: string[] };
type ActionDisplay = { value: string; priority: string };
type IconMask = { value: string; priority: string };

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

function projectAssistantActions(
  hiddenActions: Map<HTMLElement, ActionDisplay>,
): void {
  const assistantRows = document.querySelectorAll<HTMLElement>(
    ASSISTANT_ROW_SELECTOR,
  );
  const keep = new Set<HTMLElement>();

  assistantRows.forEach((row) => {
    row
      .querySelectorAll<HTMLElement>(REVERT_ACTION_SELECTOR)
      .forEach((button) => {
        keep.add(button);
        if (!hiddenActions.has(button)) {
          hiddenActions.set(button, {
            value: button.style.getPropertyValue("display"),
            priority: button.style.getPropertyPriority("display"),
          });
        }
        if (
          button.style.getPropertyValue("display") !== "none" ||
          button.style.getPropertyPriority("display") !== "important"
        ) {
          button.style.setProperty("display", "none", "important");
        }
      });
  });

  hiddenActions.forEach((display, button) => {
    if (keep.has(button)) return;
    if (display.value) {
      button.style.setProperty("display", display.value, display.priority);
    } else {
      button.style.removeProperty("display");
    }
    hiddenActions.delete(button);
  });
}

function clearAssistantActions(
  hiddenActions: Map<HTMLElement, ActionDisplay>,
): void {
  hiddenActions.forEach((display, button) => {
    if (display.value) {
      button.style.setProperty("display", display.value, display.priority);
    } else {
      button.style.removeProperty("display");
    }
  });
  hiddenActions.clear();
}

function projectRevertIcons(
  changedIcons: Map<HTMLElement, IconMask[]>,
  pluginId: string,
): void {
  const pluginAsset = `/api/v1/plugins/${encodeURIComponent(pluginId)}/assets/icon`;
  const keep = new Set<HTMLElement>();

  document
    .querySelectorAll<HTMLElement>(REVERT_ACTION_SELECTOR)
    .forEach((button) => {
      button
        .querySelectorAll<HTMLElement>(REVERT_ICON_SELECTOR)
        .forEach((icon) => {
          const asset = icon.dataset.pluginIconAsset ?? "";
          if (asset !== pluginAsset && !asset.startsWith(`${pluginAsset}?`)) {
            return;
          }
          keep.add(icon);
          if (!changedIcons.has(icon)) {
            changedIcons.set(
              icon,
              ["mask-image", "-webkit-mask-image"].map((property) => ({
                value: icon.style.getPropertyValue(property),
                priority: icon.style.getPropertyPriority(property),
              })),
            );
          }
          icon.style.setProperty("mask-image", BACK_ARROW_MASK, "important");
          icon.style.setProperty(
            "-webkit-mask-image",
            BACK_ARROW_MASK,
            "important",
          );
        });
    });

  changedIcons.forEach((masks, icon) => {
    if (keep.has(icon)) return;
    ["mask-image", "-webkit-mask-image"].forEach((property, index) => {
      const mask = masks[index];
      if (mask.value) icon.style.setProperty(property, mask.value, mask.priority);
      else icon.style.removeProperty(property);
    });
    changedIcons.delete(icon);
  });
}

function clearRevertIcons(changedIcons: Map<HTMLElement, IconMask[]>): void {
  changedIcons.forEach((masks, icon) => {
    ["mask-image", "-webkit-mask-image"].forEach((property, index) => {
      const mask = masks[index];
      if (mask.value) icon.style.setProperty(property, mask.value, mask.priority);
      else icon.style.removeProperty(property);
    });
  });
  changedIcons.clear();
}

export function mountRevertTimeline(args: {
  pluginId: string;
  signal: AbortSignal;
}): () => void {
  let hiddenRowIds = new Set<string>();
  let inFlight = false;
  const hiddenActions = new Map<HTMLElement, ActionDisplay>();
  const changedIcons = new Map<HTMLElement, IconMask[]>();

  projectAssistantActions(hiddenActions);
  projectRevertIcons(changedIcons, args.pluginId);

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
      projectAssistantActions(hiddenActions);
      projectRevertIcons(changedIcons, args.pluginId);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    window.clearInterval(timer);
    if (frame) window.cancelAnimationFrame(frame);
    observer.disconnect();
    clearProjection();
    clearAssistantActions(hiddenActions);
    clearRevertIcons(changedIcons);
  };
}
