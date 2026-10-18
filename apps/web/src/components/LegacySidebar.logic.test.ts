import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { makeThreadFixture } from "../test-fixtures";
import {
  legacySidebarSectionProject,
  legacySidebarThreads,
  shouldRenderLegacySidebarFlatSection,
  splitLegacySidebarProjects,
  visibleLegacySidebarDraftIds,
} from "./LegacySidebar.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectRef = scopeProjectRef(local, ProjectId.make("project"));
const draftId = DraftId.make("draft-one");
const nextDraftId = DraftId.make("draft-two");
const threadId = ThreadId.make("reserved-thread");

function project(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  title = "Project",
): SidebarProjectSnapshot {
  const member = {
    environmentId,
    id: projectRef.projectId,
    workspaceRoot,
    title,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    physicalProjectKey: `${environmentId}:${workspaceRoot}`,
    environmentLabel: null,
  };
  return {
    ...member,
    projectKey: member.physicalProjectKey,
    displayName: title,
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: [member],
    memberProjectRefs: [scopeProjectRef(environmentId, member.id)],
    remoteEnvironmentLabels: [],
  };
}

describe("legacy sidebar sections", () => {
  it("identifies no-project workspaces by environment and normalized path, never by title", () => {
    const scratch = project(local, "D:/Scratch/", "Renamed");
    const namedNoProject = project(local, "D:/Workspace", "No project");
    const remoteWorkspace = project(remote, "D:/Scratch");
    const remoteScratch = project(remote, "/scratch");
    const roots = new Map([
      [local, "D:\\Scratch"],
      [remote, "/scratch"],
    ]);
    expect(
      splitLegacySidebarProjects([scratch, namedNoProject, remoteWorkspace, remoteScratch], roots),
    ).toEqual({ regular: [namedNoProject, remoteWorkspace], unassigned: [scratch, remoteScratch] });
  });

  it("does not render an empty pinned flat section", () => {
    expect(shouldRenderLegacySidebarFlatSection([], "pinned", "updated_at")).toBe(false);
    expect(
      shouldRenderLegacySidebarFlatSection(
        [makeThreadFixture({ pinnedAt: "2026-10-06T01:00:00Z" })],
        "pinned",
        "updated_at",
      ),
    ).toBe(true);
  });
  it("combines no-project threads across environments without losing their scoped project refs", () => {
    const projects = [project(local, "D:/Scratch"), project(remote, "/scratch")];
    expect(legacySidebarSectionProject(projects, "unassigned")?.memberProjectRefs).toEqual(
      projects.flatMap((entry) => entry.memberProjectRefs),
    );
    expect(legacySidebarSectionProject([], "unassigned")).toBeNull();
  });

  it("moves pinned threads out of project lists and keeps global pin order", () => {
    const first = makeThreadFixture({
      id: ThreadId.make("first"),
      pinnedAt: "2026-10-06T01:00:00Z",
      pinOrderKey: "a0",
    });
    const second = makeThreadFixture({
      id: ThreadId.make("second"),
      pinnedAt: "2026-10-06T02:00:00Z",
      pinOrderKey: "a1",
    });
    const regular = makeThreadFixture({ id: ThreadId.make("regular") });
    const archived = makeThreadFixture({
      id: ThreadId.make("archived"),
      archivedAt: "2026-10-06T03:00:00Z",
      pinnedAt: first.pinnedAt,
    });
    const child = makeThreadFixture({
      id: ThreadId.make("child"),
      pinnedAt: first.pinnedAt,
      lineage: {
        rootThreadId: first.id,
        parentThreadId: first.id,
        relationshipToParent: "subagent",
      },
    });
    const threads = [second, regular, archived, child, first];
    expect(legacySidebarThreads(threads, "pinned", "updated_at")).toEqual([first, second]);
    expect(legacySidebarThreads(threads, "projects", "updated_at")).toEqual([regular]);
    expect(legacySidebarThreads(threads, "unassigned", "updated_at")).toEqual([regular]);
    expect(
      legacySidebarThreads([{ ...first, pinnedAt: null }], "projects", "updated_at"),
    ).toHaveLength(1);
  });
});

describe("legacy sidebar draft lifecycle", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, { threadId });
  });

  function visible(activeDraftId: DraftId | null, projectRefs = [projectRef]) {
    const store = useComposerDraftStore.getState();
    return visibleLegacySidebarDraftIds({
      sessions: store.draftThreadsByThreadKey,
      composers: store.draftsByThreadKey,
      projectRefs,
      activeDraftId,
    });
  }

  it("shows a new empty draft immediately, then removes the row when navigating away", () => {
    expect(visible(draftId)).toEqual([draftId]);
    expect(visible(null)).toEqual([]);
    useComposerDraftStore.getState().setPrompt(draftId, "   ");
    expect(visible(null)).toEqual([]);
  });

  it("retains text and images while navigating to another draft and back", () => {
    const store = useComposerDraftStore.getState();
    const file = new File(["image bytes"], "image.png", { type: "image/png" });
    store.setPrompt(draftId, "Continue this later");
    store.addImage(draftId, {
      id: "image",
      type: "image",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: "blob:retained-image",
    });
    const composer = useComposerDraftStore.getState().getComposerDraft(draftId);
    store.setProjectDraftThreadId(projectRef, nextDraftId, {
      threadId: ThreadId.make("next-thread"),
      createdAt: "2099-01-01T00:00:00Z",
    });
    expect(visible(nextDraftId)).toEqual([nextDraftId, draftId]);
    expect(visible(draftId)).toEqual([draftId]);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(composer);
    expect(composer?.images[0]?.file).toBe(file);
  });

  it("retains an attachment-only draft, including uploads that are still pending", () => {
    const file = new File(["file bytes"], "notes.txt", { type: "text/plain" });
    useComposerDraftStore.getState().addFiles(draftId, [
      {
        id: "file",
        type: "file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ]);
    expect(visible(null)).toEqual([draftId]);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0]?.file).toBe(file);
    useComposerDraftStore.getState().setFileUpload(draftId, "file", local, "uploaded-file");
    expect(visible(null)).toEqual([draftId]);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0]?.uploadedAttachmentId,
    ).toBe("uploaded-file");
  });

  it("removes the row after its content is cleared and never matches another environment's project", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Text");
    expect(visible(null, [scopeProjectRef(remote, projectRef.projectId)])).toEqual([]);
    store.clearComposerContent(draftId);
    expect(visible(draftId)).toEqual([draftId]);
    expect(visible(null)).toEqual([]);
  });

  it("removes promoted and explicitly closed drafts without deleting another draft's content", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "First");
    store.setProjectDraftThreadId(projectRef, nextDraftId, {
      threadId: ThreadId.make("next-thread"),
    });
    store.setPrompt(nextDraftId, "Second");
    markPromotedDraftThreadByRef(scopeThreadRef(local, threadId));
    expect(visible(draftId)).toEqual([nextDraftId]);
    store.clearDraftThread(nextDraftId);
    expect(visible(null)).toEqual([]);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("First");
    expect(useComposerDraftStore.getState().getComposerDraft(nextDraftId)).toBeNull();
  });
});
