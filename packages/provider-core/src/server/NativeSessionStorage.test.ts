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
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

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
