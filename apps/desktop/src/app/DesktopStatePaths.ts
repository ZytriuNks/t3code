import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

// The base directory is derived from the packaged `productName` so the
// Alpha and Experimental installers do not share the same T3 home (and
// therefore the same `statev2.sqlite`). An explicit T3CODE_HOME always
// wins because it is the documented override for power users.
const BASE_DIR_BY_APP_NAME: Record<string, string> = {
  "T3 Code (Alpha)": ".t3-alpha",
  "T3 Code (Experimental)": ".t3-experimental",
  "T3 Code (Dev)": ".t3-dev",
};
const BASE_DIR_FALLBACK = ".t3-experimental";

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly appName?: string | undefined;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(
      input.homeDirectory,
      BASE_DIR_BY_APP_NAME[input.appName ?? "T3 Code (Experimental)"] ?? BASE_DIR_FALLBACK,
    ),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
