import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useBbContext,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import {
  composerAgentShouldArm,
  displayedComposerAgent,
  fetchComposerChrome,
  lastArmedComposerAgent,
  rememberComposerAgent,
  resetLastArmedComposerAgent,
  shouldApplyHydratedAgent,
  shouldResetArmedComposerAgent,
  type ComposerChrome,
} from "./composer-chrome.js";
import {
  composerSurfaceWantsBanner,
  inspectLiveComposerProvider,
  newThreadAgentPickerVisible,
} from "./live-provider.js";
import { shouldRenderOpencodeChrome } from "./visibility.js";
import "./composer-agent.css";

const FALLBACK_OPTIONS = [
  { name: "build", description: "Default OpenCode primary" },
  { name: "plan", description: "Planning primary" },
  { name: "orchestrator", description: "Orchestrator primary" },
];

export function ComposerAgentPicker() {
  return <AgentPicker layout="expanded" />;
}

/** Compact / PWA prompt boxes do not mount plugin composer actions. */
export function CompactComposerAgentPicker() {
  return <AgentPicker layout="compact" />;
}

function AgentPicker({ layout }: { layout: "expanded" | "compact" }) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = useBbContext();
  const view = useComposerView();
  const threadId =
    view.scope.kind === "thread" || view.scope.kind === "queued-message"
      ? view.scope.threadId
      : null;
  const isNewThread = view.scope.kind === "new-thread" || !threadId;
  const rootRef = useRef<HTMLSpanElement>(null);
  const [wantsBanner, setWantsBanner] = useState(
    () => view.layout === "compact",
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [liveProvider, setLiveProvider] = useState({
    found: false,
    opencode: false,
  });
  const [chrome, setChrome] = useState<ComposerChrome | null>(null);
  const [agent, setAgent] = useState(() => lastArmedComposerAgent() || "build");
  const userPicked = useRef(false);
  const previousThreadId = useRef(threadId);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({
    top: 0,
    left: 0,
    maxHeight: 280,
  });
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const scopeProjectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : projectId;

  useEffect(() => {
    const sync = () => {
      setLiveProvider(inspectLiveComposerProvider(rootRef.current));
      setWantsBanner(
        !isNewThread &&
          composerSurfaceWantsBanner({
            layout: view.layout,
            from: rootRef.current,
          }),
      );
    };
    sync();
    const root =
      rootRef.current?.closest("[data-app-composer]") ?? document.body;
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "data-promptbox-compact"],
    });
    const timer = window.setInterval(sync, 250);
    const media = [
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(max-width: 767px)"),
    ];
    for (const query of media) {
      query.addEventListener("change", sync);
    }
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      for (const query of media) {
        query.removeEventListener("change", sync);
      }
    };
  }, [isNewThread, threadId, view.layout]);

  useEffect(() => {
    if (shouldResetArmedComposerAgent(previousThreadId.current, threadId)) {
      resetLastArmedComposerAgent();
      userPicked.current = false;
    }
    previousThreadId.current = threadId;
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    void fetchComposerChrome(
      (input) => rpc.call("composerChrome", input),
      {
        threadId: threadId ?? null,
        projectId: scopeProjectId ?? null,
      },
    ).then((result) => {
      if (cancelled) return;
      setChrome(result);
      if (
        shouldApplyHydratedAgent({
          userPicked: userPicked.current,
          chromeStatus: result.status,
          chromeAgent: result.agent,
          armedAgent: lastArmedComposerAgent(),
        })
      ) {
        rememberComposerAgent(result.agent);
        setAgent(result.agent);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, scopeProjectId, threadId]);

  const chromeOpenCode = shouldRenderOpencodeChrome(chrome?.providerId);
  const boundOpenCode = Boolean(threadId) && chromeOpenCode;
  const newThreadOpenCode =
    isNewThread &&
    newThreadAgentPickerVisible({
      liveFound: liveProvider.found,
      liveOpenCode: liveProvider.opencode,
      chromeOpenCode,
    });
  const layoutMatch = layout === "compact" ? wantsBanner : !wantsBanner;
  const visible = layoutMatch && (boundOpenCode || newThreadOpenCode);

  const stamp = (nextAgent: string, queued: boolean) => {
    if (!nextAgent) return;
    rememberComposerAgent(nextAgent);
    void rpc
      .call("stampAgent", {
        threadId: threadId || null,
        projectId: (scopeProjectId ?? projectId) || null,
        agent: nextAgent,
        queued,
      })
      .catch((error) => {
        console.error("opencode stampAgent failed", error);
      });
  };

  // Arm whatever the visible chip shows. New-thread has no threadId, so
  // waiting for click or isSubmitting is too late for deriveProviderOptions.
  // Compact vs expanded is exclusive via `visible`, so the sibling cannot
  // overwrite with "build".
  useEffect(() => {
    const nextAgent = agentRef.current;
    if (!composerAgentShouldArm({ visible, agent: nextAgent })) return;
    stamp(
      nextAgent,
      Boolean(threadId && view.run.isSubmitting && view.run.isRunning),
    );
  }, [
    agent,
    projectId,
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
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menu = menuRef.current;
      const menuWidth = menu?.offsetWidth ?? 240;
      const menuHeight = menu?.offsetHeight ?? 200;
      const viewport = window.visualViewport;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewLeft = viewport?.offsetLeft ?? 0;
      const viewWidth = viewport?.width ?? window.innerWidth;
      const viewHeight = viewport?.height ?? window.innerHeight;
      const safeBottom = readSafeInset("bottom");
      const safeTop = readSafeInset("top");
      const margin = 8 + Math.max(safeTop, 0);
      const gap = 6;
      const spaceBelow =
        viewTop + viewHeight - rect.bottom - margin - safeBottom;
      const spaceAbove = rect.top - viewTop - margin;
      const openUp =
        spaceBelow < Math.min(menuHeight, 220) && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        120,
        (openUp ? spaceAbove : spaceBelow) - gap,
      );
      const height = Math.min(menuHeight, maxHeight);
      let top = openUp ? rect.top - height - gap : rect.bottom + gap;
      top = Math.min(
        Math.max(viewTop + margin, top),
        viewTop + viewHeight - Math.min(height, maxHeight) - margin - safeBottom,
      );
      let left = rect.right - menuWidth;
      left = Math.min(left, viewLeft + viewWidth - menuWidth - margin);
      left = Math.max(viewLeft + margin, left);
      setMenuPos({ top, left, maxHeight });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
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
  const selected = displayedComposerAgent(options, agent, chrome?.status);
  const agentIsSelectable = options.some((option) => option.name === agent);

  return (
    <>
      <span ref={rootRef} hidden data-opencode-agent-probe="true" />
      {visible ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            className={
              layout === "compact" ? "oc-agent oc-agent--banner" : "oc-agent"
            }
            data-opencode-agent-picker="true"
            data-layout={layout}
            data-open={open && agentIsSelectable ? "true" : "false"}
            aria-haspopup={agentIsSelectable ? "listbox" : undefined}
            aria-expanded={agentIsSelectable ? open : undefined}
            aria-label={`OpenCode agent: ${selected?.name ?? "build"}`}
            title={chrome?.error || selected?.description || "OpenCode agent"}
            disabled={!agentIsSelectable}
            onClick={() => setOpen((value) => !value)}
          >
            <BotIcon />
            <span className="oc-agent__prefix">Agent</span>
            <span className="oc-agent__name">{selected?.name ?? "build"}</span>
            {agentIsSelectable ? <ChevronIcon /> : null}
          </button>
          {open && agentIsSelectable
            ? createPortal(
                <div
                  ref={menuRef}
                  className="oc-agent-menu"
                  role="listbox"
                  aria-label="Primary agents"
                  style={{
                    top: menuPos.top,
                    left: menuPos.left,
                    maxHeight: menuPos.maxHeight,
                  }}
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
                        userPicked.current = true;
                        rememberComposerAgent(option.name);
                        setAgent(option.name);
                        setOpen(false);
                        stamp(option.name, false);
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

function readSafeInset(side: "top" | "bottom"): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    `--oc-safe-${side}`,
  );
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed)) return parsed;
  const env = getComputedStyle(document.documentElement).getPropertyValue(
    `env(safe-area-inset-${side})`,
  );
  const fromEnv = Number.parseFloat(env);
  return Number.isFinite(fromEnv) ? fromEnv : 0;
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
