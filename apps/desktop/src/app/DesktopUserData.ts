import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

/** Select Electron's profile independently of the server's T3 home. */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    readonly appName: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stageNames = {
      // Alpha is the user's primary profile, so it owns the original
      // filesystem-friendly userData directory (`t3code`) — this is what
      // every prior Alpha build on this machine used, so the long-running
      // conversation history and settings live here. Experimental and Dev
      // sit alongside it for A/B verification against the alpha baseline.
      "T3 Code (Alpha)": { current: "t3code", legacy: "t3code-v2" },
      "T3 Code (Experimental)": { current: "t3code-experimental", legacy: "t3code-experimental" },
      "T3 Code (Dev)": { current: "t3code-dev", legacy: "T3 Code (Dev)" },
    } as const;
    // Packaged Dev installers (rare on Windows where dev runs via Vite + the
    // electron launcher) sit alongside Alpha and Experimental with their own
    // userData directory so the three builds stay fully isolated.
    const stageNamesFallback = stageNames;
    const names = input.isDevelopment
      ? stageNames["T3 Code (Dev)"]
      : ((stageNames as Record<string, { current: string; legacy: string }>)[input.appName] ??
        stageNames["T3 Code (Experimental)"]);
    const destinationPath = path.join(input.appDataDirectory, names.current);
    const legacyPath = path.join(input.appDataDirectory, names.legacy);
    const inspect = (resourcePath: string) =>
      fs
        .exists(resourcePath)
        .pipe(
          Effect.mapError((cause) =>
            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
          ),
        );
    if (input.isDevelopment) {
      return (yield* inspect(legacyPath)) ? legacyPath : destinationPath;
    }
    return destinationPath;
  },
);
