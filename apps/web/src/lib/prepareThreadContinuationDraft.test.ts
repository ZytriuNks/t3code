import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { prepareThreadContinuationDraft } from "./prepareThreadContinuationDraft";

const environmentId = EnvironmentId.make("continuation-environment");
const project = { environmentId, projectId: ProjectId.make("continuation-project") };
const sourceThread = { environmentId, threadId: ThreadId.make("native-child") };
const draftId = DraftId.make("independent-draft");
const threadId = ThreadId.make("independent-thread");

function setup() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    rewindingThreadKeys: new Set(),
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function openDraft() {
  useComposerDraftStore.getState().setProjectDraftThreadId(project, draftId, { threadId });
  return Promise.resolve({ draftId, threadId });
}

const input = () => ({
  sourceThread,
  sourceTitle: "Native child",
  project,
  canContinue: () => true,
  openDraft,
});

describe("prepare independent thread continuation", () => {
  it("prepares a runless child reference without changing the source or invested draft", async () => {
    setup();
    const store = useComposerDraftStore.getState();
    const existingId = DraftId.make("invested-draft");
    store.setProjectDraftThreadId(project, existingId, {
      threadId: ThreadId.make("invested-thread"),
    });
    store.setPrompt(existingId, "Do not replace this work");
    store.setPrompt(sourceThread, "Source draft stays untouched");
    const existingBefore = store.getComposerDraft(existingId);
    const sourceBefore = store.getComposerDraft(sourceThread);

    expect(await prepareThreadContinuationDraft(input())).toBe(draftId);

    const after = useComposerDraftStore.getState();
    expect(after.getComposerDraft(existingId)).toEqual(existingBefore);
    expect(after.getComposerDraft(sourceThread)).toEqual(sourceBefore);
    const target = after.getComposerDraft(draftId)!;
    expect(target.threadContexts).toMatchObject([
      { kind: "thread", environmentId, threadId: sourceThread.threadId, title: "Native child" },
    ]);
    expect(target.prompt).toContain("t3-context://v1/thread/");
    expect(after.getDraftSession(draftId)?.threadId).toBe(threadId);
    expect(after.getDraftSession(draftId)).not.toHaveProperty("providerThreadId");
  });

  it("does not open a draft without current operate permission", async () => {
    setup();
    const open = vi.fn(openDraft);
    expect(
      await prepareThreadContinuationDraft({
        ...input(),
        canContinue: () => false,
        openDraft: open,
      }),
    ).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not move a child reference into another environment", async () => {
    setup();
    const open = vi.fn(openDraft);
    expect(
      await prepareThreadContinuationDraft({
        ...input(),
        project: { ...project, environmentId: EnvironmentId.make("other-environment") },
        openDraft: open,
      }),
    ).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves state alone when opening the draft is abandoned", async () => {
    setup();
    const before = useComposerDraftStore.getState().draftsByThreadKey;
    expect(
      await prepareThreadContinuationDraft({ ...input(), openDraft: async () => null }),
    ).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual(before);
  });

  it("does not attach context if permission was revoked during draft preparation", async () => {
    setup();
    let allowed = true;
    let finish: ((value: { draftId: DraftId; threadId: ThreadId }) => void) | undefined;
    const result = prepareThreadContinuationDraft({
      ...input(),
      canContinue: () => allowed,
      openDraft: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await Promise.resolve();
    expect(finish).toBeTypeOf("function");
    useComposerDraftStore.getState().setPrompt(draftId, "Typed while preparing");
    allowed = false;
    finish?.({ draftId, threadId });
    expect(await result).toBeNull();
    const target = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(target?.prompt).toBe("Typed while preparing");
    expect(target?.threadContexts).toEqual([]);
  });

  it("reports draft preparation errors instead of writing source state", async () => {
    setup();
    const before = useComposerDraftStore.getState().draftsByThreadKey;
    await expect(
      prepareThreadContinuationDraft({
        ...input(),
        openDraft: async () => {
          throw new Error("Project could not be read");
        },
      }),
    ).rejects.toThrow("Project could not be read");
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual(before);
  });
});
