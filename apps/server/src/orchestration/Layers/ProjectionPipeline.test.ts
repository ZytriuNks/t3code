import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-cleanup-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const CLEANUP_PROJECTOR = "projection.attachment-cleanup";

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return (yield* Effect.result(fileSystem.stat(filePath)))._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-test-");
const encodeThreadLinkedPullRequest = Schema.encodeSync(
  Schema.fromJsonString(ThreadLinkedPullRequest),
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-cursor-batch-")))(
  "OrchestrationProjectionPipeline cursor batches",
  (it) => {
    it.effect("writes a project and all projector cursors in two statements", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const projectionState = yield* ProjectionStateRepository;
        const counter = makeSqlStatementCounter();
        const createdAt = "2026-01-01T00:00:00.000Z";
        const event = yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-cursor-batch-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-cursor-batch"),
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-cursor-batch-project"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-cursor-batch"),
            title: "Cursor batch project",
            workspaceRoot: "/tmp/project-cursor-batch",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        });

        yield* projectionPipeline.projectEvent(event).pipe(Effect.withTracer(counter.tracer));
        assert.strictEqual(counter.count(), 2);
        assert.deepEqual(
          yield* projectionState.listAll(),
          Object.values(ORCHESTRATION_PROJECTOR_NAMES)
            .sort()
            .map((projector) => ({
              projector,
              lastAppliedSequence: event.sequence,
              updatedAt: createdAt,
            })),
        );
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-cleanup-span-")))(
  "OrchestrationProjectionPipeline attachment cleanup span",
  (it) => {
    it.effect("runs attachment cleanup only for events that remove attachments", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        let cleanupSpans = 0;
        const tracer = Tracer.make({
          span: (options) => {
            if (options.name === "applyAttachmentSideEffects") cleanupSpans += 1;
            return new Tracer.NativeSpan(options);
          },
        });
        const now = "2026-01-01T00:00:00.000Z";
        const projectId = ProjectId.make("project-cleanup-span");
        const threadId = ThreadId.make("thread-cleanup-span");

        const projectCreated = yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-cleanup-span-project"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.make("cmd-cleanup-span-project"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Cleanup span project",
            workspaceRoot: "/tmp/project-cleanup-span",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionPipeline.projectEvent(projectCreated).pipe(Effect.withTracer(tracer));
        assert.strictEqual(cleanupSpans, 0);

        const threadDeleted = yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make("evt-cleanup-span-thread-delete"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-cleanup-span-thread-delete"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId, deletedAt: now },
        });
        yield* projectionPipeline.projectEvent(threadDeleted).pipe(Effect.withTracer(tracer));
        assert.strictEqual(cleanupSpans, 1);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-import-shell-")))(
  "imported thread shell projection",
  (it) => {
    it.effect("does not mark imported user messages as queued work in thread shells", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = "2026-08-24T10:00:00.000Z";
        const threadId = ThreadId.make("import:codex:shell-session");

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-import-shell-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-import-shell-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-import-shell-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-import-shell"),
            title: "Imported thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-import-shell-message"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-import-shell-message"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-import-shell-message"),
          metadata: { historyImport: true },
          payload: {
            threadId,
            messageId: MessageId.make("import:codex:shell-session:0"),
            role: "user",
            text: "Imported user prompt",
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        });

        yield* projectionPipeline.bootstrap;

        const readLatestUserMessageAt = sql<{ readonly latestUserMessageAt: string | null }>`
        SELECT latest_user_message_at AS "latestUserMessageAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
        assert.deepEqual(yield* readLatestUserMessageAt, [{ latestUserMessageAt: null }]);

        const sessionEvent = yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-import-shell-session"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-import-shell-session"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-import-shell-session"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
          },
        });
        yield* projectionPipeline.projectEvent(sessionEvent);
        assert.deepEqual(yield* readLatestUserMessageAt, [{ latestUserMessageAt: null }]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-branch-pr-projection-")))(
  "branch pull request projection",
  (it) => {
    it.effect("persists branch pull request updates without changing manual links", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("thread-pull-request");
        const projectId = ProjectId.make("project-pull-request");
        const eventFields = {
          aggregateKind: "thread" as const,
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        const created = yield* eventStore.append({
          ...eventFields,
          type: "thread.created",
          eventId: EventId.make("evt-pull-request-created"),
          payload: {
            threadId,
            projectId,
            title: "Pull request thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionPipeline.projectEvent(created);
        const linkedPullRequest = {
          projectId,
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://github.com/pingdotgg/t3code/pull/42",
        };
        const branchPullRequest = {
          ...linkedPullRequest,
          number: 43,
          url: "https://github.com/pingdotgg/t3code/pull/43",
        };
        const updates = [
          { payload: { linkedPullRequest, branchPullRequest }, expected: branchPullRequest },
          { payload: { title: "Renamed thread" }, expected: branchPullRequest },
          { payload: { branchPullRequest: null }, expected: null },
        ];

        for (const [index, update] of updates.entries()) {
          const event = yield* eventStore.append({
            ...eventFields,
            type: "thread.meta-updated",
            eventId: EventId.make(`evt-pull-request-update-${index}`),
            payload: { threadId, updatedAt: now, ...update.payload },
          });
          yield* projectionPipeline.projectEvent(event);

          const rows = yield* sql<{
            readonly linkedPullRequest: string | null;
            readonly branchPullRequest: string | null;
          }>`
          SELECT
            linked_pull_request_json AS "linkedPullRequest",
            branch_pull_request_json AS "branchPullRequest"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
          assert.deepEqual(rows, [
            {
              linkedPullRequest: encodeThreadLinkedPullRequest(linkedPullRequest),
              branchPullRequest:
                update.expected === null ? null : encodeThreadLinkedPullRequest(update.expected),
            },
          ]);
        }
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length + 1);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }

      yield* sql`CREATE TABLE thread_shell_updates (count INTEGER NOT NULL)`;
      yield* sql`INSERT INTO thread_shell_updates (count) VALUES (0)`;
      yield* sql`
        CREATE TRIGGER count_thread_shell_updates
        AFTER UPDATE ON projection_threads
        WHEN NEW.thread_id = 'thread-1'
        BEGIN
          UPDATE thread_shell_updates SET count = count + 1;
        END;
      `;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-assistant-update"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:00.100Z",
        commandId: CommandId.make("cmd-assistant-update"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-assistant-update"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-2"),
          role: "assistant",
          text: "more work",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.100Z",
          updatedAt: "2026-01-01T00:00:00.100Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      let threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `;
      assert.deepEqual(threadShellUpdates, [{ count: 1 }]);

      yield* sql`UPDATE thread_shell_updates SET count = 0`;
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-routine-activity"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:00.200Z",
        commandId: CommandId.make("cmd-routine-activity"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-routine-activity"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-routine"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Tool made progress",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:00:00.200Z",
          },
        },
      });
      yield* projectionPipeline.bootstrap;

      threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `;
      assert.deepEqual(threadShellUpdates, [{ count: 1 }]);
      yield* sql`DROP TRIGGER count_thread_shell_updates`;
      yield* sql`DROP TABLE thread_shell_updates`;

      // Replayed order events must survive later lifecycle upserts, whose
      // complete SQL row writes otherwise risk dropping the placement.
      const orderUpdatedAt = "2026-01-01T00:00:00.200Z";
      const orderEvents = [
        { type: "thread.meta-updated", payload: { activeOrderKey: "gm" } },
        { type: "thread.pinned", payload: { pinnedAt: now, pinOrderKey: "m" } },
        {
          type: "thread.snoozed",
          payload: { snoozedAt: now, snoozedUntil: "2026-01-02T00:00:00.000Z" },
        },
        { type: "thread.unsnoozed", payload: { reason: "user" } },
        { type: "thread.unpinned", payload: {} },
        { type: "thread.meta-updated", payload: { title: "Renamed" } },
      ] as const;
      for (const [index, event] of orderEvents.entries()) {
        yield* eventStore.append({
          type: event.type,
          eventId: EventId.make(`evt-active-order-${index}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          occurredAt: "2026-01-01T00:00:00.500Z",
          commandId: CommandId.make(`cmd-active-order-${index}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            ...event.payload,
            threadId: ThreadId.make("thread-1"),
            updatedAt: orderUpdatedAt,
          },
        });
        yield* projectionPipeline.bootstrap;
        const rows = yield* sql<{
          readonly activeOrderKey: string | null;
          readonly updatedAt: string;
        }>`
          SELECT active_order_key AS "activeOrderKey", updated_at AS "updatedAt"
          FROM projection_threads WHERE thread_id = 'thread-1'
        `;
        assert.deepEqual(rows, [{ activeOrderKey: "gm", updatedAt: orderUpdatedAt }]);
      }

      // Settled lifecycle through the DB pipeline: thread.settled writes the
      // override + timestamp, thread.unsettled(user) flips to the active pin.
      yield* eventStore.append({
        type: "thread.settled",
        eventId: EventId.make("evt-settle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-settle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-settle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
        readonly activeOrderKey: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          active_order_key AS "activeOrderKey"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(settledRows, [
        {
          settledOverride: "settled",
          settledAt: "2026-01-01T00:00:01.000Z",
          unsettledAt: null,
          activeOrderKey: null,
        },
      ]);

      yield* eventStore.append({
        type: "thread.unsettled",
        eventId: EventId.make("evt-unsettle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: CommandId.make("cmd-unsettle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-unsettle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const unsettledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
        readonly activeOrderKey: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          active_order_key AS "activeOrderKey"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      // The un-settle stamps the active-list re-entry time so clients can
      // surface the thread at the top of the list.
      assert.deepEqual(unsettledRows, [
        {
          settledOverride: "active",
          settledAt: null,
          unsettledAt: "2026-01-01T00:00:02.000Z",
          activeOrderKey: null,
        },
      ]);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-pull-requests-")))(
  "OrchestrationProjectionPipeline pull request links",
  (it) => {
    it.effect("projects link, sync, unlink, legacy replay and delete into the link table", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-pr");
        const projectId = ProjectId.make("project-pr");
        const t0 = "2026-01-01T00:00:00.000Z";
        let counter = 0;
        const base = (occurredAt: string) => {
          counter += 1;
          return {
            eventId: EventId.make(`evt-pr-${counter}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: CommandId.make(`cmd-pr-${counter}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-pr-${counter}`),
            metadata: {},
          } as const;
        };
        const readLinks = () =>
          sql<{
            readonly host: string;
            readonly repository: string;
            readonly number: number;
            readonly source: string;
            readonly linkedAt: string;
            readonly snapshotJson: string | null;
            readonly stackJson: string | null;
          }>`
            SELECT
              host,
              repository,
              number,
              source,
              linked_at AS "linkedAt",
              snapshot_json AS "snapshotJson",
              stack_json AS "stackJson"
            FROM projection_thread_pull_requests
            WHERE thread_id = ${threadId}
            ORDER BY number ASC
          `;
        const readThreadUpdatedAt = () =>
          sql<{ readonly updatedAt: string }>`
            SELECT updated_at AS "updatedAt" FROM projection_threads WHERE thread_id = ${threadId}
          `;

        yield* eventStore.append({
          ...base(t0),
          type: "thread.created",
          payload: {
            threadId,
            projectId,
            title: "Thread PR",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: t0,
            updatedAt: t0,
          },
        });

        // Legacy single-link event replays into a manual row with the URL host.
        yield* eventStore.append({
          ...base("2026-01-01T00:00:01.000Z"),
          type: "thread.meta-updated",
          payload: {
            threadId,
            linkedPullRequest: {
              projectId,
              repository: "web",
              number: 41,
              url: "https://org-a.visualstudio.com/DefaultCollection/project/_git/web/pullrequest/41",
            },
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        });
        yield* eventStore.append({
          ...base("2026-01-01T00:00:02.000Z"),
          type: "thread.pull-request-linked",
          payload: {
            threadId,
            link: {
              host: "github.com",
              repository: "pingdotgg/t3code",
              number: 42,
              url: "https://github.com/pingdotgg/t3code/pull/42",
              source: "created",
              linkedAt: "2026-01-01T00:00:02.000Z",
              snapshot: null,
              stack: null,
            },
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        });
        yield* projectionPipeline.bootstrap;

        assert.deepEqual(yield* readLinks(), [
          {
            host: "dev.azure.com",
            repository: "org-a/project/_git/web",
            number: 41,
            source: "manual",
            linkedAt: "2026-01-01T00:00:01.000Z",
            snapshotJson: null,
            stackJson: null,
          },
          {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 42,
            source: "created",
            linkedAt: "2026-01-01T00:00:02.000Z",
            snapshotJson: null,
            stackJson: null,
          },
        ]);
        assert.deepEqual(yield* readThreadUpdatedAt(), [{ updatedAt: "2026-01-01T00:00:02.000Z" }]);

        // Sync fills snapshot/stack on the matching row; a sync for an unknown
        // link is ignored.
        const snapshot: ThreadPullRequestSnapshot = {
          state: "open",
          title: "Add links",
          headBranch: "feat/links",
          baseBranch: "main",
          isDraft: false,
          updatedAt: "2026-01-01T00:00:02.500Z",
          syncedAt: "2026-01-01T00:00:03.000Z",
        };
        yield* eventStore.append({
          ...base("2026-01-01T00:00:03.000Z"),
          type: "thread.pull-request-synced",
          payload: {
            threadId,
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 42,
            snapshot,
            stack: null,
            updatedAt: "2026-01-01T00:00:03.000Z",
          },
        });
        yield* eventStore.append({
          ...base("2026-01-01T00:00:03.500Z"),
          type: "thread.pull-request-synced",
          payload: {
            threadId,
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 99,
            snapshot,
            stack: null,
            updatedAt: "2026-01-01T00:00:03.500Z",
          },
        });
        yield* projectionPipeline.bootstrap;

        const synced = yield* readLinks();
        assert.equal(synced.length, 2);
        assert.equal(synced[0]?.snapshotJson, null);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(synced[1]?.snapshotJson ?? "null"), snapshot);
        assert.deepEqual(yield* readThreadUpdatedAt(), [{ updatedAt: "2026-01-01T00:00:03.000Z" }]);

        // A legacy null clears only the manual row; created/agent/stack rows stay.
        yield* eventStore.append({
          ...base("2026-01-01T00:00:04.000Z"),
          type: "thread.meta-updated",
          payload: {
            threadId,
            linkedPullRequest: null,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
        });
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(
          (yield* readLinks()).map((row) => row.number),
          [42],
        );

        yield* eventStore.append({
          ...base("2026-01-01T00:00:05.000Z"),
          type: "thread.pull-request-unlinked",
          payload: {
            threadId,
            host: "GitHub.COM",
            repository: "PingDotGG/T3Code",
            number: 42,
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
        });
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readLinks(), []);
        assert.deepEqual(yield* readThreadUpdatedAt(), [{ updatedAt: "2026-01-01T00:00:05.000Z" }]);

        // Older Forgejo rows stored a portless host; unlink by their URL's authority.
        yield* eventStore.append({
          ...base("2026-01-01T00:00:05.100Z"),
          type: "thread.pull-request-linked",
          payload: {
            threadId,
            link: {
              host: "forge.example",
              repository: "team/repo",
              number: 42,
              url: "http://forge.example:3000/team/repo/pulls/42",
              source: "agent",
              linkedAt: "2026-01-01T00:00:05.100Z",
              snapshot: null,
              stack: null,
            },
            updatedAt: "2026-01-01T00:00:05.100Z",
          },
        });
        yield* eventStore.append({
          ...base("2026-01-01T00:00:05.200Z"),
          type: "thread.pull-request-unlinked",
          payload: {
            threadId,
            host: "forge.example:3000",
            repository: "team/repo",
            number: 42,
            updatedAt: "2026-01-01T00:00:05.200Z",
          },
        });
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readLinks(), []);

        // Deleting the thread clears whatever links it still had.
        yield* eventStore.append({
          ...base("2026-01-01T00:00:06.000Z"),
          type: "thread.pull-request-linked",
          payload: {
            threadId,
            link: {
              host: "github.com",
              repository: "pingdotgg/t3code",
              number: 43,
              url: "https://github.com/pingdotgg/t3code/pull/43",
              source: "agent",
              linkedAt: "2026-01-01T00:00:06.000Z",
              snapshot: null,
              stack: null,
            },
            updatedAt: "2026-01-01T00:00:06.000Z",
          },
        });
        yield* eventStore.append({
          ...base("2026-01-01T00:00:07.000Z"),
          type: "thread.deleted",
          payload: {
            threadId,
            deletedAt: "2026-01-01T00:00:07.000Z",
          },
        });
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readLinks(), []);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "advances the cleanup cursor to the latest event, dedupes reverts, and holds on failure",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const projectionState = yield* ProjectionStateRepository;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const projectId = ProjectId.make("project-cleanup");
        const revertedThreadId = ThreadId.make("thread-cleanup-revert");
        const deletedThreadId = ThreadId.make("thread-cleanup-delete");
        const revertedAttachmentPath = path.join(
          attachmentsDir,
          "thread-cleanup-revert-00000000-0000-4000-8000-000000000001.png",
        );
        const deletedAttachmentPath = path.join(
          attachmentsDir,
          "thread-cleanup-delete-00000000-0000-4000-8000-000000000001.png",
        );
        const cleanupCursor = projectionState
          .listAll()
          .pipe(
            Effect.map(
              (states) =>
                states.find((state) => state.projector === CLEANUP_PROJECTOR)?.lastAppliedSequence,
            ),
          );

        let eventOrdinal = 0;
        const append = (
          event: Pick<OrchestrationEvent, "type" | "aggregateKind" | "aggregateId" | "payload">,
        ) => {
          eventOrdinal += 1;
          return eventStore.append({
            ...event,
            eventId: EventId.make(`evt-cleanup-${eventOrdinal}`),
            occurredAt: now,
            commandId: CommandId.make(`cmd-cleanup-${eventOrdinal}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-cleanup-${eventOrdinal}`),
            metadata: {},
          } as Omit<OrchestrationEvent, "sequence">);
        };
        const appendThreadCreated = (threadId: ThreadId) =>
          append({
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: threadId,
            payload: {
              threadId,
              projectId,
              title: "Cleanup thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          });
        const appendReverted = (turnCount: number) =>
          append({
            type: "thread.reverted",
            aggregateKind: "thread",
            aggregateId: revertedThreadId,
            payload: { threadId: revertedThreadId, turnCount },
          });

        yield* append({
          type: "project.created",
          aggregateKind: "project",
          aggregateId: projectId,
          payload: {
            projectId,
            title: "Cleanup project",
            workspaceRoot: "/tmp/project-cleanup",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* appendThreadCreated(revertedThreadId);
        yield* appendThreadCreated(deletedThreadId);
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(revertedAttachmentPath, "stale");
        // Two reverts for one thread dedupe into a single prune.
        yield* appendReverted(2);
        yield* appendReverted(1);
        // The latest event is neither a revert nor a delete, yet the cursor must land on it.
        const latest = yield* append({
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: deletedThreadId,
          payload: { threadId: deletedThreadId, archivedAt: now, updatedAt: now },
        });

        yield* projectionPipeline.bootstrap;
        assert.isFalse(yield* exists(revertedAttachmentPath));
        assert.equal(yield* cleanupCursor, latest.sequence);

        // A cleanup that cannot remove its files leaves the cursor behind for the next bootstrap.
        yield* fileSystem.makeDirectory(deletedAttachmentPath);
        yield* fileSystem.writeFileString(path.join(deletedAttachmentPath, "keep.txt"), "keep");
        yield* append({
          type: "thread.deleted",
          aggregateKind: "thread",
          aggregateId: deletedThreadId,
          payload: { threadId: deletedThreadId, deletedAt: now },
        });
        yield* projectionPipeline.bootstrap;
        assert.isTrue(yield* exists(deletedAttachmentPath));
        assert.equal(yield* cleanupCursor, latest.sequence);

        yield* fileSystem.remove(deletedAttachmentPath, { recursive: true });
        yield* fileSystem.writeFileString(deletedAttachmentPath, "retry");
        yield* projectionPipeline.bootstrap;
        assert.isFalse(yield* exists(deletedAttachmentPath));
        assert.equal(yield* cleanupCursor, latest.sequence + 1);
      }),
  );
});
