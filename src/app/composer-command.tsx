import { useEffect, useState } from "react";
import {
  useBbContext,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { insertCommandToken } from "../slash-command.js";
import { newThreadShowsOpencodeAgent } from "./live-provider.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";
import "./composer-agent.css";

export function ComposerCommandPicker() {
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
        const bound = Boolean(threadId) && shouldRenderOpencodeChrome(chrome.providerId);
        setVisible(bound || (isNewThread && newThreadShowsOpencodeAgent(document.body)));
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

  if (!visible || commands.length === 0) return null;

  return (
    <label className="oc-agent" data-opencode-command-picker="true">
      <span className="oc-agent__prefix">Command</span>
      <select
        aria-label="OpenCode command"
        className="oc-agent__select"
        defaultValue=""
        onChange={(event) => {
          const name = event.target.value;
          event.target.value = "";
          if (!name) return;
          composer.updateText((current) => insertCommandToken(current, name));
          composer.focus();
        }}
      >
        <option value="">Insert /</option>
        {commands.map((command) => (
          <option key={command.name} value={command.name}>
            /{command.name}
          </option>
        ))}
      </select>
    </label>
  );
}
