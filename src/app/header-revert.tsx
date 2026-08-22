import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";

export function HeaderRevert(props: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [providerId, setProviderId] = useState<string | null>(null);
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

  return (
    <span data-opencode-header-revert="true">
      <button
        type="button"
        aria-label="Undo OpenCode turn"
        onClick={() => {
          void rpc.call("undo", { threadId: props.threadId }).then((result) => {
            setMessage(result.error);
          });
        }}
      >
        Undo
      </button>
      <button
        type="button"
        aria-label="Redo OpenCode turn"
        onClick={() => {
          void rpc.call("redo", { threadId: props.threadId }).then((result) => {
            setMessage(result.error);
          });
        }}
      >
        Redo
      </button>
      {message ? <span>{message}</span> : null}
    </span>
  );
}
