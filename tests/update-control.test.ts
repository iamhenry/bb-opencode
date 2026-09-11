import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  findFooterMountTarget,
  mountUpdateControl,
  UPDATE_CONTROL_ATTR,
  type UpdateControlStatus,
} from "../src/app/update-control.js";

class Mini {
  nodeType = 1;
  parent: Mini | null = null;
  children: Mini[] = [];
  attrs: Record<string, string> = {};
  listeners = new Map<string, Set<() => void>>();
  innerHTML = "";
  textContent = "";
  title = "";
  disabled = false;
  className = "";
  type = "";
  dataset: Record<string, string> = {};
  constructor(public tagName: string) {}
  get documentElement() {
    return this;
  }
  get parentElement() {
    return this.parent;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
        value;
    }
  }
  append(...nodes: Mini[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node: Mini): Mini {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  querySelector(sel: string): Mini | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): Mini[] {
    const parts = sel.trim().split(/\s+/);
    let current: Mini[] = descendants(this);
    for (const part of parts) {
      current = current.filter((node) => matches(node, part));
      if (part !== parts[parts.length - 1]) {
        current = current.flatMap(descendants);
      }
    }
    return current;
  }
  createElement(tag: string): Mini {
    return new Mini(tag);
  }
}

function descendants(node: Mini): Mini[] {
  const out: Mini[] = [];
  const walk = (item: Mini) => {
    for (const child of item.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function matches(node: Mini, sel: string): boolean {
  if (sel.startsWith(".")) {
    return node.className.split(/\s+/).includes(sel.slice(1));
  }
  const prefix = sel.match(/^\[([^=\]]+)\^="([^"]*)"\]$/);
  if (prefix) return (node.getAttribute(prefix[1]) ?? "").startsWith(prefix[2]);
  const attrEq = sel.match(/^\[([^=\]]+)='([^']*)'\]$/);
  if (attrEq) return node.getAttribute(attrEq[1]) === attrEq[2];
  const attrDq = sel.match(/^\[([^=\]]+)="([^"]*)"\]$/);
  if (attrDq) return node.getAttribute(attrDq[1]) === attrDq[2];
  const bare = sel.match(/^\[([^\]]+)\]$/);
  if (bare) return node.getAttribute(bare[1]) !== null;
  return node.tagName === sel;
}

function footerDoc(opts?: {
  settings?: boolean;
  bug?: boolean;
  extraFooter?: boolean;
  spacer?: boolean;
  nestedMenu?: boolean;
}) {
  const doc = new Mini("document");
  const footer = new Mini("div");
  footer.setAttribute("data-sidebar", "footer");
  const menu = new Mini("ul");
  menu.setAttribute("data-sidebar", "menu");
  const settings = new Mini("a");
  if (opts?.settings !== false) settings.setAttribute("aria-label", "Settings");
  const bug = new Mini("button");
  if (opts?.bug !== false) bug.setAttribute("aria-label", "Report a bug");
  const spacer = new Mini("li");
  if (opts?.spacer !== false) spacer.setAttribute("aria-hidden", "true");
  const native = new Mini("a");
  native.setAttribute("data-testid", "sidebar-updates-badge-bb");
  native.setAttribute("aria-label", "bb update available");
  menu.append(settings, bug, spacer, native);
  if (opts?.nestedMenu) {
    const wrapper = new Mini("div");
    wrapper.appendChild(menu);
    footer.appendChild(wrapper);
  } else {
    footer.appendChild(menu);
  }
  doc.appendChild(footer);
  if (opts?.extraFooter) {
    const extra = new Mini("div");
    extra.setAttribute("data-sidebar", "footer");
    doc.appendChild(extra);
  }
  return { doc, menu, native };
}

const originalObserver = globalThis.MutationObserver;
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;
let observerDisconnects = 0;
let observerObserves = 0;

function stubObserver(): void {
  observerDisconnects = 0;
  observerObserves = 0;
  globalThis.MutationObserver = class {
    observe() {
      observerObserves += 1;
    }
    disconnect() {
      observerDisconnects += 1;
    }
    takeRecords() {
      return [];
    }
  } as typeof MutationObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
}

