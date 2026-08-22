export type ImportBlockReason =
  | "running"
  | "missing-directory"
  | "already-imported"
  | null;

export function classifyImportRow(args: {
  id: string;
  directory: string | null;
  running: boolean;
  importedIds: ReadonlySet<string>;
}): { blocked: boolean; blockReason: ImportBlockReason; alreadyImported: boolean } {
  const alreadyImported = args.importedIds.has(args.id);
  const missing = !args.directory;
  if (args.running) {
    return { blocked: true, blockReason: "running", alreadyImported };
  }
  if (missing) {
    return { blocked: true, blockReason: "missing-directory", alreadyImported };
  }
  if (alreadyImported) {
    return { blocked: true, blockReason: "already-imported", alreadyImported };
  }
  return { blocked: false, blockReason: null, alreadyImported: false };
}
