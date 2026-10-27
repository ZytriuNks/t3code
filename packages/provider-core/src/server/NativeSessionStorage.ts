import { type NativeSessionStorage as Storage, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class NativeSessionStorageError extends Schema.TaggedError<NativeSessionStorageError>()(
  "NativeSessionStorageError",
  { driver: ProviderDriverKind, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to resolve native session storage.";
  }
}

export class NativeSessionStorage extends Context.Service<
  NativeSessionStorage,
  {
    readonly resolve: (input: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly storageRoot?: string | undefined;
      readonly sessionFile?: string | undefined;
    }) => Effect.Effect<Storage, NativeSessionStorageError>;
  }
>()("@t3tools/provider-core/server/NativeSessionStorage") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolve = Effect.fn("NativeSessionStorage.resolve")(
    function* (
      input: Parameters<NativeSessionStorage["Service"]["resolve"]>[0],
    ): Effect.fn.Return<Storage, PlatformError.PlatformError> {
      const file = input.driver === "pi" ? input.sessionFile : undefined;
      const root = input.storageRoot ?? (file === undefined ? undefined : path.dirname(file));
      // Missing historical evidence must never be filled from today's home settings.
      if (
        root === undefined ||
        !path.isAbsolute(root) ||
        (input.driver === "pi" && (file === undefined || !path.isAbsolute(file)))
      ) {
        return { type: "unresolved", reason: "unavailable" };
      }
      const canonicalFile =
        file === undefined
          ? undefined
          : normalizeProjectPathForComparison(yield* fs.realPath(path.resolve(file)));
      const canonicalRoot = normalizeProjectPathForComparison(
        yield* fs.realPath(
          path.resolve(
            input.storageRoot ?? (canonicalFile === undefined ? root : path.dirname(canonicalFile)),
          ),
        ),
      );
      return {
        type: "resolved",
        canonicalRoot,
        ...(canonicalFile === undefined ? {} : { canonicalFile }),
      };
    },
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed<Storage>({ type: "unresolved", reason: "unavailable" }),
    ),
    (effect, input) =>
      Effect.mapError(
        effect,
        (cause) => new NativeSessionStorageError({ driver: input.driver, cause }),
      ),
  );
  return NativeSessionStorage.of({ resolve });
});

export const layer = Layer.effect(NativeSessionStorage, make);
