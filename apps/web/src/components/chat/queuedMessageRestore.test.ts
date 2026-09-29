import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { restoreQueuedThreadContexts } from "./queuedMessageRestore";

const target = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const threadKey = scopedThreadKey(target);
const reference = threadContextRecord(
  scopeThreadRef(target.environmentId, ThreadId.make("referenced-thread")),
  "Previous conversation",
);

describe("queued message Stop restore", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  });

  it("keeps a queued thread reference when Stop drains the queue into the draft", () => {
    const drafts = useComposerDraftStore.getState();
    drafts.setPrompt(target, "Current draft\n\nQueued message");
    useQueuedMessageStore.getState().enqueue(threadKey, {
      prompt: "Queued message",
      images: [],
      files: [],
      terminalContexts: [],
      threadContexts: [reference],
      previewAnnotations: [],
      reviewComments: [],
      sendSettings: {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        promptEffort: null,
      },
      queuedAfterToolActivityId: null,
      createdAt: "2026-09-25T00:00:00Z",
    });

    const prompt = restoreQueuedThreadContexts(
      target,
      useQueuedMessageStore.getState().drain(threadKey),
    );

    expect(useQueuedMessageStore.getState().queuesByThreadKey[threadKey]).toBeUndefined();
    expect(drafts.getComposerDraft(target)?.threadContexts).toEqual([reference]);
    expect(prompt).toContain(reference.contextId);
    expect(prompt).toContain("Current draft\n\nQueued message");
  });
});
