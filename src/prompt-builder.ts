export interface PromptPart {
  type: "text" | "file" | "agent";
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
}

export interface BuiltPrompt {
  agent: string;
  parts: PromptPart[];
  model?: { providerID: string; modelID: string };
  /** OpenCode user-message `system`. Not a user text part — keep it out of ensureTitle. */
  system?: string;
}

export type AttachmentMapResult =
  | { ok: true; part: PromptPart }
  | { ok: false; reason: string };

export interface PromptInputLike {
  type: string;
  text?: string;
  path?: string;
  url?: string;
  name?: string;
  mimeType?: string;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function mapAttachment(input: PromptInputLike): AttachmentMapResult {
  if (input.type === "text") {
    return { ok: true, part: { type: "text", text: input.text ?? "" } };
  }
  if (input.type === "localFile" || input.type === "localImage") {
    const path = input.path ?? "";
    if (!path) return { ok: false, reason: "attachment path missing" };
    const filename = input.name ?? path.split("/").pop() ?? path;
    const mime =
      input.mimeType ??
      (input.type === "localImage" ? mimeFromFilename(filename) : "text/plain");
    return {
      ok: true,
      part: {
        type: "file",
        mime,
        filename,
        url: path.startsWith("file:") ? path : `file://${path}`,
      },
    };
  }
  if (input.type === "image") {
    if (!input.url) return { ok: false, reason: "image url missing" };
    return {
      ok: true,
      part: {
        type: "file",
        mime: "image/*",
        filename: "image",
        url: input.url,
      },
    };
  }
  return { ok: false, reason: `unsupported attachment type: ${input.type}` };
}

export function buildPrompt(args: {
  agent: string;
  input: readonly PromptInputLike[];
  model?: string;
  instructions?: string;
}): { ok: true; prompt: BuiltPrompt } | { ok: false; reason: string } {
  if (!args.agent) {
    return { ok: false, reason: "agent is required" };
  }
  const parts: PromptPart[] = [];
  for (const item of args.input) {
    const mapped = mapAttachment(item);
    if (!mapped.ok) return mapped;
    parts.push(mapped.part);
  }
  const prompt: BuiltPrompt = { agent: args.agent, parts };
  const instructions = args.instructions?.trim();
  if (instructions) {
    prompt.system = `[BB project instructions]\n${instructions}`;
  }
  if (args.model) {
    const split = args.model.split("/");
    if (split.length >= 2) {
      prompt.model = {
        providerID: split[0]!,
        modelID: split.slice(1).join("/"),
      };
    }
  }
  return { ok: true, prompt };
}

function mimeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  if (IMAGE_EXT.has(ext)) return "image/*";
  return "application/octet-stream";
}
