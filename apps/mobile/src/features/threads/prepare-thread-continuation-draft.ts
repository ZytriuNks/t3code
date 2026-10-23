import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

import { threadComposerContext } from "../../lib/composerContext";
import {
  createNewTaskDraft,
  insertComposerDraftContext,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

export interface ThreadContinuationDraftInput {
  readonly sourceThread: ScopedThreadRef;
  readonly sourceTitle: string;
  readonly project: ScopedProjectRef;
  readonly canContinue: () => boolean;
}

export async function prepareThreadContinuationDraft(
  input: ThreadContinuationDraftInput,
): Promise<string | null> {
  if (input.sourceThread.environmentId !== input.project.environmentId || !input.canContinue()) {
    return null;
  }
  await waitForComposerDraftsLoaded();
  if (!input.canContinue()) return null;
  const record = threadComposerContext(input.sourceThread, input.sourceTitle);
  const draftId = createNewTaskDraft(input.project);
  insertComposerDraftContext(draftId, {
    text: formatComposerContextReference(record),
    context: { version: 1, records: [record] },
  });
  return draftId;
}
