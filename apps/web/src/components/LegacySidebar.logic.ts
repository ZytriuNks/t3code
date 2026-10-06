import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  DraftId,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../types";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { filterSidebarVisibleThreads, sortPinnedThreadsForSidebar } from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";

export type LegacySidebarSection = "pinned" | "projects" | "unassigned";

export function legacySidebarThreads(
  threads: readonly SidebarThreadSummary[],
  section: LegacySidebarSection,
  order: SidebarThreadSortOrder,
) {
  const visible = filterSidebarVisibleThreads(threads).filter((thread) =>
    section === "pinned" ? thread.pinnedAt != null : thread.pinnedAt == null,
  );
  return section === "pinned" ? sortPinnedThreadsForSidebar(visible) : sortThreads(visible, order);
}

export function shouldRenderLegacySidebarFlatSection(
  threads: readonly SidebarThreadSummary[],
  section: "pinned" | "unassigned",
  order: SidebarThreadSortOrder,
): boolean {
  return legacySidebarThreads(threads, section, order).length > 0;
}

export function splitLegacySidebarProjects(
  projects: readonly SidebarProjectSnapshot[],
  scratchRoots: ReadonlyMap<EnvironmentId, string>,
) {
  const regular: SidebarProjectSnapshot[] = [];
  const unassigned: SidebarProjectSnapshot[] = [];
  for (const project of projects) {
    (project.memberProjects.every((member) =>
      isScratchProject(member, scratchRoots.get(member.environmentId)),
    )
      ? unassigned
      : regular
    ).push(project);
  }
  return { regular, unassigned };
}

// Flat sections share the existing thread actions across all their physical projects.
export function legacySidebarSectionProject(
  projects: readonly SidebarProjectSnapshot[],
  section: "pinned" | "unassigned",
): SidebarProjectSnapshot | null {
  const first = projects[0];
  if (!first) return null;
  return {
    ...first,
    projectKey: `legacy-sidebar:${section}`,
    memberProjects: projects.flatMap((project) => project.memberProjects),
    memberProjectRefs: projects.flatMap((project) => project.memberProjectRefs),
  };
}

export function visibleLegacySidebarDraftIds(input: {
  sessions: Readonly<Record<string, DraftSessionState>>;
  composers: Readonly<Record<string, ComposerThreadDraftState>>;
  projectRefs: readonly ScopedProjectRef[];
  activeDraftId: DraftId | null;
}): DraftId[] {
  const projectKeys = new Set(input.projectRefs.map(scopedProjectKey));
  return Object.entries(input.sessions)
    .filter(
      ([id, session]) =>
        session.promotedTo == null &&
        projectKeys.has(
          scopedProjectKey(scopeProjectRef(session.environmentId, session.projectId)),
        ) &&
        (id === input.activeDraftId || composerDraftHasUserContent(input.composers[id])),
    )
    .sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt))
    .map(([id]) => DraftId.make(id));
}
