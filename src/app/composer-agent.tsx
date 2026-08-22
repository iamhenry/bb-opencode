import { useEffect, useRef, useState } from "react";
import {
  useBbContext,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { newThreadShowsOpencodeAgent } from "./live-provider.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";
import "./composer-agent.css";

type Chrome = {
  providerId: string | null;
  status: "selected" | "default" | "unknown" | "hidden";
  agent: string;
  options: Array<{ name: string; description: string | null }>;
  error: string | null;
};

const FALLBACK_OPTIONS = [
  { name: "build", description: "Default OpenCode primary" },
  { name: "plan", description: "Planning primary" },
  { name: "orchestrator", description: "Orchestrator primary" },
];

export function ComposerAgentPicker() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = useBbContext();
  const view = useComposerView();
  const isNewThread = view.scope.kind === "new-thread" || !threadId;
  const rootRef = useRef<HTMLSpanElement>(null);
  const [liveOpenCode, setLiveOpenCode] = useState(false);
  const [chrome, setChrome] = useState<Chrome | null>(null);
  const [agent, setAgent] = useState("build");
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const scopeProjectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : projectId;

  useEffect(() => {
    const sync = () => {
      setLiveOpenCode(newThreadShowsOpencodeAgent(rootRef.current));
    };
    sync();
    const root =
      rootRef.current?.closest("[data-app-composer]") ?? document.body;
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title", "aria-label"],
    });
    const timer = window.setInterval(sync, 250);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [isNewThread, threadId]);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("composerChrome", {
        threadId: threadId ?? null,
        projectId: scopeProjectId ?? null,
      })
      .then((result) => {
        if (cancelled) return;
        setChrome(result);
        if (result.agent) setAgent(result.agent);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, scopeProjectId, threadId]);

  const boundOpenCode = Boolean(threadId) &&
    shouldRenderOpencodeChrome(chrome?.providerId);
  const newThreadOpenCode = isNewThread && liveOpenCode;
  const visible = boundOpenCode || newThreadOpenCode;

  useEffect(() => {
    if (!visible) return;
    if (!view.run.isSubmitting || !agentRef.current) return;
    void rpc.call("stampAgent", {
      threadId: threadId ?? undefined,
      projectId: scopeProjectId ?? undefined,
      agent: agentRef.current,
      queued: Boolean(threadId && view.run.isRunning),
    });
  }, [
    rpc,
    scopeProjectId,
    threadId,
    view.run.isRunning,
    view.run.isSubmitting,
    visible,
  ]);

  const options = chrome?.options?.length ? chrome.options : FALLBACK_OPTIONS;

  return (
    <>
      <span ref={rootRef} hidden data-opencode-agent-probe="true" />
      {visible ? (
        <label className="oc-agent" data-opencode-agent-picker="true">
          <span className="oc-agent__prefix">Agent</span>
          <select
            aria-label="OpenCode agent"
            className="oc-agent__select"
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value);
            }}
          >
            {options.map((option) => (
              <option key={option.name} value={option.name}>
                {option.name}
              </option>
            ))}
          </select>
          {chrome?.error ? (
            <span className="oc-agent__error">{chrome.error}</span>
          ) : null}
        </label>
      ) : null}
    </>
  );
}
