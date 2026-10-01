import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  CodexShadowHomeFileSystemError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shared = yield* fs.makeTempDirectoryScoped({ prefix: "codex-cross-volume-shared-" });
  const shadow = yield* fs.makeTempDirectoryScoped({ prefix: "codex-cross-volume-shadow-" });
  const layout = yield* resolveCodexHomeLayout(
    Schema.decodeSync(CodexSettings)({ homePath: shared, shadowHomePath: shadow }),
  );
  const source = path.join(shared, "config.toml");
  const linked = path.join(shadow, "config.toml");
  yield* fs.writeFileString(source, "# shared config\n");
  yield* fs.writeFileString(path.join(shadow, "auth.json"), "private-shadow-auth");
  return { fs, path, shared, shadow, layout, source, linked };
});

const crossVolume = PlatformError.systemError({
  _tag: "Unknown",
  module: "FileSystem",
  method: "link",
  cause: { code: "EXDEV" },
});

it.layer(NodeServices.layer)("Windows cross-volume Codex shadow home", (it) => {
  it.effect("falls back to a shared file link when a hardlink crosses volumes", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      // 模拟跨卷硬链接限制；文件符号链接的 OS 边界用同卷真链接替代，验证共享而非复制。
      const fs = FileSystem.FileSystem.of({
        ...h.fs,
        link: () => Effect.fail(crossVolume),
        symlink: (target, link) => h.fs.link(target, link),
      });
      yield* materializeCodexShadowHome(h.layout).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      yield* h.fs.writeFileString(h.source, "# changed shared config\n");
      assert.equal(yield* h.fs.readFileString(h.linked), "# changed shared config\n");
      assert.equal(
        yield* h.fs.readFileString(h.path.join(h.shadow, "auth.json")),
        "private-shadow-auth",
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "win32")),
  );

  it.effect("explains how to enable file links when Windows denies a cross-volume symlink", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const fs = FileSystem.FileSystem.of({
        ...h.fs,
        link: () => Effect.fail(crossVolume),
        symlink: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "symlink",
            }),
          ),
      });
      const error = yield* materializeCodexShadowHome(h.layout).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.flip,
      );
      assert.instanceOf(error, CodexShadowHomeFileSystemError);
      assert.include(error.message, "Developer Mode");
      assert.include(error.message, "same volume");
      assert.equal(yield* h.fs.readFileString(h.source), "# shared config\n");
      assert.isFalse(yield* h.fs.exists(h.linked));
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "win32")),
  );
});
