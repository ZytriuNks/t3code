import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("keeps the installed Experimental browser profile without importing Alpha secrets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-exp-profile-" });
    for (const name of ["t3code", "t3code-v2", "T3 Code (Alpha)"]) {
      yield* fs.makeDirectory(path.join(root, name), { recursive: true });
      yield* fs.writeFileString(path.join(root, name, "Local State"), name);
    }
    const experimental = path.join(root, "t3code-experimental");
    yield* fs.makeDirectory(experimental, { recursive: true });
    yield* fs.writeFileString(path.join(experimental, "Local State"), "exp-profile");
    assert.equal(
      yield* resolveUserDataPath({
        appDataDirectory: root,
        isDevelopment: false,
        platform: "win32",
      }),
      experimental,
    );
    assert.equal(yield* fs.readFileString(path.join(experimental, "Local State")), "exp-profile");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not create an Experimental profile from the Alpha profile on first launch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-exp-profile-" });
    yield* fs.makeDirectory(path.join(root, "t3code-v2"), { recursive: true });
    yield* fs.writeFileString(path.join(root, "t3code-v2", "Local State"), "alpha-profile");
    const experimental = path.join(root, "t3code-experimental");
    assert.equal(
      yield* resolveUserDataPath({
        appDataDirectory: root,
        isDevelopment: false,
        platform: "win32",
      }),
      experimental,
    );
    assert.isFalse(yield* fs.exists(path.join(experimental, "Local State")));
    assert.equal(
      yield* fs.readFileString(path.join(root, "t3code-v2", "Local State")),
      "alpha-profile",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
