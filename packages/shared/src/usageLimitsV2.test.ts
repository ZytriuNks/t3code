import {
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { isChatGptUsageLimitFailure } from "./usageLimits.ts";

const run = {
  id: RunId.make("current-run"),
  rootNodeId: NodeId.make("root-node"),
  status: "failed" as const,
};
const message = "ChatGPT subscription usage limit reached";
const failure = (
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "error" }>> = {},
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("error-one"),
  threadId: ThreadId.make("thread-one"),
  runId: run.id,
  nodeId: run.rootNodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "failed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-09-29T00:00:00.000Z"),
  type: "error",
  failure: {
    class: "usage_limit",
    code: "subscription_sharing_usage_limit_exceeded",
    message,
    retryable: false,
  },
  ...overrides,
});

describe("ChatGPT usage notice for V2 runs", () => {
  it("recognizes the current run's subscription-sharing failure", () => {
    expect(isChatGptUsageLimitFailure([failure()], message, run)).toBe(true);
  });

  it("does not reuse an older run's failure when the message matches", () => {
    expect(
      isChatGptUsageLimitFailure([failure()], message, { ...run, id: RunId.make("next-run") }),
    ).toBe(false);
    expect(isChatGptUsageLimitFailure([failure()], message, null)).toBe(false);
  });

  it("does not turn a different or cleared current error into a ChatGPT notice", () => {
    expect(isChatGptUsageLimitFailure([failure()], "Connection lost", run)).toBe(false);
    expect(isChatGptUsageLimitFailure([failure()], null, run)).toBe(false);
  });

  it("uses the latest failure in the run instead of a historical matching code", () => {
    const newer = failure({
      id: TurnItemId.make("error-two"),
      ordinal: 2,
      failure: { class: "usage_limit", code: "rate_limit_exceeded", message, retryable: true },
    });
    expect(isChatGptUsageLimitFailure([failure(), newer], message, run)).toBe(false);
  });

  it("ignores interleaved errors owned by a different run", () => {
    const other = failure({
      runId: RunId.make("other-run"),
      failure: { class: "unknown", code: null, message: "Other failure", retryable: null },
    });
    expect(isChatGptUsageLimitFailure([failure(), other], message, run)).toBe(true);
    expect(isChatGptUsageLimitFailure([], message, run)).toBe(false);
  });

  it("does not report a subagent's sharing limit as the root run's error", () => {
    const child = failure({ nodeId: NodeId.make("subagent-node") });
    expect(isChatGptUsageLimitFailure([child], message, run)).toBe(false);
    expect(isChatGptUsageLimitFailure([failure(), child], message, run)).toBe(true);
  });

  it("hides old errors while a run is active or has recovered", () => {
    expect(isChatGptUsageLimitFailure([failure()], message, { ...run, status: "running" })).toBe(
      false,
    );
    expect(isChatGptUsageLimitFailure([failure()], message, { ...run, status: "completed" })).toBe(
      false,
    );
    expect(isChatGptUsageLimitFailure([failure({ status: "running" })], message, run)).toBe(false);
  });
});
