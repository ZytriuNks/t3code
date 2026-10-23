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
/** The provider's fixed copy for a managed-sharing usage limit. */
const MANAGED_SHARING_MESSAGE =
  "Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.";
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
    message: MANAGED_SHARING_MESSAGE,
    retryable: false,
  },
  ...overrides,
});

describe("ChatGPT usage notice for V2 runs", () => {
  it("recognizes the current run's subscription-sharing failure", () => {
    expect(isChatGptUsageLimitFailure([failure()], run)).toBe(true);
  });

  it("recognizes managed sharing the provider reports as a provider_error", () => {
    // Managed sharing keeps the provider_error class and a null retryable; only
    // the failure code names the limit, so the class cannot drive the notice.
    const providerError = failure({
      failure: {
        class: "provider_error",
        code: "subscription_sharing_usage_limit_exceeded",
        message: MANAGED_SHARING_MESSAGE,
        retryable: null,
      },
    });
    expect(isChatGptUsageLimitFailure([providerError], run)).toBe(true);
  });

  it("recognizes the code whatever failure class the provider attaches", () => {
    for (const failureClass of ["provider_error", "usage_limit", "unknown"] as const) {
      const item = failure({
        failure: {
          class: failureClass,
          code: "subscription_sharing_usage_limit_exceeded",
          message: MANAGED_SHARING_MESSAGE,
          retryable: null,
        },
      });
      expect(isChatGptUsageLimitFailure([item], run)).toBe(true);
    }
  });

  it("does not show a notice for other managed-sharing codes or a missing code", () => {
    const unavailable = failure({
      failure: {
        class: "provider_error",
        code: "subscription_sharing_usage_unavailable",
        message: "ChatGPT usage is temporarily unavailable. Try again shortly.",
        retryable: null,
      },
    });
    const uncoded = failure({
      failure: {
        class: "provider_error",
        code: null,
        message: MANAGED_SHARING_MESSAGE,
        retryable: null,
      },
    });
    expect(isChatGptUsageLimitFailure([unavailable], run)).toBe(false);
    expect(isChatGptUsageLimitFailure([uncoded], run)).toBe(false);
  });

  it("does not reuse an older run's failure", () => {
    expect(isChatGptUsageLimitFailure([failure()], { ...run, id: RunId.make("next-run") })).toBe(
      false,
    );
    expect(isChatGptUsageLimitFailure([failure()], null)).toBe(false);
  });

  it("uses the latest failure in the run instead of a historical matching code", () => {
    const newer = failure({
      id: TurnItemId.make("error-two"),
      ordinal: 2,
      failure: {
        class: "usage_limit",
        code: "rate_limit_exceeded",
        message: MANAGED_SHARING_MESSAGE,
        retryable: true,
      },
    });
    expect(isChatGptUsageLimitFailure([failure(), newer], run)).toBe(false);
  });

  it("ignores interleaved errors owned by a different run", () => {
    const other = failure({
      runId: RunId.make("other-run"),
      failure: { class: "unknown", code: null, message: "Other failure", retryable: null },
    });
    expect(isChatGptUsageLimitFailure([failure(), other], run)).toBe(true);
    expect(isChatGptUsageLimitFailure([], run)).toBe(false);
  });

  it("does not report a subagent's sharing limit as the root run's error", () => {
    const child = failure({ nodeId: NodeId.make("subagent-node") });
    expect(isChatGptUsageLimitFailure([child], run)).toBe(false);
    expect(isChatGptUsageLimitFailure([failure(), child], run)).toBe(true);
  });

  it("hides old errors while a run is active or has recovered", () => {
    expect(isChatGptUsageLimitFailure([failure()], { ...run, status: "running" })).toBe(false);
    expect(isChatGptUsageLimitFailure([failure()], { ...run, status: "completed" })).toBe(false);
    expect(isChatGptUsageLimitFailure([failure({ status: "running" })], run)).toBe(false);
  });
});
