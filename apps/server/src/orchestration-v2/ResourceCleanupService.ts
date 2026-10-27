import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadLifecycleResources from "./ThreadLifecycleResources.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly suspendScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
    threadId: ThreadId,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    suspendScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const resources = yield* ThreadLifecycleResources.ThreadLifecycleResources;
    const ownership = yield* ThreadOwnership.ThreadOwnership;
    return {
      suspendScheduledTasks: (threadId: ThreadId) =>
        scheduledTasks
          .disableForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          ),
      cleanupScheduledTasks: (threadId: ThreadId) =>
        scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          ),
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      cleanupAttachments: Effect.fn("ResourceCleanupService.cleanupAttachments")(
        function* (attachmentIds: ReadonlyArray<string>, threadId: ThreadId) {
          const root = yield* ownership.resolveRoot(threadId);
          const safe = new Set(
            yield* ownership.withRoots([root], resources.safeAttachmentIds([threadId])),
          );
          // Deletion already committed under this root: new forks cannot acquire a source dependency.
          // Keep filesystem I/O outside the short ownership publication boundary.
          yield* Effect.forEach(
            attachmentIds.filter((id) => safe.has(id)),
            (attachmentId) => {
              const path = resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId,
              });
              return path === null
                ? Effect.void
                : fileSystem.remove(path, { force: true }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({
                          operation: "attachment",
                          attachmentId,
                          cause,
                        }),
                    ),
                  );
            },
            { discard: true, concurrency: 4 },
          );
        },
        (effect, _attachmentIds, threadId) =>
          Effect.mapError(effect, (cause) =>
            cause._tag === "ResourceCleanupError"
              ? cause
              : new ResourceCleanupError({ operation: "attachment", threadId, cause }),
          ),
      ),
    };
  }),
).pipe(
  Layer.provide(ThreadLifecycleResources.layer),
  Layer.provide(ThreadOwnership.layer),
  Layer.provide(ProjectionStore.layer),
);
