import { PROVIDER_DISPLAY_NAME, PROVIDER_ID } from "../identity.js";

/** Parse BB's model-chip `title` (`"OpenCode: DeepSeek · Medium reasoning"`). */
export function providerIdFromModelTriggerTitle(
  title: string | null | undefined,
): string | null {
  if (!title) return null;
  const trimmed = title.trim();
  if (
    trimmed === PROVIDER_DISPLAY_NAME ||
    trimmed === PROVIDER_ID ||
    trimmed.startsWith(`${PROVIDER_DISPLAY_NAME}:`) ||
    trimmed.toLowerCase().startsWith(`${PROVIDER_ID}:`)
  ) {
    return PROVIDER_ID;
  }
  const label = trimmed.split(":")[0]?.trim();
  if (!label) return null;
  return label;
}

export function titleFromModelTrigger(button: Element | null): string | null {
  if (!button) return null;
  const own = button.getAttribute("title");
  if (own) return own;
  const nested = button.querySelector("[title]");
  return nested?.getAttribute("title") ?? null;
}

export function chipSuggestsOpencode(args: {
  liveProviderId?: string | null;
  title?: string | null;
  text?: string | null;
  hasOpencodeLogo?: boolean;
}): boolean {
  if (args.liveProviderId === PROVIDER_ID) return true;
  if (args.hasOpencodeLogo) return true;
  const blob = `${args.title ?? ""} ${args.text ?? ""}`;
  return new RegExp(`\\b${PROVIDER_DISPLAY_NAME}\\b`, "i").test(blob);
}

function modelButtons(shell: ParentNode): Element[] {
  const labeled = Array.from(
    shell.querySelectorAll('[aria-label^="Provider, model and reasoning"]'),
  );
  if (labeled.length > 0) return labeled;
  return Array.from(
    shell.querySelectorAll(
      '[title^="OpenCode"], [title^="opencode"], [title*=": "][title*="reasoning"]',
    ),
  );
}

export function readLiveComposerProvider(from: Element | null): string | null {
  const shells: ParentNode[] = [];
  const closest = from?.closest("[data-app-composer]");
  if (closest) shells.push(closest);
  if (typeof document !== "undefined") shells.push(document);

  for (const shell of shells) {
    for (const button of modelButtons(shell)) {
      const parsed = providerIdFromModelTriggerTitle(
        titleFromModelTrigger(button),
      );
      if (parsed) return parsed;
    }
  }
  return null;
}

/** BB's compact PWA prompt box sets `data-promptbox-compact` and hides plugin actions. */
export function composerLayoutIsCompact(from: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const closest = from?.closest("[data-app-composer]");
  const shells: ParentNode[] = [];
  if (closest) shells.push(closest);
  shells.push(document);
  return shells.some((shell) => shell.querySelector("[data-promptbox-compact]") !== null);
}

/**
 * Plugin footer actions are omitted in compact composers and clipped on
 * coarse/narrow PWA. The banner slot is the surface that still mounts.
 */
export function composerSurfaceWantsBanner(args: {
  layout?: "compact" | "expanded" | "zen" | null;
  from?: Element | null;
}): boolean {
  if (args.layout === "compact") return true;
  if (composerLayoutIsCompact(args.from ?? null)) return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    window.matchMedia("(max-width: 767px)").matches
  );
}

export function inspectLiveComposerProvider(from: Element | null): {
  found: boolean;
  opencode: boolean;
} {
  const shells: ParentNode[] = [];
  const closest = from?.closest("[data-app-composer]");
  if (closest) shells.push(closest);
  if (typeof document !== "undefined") shells.push(document);

  for (const shell of shells) {
    for (const node of modelButtons(shell)) {
      const title = titleFromModelTrigger(node);
      const text = node.textContent;
      const hasOpencodeLogo = Boolean(
        node.querySelector(
          'img[src*="/providers/opencode/"], img[src*="provider=opencode"], [data-plugin-icon-asset*="opencode"]',
        ),
      );
      const liveProviderId = providerIdFromModelTriggerTitle(title);
      const opencode = chipSuggestsOpencode({
        liveProviderId,
        title,
        text,
        hasOpencodeLogo,
      });
      if (opencode || liveProviderId) {
        return { found: true, opencode };
      }
    }
  }
  return { found: false, opencode: false };
}

export function newThreadShowsOpencodeAgent(from: Element | null): boolean {
  return inspectLiveComposerProvider(from).opencode;
}

/** Pre-thread screen: live chip wins; otherwise the project default. */
export function newThreadAgentPickerVisible(args: {
  liveFound: boolean;
  liveOpenCode: boolean;
  chromeOpenCode: boolean;
}): boolean {
  if (args.liveOpenCode) return true;
  if (args.liveFound) return false;
  return args.chromeOpenCode;
}
