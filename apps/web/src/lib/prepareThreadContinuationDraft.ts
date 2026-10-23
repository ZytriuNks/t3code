import type { ScopedProjectRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { threadContextRecord } from "./composerContextRecords";

export interface ThreadContinuationDraftInput {
  readonly sourceThread: ScopedThreadRef;
  readonly sourceTitle: string;
  readonly project: ScopedProjectRef;
  readonly canContinue: () => boolean;
  readonly openDraft: (
    project: ScopedProjectRef,
  ) => Promise<{ draftId: DraftId; threadId: ThreadId } | null>;
}

export async function prepareThreadContinuationDraft(
  input: ThreadContinuationDraftInput,
): Promise<DraftId | null> {
  if (input.sourceThread.environmentId !== input.project.environmentId || !input.canContinue()) {
    return null;
  }
  const draft = await input.openDraft(input.project);
  if (draft === null || !input.canContinue()) return null;
  useComposerDraftStore
    .getState()
    .addThreadContexts(draft.draftId, [threadContextRecord(input.sourceThread, input.sourceTitle)]);
  return draft.draftId;
}
