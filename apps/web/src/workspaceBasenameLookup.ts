// Enough hits to look past same-named neighbours (`ChatView.test.tsx`) without
// asking for a full listing on a single click.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let latestLookupSequence = 0;

/** Call the returned predicate when the search settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function normalizeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Search only paths with an ambiguous workspace prefix. Ordinary full paths
 * can open directly without waiting for the workspace index.
 */
export function workspacePathLookupQueries(
  workspaceRelativePath: string,
  workspaceRoot: string,
): ReadonlyArray<string> {
  const normalizedPath = normalizeWorkspacePath(workspaceRelativePath.trim());
  if (!normalizedPath) return [];
  const workspaceName = workspaceRoot.split(/[\\/]/).findLast(Boolean);
  const segments = normalizedPath.split("/").filter(Boolean);
  if (
    workspaceName &&
    segments.length > 1 &&
    segments[0]?.toLowerCase() === workspaceName.toLowerCase()
  ) {
    return [normalizedPath, segments.slice(1).join("/")];
  }
  return [];
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  // Folded matching covers casing that drifted from disk, but `FOO.ts` against
  // both `Foo.ts` and `foo.ts` has no right answer, so it resolves to nothing
  // rather than opening whichever the index ranked first.
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

/** Returns a unique file whose workspace-relative path exactly matches target. */
export function pickWorkspacePathMatch(
  targetPath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = normalizeWorkspacePath(targetPath.trim());
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => normalizeWorkspacePath(entry.path) === target);
  if (exact) return exact.path;

  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => normalizeWorkspacePath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}
