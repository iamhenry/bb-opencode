import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";
import "./composer-agent.css";

export function HeaderRevert(props: {
  threadId: string;
  isCompactViewport?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [providerId, setProviderId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"undo" | "redo" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("threadProvider", { threadId: props.threadId }).then((result) => {
      if (!cancelled) setProviderId(result.providerId);
    });
    return () => {
      cancelled = true;
    };
  }, [props.threadId, rpc]);

  if (!shouldRenderOpencodeChrome(providerId)) return null;

  const run = (kind: "undo" | "redo") => {
    setBusy(kind);
    setMessage(null);
    void rpc
      .call(kind, { threadId: props.threadId })
      .then((result) => {
        setMessage(result.ok ? null : result.error);
      })
      .finally(() => setBusy(null));
  };

  return (
    <span className="oc-revert" data-opencode-header-revert="true">
      <button
        type="button"
        className="oc-revert__btn"
        aria-label="Undo OpenCode turn"
        title="Undo last OpenCode turn"
        disabled={busy !== null}
        onClick={() => run("undo")}
      >
        {props.isCompactViewport ? "Undo" : "Undo"}
      </button>
      <button
        type="button"
        className="oc-revert__btn"
        aria-label="Redo OpenCode turn"
        title="Redo last OpenCode turn"
        disabled={busy !== null}
        onClick={() => run("redo")}
      >
        Redo
      </button>
      {message ? (
        <span className="oc-revert__error" title={message}>
          {message}
        </span>
      ) : null}
    </span>
  );
}
