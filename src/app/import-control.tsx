import { useState } from "react";
import { useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";

type ImportSession = {
  id: string;
  title: string | null;
  directory: string | null;
  parentID: string | null;
  blocked: boolean;
  blockReason: string | null;
  alreadyImported: boolean;
};

export function ImportControl() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = useBbContext();
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState("Continue this OpenCode session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setOpen(true);
    const listed = await rpc.call("listImport", null);
    setHostId(listed.hostId);
    setSessions(listed.sessions);
    const next: Record<string, boolean> = {};
    const idleChildren = listed.sessions.filter(
      (session) => !session.blocked && session.parentID,
    );
    for (const session of listed.sessions) {
      next[session.id] = idleChildren.length
        ? !session.blocked && Boolean(session.parentID)
        : !session.blocked && !session.parentID;
    }
    setSelected(next);
  }

  async function confirm() {
    if (!projectId) {
      setError("Open a project before importing.");
      return;
    }
    const sessionIds = sessions
      .filter((session) => selected[session.id] && !session.blocked)
      .map((session) => session.id);
    if (sessionIds.length === 0) {
      setError("Select at least one idle session.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hosts = sessionIds;
      void hosts;
      if (!hostId) {
        setError("No enrolled host.");
        return;
      }
      await rpc.call("confirmImport", {
        projectId,
        hostId,
        sessionIds,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openSelected() {
    if (!projectId) {
      setError("Open a project before importing.");
      return;
    }
    const sessionId = sessions.find(
      (session) => selected[session.id] && !session.blocked,
    )?.id;
    if (!sessionId) {
      setError("Select an idle session to open.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!hostId) {
        setError("No enrolled host.");
        return;
      }
      await rpc.call("confirmImport", {
        projectId,
        hostId,
        sessionIds: [sessionId],
      });
      await rpc.call("openImported", {
        projectId,
        hostId,
        sessionId,
        prompt,
        environment: { type: "project-default" },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-opencode-import="true">
      <button type="button" onClick={() => void load()} disabled={busy}>
        Import OpenCode sessions
      </button>
      {open ? (
        <div>
          {sessions.length === 0 ? <p>No sessions on this host.</p> : null}
          <ul>
            {sessions.map((session) => (
              <li key={session.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(selected[session.id])}
                    disabled={session.blocked}
                    onChange={(event) => {
                      setSelected((current) => ({
                        ...current,
                        [session.id]: event.target.checked,
                      }));
                    }}
                  />
                  {session.title ?? session.id}
                  {session.parentID ? " (child)" : ""}
                  {session.blockReason ? ` — ${session.blockReason}` : ""}
                </label>
              </li>
            ))}
          </ul>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            aria-label="First message after import"
          />
          <button type="button" onClick={() => void confirm()} disabled={busy}>
            Save pending adopt
          </button>
          <button
            type="button"
            onClick={() => void openSelected()}
            disabled={busy}
          >
            Open selected
          </button>
          <button
            type="button"
            onClick={() => void openSelected()}
            disabled={
              busy ||
              !sessions.some(
                (session) =>
                  selected[session.id] && session.parentID && !session.blocked,
              )
            }
          >
            Open this Task
          </button>
          {error ? <p>{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
