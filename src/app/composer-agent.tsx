import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [liveOpenCode, setLiveOpenCode] = useState(false);
  const [chrome, setChrome] = useState<Chrome | null>(null);
  const [agent, setAgent] = useState("build");
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
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

  const boundOpenCode =
    Boolean(threadId) && shouldRenderOpencodeChrome(chrome?.providerId);
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

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({ top: rect.bottom + 6, left: rect.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options = chrome?.options?.length ? chrome.options : FALLBACK_OPTIONS;
  const selected = options.find((option) => option.name === agent) ?? options[0];

  return (
    <>
      <span ref={rootRef} hidden data-opencode-agent-probe="true" />
      {visible ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            className="oc-agent"
            data-opencode-agent-picker="true"
            data-open={open ? "true" : "false"}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`OpenCode agent: ${selected?.name ?? "build"}`}
            title={chrome?.error || selected?.description || "OpenCode agent"}
            onClick={() => setOpen((value) => !value)}
          >
            <BotIcon />
            <span className="oc-agent__prefix">Agent</span>
            <span className="oc-agent__name">{selected?.name ?? "build"}</span>
            <ChevronIcon />
          </button>
          {open
            ? createPortal(
                <div
                  ref={menuRef}
                  className="oc-agent-menu"
                  role="listbox"
                  aria-label="Primary agents"
                  style={{ top: menuPos.top, left: menuPos.left }}
                >
                  <div className="oc-agent-menu__heading">Primary agents</div>
                  {options.map((option) => (
                    <button
                      key={option.name}
                      type="button"
                      role="option"
                      aria-selected={option.name === agent}
                      className={
                        option.name === agent
                          ? "oc-agent-menu__item oc-agent-menu__item--selected"
                          : "oc-agent-menu__item"
                      }
                      title={option.description ?? option.name}
                      onClick={() => {
                        setAgent(option.name);
                        setOpen(false);
                      }}
                    >
                      <span className="oc-agent-menu__item-name">
                        {option.name}
                      </span>
                      {option.description ? (
                        <span className="oc-agent-menu__item-desc">
                          {option.description}
                        </span>
                      ) : null}
                    </button>
                  ))}
                  {chrome?.error ? (
                    <div className="oc-agent__error">{chrome.error}</div>
                  ) : null}
                </div>,
                document.body,
              )
            : null}
        </>
      ) : null}
    </>
  );
}

function BotIcon() {
  return (
    <svg
      className="oc-agent__icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="oc-agent__chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
