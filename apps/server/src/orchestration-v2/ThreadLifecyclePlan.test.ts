import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";
import { planThreadLifecycle } from "./ThreadLifecyclePlan.ts";

const threadId = ThreadId.make("thread:delete-plan");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:delete-plan");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const createdAt = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const deletedAt = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
const command = {
  type: "thread.delete" as const,
  commandId: CommandId.make("command:delete-plan"),
  threadId,
};

function makeProjection(): OrchestrationV2ThreadProjection {
  const base = emptyProjection({
    id: EventId.make("event:delete-plan-created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project:delete-plan"),
      title: "Delete the thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/workspace/feature",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const runs: Array<OrchestrationV2Run> = (
    ["preparing", "queued", "starting", "running", "waiting", "completed"] as const
  ).map((status, index) => ({
    id: RunId.make(`run:delete-plan:${status}`),
    threadId,
    ordinal: index + 1,
    providerInstanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message:delete-plan:${status}`),
    rootNodeId: NodeId.make(`node:delete-plan:${status}`),
    activeAttemptId: RunAttemptId.make(`attempt:delete-plan:${status}`),
    status,
    queuePosition: status === "queued" ? 1 : null,
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: status === "completed" ? createdAt : null,
    checkpointId: null,
    contextHandoffId: null,
  }));
  return {
    ...base,
    runs,
    attempts: runs.map((run) => ({
      id: run.activeAttemptId!,
      runId: run.id,
      attemptOrdinal: 1,
      rootNodeId: run.rootNodeId!,
      providerInstanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: run.status === "completed" ? "completed" : "running",
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    nodes: runs.map((run) => ({
      id: run.rootNodeId!,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId!,
      kind: "root_turn",
      status: run.status === "completed" ? "completed" : "waiting",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    runtimeRequests: ["pending", "resolved"].map((status) => ({
      id: RuntimeRequestId.make(`request:delete-plan:${status}`),
      nodeId: runs[3]!.rootNodeId!,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: status === "pending" ? "pending" : "resolved",
      responseCapability: { type: "message" },
      createdAt,
      resolvedAt: status === "resolved" ? createdAt : null,
    })),
  };
}

it.effect(
  "lifecycle archive suspends schedules and marks each cleanup without duplicating effects",
  () =>
    Effect.gen(function* () {
      const plan = yield* planThreadLifecycle({
        command: { ...command, type: "thread.archive" },
        operationRootThreadId: threadId,
        members: [makeProjection()],
        bindings: [],
        attachmentIdsByThread: new Map([[threadId, ["attachment:exclusive"]]]),
        now: deletedAt,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
      });
      assert.deepEqual(plan.effects.map((effect) => effect.request.type).sort(), [
        "preview.cleanup",
        "scheduled-tasks.suspend",
        "terminal.cleanup",
      ]);
      for (const effect of plan.effects)
        assert.deepPropertyVal(effect.request, "lifecycle", {
          commandId: command.commandId,
          rootThreadId: threadId,
          revision: 1,
        });
      assert.equal(new Set(plan.effects.map((effect) => effect.id)).size, plan.effects.length);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["delete", "archive", "unarchive"] as const)(
  "plans %s for ordered R/A/B and invalidates live work only",
  (operation) =>
    Effect.gen(function* () {
      const ids = ["R", "A", "B"].map((id) => ThreadId.make(id));
      const members = ids.map((id) => {
        const base = makeProjection();
        return {
          ...base,
          thread: { ...base.thread, id, archivedAt: operation === "unarchive" ? createdAt : null },
          runs: base.runs.map((run) => ({ ...run, threadId: id })),
          nodes: [
            ...base.nodes.map((node) => ({ ...node, threadId: id })),
            {
              ...base.nodes[0]!,
              id: NodeId.make(`runless:${id}`),
              threadId: id,
              runId: null,
              status: "running" as const,
            },
          ],
          providerSessions: [
            {
              id: ProviderSessionId.make("shared-session"),
              driver,
              providerInstanceId,
              status: "running" as const,
              cwd: "/workspace",
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt,
              updatedAt: createdAt,
              lastError: null,
            },
          ],
        };
      });
      const plan = yield* planThreadLifecycle({
        command: { ...command, type: `thread.${operation}`, threadId: ids[0]! },
        operationRootThreadId: ids[0]!,
        members,
        bindings: [],
        attachmentIdsByThread: new Map(),
        now: deletedAt,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
      });
      const kind =
        operation === "delete"
          ? "thread.deleted"
          : operation === "archive"
            ? "thread.archived"
            : "thread.unarchived";
      assert.deepEqual(
        plan.events.filter((e) => e.type === kind).map((e) => e.threadId),
        ids,
      );
      assert.equal(new Set(plan.effects.map((e) => e.id)).size, plan.effects.length);
      assert.isFalse(plan.events.some((e) => e.threadId === ThreadId.make("F")));
      for (const member of members) {
        const events = plan.events.filter((e) => e.threadId === member.thread.id);
        const after = events.reduce(applyToProjection, member);
        assert.equal(after.thread.lifecycleRevision, 1);
        if (operation === "unarchive") {
          assert.deepEqual(after.runs, member.runs);
          assert.deepEqual(after.runtimeRequests, member.runtimeRequests);
          assert.deepEqual(plan.effects, []);
          assert.deepEqual(plan.cancelUnsettledEffectsByThread, []);
        } else {
          assert.equal(
            after.nodes.find((n) => n.id === NodeId.make(`runless:${member.thread.id}`))?.status,
            "cancelled",
          );
          assert.isTrue(
            after.runs.every((r) => r.status === "completed" || r.status === "cancelled"),
          );
          assert.deepEqual(after.runs.at(-1), member.runs.at(-1));
          assert.isTrue(after.runtimeRequests.every((r) => r.status !== "pending"));
          assert.isTrue(
            plan.effects
              .filter((e) => e.threadId === member.thread.id)
              .every((e) => e.id.includes(member.thread.id)),
          );
        }
      }
      assert.equal(
        plan.events.filter(
          (e) => e.type === "thread.deleted" && e.deletionRecord?.scope === "t3_only",
        ).length,
        operation === "delete" ? 3 : 0,
      );
      assert.equal(
        plan.effects.filter((e) => e.request.type === "provider-session.detach").length,
        operation === "unarchive" ? 0 : 3,
      );
      if (operation !== "unarchive")
        assert.deepEqual(
          plan.cancelUnsettledEffectsByThread.map((c) => c.effectTypes),
          ids.map(
            () =>
              [
                "provider-turn.start",
                "provider-turn.steer",
                "provider-turn.restart",
                "provider-runtime.continue",
                "runtime-request.respond",
                "provider-thread.rollback",
                "thread-title.generate",
              ] as const,
          ),
        );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "disposes each open completion cohort and records only owned historical native bindings",
  () =>
    Effect.gen(function* () {
      const base = makeProjection();
      const run = base.runs.find((r) => r.status === "completed")!;
      const taskId = NodeId.make("task5:completion");
      const member = {
        ...base,
        runs: base.runs.map((r) =>
          r.id === run.id
            ? {
                ...r,
                delegatedCompletion: {
                  disposition: "open" as const,
                  nextGeneration: 4,
                  delivery: {
                    generation: 3,
                    messageId: base.runs[1]!.userMessageId,
                    taskIds: [taskId],
                  },
                },
              }
            : r,
        ),
        subagents: [
          {
            id: taskId,
            threadId,
            runId: run.id,
            parentNodeId: run.rootNodeId!,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect",
            title: null,
            model: null,
            completionDelivery: { state: "claimed" as const, observedByRunId: null },
            status: "completed" as const,
            result: "preserve-result",
            startedAt: createdAt,
            completedAt: createdAt,
            updatedAt: createdAt,
          },
        ],
      };
      const binding = {
        threadId,
        providerThreadId,
        providerInstanceId,
        driver,
        nativeId: "task5:native",
        storage: { type: "resolved" as const, canonicalRoot: "/task5/native" },
        boundAt: DateTime.formatIso(createdAt),
      };
      for (const operation of ["delete", "archive"] as const) {
        const plan = yield* planThreadLifecycle({
          command: { ...command, type: `thread.${operation}` },
          operationRootThreadId: threadId,
          members: [member],
          bindings: [binding, { ...binding, threadId: ThreadId.make("foreign") }],
          attachmentIdsByThread: new Map(),
          now: deletedAt,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
        });
        const after = plan.events.reduce(applyToProjection, member);
        const completed = after.runs.find((r) => r.id === run.id)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.completedAt, createdAt);
        assert.deepEqual(completed.delegatedCompletion, {
          disposition: "disposed",
          nextGeneration: 4,
          delivery: null,
        });
        assert.equal(after.subagents[0]?.result, "preserve-result");
        assert.equal(after.subagents[0]?.completionDelivery?.state, "disposed");
        const deletion = plan.events.find((e) => e.type === "thread.deleted");
        assert.deepEqual(
          deletion?.deletionRecord?.sessions ?? [],
          operation === "delete" ? [binding] : [],
        );
      }
    }).pipe(Effect.provide(IdAllocator.layer)),
);
