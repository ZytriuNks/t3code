import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "pingdotgg/t3code";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

/** Words and formatters for updater copy; raw updater messages and version strings stay verbatim. */
export interface DesktopUpdateCopy {
  /** Optional because this retry state was added after the original copy contract. */
  readonly notAppliedTooltip?: (version: string) => string;
  readonly availableTooltip: (version: string | null) => string;
  readonly downloadingTooltip: (percent: number | null) => string;
  readonly downloadedTooltip: (version: string | null) => string;
  readonly downloadFailedTooltip: (version: string) => string;
  readonly installFailedTooltip: (version: string) => string;
  readonly failedTooltip: string;
  readonly upToDateTooltip: string;
  readonly installConfirmation: (version: string | null) => string;
}

export const DESKTOP_UPDATE_COPY_DEFAULTS: DesktopUpdateCopy = {
  notAppliedTooltip: (version) => `Update ${version} did not apply. Click to retry.`,
  availableTooltip: (version) => `Update ${version ?? "available"} ready to download`,
  downloadingTooltip: (percent) =>
    `Downloading update${percent === null ? "" : ` (${Math.floor(percent)}%)`}`,
  downloadedTooltip: (version) =>
    `Update ${version ?? "ready"} downloaded. Click to restart and install.`,
  downloadFailedTooltip: (version) => `Download failed for ${version}. Click to retry.`,
  installFailedTooltip: (version) => `Install failed for ${version}. Click to retry.`,
  failedTooltip: "Update failed",
  upToDateTooltip: "Up to date",
  installConfirmation: (version) =>
    `Install update${version ? ` ${version}` : ""} and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`,
};

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  copy: DesktopUpdateCopy = DESKTOP_UPDATE_COPY_DEFAULTS,
): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return (copy.notAppliedTooltip ?? DESKTOP_UPDATE_COPY_DEFAULTS.notAppliedTooltip!)(
      state.notAppliedVersion,
    );
  }
  if (state.status === "available") {
    return copy.availableTooltip(state.availableVersion);
  }
  if (state.status === "downloading") {
    return copy.downloadingTooltip(
      typeof state.downloadPercent === "number" ? state.downloadPercent : null,
    );
  }
  if (state.status === "downloaded") {
    return copy.downloadedTooltip(state.downloadedVersion ?? state.availableVersion);
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return copy.downloadFailedTooltip(state.availableVersion);
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return copy.installFailedTooltip(state.downloadedVersion);
    }
    if (state.downloadedVersion) {
      return copy.downloadedTooltip(state.downloadedVersion);
    }
    return state.message ?? copy.failedTooltip;
  }
  return copy.upToDateTooltip;
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  copy: DesktopUpdateCopy = DESKTOP_UPDATE_COPY_DEFAULTS,
): string {
  return copy.installConfirmation(state.downloadedVersion ?? state.availableVersion);
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state);
  return disabledReason
    ? { title: "Updates unavailable", detail: disabledReason }
    : { title: "Check for updates", detail: null };
}
