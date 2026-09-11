import { callPluginRpc, reportActionError } from "./rpc.js";

export const UPDATE_CONTROL_ATTR = "data-oc-update-control";
const POLL_MS = 2_000;

export type UpdateControlStatus = {
  eligible: boolean;
  canRestart: boolean;
  current: boolean;
  error: string | null;
};

export type UpdateControlRpc = {
  status(): Promise<UpdateControlStatus>;
  install(): Promise<{
    ok: boolean;
    error: string | null;
    pendingRestart?: boolean;
  }>;
  activate?(): Promise<{ ok: boolean; error: string | null }>;
};

const DOWNLOAD_ICON_SVG =
  '<svg class="oc-update__download" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 17c0 .93 0 1.395.102 1.777A3 3 0 0 0 5.223 20.9C5.605 21 6.07 21 7 21h10c.93 0 1.395 0 1.777-.102a3 3 0 0 0 2.12-2.121C21 18.395 21 17.93 21 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M16.5 11.5S13.186 16 12 16s-4.5-4.5-4.5-4.5M12 15V3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>';
const PROVIDER_ICON_SVG =
  '<svg class="oc-update__provider" viewBox="-72 -42 384 384" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M180 240H60V120H180V240Z" fill="currentColor" fill-opacity="0.45"/><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="currentColor"/></svg>';

function ariaLabel(node: Element): string {
  return node.getAttribute("aria-label") ?? "";
}

function isElement(node: ChildNode): node is HTMLElement {
  return node.nodeType === 1 && typeof (node as HTMLElement).getAttribute === "function";
}

export function findFooterMountTarget(doc: ParentNode): HTMLElement | null {
  const footers = doc.querySelectorAll("[data-sidebar='footer']");
  if (footers.length !== 1) return null;
  const footer = footers[0];
  if (!footer) return null;
  const menus = Array.from(footer.children).filter(
    (node): node is HTMLElement =>
      isElement(node) && node.getAttribute("data-sidebar") === "menu",
  );
  if (menus.length !== 1) return null;
  const menu = menus[0];
  const directItems = Array.from(menu.children).filter(isElement);
  const hasSpacer = directItems.some(
    (node) =>
      node.tagName.toUpperCase() === "LI" &&
      node.getAttribute("aria-hidden") === "true",
  );
  let settings = false;
  let bug = false;
  for (const node of Array.from(menu.querySelectorAll("[aria-label]"))) {
    const label = ariaLabel(node);
    if (label === "Settings" || label.startsWith("Settings ")) settings = true;
    if (label === "Report a bug") bug = true;
  }
  if (!hasSpacer || !settings || !bug) return null;
  return menu;
}

function defaultRpc(): UpdateControlRpc {
  return {
    status: () => callPluginRpc<UpdateControlStatus>("updateStatus", {}),
    install: () =>
      callPluginRpc<{
        ok: boolean;
        error: string | null;
        pendingRestart?: boolean;
      }>("installUpdate", {}),
    activate: () =>
      callPluginRpc<{ ok: boolean; error: string | null }>("restartToApply", {}),
  };
}

function paint(
  button: HTMLButtonElement,
  live: Element | null,
  state: "ready" | "pending" | "failed" | "pending-restart",
  error?: string,
): void {
  button.disabled = state === "pending";
  button.setAttribute("aria-busy", state === "pending" ? "true" : "false");
  button.dataset.state = state;
  const detail = button.parentElement?.querySelector(".oc-update__detail");
  if (state === "pending") {
    button.setAttribute("aria-label", "Updating OpenCode");
    button.title = "Updating OpenCode";
    if (detail) detail.textContent = "";
    if (live) live.textContent = "Updating OpenCode";
  } else if (state === "pending-restart") {
    button.setAttribute("aria-label", "Installed—restart pending");
    button.title = "Installed—restart pending";
    if (detail) detail.textContent = "";
    if (live) live.textContent = "Installed—restart pending";
  } else if (state === "failed") {
    const message = error || "OpenCode update failed";
    button.setAttribute("aria-label", `${message}. Click to retry.`);
    button.title = `${message}. Click to retry.`;
    if (detail) detail.textContent = message;
    if (live) live.textContent = `${message}. Click to retry.`;
  } else {
    button.setAttribute("aria-label", "Update OpenCode");
    button.title = "Update OpenCode";
    if (detail) detail.textContent = "";
    if (live) live.textContent = "";
  }
}

function ownSelector(ownerId: string): string {
  return `[${UPDATE_CONTROL_ATTR}="${ownerId}"]`;
}

function ensureControl(
  menu: HTMLElement,
  doc: Document,
  ownerId: string,
): HTMLButtonElement | null {
  const mine = menu.querySelector<HTMLElement>(ownSelector(ownerId));
  if (mine) {
    const button = mine.querySelector("button");
    return button;
  }
  const other = menu.querySelector(`[${UPDATE_CONTROL_ATTR}]`);
  if (other) return null;
  const item = doc.createElement("li");
  item.setAttribute(UPDATE_CONTROL_ATTR, ownerId);
  item.setAttribute("data-sidebar", "menu-item");
  item.className = "oc-update-item";
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "oc-update";
  button.innerHTML = DOWNLOAD_ICON_SVG + PROVIDER_ICON_SVG;
  const status = doc.createElement("span");
  status.className = "oc-update__live";
  status.setAttribute("role", "status");
  const detail = doc.createElement("span");
  detail.className = "oc-update__detail";
  item.append(button, detail, status);
  paint(button, status, "ready");
  menu.appendChild(item);
  return button;
}

