import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { restoreQueuedThreadContexts } from "./queuedMessageRestore";

const target = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const reference = threadContextRecord(
  scopeThreadRef(target.environmentId, ThreadId.make("referenced-thread")),
  "Previous conversation",
);

describe("queued message Stop restore", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it("keeps a queued thread reference when Stop returns messages to the draft", () => {
    const drafts = useComposerDraftStore.getState();
    drafts.setPrompt(target, "Current draft\n\nQueued message");
    // Stop takes the messages out of the run queue and hands them back to the
    // composer; only their thread references need restoring here.
    const messages = [{ threadContexts: [reference] }];

    const prompt = restoreQueuedThreadContexts(target, messages);

    expect(drafts.getComposerDraft(target)?.threadContexts).toEqual([reference]);
    expect(prompt).toContain(reference.contextId);
    expect(prompt).toContain("Current draft\n\nQueued message");
  });
});
