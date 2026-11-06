// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem does not expose Windows junction creation.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import * as IdAllocator from "./IdAllocator.ts";
import * as NativeSessionStorage from "./NativeSessionStorage.ts";

it.effect("storage resolves real directory aliases and platform casing", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-storage-" });
    const root = path.join(temp, "Store");
    const alias = path.join(temp, "alias");
    yield* fs.makeDirectory(root);
    yield* Effect.promise(() =>
      NodeFSP.symlink(root, alias, platform === "win32" ? "junction" : "dir"),
    );
    const storage = yield* NativeSessionStorage.NativeSessionStorage;
    const resolved = yield* storage.resolve({
      driver: ProviderDriverKind.make("codex"),
      nativeId: "native",
      storageRoot: root,
    });
    expect(resolved).toEqual({
      type: "resolved",
      canonicalRoot: normalizeProjectPathForComparison(yield* fs.realPath(root)),
    });
    expect(
      yield* storage.resolve({
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native",
        storageRoot: alias,
      }),
    ).toEqual(resolved);
    if (platform === "win32") {
      expect(
        yield* storage.resolve({
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native",
          storageRoot: root.toUpperCase(),
        }),
      ).toEqual(resolved);
    }
    const sessionFile = path.join(root, "session.jsonl");
    yield* fs.writeFileString(sessionFile, "");
    const pi = yield* storage.resolve({
      driver: ProviderDriverKind.make("pi"),
      nativeId: sessionFile,
      sessionFile: path.join(alias, "session.jsonl"),
    });
    expect(pi).toEqual({
      type: "resolved",
      canonicalRoot: normalizeProjectPathForComparison(yield* fs.realPath(root)),
      canonicalFile: normalizeProjectPathForComparison(yield* fs.realPath(sessionFile)),
    });
    expect(
      yield* storage.resolve({
        driver: ProviderDriverKind.make("pi"),
        nativeId: sessionFile,
        sessionFile,
      }),
    ).toEqual(pi);
    expect(
      yield* storage.resolve({ driver: ProviderDriverKind.make("codex"), nativeId: "legacy" }),
    ).toEqual({ type: "unresolved", reason: "unavailable" });
  }).pipe(
    Effect.scoped,
    Effect.provide(NativeSessionStorage.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("storage resolves a delayed Pi file through its existing canonical parent", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-storage-delayed-" });
    const root = path.join(temp, "Store");
    const alias = path.join(temp, "alias");
    yield* fs.makeDirectory(root);
    yield* Effect.promise(() =>
      NodeFSP.symlink(root, alias, platform === "win32" ? "junction" : "dir"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    const input = {
      driver: ProviderDriverKind.make("pi"),
      nativeId: sessionFile,
      sessionFile: path.join(alias, "session.jsonl"),
    };
    const storage = yield* NativeSessionStorage.NativeSessionStorage;
    const before = yield* storage.resolve(input);
    expect(before).toEqual({
      type: "resolved",
      canonicalRoot: normalizeProjectPathForComparison(yield* fs.realPath(root)),
      canonicalFile: normalizeProjectPathForComparison(
        path.join(yield* fs.realPath(root), "session.jsonl"),
      ),
    });
    expect(yield* storage.resolve({ ...input, storageRoot: root })).toEqual(before);
    yield* fs.writeFileString(sessionFile, "session");
    const after = yield* storage.resolve(input);
    expect(after).toEqual(before);
    expect(IdAllocator.nativeStorageScope({ ...input, storage: before })).toBe(
      IdAllocator.nativeStorageScope({ ...input, storage: after }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(NativeSessionStorage.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("storage leaves unsafe or unsupported delayed Pi locators unresolved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-storage-boundary-" });
    const root = path.join(temp, "root");
    const sibling = path.join(temp, "root-other");
    yield* fs.makeDirectory(root);
    yield* fs.makeDirectory(sibling);
    const storage = yield* NativeSessionStorage.NativeSessionStorage;
    for (const input of [
      { sessionFile: path.join(sibling, "missing.jsonl"), storageRoot: root },
      { sessionFile: path.join(root, "missing-parent", "missing.jsonl") },
      { sessionFile: "relative.jsonl", storageRoot: root },
      { storageRoot: root },
      { sessionFile: path.join(root, "missing.jsonl"), storageRoot: "relative-root" },
    ]) {
      expect(
        yield* storage.resolve({
          ...input,
          driver: ProviderDriverKind.make("pi"),
          nativeId: path.join(root, "native-id-must-not-supply-locator.jsonl"),
        }),
      ).toEqual({ type: "unresolved", reason: "unavailable" });
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(NativeSessionStorage.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("storage rejects unsafe delayed Pi parents and dangling leaf links", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-storage-unsafe-" });
    const sessionFile = path.join(root, "session.jsonl");
    const nonDirectory = path.join(root, "not-a-directory");
    yield* fs.writeFileString(nonDirectory, "keep");
    for (const fakeFs of [
      FileSystem.FileSystem.of({
        ...fs,
        stat: (candidate) =>
          fs.stat(
            normalizeProjectPathForComparison(candidate) === normalizeProjectPathForComparison(root)
              ? nonDirectory
              : candidate,
          ),
      }),
      FileSystem.FileSystem.of({
        ...fs,
        realPath: (candidate) =>
          candidate === root ? Effect.succeed("relative-parent") : fs.realPath(candidate),
      }),
      FileSystem.FileSystem.of({
        ...fs,
        readLink: () => Effect.succeed(path.join(root, "missing-target.jsonl")),
      }),
    ]) {
      const storage = yield* NativeSessionStorage.make.pipe(
        Effect.provideService(FileSystem.FileSystem, fakeFs),
      );
      expect(
        yield* storage.resolve({
          driver: ProviderDriverKind.make("pi"),
          nativeId: sessionFile,
          sessionFile,
        }),
      ).toEqual({ type: "unresolved", reason: "unavailable" });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("storage only falls back on NotFound when resolving a delayed Pi file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-storage-error-" });
    const sessionFile = path.join(root, "session.jsonl");
    for (const [_tag, code] of [
      ["Busy", "EBUSY"],
      ["Unknown", "EPERM"],
      ["PermissionDenied", "EACCES"],
    ] as const) {
      const cause = PlatformError.systemError({
        _tag,
        syscall: "realpath",
        module: "test",
        method: "realPath",
        cause: { code, syscall: "realpath" },
      });
      const storage = yield* NativeSessionStorage.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          realPath: (candidate) =>
            candidate === sessionFile ? Effect.fail(cause) : fs.realPath(candidate),
        }),
      );
      const error = yield* storage
        .resolve({ driver: ProviderDriverKind.make("pi"), nativeId: sessionFile, sessionFile })
        .pipe(Effect.flip);
      expect(error._tag).toBe("NativeSessionStorageError");
      expect(error.cause).toBe(cause);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
