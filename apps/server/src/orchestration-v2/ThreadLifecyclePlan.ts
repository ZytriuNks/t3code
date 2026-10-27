import {
  type NativeSessionBinding,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";
import { withPullRequestWatch } from "./pullRequestWatch.ts";

type PendingOrchestrationEffectV2 = EffectOutbox.PendingOrchestrationEffectV2;
export type LifecycleThreadRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "attempts"
  | "nodes"
  | "runtimeRequests"
  | "subagents"
  | "providerSessions"
  | "providerThreads"
  | "providerTurns"
  | "turnItems"
>;
type LifecycleCommand = Extract<
  OrchestrationV2Command,
  { type: "thread.delete" | "thread.archive" | "thread.unarchive" }
>;
export interface ThreadLifecyclePlan {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
  readonly cancelUnsettledEffectsByThread: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
    readonly reason: string;
  }>;
}
const lifecycleCancelledEffectTypes = [
  "provider-turn.start",
  "provider-turn.steer",
  "provider-turn.restart",
  "provider-runtime.continue",
  "runtime-request.respond",
  "provider-thread.rollback",
  "thread-title.generate",
] as const;

export const planThreadLifecycle = Effect.fn("ThreadLifecyclePlan.planThreadLifecycle")(
  function* (input: {
    readonly command: LifecycleCommand;
    readonly operationRootThreadId: ThreadId;
    readonly members: ReadonlyArray<LifecycleThreadRecords>;
    readonly bindings: ReadonlyArray<NativeSessionBinding>;
    readonly attachmentIdsByThread: ReadonlyMap<ThreadId, ReadonlyArray<string>>;
    readonly now: DateTime.Utc;
    readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  }): Effect.fn.Return<ThreadLifecyclePlan, IdAllocator.IdAllocatorV2Error> {
    const { now, idAllocator } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const effects: Array<PendingOrchestrationEffectV2> = [];
    const cancelUnsettledEffectsByThread: Array<
      ThreadLifecyclePlan["cancelUnsettledEffectsByThread"][number]
    > = [];
    for (const projection of input.members) {
      const command = { ...input.command, threadId: projection.thread.id };
      let current = projection;
      const emitEvent = Effect.fn("ThreadLifecyclePlan.emitEvent")(function* <
        Event extends OrchestrationV2DomainEvent,
      >(event: Omit<Event, "id">) {
        const id = yield* idAllocator.allocate.event({
          threadId: event.threadId,
          commandId: command.commandId,
        });
        const withId = { ...event, id } as Event;
        events.push(withId);
        if (withId.type === "run.updated") {
          current = {
            ...current,
            runs: current.runs.map((run) => (run.id === withId.payload.id ? withId.payload : run)),
          };
        }
        if (withId.type === "subagent.updated") {
          current = {
            ...current,
            subagents: current.subagents.map((task) =>
              task.id === withId.payload.id ? withId.payload : task,
            ),
          };
        }
      });

      const changed =
        command.type === "thread.delete"
          ? projection.thread.deletedAt === null
          : command.type === "thread.archive"
            ? projection.thread.archivedAt === null
            : projection.thread.archivedAt !== null;
      const thread = {
        ...projection.thread,
        lifecycleRevision: (projection.thread.lifecycleRevision ?? 0) + (changed ? 1 : 0),
        updatedAt: changed ? now : projection.thread.updatedAt,
      };
      if (command.type === "thread.delete") {
        yield* emitEvent<Extract<OrchestrationV2DomainEvent, { type: "thread.deleted" }>>({
          type: "thread.deleted",
          threadId: command.threadId,
          occurredAt: now,
          providerInstanceId: thread.providerInstanceId,
          payload: {
            ...thread,
            deletedAt: thread.deletedAt ?? now,
            titleRegeneration: null,
            limitRecovery: thread.limitRecovery
              ? { ...thread.limitRecovery, autoResume: false, snooze: false }
              : thread.limitRecovery,
          },
          deletionRecord: {
            threadId: thread.id,
            projectId: thread.projectId,
            parentThreadId: thread.lineage.parentThreadId,
            operationRootThreadId: input.operationRootThreadId,
            deletedAt: DateTime.formatIso(thread.deletedAt ?? now),
            commandId: command.commandId,
            scope: "t3_only",
            sessions: input.bindings.filter((binding) => binding.threadId === thread.id),
          },
        });
      } else {
        yield* emitEvent({
          type: command.type === "thread.archive" ? "thread.archived" : "thread.unarchived",
          threadId: command.threadId,
          occurredAt: now,
          providerInstanceId: thread.providerInstanceId,
          payload: {
            ...thread,
            archivedAt: command.type === "thread.archive" ? (thread.archivedAt ?? now) : null,
            ...(command.type === "thread.archive"
              ? {
                  titleRegeneration: null,
                  pullRequests: thread.pullRequests?.map((link) =>
                    withPullRequestWatch(link, undefined),
                  ),
                  limitRecovery: thread.limitRecovery
                    ? { ...thread.limitRecovery, autoResume: false, snooze: false }
                    : thread.limitRecovery,
                }
              : {}),
          },
        });
      }
      if (command.type === "thread.unarchive") continue;
      const detail = command.type === "thread.delete" ? "Thread deleted." : "Thread archived.";
      cancelUnsettledEffectsByThread.push({
        threadId: command.threadId,
        effectTypes: lifecycleCancelledEffectTypes,
        reason: detail,
      });

      const activeRuns = projection.runs.filter((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      );
      const activeRunById = new Map(activeRuns.map((run) => [run.id, run]));
      for (const run of activeRuns) {
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
      }
      for (const attempt of projection.attempts) {
        if (attempt.status !== "pending" && attempt.status !== "running") {
          continue;
        }
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: attempt.runId,
          nodeId: attempt.rootNodeId,
          providerInstanceId: attempt.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "cancelled", completedAt: now },
        });
      }
      for (const node of projection.nodes) {
        const run = node.runId === null ? undefined : activeRunById.get(node.runId);
        if (!["pending", "running", "waiting"].includes(node.status)) {
          continue;
        }
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          ...(node.runId === null ? {} : { runId: node.runId }),
          nodeId: node.id,
          providerInstanceId: run?.providerInstanceId ?? thread.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "cancelled", completedAt: now },
        });
      }
      for (const request of projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      )) {
        yield* emitEvent({
          type: "runtime-request.updated",
          threadId: command.threadId,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason:
                command.type === "thread.delete"
                  ? "The thread was deleted."
                  : "The thread was archived.",
            },
            resolvedAt: now,
          },
        });
      }

      for (const turn of projection.providerTurns) {
        if (turn.status !== "pending" && turn.status !== "running") continue;
        yield* emitEvent({
          type: "provider-turn.updated",
          threadId: command.threadId,
          nodeId: turn.nodeId,
          occurredAt: now,
          payload: { ...turn, status: "interrupted", completedAt: now },
        });
      }
      for (const providerThread of projection.providerThreads) {
        if (
          providerThread.appThreadId !== thread.id ||
          (providerThread.pendingBackgroundTasks?.length ?? 0) === 0
        )
          continue;
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          occurredAt: now,
          providerInstanceId: providerThread.providerInstanceId,
          driver: providerThread.driver,
          payload: {
            ...providerThread,
            status: providerThread.status === "active" ? "idle" : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: now,
          },
        });
      }
      for (const item of projection.turnItems) {
        if (!["pending", "running", "waiting"].includes(item.status)) continue;
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          occurredAt: now,
          payload: {
            ...item,
            status: "cancelled",
            ...(item.type === "command_execution" &&
            projection.runs.some((run) => run.id === item.runId && run.status === "preparing")
              ? { title: "Workspace preparation cancelled" }
              : {}),
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      for (const task of current.subagents) {
        if (!["pending", "running", "waiting"].includes(task.status)) continue;
        yield* emitEvent({
          type: "subagent.updated",
          threadId: command.threadId,
          nodeId: task.id,
          occurredAt: now,
          payload: { ...task, status: "cancelled", completedAt: now, updatedAt: now },
        });
      }

      const cohortRunIds = new Set([
        ...current.runs.filter((run) => run.delegatedCompletion !== undefined).map((run) => run.id),
        ...current.subagents
          .filter((task) => task.origin === "app_owned" && task.runId !== null)
          .map((task) => task.runId!),
      ]);
      for (const parentRunId of cohortRunIds) {
        // Use the projected cancellation so disposing a cohort cannot revive its run.
        const parentRun = current.runs.find((run) => run.id === parentRunId);
        if (parentRun === undefined) continue;
        const cohort = parentRun.delegatedCompletion;
        const tasks = current.subagents.filter(
          (task) => task.origin === "app_owned" && task.runId === parentRunId,
        );
        if (cohort?.disposition !== "disposed" || cohort.delivery !== null)
          yield* emitEvent({
            type: "run.updated",
            threadId: parentRun.threadId,
            runId: parentRun.id,
            ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
            providerInstanceId: parentRun.providerInstanceId,
            occurredAt: now,
            payload: {
              ...parentRun,
              delegatedCompletion: {
                disposition: "disposed",
                nextGeneration: cohort?.nextGeneration ?? 1,
                delivery: null,
              },
            },
          });
        for (const task of tasks) {
          if (
            task.completionDelivery?.state === "acknowledged" ||
            task.completionDelivery?.state === "delivered" ||
            task.completionDelivery?.state === "disposed"
          ) {
            continue;
          }
          yield* emitEvent({
            type: "subagent.updated",
            threadId: parentRun.threadId,
            ...(task.runId === null ? {} : { runId: task.runId }),
            nodeId: task.id,
            driver: task.driver,
            providerInstanceId: task.providerInstanceId,
            occurredAt: now,
            payload: {
              ...task,
              completionDelivery: { state: "disposed", observedByRunId: null },
              updatedAt: now,
            },
          });
        }
      }

      for (const session of projection.providerSessions) {
        if (session.status === "stopped" || session.status === "error") continue;
        yield* emitEvent({
          type: "provider-session.detached",
          threadId: command.threadId,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: {
            providerSessionId: session.id,
            detachedAt: now,
            reason: detail,
          },
        });
        effects.push({
          id: `effect:${command.commandId}:${command.threadId}:provider-session.detach:${session.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-session.detach",
            providerSessionId: session.id,
            detail,
            revokeMcpCredential: true,
          },
        });
      }
      if (command.type === "thread.delete") {
        effects.push({
          id: `effect:${command.commandId}:${command.threadId}:scheduled-tasks.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "scheduled-tasks.cleanup" },
        });
      }
      effects.push({
        id: `effect:${command.commandId}:${command.threadId}:terminal.cleanup`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "terminal.cleanup" },
      });
      if (command.type === "thread.delete") {
        effects.push({
          id: `effect:${command.commandId}:${command.threadId}:preview.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "preview.cleanup" },
        });
        const attachmentIds = Array.from(
          new Set(input.attachmentIdsByThread.get(command.threadId) ?? []),
        );
        if (attachmentIds.length > 0) {
          effects.push({
            id: `effect:${command.commandId}:${command.threadId}:attachment.cleanup`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: { type: "attachment.cleanup", attachmentIds },
          });
        }
      }
    }
    return { events, effects, cancelUnsettledEffectsByThread };
  },
);

export class ThreadLifecyclePlanner extends Context.Service<
  ThreadLifecyclePlanner,
  {
    /** Caller holds the operation root lock through commit. */
    readonly plan: (
      command: LifecycleCommand,
    ) => Effect.Effect<
      ThreadLifecyclePlan,
      | ThreadOwnership.ThreadOwnershipError
      | ProjectionStore.ProjectionStoreV2Error
      | NativeSessionBindings.NativeSessionBindingError
      | IdAllocator.IdAllocatorV2Error
      | EffectOutbox.EffectOutboxError
    >;
  }
>()("t3/orchestration-v2/ThreadLifecyclePlan/ThreadLifecyclePlanner") {}

const make = Effect.gen(function* () {
  const ownership = yield* ThreadOwnership.ThreadOwnership;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const bindings = yield* NativeSessionBindings.NativeSessionBindings;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const plan = Effect.fn("ThreadLifecyclePlanner.plan")(function* (command: LifecycleCommand) {
    const scope = yield* ownership.resolveScope({
      rootThreadId: command.threadId,
      operation:
        command.type === "thread.delete"
          ? "delete"
          : command.type === "thread.archive"
            ? "archive"
            : "unarchive",
    });
    const members: ReadonlyArray<LifecycleThreadRecords> = yield* Effect.forEach(
      scope.members,
      (member) =>
        command.type === "thread.unarchive"
          ? store.getThreadRecords(member.id, []).pipe(
              Effect.map(({ thread }) => ({
                thread,
                runs: [],
                attempts: [],
                nodes: [],
                runtimeRequests: [],
                subagents: [],
                providerSessions: [],
                providerThreads: [],
                providerTurns: [],
                turnItems: [],
              })),
            )
          : store.getThreadRecords(
              member.id,
              [
                "runs",
                "attempts",
                "nodes",
                "runtimeRequests",
                "subagents",
                "providerSessions",
                "providerThreads",
                "providerTurns",
                "turnItems",
              ],
              { lifecycleOnly: true },
            ),
    );
    const attachmentIdsByThread = new Map<ThreadId, ReadonlyArray<string>>();
    if (command.type === "thread.delete")
      for (const member of members)
        attachmentIdsByThread.set(
          member.thread.id,
          yield* store.getThreadAttachmentIds(member.thread.id),
        );
    const now = yield* DateTime.now;
    const planned = yield* planThreadLifecycle({
      command,
      operationRootThreadId: command.threadId,
      members,
      bindings:
        command.type === "thread.delete"
          ? yield* bindings.listForThreads(members.map((m) => m.thread.id))
          : [],
      attachmentIdsByThread,
      now,
      idAllocator,
    });
    if (command.type === "thread.unarchive") return planned;
    const effects = [...planned.effects];
    const events = [...planned.events];
    for (const member of members) {
      const threadId = member.thread.id;
      // Preserve Task4's SQL history provenance after detach and process loss.
      const sources = yield* store.getProviderAttachmentSources(threadId);
      const receipts = yield* outbox.attachmentRetirements(threadId);
      for (const source of sources) {
        const index = effects.findIndex(
          (e) =>
            e.threadId === threadId &&
            e.request.type === "provider-session.detach" &&
            e.request.providerSessionId === source.providerSessionId,
        );
        if (index !== -1) effects.splice(index, 1);
        if (
          receipts.some(
            (r) =>
              r.providerSessionId === source.providerSessionId &&
              r.retirementRevision === (source.lifecycleRevision ?? 0) &&
              r.retirementSourceToken === source.sourceToken,
          )
        )
          continue;
        const detail = command.type === "thread.delete" ? "Thread deleted." : "Thread archived.";
        effects.push({
          id: `effect:${command.commandId}:${threadId}:provider-session.detach:${source.providerSessionId}`,
          commandId: command.commandId,
          threadId,
          request: {
            type: "provider-session.detach",
            providerSessionId: source.providerSessionId,
            retirementRevision: source.lifecycleRevision ?? 0,
            ...(source.sourceToken === null ? {} : { retirementSourceToken: source.sourceToken }),
            detail,
            revokeMcpCredential: true,
          },
        });
        if (
          !events.some(
            (e) =>
              e.threadId === threadId &&
              e.type === "provider-session.detached" &&
              e.payload.providerSessionId === source.providerSessionId,
          )
        )
          events.push({
            id: yield* idAllocator.allocate.event({ threadId, commandId: command.commandId }),
            type: "provider-session.detached",
            threadId,
            occurredAt: now,
            payload: {
              providerSessionId: source.providerSessionId,
              detachedAt: now,
              reason: detail,
            },
          });
      }
    }
    return { ...planned, events, effects };
  });
  return ThreadLifecyclePlanner.of({ plan });
});
export const layer = Layer.effect(ThreadLifecyclePlanner, make).pipe(
  Layer.provide(NativeSessionBindings.layer),
);
