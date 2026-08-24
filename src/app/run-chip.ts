import { unwrapPluginRpcResult } from "./rpc.js";

const RUN_ATTR = "data-oc-run";
const ALIGN_ATTR = "data-oc-align";
const SENT_AT_ATTR = "data-bb-sent-at";
const POLL_MS = 400;
const REFRESH_MS = 1500;
const MAX_THREAD_IDS = 8;

type ChipRow = { id: string; label: string; title: string };

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

  return Array.from(ids).slice(0, MAX_THREAD_IDS);
}

function findTimeHost(row: HTMLElement): HTMLElement | null {
  const group = row.querySelector<HTMLElement>(".group\\/message");
  if (!group) return null;
  return (
    group.querySelector<HTMLElement>(":scope > .mt-1.flex.justify-end") ?? group
  );
}

function messageAlign(row: HTMLElement): "start" | "end" {
  const group = row.querySelector<HTMLElement>(".group\\/message");
  return group?.classList.contains("ml-auto") ? "end" : "start";
}

const titledByUs = new WeakMap<HTMLElement, string>();

function applyGutter(host: HTMLElement): void {
  const sentAt = host.getAttribute(SENT_AT_ATTR);
  if (!sentAt || !host.classList.contains("group/message")) {
    if (host.style.getPropertyValue("--oc-time-gutter")) {
      host.style.removeProperty("--oc-time-gutter");
    }
    return;
  }
  const gutter = `${sentAt.length + 1}ch`;
  if (host.style.getPropertyValue("--oc-time-gutter") !== gutter) {
    host.style.setProperty("--oc-time-gutter", gutter);
  }
}

function decorate(chips: Map<string, ChipRow>): void {
  const keep = new Set<HTMLElement>();

  document
    .querySelectorAll<HTMLElement>("[data-timeline-row-id]")
    .forEach((row) => {
      const id = row.dataset.timelineRowId;
      const chip = id ? chips.get(id) : undefined;
      const host = findTimeHost(row);
      if (!host) return;
      if (!chip) {
        clearHost(host);
        return;
      }

      const align = messageAlign(row);
      if (host.getAttribute(RUN_ATTR) !== chip.label) {
        host.setAttribute(RUN_ATTR, chip.label);
      }
      if (host.getAttribute(ALIGN_ATTR) !== align) {
        host.setAttribute(ALIGN_ATTR, align);
      }
      if (!host.title.startsWith("Sent ")) {
        host.title = chip.title;
        titledByUs.set(host, chip.title);
      }
      if (align === "end") applyGutter(host);
      else if (host.style.getPropertyValue("--oc-time-gutter")) {
        host.style.removeProperty("--oc-time-gutter");
      }
      keep.add(host);
    });

  document.querySelectorAll<HTMLElement>(`[${RUN_ATTR}]`).forEach((element) => {
    if (keep.has(element)) return;
    clearHost(element);
  });
}

function clearHost(host: HTMLElement): void {
  if (host.hasAttribute(RUN_ATTR)) host.removeAttribute(RUN_ATTR);
  if (host.hasAttribute(ALIGN_ATTR)) host.removeAttribute(ALIGN_ATTR);
  if (host.style.getPropertyValue("--oc-time-gutter")) {
    host.style.removeProperty("--oc-time-gutter");
  }
  const written = titledByUs.get(host);
  if (written && host.title === written) host.removeAttribute("title");
  titledByUs.delete(host);
}

function clearDecorations(): void {
  document.querySelectorAll<HTMLElement>(`[${RUN_ATTR}]`).forEach(clearHost);
}

export function mountRunChips(args: {
  pluginId: string;
  signal: AbortSignal;
}): () => void {
  const chips = new Map<string, ChipRow>();
  let inFlight: Promise<void> | null = null;
  let lastRefreshAt = 0;
  let lastThreadKey = "";

  const load = async (threadIds: string[]) => {
    const response = await fetch(
      `/api/v1/plugins/${encodeURIComponent(args.pluginId)}/rpc/messageRunChips`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds }),
        signal: args.signal,
      },
    );
    const envelope: unknown = await response.json();
    const result = unwrapPluginRpcResult<{ rows: ChipRow[] }>(
      envelope,
      "messageRunChips",
    );
    chips.clear();
    for (const row of result.rows) chips.set(row.id, row);
  };

  const refresh = (force: boolean) => {
    if (args.signal.aborted) return;
    const threadIds = visibleThreadIds();
    if (threadIds.length === 0) {
      if (chips.size > 0) {
        chips.clear();
        clearDecorations();
      }
      return;
    }

    const threadKey = threadIds.slice().sort().join(",");
    const stale =
      force ||
      threadKey !== lastThreadKey ||
      Date.now() - lastRefreshAt >= REFRESH_MS;
    if (!stale) {
      decorate(chips);
      return;
    }
    if (inFlight) {
      decorate(chips);
      return;
    }

    lastThreadKey = threadKey;
    lastRefreshAt = Date.now();
    inFlight = load(threadIds)
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
        if (!args.signal.aborted) decorate(chips);
      });
  };

  refresh(true);
  const timer = window.setInterval(() => refresh(false), POLL_MS);
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      refresh(false);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    window.clearInterval(timer);
    if (frame) window.cancelAnimationFrame(frame);
    observer.disconnect();
    clearDecorations();
  };
}
