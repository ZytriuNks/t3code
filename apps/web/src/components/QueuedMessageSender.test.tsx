import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useQueuedMessageStore, type QueuedComposerMessage } from "../queuedMessageStore";
import { threadContextRecord } from "../lib/composerContextRecords";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { sendQueuedMessage } from "./chat/sendQueuedMessage";
import { QueuedMessageSender } from "./QueuedMessageSender";

const io = vi.hoisted(() => ({
  run: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
  thread: null as unknown,
  shell: { runtimeMode: "full-access", interactionMode: "default" } as Record<string, unknown>,
}));
const config = {
  environment: { capabilities: { attachmentUploads: true, inlineMessageContext: true } },
};
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => io.run(...args),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["env-a", config]]) },
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    updateMetadata: "metadata",
    setRuntimeMode: "runtime",
    setInteractionMode: "interaction",
    startTurn: "start",
  },
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("../state/entities", () => ({
  useThreadProjection: () => io.thread,
  useThreadShell: () => io.shell,
  useThreadStatus: () => "live",
  useServerConfigs: () => new Map([["env-a", config]]),
  readThreadShell: () => io.shell,
  readThread: () => io.thread,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: (...args: unknown[]) => io.toast(...args) } }));
vi.mock("../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: (...args: unknown[]) => io.upload(...args),
  getUploadedAttachments: () => [
    { type: "image", id: "uploaded", name: "a.png", mimeType: "image/png", sizeBytes: 4 },
  ],
  releaseDraftAttachments: vi.fn(),
}));

const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const threadKey = scopedThreadKey(threadRef);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

function enqueue(overrides: Partial<QueuedComposerMessage> = {}) {
  return useQueuedMessageStore.getState().enqueue(threadKey, {
    prompt: "follow up",
    images: [],
    files: [],
    terminalContexts: [],
    threadContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-25T00:00:00Z",
    ...overrides,
  });
}

const commandsRun = () => io.run.mock.calls.map((call) => call[1]);
const queue = () => useQueuedMessageStore.getState().queuesByThreadKey[threadKey];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  io.thread = null;
  io.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  io.upload.mockReset().mockResolvedValue(undefined);
  io.toast.mockReset();
  io.shell = {
    modelSelection,
    branch: null,
    runtimeMode: "full-access",
    interactionMode: "default",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QueuedMessageSender", () => {
  const setThread = (
    status: "running" | "idle",
    { toolActivityIds = [] as string[], userMessageIds = [] as string[] } = {},
  ) => {
    const projection = makeThreadProjectionFixture();
    const at = DateTime.makeUnsafe("2026-09-25T00:00:01Z");
    const turnItems: OrchestrationV2TurnItem[] = toolActivityIds.map((id, index) => ({
      id: TurnItemId.make(id),
      threadId: threadRef.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "command_execution",
      input: "echo done",
    }));
    const messages: OrchestrationV2ConversationMessage[] = userMessageIds.map((id) => ({
      id: MessageId.make(id),
      threadId: threadRef.threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: id,
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: at,
      updatedAt: at,
    }));
    io.thread = {
      environmentId: threadRef.environmentId,
      projection: {
        ...projection,
        thread: { ...projection.thread, id: threadRef.threadId },
        turnItems,
        messages,
      },
    };
    io.shell = {
      ...io.shell,
      latestRun: null,
      runtime: {
        status,
        activeRunId: status === "running" ? RunId.make("run-a") : null,
        providerInstanceId: modelSelection.instanceId,
        providerName: null,
        lastError: null,
        updatedAt: "2026-09-25T00:00:01Z",
      },
    };
  };
  let root: ReactTestRenderer | null = null;
  const render = () =>
    act(() => {
      if (root) root.update(createElement(QueuedMessageSender));
      else root = create(createElement(QueuedMessageSender));
    });
  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
  });

  it("sends a queued message when the turn ends, with no chat view open", async () => {
    enqueue();
    setThread("running");
    await render();
    expect(commandsRun()).toEqual([]);

    setThread("idle");
    await render();

    expect(commandsRun()).toEqual(["start"]);
    expect(io.run.mock.calls[0]?.[2]).toMatchObject({
      environmentId: "env-a",
      input: { threadId: "thread-a", message: { text: "follow up" }, modelSelection },
    });
    expect(queue()).toBeUndefined();
  });

  it("holds the next message until the server picks up the one before it", async () => {
    enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    setThread("idle");
    await render();
    await render();
    expect(commandsRun()).toEqual(["start"]);

    // The first message started a turn; the second waits for its next tool call.
    setThread("running", { userMessageIds: ["first"] });
    await render();
    expect(commandsRun()).toEqual(["start"]);
    setThread("running", { userMessageIds: ["first"], toolActivityIds: ["tool-1"] });
    await render();
    expect(commandsRun()).toEqual(["start", "start"]);
  });

  it("anchors the next queued send to the latest completed V2 tool item", async () => {
    enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    setThread("idle", { toolActivityIds: ["tool-1"], userMessageIds: ["earlier"] });

    await render();

    expect(queue()?.[0]).toMatchObject({
      prompt: "second",
      queuedAfterToolActivityId: "tool-1",
    });
    expect(
      useQueuedMessageStore.getState().lastDispatchByThreadKey[threadKey]?.thread,
    ).toMatchObject({ latestUserMessageId: "earlier" });
  });

  it("holds queued sends while a V2 approval request is pending", async () => {
    enqueue();
    setThread("idle");
    const thread = io.thread as EnvironmentThread;
    const request: OrchestrationV2RuntimeRequest = {
      id: RuntimeRequestId.make("approval-1"),
      nodeId: NodeId.make("node-1"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "not_resumable", reason: "closed" },
      createdAt: DateTime.makeUnsafe("2026-09-25T00:00:01Z"),
      resolvedAt: null,
    };
    io.thread = { ...thread, projection: { ...thread.projection, runtimeRequests: [request] } };

    await render();
    expect(commandsRun()).toEqual([]);

    io.thread = {
      ...thread,
      projection: { ...thread.projection, runtimeRequests: [{ ...request, status: "resolved" }] },
    };
    await render();
    expect(commandsRun()).toEqual(["start"]);
  });

  it("moves on to the next message after a failed one is cancelled", async () => {
    io.run.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    const first = enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    setThread("idle");
    await render();
    expect(queue()?.[0]).toMatchObject({ prompt: "first", holdUntilUserAction: true });

    await act(() => {
      useQueuedMessageStore.getState().remove(threadKey, first.id);
    });
    await render();

    expect(commandsRun()).toEqual(["start", "start"]);
    expect(io.run.mock.calls[1]?.[2]).toMatchObject({ input: { message: { text: "second" } } });
  });
});

