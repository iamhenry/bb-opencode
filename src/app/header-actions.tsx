import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";

type TaskChild = {
  sessionId: string;
  title: string;
  running: boolean;
  threadId: string | null;
  openable: boolean;
};

export function TaskChildrenHeaderAction(props: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TaskChild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("threadProvider", { threadId: props.threadId }).then((result) => {
      if (!cancelled) setVisible(shouldRenderOpencodeChrome(result.providerId));
    });
    return () => {
      cancelled = true;
    };
  }, [props.threadId, rpc]);

  async function refresh() {
    const listed = await rpc.call("listTaskChildren", { threadId: props.threadId });
    setChildren(listed.children);
  }

  if (!visible) return null;

  return (
    <div className="oc-header-task">
      <button
        type="button"
        className="oc-header-btn"
        aria-label="Open Task"
        title="Open this Task"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setError(null);
          void refresh().catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
      >
        {props.isCompactViewport ? "Task" : "Open Task"}
      </button>
      {open ? (
        <div className="oc-header-task-menu" role="menu">
          {children.length === 0 ? <p>No Task children on this thread.</p> : null}
          {children.map((child) => (
            <button
              key={child.sessionId}
              type="button"
              role="menuitem"
              disabled={busy || !child.openable}
              onClick={() => {
                setBusy(true);
                setError(null);
                void (async () => {
                  if (child.threadId) {
                    navigate.toThread(child.threadId);
                    return;
                  }
                  const opened = await rpc.call("openTaskChild", {
                    projectId: props.projectId,
                    parentThreadId: props.threadId,
                    sessionId: child.sessionId,
                  });
                  if (opened.threadId) {
                    navigate.toThread(opened.threadId);
                    return;
                  }
                  setError(opened.error ?? "Could not open Task");
                })()
                  .catch((cause) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {child.title}
              {child.running ? " (running)" : ""}
              {child.threadId ? "" : child.openable ? " — open" : " — busy"}
            </button>
          ))}
          {error ? <p className="oc-header-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
