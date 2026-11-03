import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type NativeSessionStorage,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";

import { deletePiNativeSessionFile } from "./nativeSessionDeletion.ts";
import type { ProviderAdapterNativeThreadDeleteError } from "@t3tools/provider-core/server/ProviderAdapter";

const makeProviderThread = (nativeStorage: NativeSessionStorage): OrchestrationV2ProviderThread => {
  const now = DateTime.makeUnsafe(0);
  return {
    nativeStorage,
    id: ProviderThreadId.make("provider-thread-delete-test"),
    driver: ProviderDriverKind.make("pi"),
    providerInstanceId: ProviderInstanceId.make("pi"),
    providerSessionId: ProviderSessionId.make("provider-session-delete-test"),
    appThreadId: ThreadId.make("thread-delete-test"),
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
  };
};

const runDelete = (providerThread: OrchestrationV2ProviderThread) =>
  deletePiNativeSessionFile(providerThread).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const expectDeleteError = (effect: Effect.Effect<void, ProviderAdapterNativeThreadDeleteError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe("ProviderAdapterNativeThreadDeleteError");
      return error;
    }),
  );

it.effect("deletes a regular canonical session file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const sessionFile = path.join(root, "session.jsonl");
    yield* fs.writeFileString(sessionFile, "session");

    yield* runDelete(
      makeProviderThread({
        type: "resolved",
        canonicalRoot: yield* fs.realPath(root),
        canonicalFile: yield* fs.realPath(sessionFile),
      }),
    );

    expect(yield* fs.exists(sessionFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("treats an already absent file as success", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const sessionFile = path.join(root, "missing.jsonl");

    yield* runDelete(
      makeProviderThread({
        type: "resolved",
        canonicalRoot: yield* fs.realPath(root),
        canonicalFile: sessionFile,
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a directory target without recursive removal", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const target = path.join(root, "session.jsonl");
    const nested = path.join(target, "nested.jsonl");
    yield* fs.makeDirectory(target);
    yield* fs.writeFileString(nested, "keep");

    const error = yield* expectDeleteError(
      runDelete(
        makeProviderThread({
          type: "resolved",
          canonicalRoot: yield* fs.realPath(root),
          canonicalFile: yield* fs.realPath(target),
        }),
      ),
    );

    expect(error.reason).toBe("non_regular_target");
    expect(yield* fs.exists(target)).toBe(true);
    expect(yield* fs.exists(nested)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a canonical file outside canonicalRoot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-outside-" });
    const sessionFile = path.join(outside, "session.jsonl");
    yield* fs.writeFileString(sessionFile, "keep");

    const error = yield* expectDeleteError(
      runDelete(
        makeProviderThread({
          type: "resolved",
          canonicalRoot: yield* fs.realPath(root),
          canonicalFile: yield* fs.realPath(sessionFile),
        }),
      ),
    );

    expect(error.reason).toBe("path_boundary");
    expect(yield* fs.exists(sessionFile)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves a second session file in the same directory untouched", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const target = path.join(root, "target.jsonl");
    const sibling = path.join(root, "sibling.jsonl");
    yield* fs.writeFileString(target, "delete");
    yield* fs.writeFileString(sibling, "keep");

    yield* runDelete(
      makeProviderThread({
        type: "resolved",
        canonicalRoot: yield* fs.realPath(root),
        canonicalFile: yield* fs.realPath(target),
      }),
    );

    expect(yield* fs.exists(target)).toBe(false);
    expect(yield* fs.exists(sibling)).toBe(true);
    expect(yield* fs.readFileString(sibling)).toBe("keep");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects unresolved storage and missing canonical file", () =>
  Effect.gen(function* () {
    const unresolved = yield* expectDeleteError(
      runDelete(makeProviderThread({ type: "unresolved", reason: "legacy_missing_locator" })),
    );
    expect(unresolved.reason).toBe("unresolved_identity");

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const missing = path.join(root, "missing.jsonl");
    const missingFile = yield* expectDeleteError(
      runDelete(
        makeProviderThread({
          type: "resolved",
          canonicalRoot: yield* fs.realPath(root),
        }),
      ),
    );
    expect(missingFile.reason).toBe("unresolved_identity");

    const relative = yield* expectDeleteError(
      runDelete(
        makeProviderThread({
          type: "resolved",
          canonicalRoot: yield* fs.realPath(root),
          canonicalFile: path.basename(missing),
        }),
      ),
    );
    expect(relative.reason).toBe("path_boundary");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("treats a path whose type cannot be safely established as failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-delete-" });
    const sessionFile = path.join(root, "unknown.jsonl");
    yield* fs.writeFileString(sessionFile, "keep");
    const unsafeFileSystem = {
      ...fs,
      stat: () =>
        Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({ _tag: "Unknown", module: "test", method: "stat" }),
          ),
        ),
    } satisfies FileSystem.FileSystem;

    const error = yield* expectDeleteError(
      deletePiNativeSessionFile(
        makeProviderThread({
          type: "resolved",
          canonicalRoot: yield* fs.realPath(root),
          canonicalFile: yield* fs.realPath(sessionFile),
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, unsafeFileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );

    expect(error.reason).toBe("filesystem_failure");
    expect(yield* fs.exists(sessionFile)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
