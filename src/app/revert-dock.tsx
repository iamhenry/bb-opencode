import { useCallback, useEffect, useRef, useState } from "react";
import {
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import {
  EMPTY_REVERT_STATE,
  OPENCODE_REVERT_CHANNEL,
  type OpenCodeRevertState,
} from "../revert-state.js";

interface RevertStateResponse extends OpenCodeRevertState {
  error: string | null;
  hiddenRowIds: string[];
}

function draftStorageKey(threadId: string): string {
  return `bb-opencode:revert-draft:${threadId}`;
}

function readPreviousDraft(threadId: string): string {
  try {
    return sessionStorage.getItem(draftStorageKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

function rememberPreviousDraft(threadId: string, text: string): void {
  try {
    if (sessionStorage.getItem(draftStorageKey(threadId)) === null) {
      sessionStorage.setItem(draftStorageKey(threadId), text);
    }
  } catch {
    /* Session storage is optional in restricted webviews. */
  }
}

function forgetPreviousDraft(threadId: string): void {
  try {
    sessionStorage.removeItem(draftStorageKey(threadId));
  } catch {
    /* Session storage is optional in restricted webviews. */
  }
}

export function RevertDock() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const connection = useRealtimeConnectionState();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [state, setState] = useState<RevertStateResponse>({
    ...EMPTY_REVERT_STATE,
    error: null,
    hiddenRowIds: [],
  });
  const [expanded, setExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const activeMarkerRef = useRef<string | null>(null);
  const connectedOnceRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setState({ ...EMPTY_REVERT_STATE, error: null, hiddenRowIds: [] });
      return;
    }
    const next = await rpc.call("revertState", { threadId });
    setState(next);
  }, [rpc, threadId]);

  useEffect(() => {
    let cancelled = false;
    if (!threadId) {
      setState({ ...EMPTY_REVERT_STATE, error: null, hiddenRowIds: [] });
      return;
    }
    void rpc.call("revertState", { threadId }).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  useRealtime(OPENCODE_REVERT_CHANNEL, (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      (payload as { threadId?: unknown }).threadId === threadId
    ) {
      void refresh();
    }
  });

  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedOnceRef.current) void refresh();
    connectedOnceRef.current = true;
  }, [connection, refresh]);

  useEffect(() => {
    if (!state.active || !threadId) return;
    const timer = window.setInterval(() => void refresh(), 800);
    return () => window.clearInterval(timer);
  }, [refresh, state.active, threadId]);

  useEffect(() => {
    if (!threadId) return;
    if (state.active && state.messageID) {
      if (activeMarkerRef.current !== state.messageID) {
        rememberPreviousDraft(threadId, composer.text);
        composer.setText(state.promptText ?? "");
        composer.focus();
        setExpanded(false);
      }
      activeMarkerRef.current = state.messageID;
      return;
    }
    if (activeMarkerRef.current !== null) {
      forgetPreviousDraft(threadId);
    }
    activeMarkerRef.current = null;
  }, [composer, state.active, state.messageID, state.promptText, threadId]);

  useEffect(() => {
    const locked = state.active && view.run.isRunning;
    composer.setInputLock(locked);
    return () => composer.setInputLock(false);
  }, [composer, state.active, view.run.isRunning]);

  const undo = useCallback(async () => {
    if (!threadId || undoing) return;
    setUndoing(true);
    try {
      const previousDraft = readPreviousDraft(threadId);
      const result = await rpc.call("redo", { threadId });
      if (!result.ok) throw new Error(result.error ?? "Could not undo revert");
      composer.setText(previousDraft);
      forgetPreviousDraft(threadId);
      activeMarkerRef.current = null;
      await refresh();
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setUndoing(false);
    }
  }, [composer, refresh, rpc, threadId, undoing]);

  if (!threadId || !state.active) return null;
  const count = state.messages.length;

  return (
    <div className="oc-revert-dock" role="status">
      <button
        type="button"
        className="oc-revert-dock__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>
          {count} reverted {count === 1 ? "message" : "messages"}
        </span>
        <span className="oc-revert-dock__chevron" aria-hidden="true">
          {expanded ? "▴" : "▾"}
        </span>
      </button>
      <button
        type="button"
        className="oc-revert-dock__undo"
        disabled={undoing || view.run.isRunning}
        onClick={() => void undo()}
      >
        {undoing ? "Restoring…" : "Undo revert"}
      </button>
      {expanded ? (
        <div className="oc-revert-dock__messages">
          {state.messages.map((message) => (
            <div className="oc-revert-dock__message" key={message.id}>
              <span>{message.text || "Message with attachments"}</span>
              {message.attachments.length > 0 ? (
                <small>{message.attachments.join(", ")}</small>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {state.error ? (
        <div className="oc-revert-dock__error">{state.error}</div>
      ) : null}
    </div>
  );
}
