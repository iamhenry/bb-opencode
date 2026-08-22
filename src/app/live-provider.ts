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
  return Array.from(
    shell.querySelectorAll('[aria-label^="Provider, model and reasoning"]'),
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

export function newThreadShowsOpencodeAgent(from: Element | null): boolean {
  const shells: ParentNode[] = [];
  const closest = from?.closest("[data-app-composer]");
  if (closest) shells.push(closest);
  if (typeof document !== "undefined") shells.push(document);

  for (const shell of shells) {
    for (const button of modelButtons(shell)) {
      const title = titleFromModelTrigger(button);
      const text = button.textContent;
      const hasOpencodeLogo = Boolean(
        button.querySelector(
          'img[src*="/providers/opencode/"], img[src*="provider=opencode"]',
        ),
      );
      if (
        chipSuggestsOpencode({
          liveProviderId: providerIdFromModelTriggerTitle(title),
          title,
          text,
          hasOpencodeLogo,
        })
      ) {
        return true;
      }
    }
  }
  return false;
}
