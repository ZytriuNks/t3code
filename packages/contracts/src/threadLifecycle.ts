import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const NativeSessionStorage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("resolved"),
    canonicalRoot: TrimmedNonEmptyString,
    canonicalFile: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("unresolved"),
    reason: Schema.Literals(["legacy_missing_locator", "unavailable"]),
  }),
]);
export type NativeSessionStorage = typeof NativeSessionStorage.Type;

export const NativeSessionBinding = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  nativeId: Schema.NullOr(TrimmedNonEmptyString),
  storage: NativeSessionStorage,
  boundAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (binding) =>
      binding.driver !== "pi" ||
      binding.storage.type !== "resolved" ||
      binding.storage.canonicalFile !== undefined ||
      "Resolved Pi sessions require a canonical file.",
  ),
);
export type NativeSessionBinding = typeof NativeSessionBinding.Type;

export const ThreadDeletionRecord = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId),
  operationRootThreadId: ThreadId,
  deletedAt: IsoDateTime,
  commandId: CommandId,
  scope: Schema.Literal("t3_only"),
  sessions: Schema.Array(NativeSessionBinding),
});
export type ThreadDeletionRecord = typeof ThreadDeletionRecord.Type;
