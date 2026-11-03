import { type OrchestrationV2ProviderThread, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const PI_PROVIDER = ProviderDriverKind.make("pi");

const deleteError = (
  reason: ProviderAdapter.ProviderAdapterNativeThreadDeleteReason,
  cause?: unknown,
) =>
  new ProviderAdapter.ProviderAdapterNativeThreadDeleteError({
    driver: PI_PROVIDER,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof error.reason === "object" &&
  error.reason !== null &&
  "_tag" in error.reason &&
  error.reason._tag === "NotFound";

export const deletePiNativeSessionFile = Effect.fn("deletePiNativeSessionFile")(function* (
  providerThread: OrchestrationV2ProviderThread,
) {
  const storage = providerThread.nativeStorage;
  if (storage === undefined || storage.type !== "resolved" || storage.canonicalFile === undefined) {
    return yield* deleteError("unresolved_identity");
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { canonicalFile, canonicalRoot } = storage;
  if (!path.isAbsolute(canonicalRoot) || !path.isAbsolute(canonicalFile)) {
    return yield* deleteError("path_boundary");
  }

  const relative = path.relative(canonicalRoot, canonicalFile);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith("../") ||
    relative.startsWith("..\\")
  ) {
    return yield* deleteError("path_boundary");
  }

  const recoverFilesystemFailure = (error: unknown) =>
    isNotFound(error) ? Effect.succeedNone : Effect.fail(deleteError("filesystem_failure", error));
  const recoverRemoveFailure = (error: unknown) =>
    isNotFound(error) ? Effect.void : Effect.fail(deleteError("filesystem_failure", error));

  // A failed stat is not evidence that the target is safe to remove. Only an
  // explicit NotFound result is treated as the idempotent already-absent case.
  const targetInfo = yield* fileSystem.stat(canonicalFile).pipe(
    Effect.asSome,
    Effect.catchIf(() => true, recoverFilesystemFailure, recoverFilesystemFailure),
  );
  if (Option.isNone(targetInfo)) return;
  if (targetInfo.value.type !== "File") {
    return yield* deleteError("non_regular_target");
  }

  yield* fileSystem
    .remove(canonicalFile)
    .pipe(Effect.catchIf(() => true, recoverRemoveFailure, recoverRemoveFailure));
});