describe("sendQueuedMessage", () => {
  it("sends a queued thread reference with its message context", async () => {
    const reference = threadContextRecord(
      scopeThreadRef(threadRef.environmentId, ThreadId.make("referenced-thread")),
      "Previous conversation",
    );
    const message = enqueue({ prompt: "Continue from this thread", threadContexts: [reference] });

    await sendQueuedMessage(threadRef, message.id);

    expect(io.run.mock.calls[0]?.[2]).toMatchObject({
      input: {
        message: {
          text: "Continue from this thread",
          context: { version: 1, records: [reference] },
        },
      },
    });
    expect(queue()).toBeUndefined();
  });

  it("sends a queued thread reference without prose", async () => {
    const reference = threadContextRecord(
      scopeThreadRef(threadRef.environmentId, ThreadId.make("referenced-thread")),
      "Previous conversation",
    );
    const message = enqueue({ prompt: "", threadContexts: [reference] });

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual(["start"]);
    expect(io.run.mock.calls[0]?.[2]).toMatchObject({
      input: { message: { context: { records: [reference] } } },
    });
    expect(queue()).toBeUndefined();
  });

  it("saves a mode changed before queueing, then starts the turn", async () => {
    io.shell = { ...io.shell, runtimeMode: "approval-required" };
    const message = enqueue();

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual(["runtime", "start"]);
    expect(io.run.mock.calls[1]?.[2]).toMatchObject({ input: { runtimeMode: "full-access" } });
    expect(queue()).toBeUndefined();
  });

  it("gives a message back to Stop while its upload runs, without starting a turn", async () => {
    let finishUpload!: () => void;
    io.upload.mockReturnValue(new Promise<void>((resolve) => (finishUpload = resolve)));
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "data:image/png;base64,AAAA",
      file: new File(["AAAA"], "a.png", { type: "image/png" }),
    };
    const message = enqueue({ images: [image] });

    const sending = sendQueuedMessage(threadRef, message.id);
    expect(useQueuedMessageStore.getState().drain(threadKey)).toHaveLength(1);
    finishUpload();
    await sending;

    expect(commandsRun()).toEqual([]);
    expect(io.toast).not.toHaveBeenCalled();
    expect(queue()).toBeUndefined();
  });

  it("holds a message at the head when the turn start fails", async () => {
    io.run.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    enqueue({ prompt: "first" });
    const second = enqueue({ prompt: "second" });

    await sendQueuedMessage(threadRef, second.id);

    expect(queue()?.map((entry) => [entry.prompt, entry.holdUntilUserAction])).toEqual([
      ["second", true],
      ["first", undefined],
    ]);
    expect(io.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "offline" }));
  });
});
