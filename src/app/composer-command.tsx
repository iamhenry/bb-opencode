import { useEffect, useMemo, useState } from "react";
import {
  useBbContext,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import {
  filterListedCommands,
  insertCommandToken,
  slashAutocompleteQuery,
} from "../slash-command.js";
import { newThreadShowsOpencodeAgent } from "./live-provider.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";
import "./composer-agent.css";

export function ComposerSlashSuggest() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const { threadId, projectId } = useBbContext();
  const isNewThread = view.scope.kind === "new-thread" || !threadId;
  const [visible, setVisible] = useState(false);
  const [commands, setCommands] = useState<
    Array<{ name: string; description: string | null }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("composerChrome", {
        threadId: threadId ?? null,
        projectId: projectId ?? null,
      })
      .then((chrome) => {
        if (cancelled) return;
        const bound =
          Boolean(threadId) && shouldRenderOpencodeChrome(chrome.providerId);
        setVisible(
          bound || (isNewThread && newThreadShowsOpencodeAgent(document.body)),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isNewThread, projectId, rpc, threadId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void rpc.call("listCommands", {}).then((result) => {
      if (cancelled) return;
      setCommands(result.commands);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, visible]);

  const query = slashAutocompleteQuery(view.draft.text);
  const matches = useMemo(
    () => (query === null ? [] : filterListedCommands(query, commands)),
    [commands, query],
  );

  if (!visible || query === null || matches.length === 0) return null;

  return (
    <div className="oc-slash" role="listbox" aria-label="OpenCode commands">
      {matches.slice(0, 12).map((command) => (
        <button
          key={command.name}
          type="button"
          className="oc-slash__row"
          role="option"
          onMouseDown={(event) => {
            event.preventDefault();
            composer.updateText((current) =>
              insertCommandToken(current, command.name),
            );
            composer.focus();
          }}
        >
          <span className="oc-slash__name">/{command.name}</span>
          {command.description ? (
            <span className="oc-slash__hint">{command.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