function removeOwned(doc: ParentNode, ownerId: string): void {
  doc.querySelectorAll(ownSelector(ownerId)).forEach((node) => {
    node.remove();
  });
}

export function mountUpdateControl(args: {
  pluginId: string;
  signal: AbortSignal;
  rpc?: UpdateControlRpc;
  document?: Document;
  ownerId?: string;
  pollMs?: number;
}): () => void {
  if (args.signal.aborted) return () => undefined;
  const doc = args.document ?? document;
  const rpc = args.rpc ?? defaultRpc();
  const ownerId =
    args.ownerId ??
    globalThis.crypto?.randomUUID?.() ??
    `oc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let statusInFlight: Promise<void> | null = null;
  let installing = false;
  let lastEligible = false;
  let lastCanRestart = false;
  let lastError: string | null = null;
  let clickBound: HTMLButtonElement | null = null;
  let disposed = false;
  let statusGen = 0;
  let installGen = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let observer: MutationObserver | null = null;

  const inactive = () => disposed || args.signal.aborted;

  const onClick = () => {
    if (inactive() || installing) return;
    installing = true;
    statusGen += 1;
    const myInstall = (installGen += 1);
    const root = doc.querySelector(ownSelector(ownerId));
    const button = root?.querySelector("button") ?? null;
    const live = root?.querySelector('[role="status"]') ?? null;
    const activateOnly = lastCanRestart && !lastEligible;
    if (button) paint(button, live, "pending");
    const done = activateOnly
      ? (rpc.activate ?? rpc.install)()
      : rpc.install();
    void done
      .then((result) => {
        if (inactive() || myInstall !== installGen) return;
        if (!result.ok) {
          lastError = result.error ?? "OpenCode update failed";
          installing = false;
          if (button) {
            paint(
              button,
              live,
              lastCanRestart ? "pending-restart" : "failed",
              lastError,
            );
          }
          reportActionError("OpenCode update", lastError);
          return;
        }
        lastError = null;
        installing = false;
        if ("pendingRestart" in result && result.pendingRestart) {
          lastCanRestart = true;
          lastEligible = false;
          if (button) paint(button, live, "pending-restart");
          return;
        }
        omitOwned();
      })
      .catch((error) => {
        if (inactive() || myInstall !== installGen) return;
        lastError = error instanceof Error ? error.message : String(error);
        installing = false;
        if (button) paint(button, live, "failed", lastError);
        reportActionError("OpenCode update", lastError);
      });
  };

  const bind = (button: HTMLButtonElement) => {
    if (clickBound === button) return;
    clickBound?.removeEventListener("click", onClick);
    button.addEventListener("click", onClick);
    clickBound = button;
  };

  const omitOwned = () => {
    clickBound?.removeEventListener("click", onClick);
    clickBound = null;
    removeOwned(doc, ownerId);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    statusGen += 1;
    installGen += 1;
    args.signal.removeEventListener("abort", cleanup);
    if (timer !== undefined) globalThis.clearInterval(timer);
    timer = undefined;
    if (frame) globalThis.cancelAnimationFrame(frame);
    frame = 0;
    observer?.disconnect();
    observer = null;
    omitOwned();
  };

  const sync = () => {
    if (inactive()) {
      cleanup();
      return;
    }
    const menu = findFooterMountTarget(doc);
    if (!menu) {
      omitOwned();
      return;
    }
    if (installing) {
      const button = ensureControl(menu, doc, ownerId);
      if (button) {
        const live = button.parentElement?.querySelector('[role="status"]') ?? null;
        paint(button, live, lastError ? "failed" : "pending", lastError ?? undefined);
        bind(button);
      }
      return;
    }
    if (statusInFlight) return;
    const myGen = (statusGen += 1);
    statusInFlight = rpc
      .status()
      .catch(() => undefined)
      .then((status) => {
        if (inactive() || myGen !== statusGen || installing) return;
        const next = findFooterMountTarget(doc);
        lastEligible = Boolean(status?.eligible);
        lastCanRestart = Boolean(status?.canRestart);
        if (!next || (!status?.eligible && !status?.canRestart)) {
          omitOwned();
          return;
        }
        const button = ensureControl(next, doc, ownerId);
        if (!button) return;
        const live = button.parentElement?.querySelector('[role="status"]') ?? null;
        const state = status.canRestart && !status.eligible
          ? "pending-restart"
          : lastError
            ? "failed"
            : "ready";
        paint(button, live, state, lastError ?? undefined);
        bind(button);
      })
      .finally(() => {
        statusInFlight = null;
      });
  };

  args.signal.addEventListener("abort", cleanup);
  if (args.signal.aborted) {
    cleanup();
    return cleanup;
  }
  sync();
  timer = globalThis.setInterval(sync, args.pollMs ?? POLL_MS);
  observer = new MutationObserver(() => {
    if (frame || disposed) return;
    frame = globalThis.requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      const menu = findFooterMountTarget(doc);
      if (!menu) {
        omitOwned();
        return;
      }
      if (menu.querySelector(ownSelector(ownerId))) return;
      sync();
    });
  });
  const root =
    "documentElement" in doc && doc.documentElement
      ? doc.documentElement
      : doc;
  observer.observe(root, {
    childList: true,
    subtree: true,
  });
  return cleanup;
}
