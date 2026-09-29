import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import type { QueuedComposerMessage } from "../../queuedMessageStore";

/** Restore thread references from messages returned to the composer by Stop or Cancel. */
export function restoreQueuedThreadContexts(
  target: ComposerThreadTarget,
  messages: ReadonlyArray<Pick<QueuedComposerMessage, "threadContexts">>,
): string {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const threadContexts = messages.flatMap((message) => message.threadContexts);
  if (threadContexts.length > 0) {
    const seen = new Set<string>();
    store.setThreadContexts(
      target,
      [...(draft?.threadContexts ?? []), ...threadContexts].filter((record) => {
        if (seen.has(record.contextId)) return false;
        seen.add(record.contextId);
        return true;
      }),
    );
  }
  return store.getComposerDraft(target)?.prompt ?? "";
}
