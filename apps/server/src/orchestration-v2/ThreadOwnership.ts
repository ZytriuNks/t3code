import { ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export type LifecycleOperation = "delete" | "archive" | "unarchive";

export type LifecycleThread = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "archivedAt" | "deletedAt"
>;

export class ThreadOwnershipError extends Schema.TaggedError<ThreadOwnershipError>()(
  "ThreadOwnershipError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["subagent_target", "cycle", "cross_project", "missing_parent"]),
  },
) {
  override get message(): string {
    return `Invalid lifecycle ownership for thread ${this.threadId}: ${this.reason}.`;
  }
}

export class ThreadOwnership extends Context.Service<
  ThreadOwnership,
  {
    readonly resolveRoot: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadId, ThreadOwnershipError | ProjectionStore.ProjectionStoreV2Error>;
    readonly resolveScope: (input: {
      readonly rootThreadId: ThreadId;
      readonly operation: LifecycleOperation;
    }) => Effect.Effect<
      { readonly rootThreadId: ThreadId; readonly members: ReadonlyArray<LifecycleThread> },
      ThreadOwnershipError | ProjectionStore.ProjectionStoreV2Error
    >;
    /** Not reentrant. These locks are independent of ThreadCommandExecutor.withLock. */
    readonly withRoots: <A, E, R>(
      rootIds: ReadonlyArray<ThreadId>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadOwnership") {}

const make = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const locks = yield* ThreadCommandExecutor.ThreadRootCommandExecutor;

  // Both public operations trace the query and this in-memory path validation.
  const resolvePath = Effect.fnUntraced(function* (
    threadId: ThreadId,
    path: ReadonlyArray<LifecycleThread>,
  ) {
    const byId = new Map(path.map((thread) => [thread.id, thread]));
    const seen = new Set<ThreadId>();
    let currentId = threadId;
    while (true) {
      if (seen.has(currentId)) {
        return yield* new ThreadOwnershipError({ threadId: currentId, reason: "cycle" });
      }
      seen.add(currentId);
      const current = byId.get(currentId);
      if (current === undefined) {
        return yield* new ThreadOwnershipError({ threadId: currentId, reason: "missing_parent" });
      }
      if (current.lineage.relationshipToParent !== "subagent") return current;
      const parentId = current.lineage.parentThreadId;
      const parent = parentId === null ? undefined : byId.get(parentId);
      if (parent === undefined) {
        return yield* new ThreadOwnershipError({ threadId: current.id, reason: "missing_parent" });
      }
      if (parent.projectId !== current.projectId) {
        return yield* new ThreadOwnershipError({ threadId: current.id, reason: "cross_project" });
      }
      currentId = parent.id;
    }
  });

  const resolveRoot = Effect.fn("ThreadOwnership.resolveRoot")(function* (threadId: ThreadId) {
    return (yield* resolvePath(threadId, yield* store.getOwnershipPath(threadId))).id;
  });

  const resolveScope = Effect.fn("ThreadOwnership.resolveScope")(function* (input: {
    readonly rootThreadId: ThreadId;
    readonly operation: LifecycleOperation;
  }) {
    const { rootThreadId, operation } = input;
    const root = yield* resolvePath(rootThreadId, yield* store.getOwnershipPath(rootThreadId));
    if (root.id !== rootThreadId) {
      return yield* new ThreadOwnershipError({ threadId: rootThreadId, reason: "subagent_target" });
    }
    const descendants = yield* store.getSubagentDescendants(rootThreadId);
    const children = new Map<ThreadId, Array<LifecycleThread>>();
    for (const member of descendants) {
      if (member.projectId !== root.projectId) {
        return yield* new ThreadOwnershipError({ threadId: member.id, reason: "cross_project" });
      }
      const parentId = member.lineage.parentThreadId;
      if (parentId === null) {
        return yield* new ThreadOwnershipError({ threadId: member.id, reason: "missing_parent" });
      }
      const siblings = children.get(parentId) ?? [];
      siblings.push(member);
      children.set(parentId, siblings);
    }
    const members: Array<LifecycleThread> = [];
    const seen = new Set<ThreadId>();
    let level = [root];
    while (level.length > 0) {
      level.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const next: Array<LifecycleThread> = [];
      for (const member of level) {
        if (seen.has(member.id)) {
          return yield* new ThreadOwnershipError({ threadId: member.id, reason: "cycle" });
        }
        seen.add(member.id);
        if (operation !== "delete" && member.deletedAt !== null) continue;
        members.push(member);
        next.push(...(children.get(member.id) ?? []));
      }
      level = next;
    }
    return { rootThreadId, members };
  });

  const withRoots = Effect.fn("ThreadOwnership.withRoots")(function <A, E, R>(
    rootIds: ReadonlyArray<ThreadId>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    const ids = [...new Set(rootIds)].sort();
    // Nest in reverse so acquisition is ascending and release is descending.
    return ids.reduceRight((held, id) => locks.withLock(id, held), effect);
  });

  return ThreadOwnership.of({ resolveRoot, resolveScope, withRoots });
});

export const layer = Layer.effect(ThreadOwnership, make).pipe(
  Layer.provide(ThreadCommandExecutor.layerRoots),
);
