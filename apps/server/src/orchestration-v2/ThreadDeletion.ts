import type { OrchestrationV2Command, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { planThreadLifecycle } from "./ThreadLifecyclePlan.ts";

export const planThreadDeletion = Effect.fn("ThreadDeletion.planThreadDeletion")(function* (input: {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "thread.delete" }>;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "nodes" | "runtimeRequests" | "subagents" | "providerSessions"
  >;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly now: DateTime.Utc;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}) {
  return yield* planThreadLifecycle({
    ...input,
    operationRootThreadId: input.command.threadId,
    members: [{ ...input.projection, providerThreads: [], providerTurns: [], turnItems: [] }],
    bindings: [],
    attachmentIdsByThread: new Map([[input.command.threadId, input.attachmentIds]]),
  });
});
