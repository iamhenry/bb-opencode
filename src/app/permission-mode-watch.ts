import { pickVisiblePermissionMode } from "../permission-mode.js";
import { callPluginRpc } from "./rpc.js";

function threadIdFromPath(pathname = window.location.pathname): string | null {
  const match = decodeURIComponent(pathname).match(/\/threads\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function labelsIn(shell: ParentNode): string[] {
  return Array.from(shell.querySelectorAll("button, [role='button']")).map(
    (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

function visibleFooterMode(): ReturnType<typeof pickVisiblePermissionMode> {
  const shells: ParentNode[] = [
    ...Array.from(document.querySelectorAll("[data-app-composer]")),
    document.body,
  ];
  for (const shell of shells) {
    const mode = pickVisiblePermissionMode(labelsIn(shell));
    if (mode) return mode;
  }
  return undefined;
}

export function mountPermissionModeWatch(args: { signal: AbortSignal }): () => void {
  let lastKey = "";
  const missingLogged = new Set<string>();

  const sync = () => {
    if (args.signal.aborted) return;
    const threadId = threadIdFromPath();
    if (!threadId) return;
    const mode = visibleFooterMode();
    if (!mode) {
      const anyLabel = labelsIn(document.body).some((label) =>
        pickVisiblePermissionMode([label]),
      );
      if (!missingLogged.has(threadId) && !anyLabel) {
        missingLogged.add(threadId);
        console.debug("[opencode] perm-mode label not found");
      }
      return;
    }
    missingLogged.delete(threadId);
    const key = `${threadId}:${mode}`;
    if (key === lastKey) return;
    lastKey = key;
    void callPluginRpc("stampPermissionMode", {
      threadId,
      permissionMode: mode,
    }).catch(() => undefined);
  };

  sync();
  const timer = window.setInterval(sync, 250);
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  const onAbort = () => {
    window.clearInterval(timer);
    if (frame) window.cancelAnimationFrame(frame);
    observer.disconnect();
  };
  args.signal.addEventListener("abort", onAbort);
  return onAbort;
}
