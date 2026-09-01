import type { OpenCodeClient } from "./client.js";
import type { HydrateMessage } from "./hydrate.js";

export interface CompleteHistoryResult {
  messages: HydrateMessage[];
  pages: number;
  paginated: boolean;
}

/**
 * Read explicit complete history in bounded OpenCode pages. Older servers that
 * ignore `before` fall back once to the legacy complete read for correctness.
 */
export async function readCompleteHistory(
  client: OpenCodeClient,
  sessionId: string,
  pageSize = 100,
): Promise<CompleteHistoryResult> {
  const size = Math.max(1, pageSize);
  let before: string | undefined;
  let pages = 0;
  const newestFirstPages: HydrateMessage[][] = [];
  const seenCursors = new Set<string>();
  const flattenSourceOrder = () => [...newestFirstPages].reverse().flat();

  const legacyFallback = async (): Promise<CompleteHistoryResult> => ({
    messages: (await client.sessionMessages(sessionId)) as HydrateMessage[],
    pages: pages + 1,
    paginated: false,
  });

  while (true) {
    let page: HydrateMessage[];
    pages += 1;
    try {
      page = (await client.sessionMessages(sessionId, size, before)) as HydrateMessage[];
    } catch (error) {
      // OpenCode releases before cursor support reject the second request. The
      // first bounded request must still succeed; only cursor rejection proves
      // that this server needs the explicit legacy complete read.
      if (before === undefined) throw error;
      return legacyFallback();
    }
    if (page.length === 0) {
      return { messages: flattenSourceOrder(), pages, paginated: true };
    }

    const firstId = page[0]?.info.id;
    if (!firstId || seenCursors.has(firstId)) return legacyFallback();
    seenCursors.add(firstId);
    newestFirstPages.push(page);
    if (page.length < size) {
      return { messages: flattenSourceOrder(), pages, paginated: true };
    }
    before = firstId;
  }
}