afterEach(() => {
  globalThis.MutationObserver = originalObserver;
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

describe("findFooterMountTarget", () => {
  it("returns the unique validated footer menu", () => {
    const { doc, menu } = footerDoc();
    expect(findFooterMountTarget(doc as unknown as ParentNode)).toBe(menu);
  });

  it("omits when the footer is missing, duplicated, incomplete, or not a direct menu", () => {
    expect(findFooterMountTarget(new Mini("document") as unknown as ParentNode)).toBeNull();
    expect(
      findFooterMountTarget(footerDoc({ extraFooter: true }).doc as unknown as ParentNode),
    ).toBeNull();
    expect(
      findFooterMountTarget(footerDoc({ settings: false }).doc as unknown as ParentNode),
    ).toBeNull();
    expect(
      findFooterMountTarget(footerDoc({ bug: false }).doc as unknown as ParentNode),
    ).toBeNull();
    expect(
      findFooterMountTarget(footerDoc({ spacer: false }).doc as unknown as ParentNode),
    ).toBeNull();
    expect(
      findFooterMountTarget(footerDoc({ nestedMenu: true }).doc as unknown as ParentNode),
    ).toBeNull();
  });
});

describe("mountUpdateControl", () => {
  it("returns immediately when the abort signal is already aborted", () => {
    stubObserver();
    const ac = new AbortController();
    ac.abort();
    let intervals = 0;
    const originalInterval = globalThis.setInterval;
    globalThis.setInterval = ((handler: TimerHandler, timeout?: number) => {
      intervals += 1;
      return originalInterval(handler, timeout);
    }) as typeof setInterval;
    try {
      const dispose = mountUpdateControl({
        pluginId: "opencode",
        signal: ac.signal,
        ownerId: "gen-abort",
        document: footerDoc().doc as unknown as Document,
        rpc: {
          async status() {
            return { eligible: true, canRestart: false, current: false, error: null };
          },
          async install() {
            return { ok: true, error: null };
          },
        },
      });
      expect(intervals).toBe(0);
      expect(observerObserves).toBe(0);
      dispose();
      expect(observerDisconnects).toBe(0);
    } finally {
      globalThis.setInterval = originalInterval;
    }
  });

  it("omission unbinds the click listener and removes only owned DOM", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    const dispose = mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-omit",
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: false, canRestart: false, current: false, error: null };
        },
        async install() {
          return { ok: true, error: null };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);
    dispose();
    expect(observerDisconnects).toBe(1);
    ac.abort();
  });

  it("mounts one owned control when eligible, omits when current, and cleans up", async () => {
    const { doc, menu, native } = footerDoc();
    const ac = new AbortController();
    stubObserver();
    const dispose = mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-a",
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: true, canRestart: false, current: false, error: null };
        },
        async install() {
          return { ok: true, error: null };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(1);
    expect(native.getAttribute("data-testid")).toBe("sidebar-updates-badge-bb");
    expect(menu.children.at(-1)?.getAttribute(UPDATE_CONTROL_ATTR)).toBe("gen-a");
    const button = menu.querySelector(`[${UPDATE_CONTROL_ATTR}] button`);
    expect(button?.innerHTML).toContain("oc-update__download");
    expect(button?.innerHTML).toContain("oc-update__provider");
    dispose();
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);
    expect(observerDisconnects).toBe(1);
    ac.abort();
  });

  it("does not steal or duplicate another generation's control", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const a = new AbortController();
    const b = new AbortController();
    const first = mountUpdateControl({
      pluginId: "opencode",
      signal: a.signal,
      ownerId: "gen-a",
      pollMs: 20,
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: true, canRestart: false, current: false, error: null };
        },
        async install() {
          return { ok: true, error: null };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = mountUpdateControl({
      pluginId: "opencode",
      signal: b.signal,
      ownerId: "gen-b",
      pollMs: 20,
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: true, canRestart: false, current: false, error: null };
        },
        async install() {
          return { ok: true, error: null };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(1);
    expect(menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-a"]`)).toBeTruthy();
    first();
    expect(menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-a"]`)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-b"]`)).toBeTruthy();
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(1);
    second();
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);
    a.abort();
    b.abort();
  });

  it("keeps a single listener across rerenders and reports failure accessibly", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    const installs: number[] = [];
    mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-a",
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: true, canRestart: false, current: false, error: null };
        },
        async install() {
          installs.push(1);
          return { ok: false, error: "installer exploded" };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-a"]`) as Mini;
    const button = item.querySelector("button") as Mini;
    const live = item.querySelector('[role="status"]') as Mini;
    button.click();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(installs).toEqual([1]);
    expect(button.listeners.get("click")?.size).toBe(1);
    expect(button.getAttribute("aria-label")).toContain("installer exploded");
    expect(button.getAttribute("aria-label")).toContain("retry");
    expect(live.textContent).toContain("installer exploded");
    expect(button.innerHTML).toContain("oc-update__download");
    expect(button.innerHTML).toContain("oc-update__provider");
    expect(item.querySelector(".oc-update__detail")?.textContent).toBe("installer exploded");
    ac.abort();
  });

  it("omission after a visible control unbinds click and leaves native DOM", async () => {
    const { doc, menu, native } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    let eligible = true;
    mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-omit-live",
      pollMs: 20,
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible, canRestart: false, current: !eligible, error: null };
        },
        async install() {
          return { ok: true, error: null };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-omit-live"]`) as Mini;
    const button = item.querySelector("button") as Mini;
    expect(button.listeners.get("click")?.size).toBe(1);
    eligible = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(button.listeners.get("click")?.size).toBe(0);
    expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);
    expect(native.getAttribute("data-testid")).toBe("sidebar-updates-badge-bb");
    ac.abort();
  });

  it("abort cleanup is idempotent and drops click, abort, observer, and timer", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    let abortListeners = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (type === "abort") abortListeners += 1;
      return add(type, fn, opts);
    }) as AbortSignal["addEventListener"];
    ac.signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
      if (type === "abort") abortListeners -= 1;
      return remove(type, fn, opts);
    }) as AbortSignal["removeEventListener"];
    let intervals = 0;
    let cleared = 0;
    const originalInterval = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    globalThis.setInterval = ((handler: TimerHandler, timeout?: number) => {
      intervals += 1;
      return originalInterval(handler, timeout);
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      cleared += 1;
      return originalClear(id);
    }) as typeof clearInterval;
    try {
      const dispose = mountUpdateControl({
        pluginId: "opencode",
        signal: ac.signal,
        ownerId: "gen-clean",
        document: doc as unknown as Document,
        rpc: {
          async status() {
            return { eligible: true, canRestart: false, current: false, error: null };
          },
          async install() {
            return { ok: true, error: null };
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-clean"]`) as Mini;
      const button = item.querySelector("button") as Mini;
      expect(button.listeners.get("click")?.size).toBe(1);
      expect(abortListeners).toBe(1);
      expect(intervals).toBe(1);
      ac.abort();
      expect(button.listeners.get("click")?.size).toBe(0);
      expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);
      expect(observerDisconnects).toBe(1);
      expect(cleared).toBe(1);
      expect(abortListeners).toBe(0);
      dispose();
      dispose();
      expect(observerDisconnects).toBe(1);
      expect(cleared).toBe(1);
    } finally {
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClear;
    }
  });

  it("keeps Installed—restart pending on the same control", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    const activates: number[] = [];
    mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-pending",
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: false, canRestart: true, current: false, error: null };
        },
        async install() {
          return { ok: true, error: null };
        },
        async activate() {
          activates.push(1);
          return { ok: false, error: "OpenCode sessions are busy" };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-pending"]`) as Mini;
    const button = item.querySelector("button") as Mini;
    expect(button.getAttribute("aria-label")).toContain("restart pending");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activates).toEqual([1]);
    expect(menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-pending"]`)).toBeTruthy();
    ac.abort();
  });

  it("keeps the icon-only control accessible and long failures readable", async () => {
    const css = readFileSync(new URL("../src/app/update-control.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.oc-update-item[\s\S]*max-width:\s*100%/);
    expect(css).toMatch(/\.oc-update__detail[\s\S]*overflow-wrap:\s*anywhere/);

    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-labels",
      document: doc as unknown as Document,
      rpc: {
        async status() {
          return { eligible: true, canRestart: false, current: false, error: null };
        },
        async install() {
          return {
            ok: false,
            error: "a very long installer failure that must wrap outside the compact action",
          };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-labels"]`) as Mini;
    const button = item.querySelector("button") as Mini;
    expect(button.innerHTML).not.toContain("Update");
    button.click();
    expect(button.getAttribute("aria-label")).toBe("Updating OpenCode");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.getAttribute("aria-label")).toContain("Click to retry");
    expect(item.querySelector(".oc-update__detail")?.textContent).toContain(
      "a very long installer failure",
    );
    ac.abort();
  });

  it("does not let a stale status completion drop in-progress install UI", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    let statusCalls = 0;
    let releaseStatus: ((value: UpdateControlStatus) => void) | undefined;
    const dispose = mountUpdateControl({
      pluginId: "opencode",
      signal: ac.signal,
      ownerId: "gen-stale",
      pollMs: 20,
      document: doc as unknown as Document,
      rpc: {
        async status() {
          statusCalls += 1;
          if (statusCalls === 1) return { eligible: true, canRestart: false, current: false, error: null };
          return new Promise((resolve) => {
            releaseStatus = resolve;
          });
        },
        async install() {
          return new Promise(() => undefined);
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = Date.now();
    while (statusCalls < 2 && Date.now() - started < 500) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-stale"]`) as Mini;
    const button = item.querySelector("button") as Mini;
    button.click();
    expect(button.dataset.state).toBe("pending");
    releaseStatus?.({ eligible: false, canRestart: false, current: false, error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-stale"]`)).toBeTruthy();
    expect(button.dataset.state).toBe("pending");
    dispose();
    ac.abort();
  });

  it("ignores deferred status and install after manual dispose", async () => {
    const { doc, menu } = footerDoc();
    stubObserver();
    const ac = new AbortController();
    let finishStatus: ((value: UpdateControlStatus) => void) | undefined;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = ((...args: unknown[]) => {
      errors.push(String(args[0]));
    }) as typeof console.error;
    try {
      const disposeStatus = mountUpdateControl({
        pluginId: "opencode",
        signal: ac.signal,
        ownerId: "gen-defer-status",
        document: doc as unknown as Document,
        rpc: {
          async status() {
            return new Promise((resolve) => {
              finishStatus = resolve;
            });
          },
          async install() {
            return { ok: true, error: null };
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      disposeStatus();
      finishStatus?.({ eligible: true, canRestart: false, current: false, error: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);

      let finishInstall: ((value: { ok: boolean; error: string | null }) => void) | undefined;
      const ac2 = new AbortController();
      const disposeInstall = mountUpdateControl({
        pluginId: "opencode",
        signal: ac2.signal,
        ownerId: "gen-defer-install",
        document: doc as unknown as Document,
        rpc: {
          async status() {
            return { eligible: true, canRestart: false, current: false, error: null };
          },
          async install() {
            return new Promise((resolve) => {
              finishInstall = resolve;
            });
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const item = menu.querySelector(`[${UPDATE_CONTROL_ATTR}="gen-defer-install"]`) as Mini;
      (item.querySelector("button") as Mini).click();
      disposeInstall();
      finishInstall?.({ ok: false, error: "late fail" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(menu.querySelectorAll(`[${UPDATE_CONTROL_ATTR}]`)).toHaveLength(0);
      expect(errors.some((line) => line.includes("late fail"))).toBe(false);
      ac2.abort();
    } finally {
      console.error = originalError;
      ac.abort();
    }
  });
});

describe("registration", () => {
  it("registers a dedicated content script and daemon provider installation", () => {
    const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
    expect(app).toContain('id: "opencode-update-control"');
    expect(app).toContain("mountUpdateControl");
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(server).toContain("installation: true");
    expect(server).toContain("installProviderCli");
    expect(server).not.toContain("host.call(\"installUpdate\"");
    const settings = readFileSync(
      new URL("../src/app/settings-section.tsx", import.meta.url),
      "utf8",
    );
    expect(settings).not.toMatch(/installUpdate|Update OpenCode|Install OpenCode|Restart to apply/);
  });
});
