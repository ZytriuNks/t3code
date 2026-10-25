import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import type { ConversationStructure } from "@t3tools/contracts/settings";
import { ServerSettings } from "@t3tools/contracts";
import { isProjectScopedSettingKey, type ScopedSettingsPatch } from "./scopedSettings";
import { SettingsRowCopyProvider, type SettingsRowCopy } from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";
import { NotificationSettings } from "./NotificationSettings";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  type DesktopUpdateChannel,
  IDLE_COMPACTION_MODES,
  globalIdleCompaction,
  ProviderDriverKind,
  type ProviderInstanceId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type DiffLayout,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  type QuitConfirmationMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import { MobileAppSettingsRow } from "./MobileAppSettingsRow";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import { scopedIdleCompaction } from "./scopedSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
} from "./SettingsPanels.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { BackgroundActivitySettingsRow } from "./BackgroundActivitySettings";

const SIDEBAR_PROJECT_SORT_ORDER_LABEL_KEYS: Record<SidebarProjectSortOrder, MessageKey> = {
  updated_at: "settings.general.projectOrder.updatedAt",
  created_at: "settings.general.projectOrder.createdAt",
  manual: "settings.general.projectOrder.manual",
};
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder);
const IDLE_COMPACTION_LABEL_KEYS = {
  onReturn: "settings.general.idleCompaction.onReturn",
  beforeCacheExpires: "settings.general.idleCompaction.beforeCacheExpires",
  off: "settings.general.idleCompaction.off",
} as const;

const TIMESTAMP_FORMAT_LABEL_KEYS = {
  locale: "settings.general.timeFormat.locale",
  "12-hour": "settings.general.timeFormat.12Hour",
  "24-hour": "settings.general.timeFormat.24Hour",
} as const;

const DIFF_LAYOUT_LABEL_KEYS: Record<DiffLayout, MessageKey> = {
  stacked: "settings.general.diffLayout.stacked",
  split: "settings.general.diffLayout.split",
};

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
function AboutVersionTitle({ version = APP_VERSION }: { version?: string }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{t("settings.general.version.title")}</span>
      <code className="text-2xs font-medium text-muted-foreground">{version}</code>
    </span>
  );
}

function AboutVersionSection() {
  const { t } = useI18n();
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = (channel: DesktopUpdateChannel) => {
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.setUpdateChannel !== "function" ||
      channel === selectedUpdateChannel
    ) {
      return;
    }

    setIsChangingUpdateChannel(true);
    void bridge
      .setUpdateChannel(channel)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("settings.general.version.channelChangeFailed"),
            description:
              error instanceof Error
                ? error.message
                : t("settings.general.version.channelChangeFailedDescription"),
          }),
        );
      })
      .finally(() => {
        setIsChangingUpdateChannel(false);
      });
  };

  const handleButtonClick = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("settings.general.version.downloadFailed"),
            description:
              error instanceof Error
                ? error.message
                : t("settings.general.version.downloadFailedDescription"),
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("settings.general.version.confirmFailed"),
            description:
              error instanceof Error
                ? error.message
                : t("settings.general.version.confirmFailedDescription"),
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("settings.general.version.installFailed"),
              description:
                error instanceof Error
                  ? error.message
                  : t("settings.general.version.installFailedDescription"),
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("settings.general.version.checkFailed"),
              description:
                result.state.message ?? t("settings.general.version.checkFailedDescription"),
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("settings.general.version.checkFailed"),
            description:
              error instanceof Error
                ? error.message
                : t("settings.general.version.checkFailedFallback"),
          }),
        );
      });
  };

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = {
    download: t("settings.general.version.download"),
    install: t("settings.general.version.install"),
  };
  const statusLabel: Record<string, string> = {
    checking: t("settings.general.version.checking"),
    downloading: t("settings.general.version.downloading"),
    "up-to-date": t("settings.general.version.upToDate"),
  };
  const buttonLabel =
    actionLabel[action] ??
    statusLabel[updateState?.status ?? ""] ??
    t("settings.general.version.checkForUpdates");
  const description =
    action === "download" || action === "install"
      ? t("settings.general.version.updateAvailable")
      : (getDesktopUpdateDisabledReason(updateState) ?? t("settings.general.version.description"));

  return (
    <>
      <SettingsRow
        id={searchableSetting("app-version").id}
        title={<AboutVersionTitle version={updateState?.currentVersion ?? APP_VERSION} />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          {...searchableSetting("update-track", t)}
          description={t("settings.general.version.updateTrackDescription")}
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("settings.general.version.updateTrack")}
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly"
                    ? t("settings.general.version.nightly")
                    : t("settings.general.version.stable")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  {t("settings.general.version.stable")}
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  {t("settings.general.version.nightly")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          {...searchableSetting("update-track", t)}
          description={t("settings.general.version.hostedTrackDescription")}
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("settings.general.version.updateTrack")}
              >
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  {t("settings.general.version.latest")}
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  {t("settings.general.version.nightly")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {hasDesktopBridge ? <CliCommandSettingsRow /> : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { t } = useI18n();
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const scopedSettings = useScopedSettings();
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  // Environment-only values are not part of a project's reset or its confirmation summary.
  const settings = isProjectScope
    ? {
        ...scopedSettings,
        ...Object.fromEntries(
          Object.entries(DEFAULT_UNIFIED_SETTINGS).filter(
            ([key]) => Object.hasOwn(ServerSettings.fields, key) && !isProjectScopedSettingKey(key),
          ),
        ),
      }
    : scopedSettings;
  const updateSettings = useUpdateScopedSettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = (() =>
    [
      ...(settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled
        ? ["Render math"]
        : []),
      ...(!Equal.equals(settings.idleCompaction, DEFAULT_UNIFIED_SETTINGS.idleCompaction)
        ? ["Idle compaction"]
        : []),
      ...(theme !== "system" ? ["Theme"] : []),
      ...(!followSystem ? ["Follow system"] : []),
      ...(themeHalves !== null ? ["Theme mix"] : []),
      ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
        ? ["Contrast"]
        : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
      ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
        ? ["Diff colors"]
        : []),
      ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),
      ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
        ? ["Panel animations"]
        : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Environment identification"]
        : []),
      ...(settings.language !== DEFAULT_UNIFIED_SETTINGS.language ? ["Language"] : []),
      ...(settings.autoExpandThreadDetailsPanel !==
      DEFAULT_UNIFIED_SETTINGS.autoExpandThreadDetailsPanel
        ? ["Automatically expand workspace details"]
        : []),
      ...(settings.hideUnavailableContextMenuItems !==
      DEFAULT_UNIFIED_SETTINGS.hideUnavailableContextMenuItems
        ? ["Hide unavailable context menu items"]
        : []),
      ...(settings.scratchBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.scratchBaseDirectory
        ? ["No-project chats base directory"]
        : []),
      ...(settings.legacySidebarEnabled !== DEFAULT_UNIFIED_SETTINGS.legacySidebarEnabled
        ? ["Sidebar (legacy)"]
        : []),
      ...(settings.legacySidebarProjectGuides !==
      DEFAULT_UNIFIED_SETTINGS.legacySidebarProjectGuides
        ? ["Indentation guides"]
        : []),
      ...(settings.legacySidebarThreadStatusDots !==
      DEFAULT_UNIFIED_SETTINGS.legacySidebarThreadStatusDots
        ? ["Thread status dots"]
        : []),
      ...(settings.legacySidebarHideStatusLabels !==
      DEFAULT_UNIFIED_SETTINGS.legacySidebarHideStatusLabels
        ? ["Hide thread status labels"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
        ? ["Thread notifications"]
        : []),
      ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
        ? ["In-app notifications"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Project Grouping"]
        : []),
      ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
        ? ["Project order"]
        : []),
      ...(settings.sidebarWorkingShelfEnabled !==
      DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
        ? ["Working section"]
        : []),
      ...(settings.sidebarAutoSettleAfterDays !==
      DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
        ? ["Auto-settle inactive threads"]
        : []),
      ...(settings.sidebarAutoSettleKeepPullRequests !==
      DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests
        ? ["Keep threads with a PR"]
        : []),
      ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
        ? ["Auto-settle merged threads"]
        : []),
      ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
        ? ["Auto-resume limited threads"]
        : []),
      ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
        ? ["Snooze limited threads"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
      ...(settings.persistComposerContextStrip !==
      DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
        ? ["Composer context"]
        : []),
      ...getChangedTypographySettingLabels(settings),
      ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
        ? ["Default diff file state"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? ["Diff layout"] : []),
      ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
        ? ["Proactive panels"]
        : []),
      ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
        ? ["Show skills in slash menu"]
        : []),
      ...(settings.composerCollapseOnScroll !== DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll
        ? ["Collapse composer on scroll"]
        : []),
      ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
        ? ["Rich text composer"]
        : []),
      ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? ["Send shortcut"] : []),
      ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
        ? ["Follow-up behavior"]
        : []),
      ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
        ? ["Context window indicator"]
        : []),
      ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
        ? ["Response streaming"]
        : []),
      ...(settings.conversationStructure !== DEFAULT_UNIFIED_SETTINGS.conversationStructure
        ? [t("settings.search.item.conversation-structure.title")]
        : []),
      ...(settings.conversationStructureThinkingLabel !==
      DEFAULT_UNIFIED_SETTINGS.conversationStructureThinkingLabel
        ? [t("settings.general.conversation.thinkingLabel.title")]
        : []),
      ...(settings.conversationStructureIdleLabel !==
      DEFAULT_UNIFIED_SETTINGS.conversationStructureIdleLabel
        ? [t("settings.general.conversation.idleLabel.title")]
        : []),
      ...(settings.smoothOutputMode !== DEFAULT_UNIFIED_SETTINGS.smoothOutputMode
        ? [t("settings.general.streaming.unit.title")]
        : []),
      ...(settings.smoothOutputLineMode !== DEFAULT_UNIFIED_SETTINGS.smoothOutputLineMode
        ? [t("settings.general.streaming.lines.title")]
        : []),
      ...(settings.footnotesAutoCollapse !== DEFAULT_UNIFIED_SETTINGS.footnotesAutoCollapse
        ? [t("settings.general.footnotesAutoCollapse.title")]
        : []),
      ...(settings.smoothTextFadeDurationMs !== DEFAULT_UNIFIED_SETTINGS.smoothTextFadeDurationMs
        ? [t("settings.general.streaming.fade.title")]
        : []),
      ...(settings.smoothTextYieldDurationMs !== DEFAULT_UNIFIED_SETTINGS.smoothTextYieldDurationMs
        ? [t("settings.general.streaming.yield.title")]
        : []),
      ...(settings.smoothMarkdownPreload !== DEFAULT_UNIFIED_SETTINGS.smoothMarkdownPreload
        ? [t("settings.general.streaming.preload.title")]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Provider update checks"]
        : []),
      ...(settings.continueThreadsAfterServerUpdate !==
      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
        ? ["Continue threads after restarts"]
        : []),
      ...(isBackgroundActivityDirty ? ["Background activity"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["New worktrees start from origin"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
        ? ["Unpin confirmation"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? ["Quit shortcut"] : []),
      ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
      ...getChangedBrowserSettingLabels(settings),
      ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
        ? ["Agent browser access"]
        : []),
    ].map((label) => {
      const key = RESTORE_LABEL_MESSAGE_KEYS[label];
      return key === undefined ? label : t(key);
    }))();

  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        t("settings.restore.title"),
        t("settings.restore.body", { labels: changedSettingLabels.join(", ") }),
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {
      // Storage is unreadable; the render-time value is the best rollback.
    }
    // The mix may have changed while the confirmation dialog was open; both
    // the dirty check and the rollback must see the live value.
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    // Same for the appearance mode: trusting the render-time value would skip
    // the reset and report success while a non-system mode stayed in storage.
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.restore.themeFailedTitle"),
          description: t("settings.restore.themeFailedDescription"),
        }),
      );
    };
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    const resetPatch: ScopedSettingsPatch = {
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      language: DEFAULT_UNIFIED_SETTINGS.language,
      autoExpandThreadDetailsPanel: DEFAULT_UNIFIED_SETTINGS.autoExpandThreadDetailsPanel,
      hideUnavailableContextMenuItems: DEFAULT_UNIFIED_SETTINGS.hideUnavailableContextMenuItems,
      scratchBaseDirectory: DEFAULT_UNIFIED_SETTINGS.scratchBaseDirectory,
      legacySidebarEnabled: DEFAULT_UNIFIED_SETTINGS.legacySidebarEnabled,
      legacySidebarProjectGuides: DEFAULT_UNIFIED_SETTINGS.legacySidebarProjectGuides,
      legacySidebarThreadStatusDots: DEFAULT_UNIFIED_SETTINGS.legacySidebarThreadStatusDots,
      legacySidebarHideStatusLabels: DEFAULT_UNIFIED_SETTINGS.legacySidebarHideStatusLabels,
      mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
      idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS),
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
      inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
      sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleKeepPullRequests: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
      snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      smoothOutputMode: DEFAULT_UNIFIED_SETTINGS.smoothOutputMode,
      smoothOutputLineMode: DEFAULT_UNIFIED_SETTINGS.smoothOutputLineMode,
      smoothMarkdownPreload: DEFAULT_UNIFIED_SETTINGS.smoothMarkdownPreload,
      smoothTextFadeDurationMs: DEFAULT_UNIFIED_SETTINGS.smoothTextFadeDurationMs,
      smoothTextYieldDurationMs: DEFAULT_UNIFIED_SETTINGS.smoothTextYieldDurationMs,
      footnotesAutoCollapse: DEFAULT_UNIFIED_SETTINGS.footnotesAutoCollapse,
      conversationStructure: DEFAULT_UNIFIED_SETTINGS.conversationStructure,
      conversationStructureThinkingLabel:
        DEFAULT_UNIFIED_SETTINGS.conversationStructureThinkingLabel,
      conversationStructureIdleLabel: DEFAULT_UNIFIED_SETTINGS.conversationStructureIdleLabel,

      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      pullRequestLinksOpenInApp: DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp,
      // Re-granted like any other default. The confirmation dialog lists it by
      // name, so a user restoring defaults is told the agent regains access
      // rather than discovering it later.
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    };
    updateSettings(
      isProjectScope
        ? Object.fromEntries(
            Object.entries(resetPatch).filter(
              ([key]) =>
                !Object.hasOwn(ServerSettings.fields, key) || isProjectScopedSettingKey(key),
            ),
          )
        : resetPatch,
    );
    onRestored?.();
  };

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={t("settings.general.autoSettleDays.ariaLabel")}
    />
  );
}

const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-plan-mode",
  "legacy-context-window-indicator",
  "legacy-sidebar",
]);

function LegacyFeaturesSection() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>("legacy-features");
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      lastExpandedTargetRef.current = null;
      return;
    }
    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section id="legacy-features" ref={targetRef} tabIndex={-1} className="space-y-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-sm font-normal text-foreground/70 transition-colors group-hover:text-foreground">
            {t("settings.general.legacy.title")}
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SettingsGroup>
            <SettingsRow
              {...searchableSetting("legacy-plan-mode", t)}
              description={t("settings.general.legacy.planMode.description")}
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) => {
                    updateSettings({ planModeEnabled: Boolean(checked) });
                  }}
                  aria-label={t("settings.search.item.legacy-plan-mode.title")}
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-context-window-indicator", t)}
              description={t("settings.general.legacy.contextWindowIndicator.description")}
              control={
                <Switch
                  checked={settings.contextWindowMeterEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
                  }
                  aria-label={t("settings.search.item.legacy-context-window-indicator.title")}
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-sidebar", t)}
              description="Restore per-project thread trees instead of the default flat sidebar."
              control={
                <Switch
                  checked={settings.legacySidebarEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ legacySidebarEnabled: Boolean(checked) })
                  }
                  aria-label="Sidebar (legacy)"
                />
              }
            />
          </SettingsGroup>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function GeneralSettingsPanel() {
  const { t } = useI18n();
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: t("settings.general.sendShortcut.enter") },
    {
      value: "mod-enter-multiline",
      label: t("settings.general.sendShortcut.multiline", { modifier: modifierLabel }),
    },
    {
      value: "mod-enter",
      label: t("settings.general.sendShortcut.always", { modifier: modifierLabel }),
    },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { scope, environment, connectedEnvironments, target, targets } = useSettingsScope();
  const idleCompaction = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    );
  const supportsAutoSettlementScope = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.threadAutoSettlementScope === true,
  );
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    );

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(textGenerationProviders),
      settings,
      target?.projectId ?? null,
    ),
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);

  const copy = useSettingsPanelCopy();
  const mixedSmoothOutputMode = useScopedSettingsMixed(["smoothOutputMode"]);
  const mixedSmoothOutputLineMode = useScopedSettingsMixed(["smoothOutputLineMode"]);
  const mixedSmoothTextFadeDuration = useScopedSettingsMixed(["smoothTextFadeDurationMs"]);
  const mixedSmoothTextYieldDuration = useScopedSettingsMixed(["smoothTextYieldDurationMs"]);
  const mixedConversationStructure = useScopedSettingsMixed(["conversationStructure"]);
  const smoothOutputAvailable =
    !mixedConversationStructure && settings.conversationStructure === "restructured";
  const selectConversationStructure = (value: ConversationStructure) =>
    updateSettings({ conversationStructure: value });
  const mixedConversationStructureIdleLabel = useScopedSettingsMixed([
    "conversationStructureIdleLabel",
  ]);
  const mixedConversationStructureThinkingLabel = useScopedSettingsMixed([
    "conversationStructureThinkingLabel",
  ]);
  const mixedScratchBaseDirectory = useScopedSettingsMixed(["scratchBaseDirectory"]);
  const languageLabels = {
    system: t("settings.language.system"),
    en: t("settings.language.english"),
    "zh-CN": t("settings.language.simplifiedChinese"),
  };
  return (
    <SettingsRowCopyProvider copy={copy}>
      <SettingsPageContainer>
        <ProjectDefaultsSettings category="general" />
        <SettingsSection id="organization" title={t("settings.general.section.organization")}>
          <SettingsRow
            {...searchableSetting("project-grouping", t)}
            description={t("settings.general.projectGrouping.description")}
            resetAction={
              settings.sidebarProjectGroupingMode !==
              DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
                <SettingResetButton
                  label={t("settings.general.projectGrouping.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      sidebarProjectGroupingMode:
                        DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
                onCheckedChange={(checked) => {
                  if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                    lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                    rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                  }
                  updateSettings({
                    sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                      checked,
                      lastEnabledProjectGroupingMode.current,
                    ),
                  });
                }}
                aria-label={t("settings.general.projectGrouping.ariaLabel")}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("project-order", t)}
            description={t("settings.general.projectOrder.description")}
            resetAction={
              settings.sidebarProjectSortOrder !==
              DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
                <SettingResetButton
                  label={t("settings.search.item.project-order.title")}
                  onClick={() =>
                    updateSettings({
                      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.sidebarProjectSortOrder}
                onValueChange={(value) => {
                  if (isSidebarProjectSortOrder(value)) {
                    updateSettings({ sidebarProjectSortOrder: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-44"
                  aria-label={t("settings.search.item.project-order.title")}
                >
                  <SelectValue>
                    {t(SIDEBAR_PROJECT_SORT_ORDER_LABEL_KEYS[settings.sidebarProjectSortOrder])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SidebarProjectSortOrder.literals.map((sortOrder) => (
                    <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                      {t(SIDEBAR_PROJECT_SORT_ORDER_LABEL_KEYS[sortOrder])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            serverScoped
            {...searchableSetting("auto-resume-limited-threads", t)}
            description={t("settings.general.autoResumeLimitedThreads.description")}
            settingKeys={["autoResumeLimitedThreads"]}
            control={
              <ScopedSwitch
                settingKeys={["autoResumeLimitedThreads"]}
                checked={settings.autoResumeLimitedThreads}
                onCheckedChange={(checked) =>
                  updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
                }
                aria-label={t("settings.restore.label.autoResumeLimitedThreads")}
              />
            }
          />
          <SettingsRow
            serverScoped
            {...searchableSetting("snooze-limited-threads", t)}
            description={t("settings.general.snoozeLimitedThreads.description")}
            settingKeys={["snoozeLimitedThreads"]}
            control={
              <ScopedSwitch
                settingKeys={["snoozeLimitedThreads"]}
                checked={settings.snoozeLimitedThreads}
                onCheckedChange={(checked) =>
                  updateSettings({ snoozeLimitedThreads: Boolean(checked) })
                }
                aria-label={t("settings.restore.label.snoozeLimitedThreads")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("working-shelf", t)}
            description={t("settings.general.workingShelf.description")}
            resetAction={
              settings.sidebarWorkingShelfEnabled !==
              DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
                <SettingResetButton
                  label="working section"
                  onClick={() =>
                    updateSettings({
                      sidebarWorkingShelfEnabled:
                        DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.sidebarWorkingShelfEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
                }
                aria-label={t("settings.general.workingShelf.label")}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["idleCompaction", "compactIdleThreads"]}
            mixed={idleCompaction.mixed}
            {...searchableSetting("compact-idle-threads", t)}
            description={t("settings.general.idleCompaction.description")}
            resetAction={
              globalIdleCompaction(settings) !== globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) ? (
                <SettingResetButton
                  label={t("settings.search.item.compact-idle-threads.title")}
                  onClick={() =>
                    updateSettings({
                      idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS),
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={idleCompaction.mixed ? null : globalIdleCompaction(settings)}
                onValueChange={(value) => {
                  const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
                  if (mode) updateSettings({ idleCompaction: mode.value });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label={t("settings.search.item.compact-idle-threads.title")}
                >
                  <SelectValue>
                    {(value: string | null) =>
                      value === null
                        ? t("settings.general.mixed")
                        : t(
                            IDLE_COMPACTION_LABEL_KEYS[
                              value as keyof typeof IDLE_COMPACTION_LABEL_KEYS
                            ],
                          )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {IDLE_COMPACTION_MODES.map((mode) => (
                    <SelectItem
                      hideIndicator
                      key={mode.value}
                      value={mode.value}
                      // A server from before modes has only the on/off switch, so it cannot store "Never".
                      disabled={mode.value === "off" && !idleCompaction.neverAvailable}
                    >
                      {t(IDLE_COMPACTION_LABEL_KEYS[mode.value])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          {supportsAutoSettlement ? (
            <>
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleOnMerge"]}
                {...searchableSetting("auto-settle-merged-threads", t)}
                description={t("settings.general.autoSettleMerged.description")}
                resetAction={
                  settings.sidebarAutoSettleOnMerge !==
                  DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                    <SettingResetButton
                      label={t("settings.general.autoSettleMerged.resetLabel")}
                      onClick={() =>
                        updateSettings({
                          sidebarAutoSettleOnMerge:
                            DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <ScopedSwitch
                    settingKeys={["sidebarAutoSettleOnMerge"]}
                    checked={settings.sidebarAutoSettleOnMerge}
                    onCheckedChange={(checked) =>
                      updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                    }
                    aria-label={t("settings.restore.label.autoSettleMerged")}
                  />
                }
              />

              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleAfterDays"]}
                {...searchableSetting("auto-settle-inactive-threads", t)}
                description={t("settings.general.autoSettleInactive.description")}
                resetAction={
                  settings.sidebarAutoSettleAfterDays !==
                  DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                    <SettingResetButton
                      label={t("settings.general.autoSettleInactive.resetLabel")}
                      onClick={() =>
                        updateSettings({
                          sidebarAutoSettleAfterDays:
                            DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <ScopedSwitch
                    settingKeys={["sidebarAutoSettleAfterDays"]}
                    checked={settings.sidebarAutoSettleAfterDays !== null}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                      })
                    }
                    aria-label={t("settings.restore.label.autoSettleInactive")}
                  />
                }
              />
              {settings.sidebarAutoSettleAfterDays !== null ? (
                <SettingsRow
                  serverScoped
                  settingKeys={["sidebarAutoSettleAfterDays"]}
                  title={searchableSetting("days-before-auto-settle", t).title}
                  description={t("settings.general.autoSettleDays.description")}
                  control={
                    <AutoSettleDaysInput
                      value={settings.sidebarAutoSettleAfterDays}
                      onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                    />
                  }
                />
              ) : null}
              {settings.sidebarAutoSettleAfterDays !== null && supportsAutoSettlementScope ? (
                <SettingsRow
                  serverScoped
                  settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                  title="Keep threads with a PR"
                  description="Inactivity does not settle threads with a pull request. Merge and close still do."
                  control={
                    <ScopedSwitch
                      settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                      checked={settings.sidebarAutoSettleKeepPullRequests}
                      onCheckedChange={(checked) =>
                        updateSettings({ sidebarAutoSettleKeepPullRequests: checked })
                      }
                      aria-label="Keep threads with a PR"
                    />
                  }
                />
              ) : null}
            </>
          ) : null}
        </SettingsSection>

        <SettingsSection id="behavior" title={t("settings.general.section.behavior")}>
          <NotificationSettings />
          <SettingsRow
            {...searchableSetting("in-app-notifications", t)}
            description={t("settings.general.inAppNotifications.description")}
            control={
              <Switch
                checked={settings.inAppNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ inAppNotificationsEnabled: checked })
                }
                aria-label={t("settings.restore.label.inAppNotifications")}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("time-format", t)}
            description={t("settings.general.timeFormat.description")}
            resetAction={
              settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
                <SettingResetButton
                  label={t("settings.general.timeFormat.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.timestampFormat}
                onValueChange={(value) => {
                  if (value === "locale" || value === "12-hour" || value === "24-hour") {
                    updateSettings({ timestampFormat: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("settings.general.timeFormat.ariaLabel")}
                >
                  <SelectValue>
                    {t(TIMESTAMP_FORMAT_LABEL_KEYS[settings.timestampFormat])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="locale">
                    {t("settings.general.timeFormat.locale")}
                  </SelectItem>
                  <SelectItem hideIndicator value="12-hour">
                    {t("settings.general.timeFormat.12Hour")}
                  </SelectItem>
                  <SelectItem hideIndicator value="24-hour">
                    {t("settings.general.timeFormat.24Hour")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            {...searchableSetting("hide-whitespace-changes", t)}
            description={t("settings.general.hideWhitespace.description")}
            resetAction={
              settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
                <SettingResetButton
                  label={t("settings.general.hideWhitespace.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.diffIgnoreWhitespace}
                onCheckedChange={(checked) =>
                  updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
                }
                aria-label={t("settings.general.hideWhitespace.ariaLabel")}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("default-diff-file-state", t)}
            description={t("settings.general.diffFileState.description")}
            resetAction={
              settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
                <SettingResetButton
                  label={t("settings.general.diffFileState.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.diffFilesCollapsed ? "collapsed" : "expanded"}
                onValueChange={(value) => {
                  if (value === "expanded" || value === "collapsed") {
                    updateSettings({ diffFilesCollapsed: value === "collapsed" });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("settings.restore.label.defaultDiffFileState")}
                >
                  <SelectValue>
                    {settings.diffFilesCollapsed
                      ? t("settings.general.diffFileState.collapsed")
                      : t("settings.general.diffFileState.expanded")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="expanded">
                    {t("settings.general.diffFileState.expanded")}
                  </SelectItem>
                  <SelectItem hideIndicator value="collapsed">
                    {t("settings.general.diffFileState.collapsed")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("diff-layout", t)}
            description={t("settings.general.diffLayout.description")}
            resetAction={
              settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
                <SettingResetButton
                  label={t("settings.general.diffLayout.resetLabel")}
                  onClick={() =>
                    updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.diffLayout}
                onValueChange={(value) => {
                  if (value === "stacked" || value === "split") {
                    updateSettings({ diffLayout: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("settings.restore.label.diffLayout")}
                >
                  <SelectValue>{t(DIFF_LAYOUT_LABEL_KEYS[settings.diffLayout])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="stacked">
                    {t("settings.general.diffLayout.stacked")}
                  </SelectItem>
                  <SelectItem hideIndicator value="split">
                    {t("settings.general.diffLayout.split")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            {...searchableSetting("proactive-panels", t)}
            description={t("settings.general.proactivePanels.description")}
            resetAction={
              settings.proactivePanelsEnabled !==
              DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
                <SettingResetButton
                  label={t("settings.general.proactivePanels.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.proactivePanelsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ proactivePanelsEnabled: Boolean(checked) })
                }
                aria-label={t("settings.restore.label.proactivePanels")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("skills-in-slash-menu", t)}
            description={t("settings.general.skillsInSlashMenu.description")}
            resetAction={
              settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
                <SettingResetButton
                  label={t("settings.general.skillsInSlashMenu.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.showSkillsInSlashMenu}
                onCheckedChange={(checked) =>
                  updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
                }
                aria-label={t("settings.restore.label.skillsInSlashMenu")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("composer-rich-text", t)}
            description={t("settings.general.richText.description")}
            resetAction={
              settings.composerRichTextEnabled !==
              DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
                <SettingResetButton
                  label={t("settings.general.richText.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.composerRichTextEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ composerRichTextEnabled: Boolean(checked) })
                }
                aria-label="Rich text composer"
              />
            }
          />

          <SettingsRow
            {...searchableSetting("composer-collapse", t)}
            description={t("settings.general.composerCollapse.description")}
            resetAction={
              settings.composerCollapseOnScroll !==
              DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
                <SettingResetButton
                  label={t("settings.general.composerCollapse.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.composerCollapseOnScroll}
                onCheckedChange={(checked) =>
                  updateSettings({ composerCollapseOnScroll: Boolean(checked) })
                }
                aria-label={t("settings.restore.label.composerCollapse")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("send-shortcut", t)}
            description={t("settings.general.sendShortcut.description")}
            resetAction={
              settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
                <SettingResetButton
                  label={t("settings.general.sendShortcut.resetLabel")}
                  onClick={() =>
                    updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.sendShortcut}
                onValueChange={(value) => {
                  const option = sendShortcutOptions.find((option) => option.value === value);
                  if (option) updateSettings({ sendShortcut: option.value });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-0 max-w-full"
                  aria-label={t("settings.general.sendShortcut.ariaLabel")}
                >
                  <SelectValue>
                    {
                      sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                        ?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {sendShortcutOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-center justify-between gap-4">
                        {option.label}
                        {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            {...searchableSetting("follow-up-behavior", t)}
            description={
              t("settings.general.followUpBehavior.description") +
              " " +
              (settings.sendShortcut === "mod-enter-multiline"
                ? t("settings.general.followUpBehavior.oppositeSingleAndMultiline", {
                    modifier: modifierLabel,
                  })
                : t("settings.general.followUpBehavior.opposite", {
                    modifier: modifierLabel,
                    shift: settings.sendShortcut === "mod-enter" ? " + Shift" : "",
                  }))
            }
            resetAction={
              settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
                <SettingResetButton
                  label={t("settings.general.followUpBehavior.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.followUpBehavior}
                onValueChange={(value) => {
                  if (value === "queue" || value === "steer") {
                    updateSettings({ followUpBehavior: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-0"
                  aria-label={t("settings.restore.label.followUpBehavior")}
                >
                  <SelectValue>
                    {settings.followUpBehavior === "queue"
                      ? t("settings.general.followUpBehavior.option.queue")
                      : t("settings.general.followUpBehavior.option.steer")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="queue">
                    {t("settings.general.followUpBehavior.option.queue")}
                  </SelectItem>
                  <SelectItem value="steer">
                    {t("settings.general.followUpBehavior.option.steer")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["enableProviderUpdateChecks"]}
            {...searchableSetting("provider-update-checks", t)}
            description={t("settings.general.providerUpdateChecks.description")}
            resetAction={
              settings.enableProviderUpdateChecks !==
              DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
                <SettingResetButton
                  label={t("settings.general.providerUpdateChecks.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      enableProviderUpdateChecks:
                        DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["enableProviderUpdateChecks"]}
                checked={settings.enableProviderUpdateChecks}
                onCheckedChange={(checked) =>
                  updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                }
                aria-label={t("settings.general.providerUpdateChecks.ariaLabel")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("continue-threads-after-server-update", t)}
            serverScoped
            settingKeys={["continueThreadsAfterServerUpdate"]}
            description={t("settings.general.continueThreads.description")}
            status={
              !supportsRestartContinuation
                ? t("settings.general.continueThreads.unsupported")
                : undefined
            }
            resetAction={
              supportsRestartContinuation &&
              settings.continueThreadsAfterServerUpdate !==
                DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
                <SettingResetButton
                  label={t("settings.general.continueThreads.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      continueThreadsAfterServerUpdate:
                        DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["continueThreadsAfterServerUpdate"]}
                checked={settings.continueThreadsAfterServerUpdate}
                disabled={!supportsRestartContinuation}
                onCheckedChange={(checked) =>
                  updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
                }
                aria-label={t("settings.restore.label.continueThreads")}
              />
            }
          />

          <BackgroundActivitySettingsRow />
          <SettingsRow
            {...searchableSetting("auto-expand-thread-details", t)}
            description={t("settings.general.autoExpandThreadDetails.description")}
            resetAction={
              settings.autoExpandThreadDetailsPanel !==
              DEFAULT_UNIFIED_SETTINGS.autoExpandThreadDetailsPanel ? (
                <SettingResetButton
                  label={t("settings.search.item.auto-expand-thread-details.title")}
                  onClick={() =>
                    updateSettings({
                      autoExpandThreadDetailsPanel:
                        DEFAULT_UNIFIED_SETTINGS.autoExpandThreadDetailsPanel,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.autoExpandThreadDetailsPanel}
                onCheckedChange={(checked) =>
                  updateSettings({ autoExpandThreadDetailsPanel: Boolean(checked) })
                }
                aria-label={t("settings.search.item.auto-expand-thread-details.title")}
              />
            }
          />
          <SettingsRow
            id={searchableSetting("language", t).id}
            title={t("settings.language.title")}
            description={t("settings.language.description")}
            resetAction={
              settings.language !== DEFAULT_UNIFIED_SETTINGS.language ? (
                <SettingResetButton
                  label={t("settings.language.title")}
                  onClick={() => updateSettings({ language: DEFAULT_UNIFIED_SETTINGS.language })}
                />
              ) : null
            }
            control={
              <Select
                value={settings.language}
                onValueChange={(value) => {
                  if (value === "system" || value === "en" || value === "zh-CN") {
                    updateSettings({ language: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("settings.language.title")}
                >
                  <SelectValue>{languageLabels[settings.language]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="system">
                    {languageLabels.system}
                  </SelectItem>
                  <SelectItem hideIndicator value="en">
                    {languageLabels.en}
                  </SelectItem>
                  <SelectItem hideIndicator value="zh-CN">
                    {languageLabels["zh-CN"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection
          id="projects-and-threads"
          title={t("settings.general.section.projectsAndThreads")}
        >
          <SettingsRow
            serverScoped
            settingKeys={["newWorktreesStartFromOrigin"]}
            {...searchableSetting("start-from-origin", t)}
            description={t("settings.general.startFromOrigin.description")}
            resetAction={
              settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                <SettingResetButton
                  label="new worktrees start from remote"
                  onClick={() =>
                    updateSettings({
                      newWorktreesStartFromOrigin:
                        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["newWorktreesStartFromOrigin"]}
                checked={settings.newWorktreesStartFromOrigin}
                onCheckedChange={(checked) =>
                  updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
                }
                aria-label="Start new worktrees from remote by default"
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["addProjectBaseDirectory"]}
            {...searchableSetting("add-project-starts-in", t)}
            description={t("settings.general.addProjectBaseDirectory.description")}
            resetAction={
              settings.addProjectBaseDirectory !==
              DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
                <SettingResetButton
                  label={t("settings.general.addProjectBaseDirectory.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
                onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
                placeholder={mixedAddProjectBaseDirectory ? "Mixed" : "~/"}
                spellCheck={false}
                aria-label={t("settings.restore.label.addProjectBaseDirectory")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["scratchBaseDirectory"]}
            {...searchableSetting("scratch-base-directory", t)}
            description={t("settings.general.scratchBaseDirectory.description")}
            resetAction={
              settings.scratchBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.scratchBaseDirectory ? (
                <SettingResetButton
                  label={t("settings.search.item.scratch-base-directory.title")}
                  onClick={() =>
                    updateSettings({
                      scratchBaseDirectory: DEFAULT_UNIFIED_SETTINGS.scratchBaseDirectory,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={mixedScratchBaseDirectory ? "" : settings.scratchBaseDirectory}
                onCommit={(next) => updateSettings({ scratchBaseDirectory: next })}
                placeholder={
                  mixedScratchBaseDirectory
                    ? t("settings.general.mixed")
                    : t("settings.general.scratchBaseDirectory.placeholder")
                }
                spellCheck={false}
                aria-label={t("settings.search.item.scratch-base-directory.title")}
              />
            }
          />
        </SettingsSection>

        <SettingsSection id="confirmations" title={t("settings.general.section.confirmations")}>
          <SettingsRow
            {...searchableSetting("unpin-confirmation", t)}
            description={t("settings.general.confirmUnpin.description")}
            resetAction={
              settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
                <SettingResetButton
                  label={t("settings.general.confirmUnpin.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadUnpin}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadUnpin: Boolean(checked) })
                }
                aria-label={t("settings.general.confirmUnpin.ariaLabel")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("archive-confirmation", t)}
            description={t("settings.general.confirmArchive.description")}
            resetAction={
              settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
                <SettingResetButton
                  label={t("settings.general.confirmArchive.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadArchive}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadArchive: Boolean(checked) })
                }
                aria-label={t("settings.general.confirmArchive.ariaLabel")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("delete-confirmation", t)}
            description={t("settings.general.confirmDelete.description")}
            resetAction={
              settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
                <SettingResetButton
                  label={t("settings.general.confirmDelete.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadDelete}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadDelete: Boolean(checked) })
                }
                aria-label={t("settings.general.confirmDelete.ariaLabel")}
              />
            }
          />

          {isElectron ? (
            <SettingsRow
              {...searchableSetting("quit-confirmation", t)}
              description={t("settings.general.confirmQuit.description")}
              resetAction={
                settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                  <SettingResetButton
                    label={t("settings.general.confirmQuit.resetLabel")}
                    onClick={() =>
                      updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.confirmQuit}
                  onValueChange={(value) => {
                    if (value === "direct" || value === "hold" || value === "double-click") {
                      updateSettings({ confirmQuit: value });
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full sm:w-40"
                    aria-label={t("settings.general.confirmQuit.ariaLabel")}
                  >
                    <SelectValue>{QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
          <SettingsRow
            {...searchableSetting("hide-unavailable-context-menu-items", t)}
            description={t("settings.general.hideUnavailableContextMenuItems.description")}
            resetAction={
              settings.hideUnavailableContextMenuItems !==
              DEFAULT_UNIFIED_SETTINGS.hideUnavailableContextMenuItems ? (
                <SettingResetButton
                  label={t("settings.general.hideUnavailableContextMenuItems.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      hideUnavailableContextMenuItems:
                        DEFAULT_UNIFIED_SETTINGS.hideUnavailableContextMenuItems,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.hideUnavailableContextMenuItems}
                onCheckedChange={(checked) =>
                  updateSettings({ hideUnavailableContextMenuItems: Boolean(checked) })
                }
                aria-label={t("settings.general.hideUnavailableContextMenuItems.ariaLabel")}
              />
            }
          />
        </SettingsSection>

        <SettingsSection
          id="conversation-structure-section"
          title={t("settings.general.section.conversation")}
        >
          <SettingsRow
            serverScoped
            settingKeys={["conversationStructure"]}
            {...searchableSetting("conversation-structure", t)}
            description={
              mixedConversationStructure
                ? t("settings.row.copy.mixedAcrossEnvironments")
                : t("settings.general.conversation.structure.description")
            }
            resetAction={
              settings.conversationStructure !== DEFAULT_UNIFIED_SETTINGS.conversationStructure ? (
                <SettingResetButton
                  label={t("settings.general.conversation.structure.resetLabel")}
                  onClick={() =>
                    selectConversationStructure(DEFAULT_UNIFIED_SETTINGS.conversationStructure)
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedConversationStructure ? null : settings.conversationStructure}
                onValueChange={(value) => {
                  if (value === "default" || value === "restructured") {
                    selectConversationStructure(value);
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label={t("settings.general.conversation.structure.description")}
                >
                  <SelectValue>
                    {(value: ConversationStructure | null) =>
                      value === null
                        ? t("settings.row.copy.mixedAcrossEnvironments")
                        : t(
                            value === "restructured"
                              ? "settings.general.conversation.structure.restructured"
                              : "settings.general.conversation.structure.default",
                          )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="default">
                    {t("settings.general.conversation.structure.default")}
                  </SelectItem>
                  <SelectItem hideIndicator value="restructured">
                    {t("settings.general.conversation.structure.restructured")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["responseStreamingMode"]}
            {...searchableSetting("response-streaming", t)}
            description={
              mixedResponseStreamingMode
                ? t("settings.general.streaming.mixed")
                : !smoothOutputAvailable
                  ? `${t(RESPONSE_STREAMING_MODE_DESCRIPTION_KEYS[settings.responseStreamingMode])} ${t("settings.general.streaming.requiresRestructured")}`
                  : t(RESPONSE_STREAMING_MODE_DESCRIPTION_KEYS[settings.responseStreamingMode])
            }
            resetAction={
              settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
                <SettingResetButton
                  label={t("settings.general.streaming.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
                onValueChange={(value) => {
                  if (
                    value === "turn" ||
                    value === "paragraph" ||
                    value === "realtime" ||
                    value === "smooth"
                  ) {
                    updateSettings({ responseStreamingMode: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label={t("settings.general.streaming.ariaLabel")}
                >
                  <SelectValue>
                    {(value: ResponseStreamingMode | null) =>
                      value === null
                        ? t("settings.general.streaming.mixedValue")
                        : t(RESPONSE_STREAMING_MODE_LABEL_KEYS[value])
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="turn">
                    {t(RESPONSE_STREAMING_MODE_LABEL_KEYS.turn)}
                  </SelectItem>
                  <SelectItem hideIndicator value="paragraph">
                    {t(RESPONSE_STREAMING_MODE_LABEL_KEYS.paragraph)}
                  </SelectItem>
                  <SelectItem hideIndicator value="realtime">
                    {t(RESPONSE_STREAMING_MODE_LABEL_KEYS.realtime)}
                  </SelectItem>
                  <SelectItem hideIndicator value="smooth" disabled={!smoothOutputAvailable}>
                    {t(RESPONSE_STREAMING_MODE_LABEL_KEYS.smooth)}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          {!mixedResponseStreamingMode && settings.responseStreamingMode === "smooth" && (
            <SettingsRow
              id="smooth-output-mode"
              serverScoped
              settingKeys={["smoothOutputMode"]}
              title={t("settings.general.streaming.unit.title")}
              description={t("settings.general.streaming.unit.description")}
              resetAction={
                settings.smoothOutputMode !== DEFAULT_UNIFIED_SETTINGS.smoothOutputMode ? (
                  <SettingResetButton
                    label={t("settings.general.streaming.unit.title")}
                    onClick={() =>
                      updateSettings({
                        smoothOutputMode: DEFAULT_UNIFIED_SETTINGS.smoothOutputMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={mixedSmoothOutputMode ? null : settings.smoothOutputMode}
                  onValueChange={(value) => {
                    if (value === "character" || value === "token" || value === "auto")
                      updateSettings({ smoothOutputMode: value });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={t("settings.general.streaming.unit.title")}>
                    <SelectValue>
                      {(value: string | null) =>
                        value === null
                          ? t("settings.general.streaming.mixedValue")
                          : t(SMOOTH_OUTPUT_MODE_LABEL_KEYS[value]!)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="character">
                      {t("settings.general.streaming.unit.character")}
                    </SelectItem>
                    <SelectItem hideIndicator value="token">
                      {t("settings.general.streaming.unit.token")}
                    </SelectItem>
                    <SelectItem hideIndicator value="auto">
                      {t("settings.general.streaming.unit.auto")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          )}
          {!mixedResponseStreamingMode && settings.responseStreamingMode === "smooth" && (
            <SettingsRow
              id="smooth-output-lines"
              serverScoped
              settingKeys={["smoothOutputLineMode"]}
              title={t("settings.general.streaming.lines.title")}
              description={t("settings.general.streaming.lines.description")}
              resetAction={
                settings.smoothOutputLineMode !== DEFAULT_UNIFIED_SETTINGS.smoothOutputLineMode ? (
                  <SettingResetButton
                    label={t("settings.general.streaming.lines.title")}
                    onClick={() =>
                      updateSettings({
                        smoothOutputLineMode: DEFAULT_UNIFIED_SETTINGS.smoothOutputLineMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={mixedSmoothOutputLineMode ? null : settings.smoothOutputLineMode}
                  onValueChange={(value) => {
                    if (value === "adaptive" || value === "parallel")
                      updateSettings({ smoothOutputLineMode: value });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={t("settings.general.streaming.lines.title")}>
                    <SelectValue>
                      {(value: string | null) =>
                        value === null
                          ? t("settings.general.streaming.mixedValue")
                          : t(SMOOTH_OUTPUT_LINE_MODE_LABEL_KEYS[value]!)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="adaptive">
                      {t("settings.general.streaming.lines.adaptive")}
                    </SelectItem>
                    <SelectItem hideIndicator value="parallel">
                      {t("settings.general.streaming.lines.parallel")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          )}
          {!mixedResponseStreamingMode && settings.responseStreamingMode === "smooth" && (
            <SettingsRow
              id="smooth-text-yield-duration"
              serverScoped
              settingKeys={["smoothTextYieldDurationMs"]}
              title={t("settings.general.streaming.yield.title")}
              description={t("settings.general.streaming.yield.description")}
              resetAction={
                mixedSmoothTextYieldDuration ||
                settings.smoothTextYieldDurationMs !==
                  DEFAULT_UNIFIED_SETTINGS.smoothTextYieldDurationMs ? (
                  <SettingResetButton
                    label={t("settings.general.streaming.yield.title")}
                    onClick={() =>
                      updateSettings({
                        smoothTextYieldDurationMs:
                          DEFAULT_UNIFIED_SETTINGS.smoothTextYieldDurationMs,
                      })
                    }
                  />
                ) : null
              }
              control={
                <SmoothTextYieldDurationSlider
                  value={mixedSmoothTextYieldDuration ? null : settings.smoothTextYieldDurationMs}
                  onCommit={(value) => updateSettings({ smoothTextYieldDurationMs: value })}
                  ariaLabel={t("settings.general.streaming.yield.title")}
                  formatValue={(value) =>
                    value === null
                      ? t("settings.general.streaming.mixedValue")
                      : t("settings.general.streaming.yield.value", { value })
                  }
                />
              }
            />
          )}
          {!mixedResponseStreamingMode && settings.responseStreamingMode === "smooth" && (
            <SettingsRow
              id="smooth-text-fade-duration"
              serverScoped
              settingKeys={["smoothTextFadeDurationMs"]}
              title={t("settings.general.streaming.fade.title")}
              description={t("settings.general.streaming.fade.description")}
              resetAction={
                mixedSmoothTextFadeDuration ||
                settings.smoothTextFadeDurationMs !==
                  DEFAULT_UNIFIED_SETTINGS.smoothTextFadeDurationMs ? (
                  <SettingResetButton
                    label={t("settings.general.streaming.fade.title")}
                    onClick={() =>
                      updateSettings({
                        smoothTextFadeDurationMs: DEFAULT_UNIFIED_SETTINGS.smoothTextFadeDurationMs,
                      })
                    }
                  />
                ) : null
              }
              control={
                <SmoothTextFadeDurationSlider
                  value={mixedSmoothTextFadeDuration ? null : settings.smoothTextFadeDurationMs}
                  onCommit={(value) => updateSettings({ smoothTextFadeDurationMs: value })}
                  ariaLabel={t("settings.general.streaming.fade.title")}
                  formatValue={(value) =>
                    value === null
                      ? t("settings.general.streaming.mixedValue")
                      : value === 0
                        ? t("settings.general.streaming.fade.off")
                        : t("settings.general.streaming.fade.value", { value })
                  }
                />
              }
            />
          )}
          {!mixedResponseStreamingMode && settings.responseStreamingMode === "smooth" && (
            <SettingsRow
              id="smooth-markdown-preload"
              serverScoped
              settingKeys={["smoothMarkdownPreload"]}
              title={t("settings.general.streaming.preload.title")}
              description={t("settings.general.streaming.preload.description")}
              resetAction={
                settings.smoothMarkdownPreload !==
                DEFAULT_UNIFIED_SETTINGS.smoothMarkdownPreload ? (
                  <SettingResetButton
                    label={t("settings.general.streaming.preload.title")}
                    onClick={() =>
                      updateSettings({
                        smoothMarkdownPreload: DEFAULT_UNIFIED_SETTINGS.smoothMarkdownPreload,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["smoothMarkdownPreload"]}
                  checked={settings.smoothMarkdownPreload}
                  onCheckedChange={(checked) =>
                    updateSettings({ smoothMarkdownPreload: Boolean(checked) })
                  }
                  aria-label={t("settings.general.streaming.preload.title")}
                />
              }
            />
          )}
          <SettingsRow
            id="footnotes-auto-collapse"
            serverScoped
            settingKeys={["footnotesAutoCollapse"]}
            title={t("settings.general.footnotesAutoCollapse.title")}
            description={t("settings.general.footnotesAutoCollapse.description")}
            resetAction={
              settings.footnotesAutoCollapse !== DEFAULT_UNIFIED_SETTINGS.footnotesAutoCollapse ? (
                <SettingResetButton
                  label={t("settings.general.footnotesAutoCollapse.title")}
                  onClick={() =>
                    updateSettings({
                      footnotesAutoCollapse: DEFAULT_UNIFIED_SETTINGS.footnotesAutoCollapse,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["footnotesAutoCollapse"]}
                checked={settings.footnotesAutoCollapse}
                onCheckedChange={(checked) =>
                  updateSettings({ footnotesAutoCollapse: Boolean(checked) })
                }
                aria-label={t("settings.general.footnotesAutoCollapse.title")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["conversationStructureThinkingLabel"]}
            {...searchableSetting("conversation-thinking-label", t)}
            description={t("settings.general.conversation.thinkingLabel.description")}
            resetAction={
              settings.conversationStructureThinkingLabel !==
              DEFAULT_UNIFIED_SETTINGS.conversationStructureThinkingLabel ? (
                <SettingResetButton
                  label={t("settings.general.conversation.thinkingLabel.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      conversationStructureThinkingLabel:
                        DEFAULT_UNIFIED_SETTINGS.conversationStructureThinkingLabel,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={
                  mixedConversationStructureThinkingLabel
                    ? ""
                    : settings.conversationStructureThinkingLabel
                }
                // Empty means the built-in label, which follows the app language.
                onCommit={(next) =>
                  updateSettings({ conversationStructureThinkingLabel: next.trim() })
                }
                placeholder={
                  mixedConversationStructureThinkingLabel
                    ? t("settings.general.mixed")
                    : t("chat.liveActivity.thinkingDefault")
                }
                aria-label={t("settings.general.conversation.thinkingLabel.ariaLabel")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["conversationStructureIdleLabel"]}
            {...searchableSetting("conversation-idle-label", t)}
            description={t("settings.general.conversation.idleLabel.description")}
            resetAction={
              settings.conversationStructureIdleLabel !==
              DEFAULT_UNIFIED_SETTINGS.conversationStructureIdleLabel ? (
                <SettingResetButton
                  label={t("settings.general.conversation.idleLabel.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      conversationStructureIdleLabel:
                        DEFAULT_UNIFIED_SETTINGS.conversationStructureIdleLabel,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={
                  mixedConversationStructureIdleLabel ? "" : settings.conversationStructureIdleLabel
                }
                onCommit={(next) => updateSettings({ conversationStructureIdleLabel: next.trim() })}
                placeholder={
                  mixedConversationStructureIdleLabel
                    ? t("settings.general.mixed")
                    : t("chat.liveActivity.idleDefault")
                }
                disabled={settings.conversationStructure !== "restructured"}
                aria-label={t("settings.general.conversation.idleLabel.ariaLabel")}
              />
            }
          />
        </SettingsSection>
        <SettingsSection id="text-generation" title={t("settings.general.section.textGeneration")}>
          <SettingsRow
            serverScoped
            settingKeys={["textGenerationModelSelection"]}
            {...searchableSetting("text-generation-model", t)}
            description={t("settings.general.textGeneration.description")}
            resetAction={
              hasServerTargets && isTextGenerationModelDirty ? (
                <SettingResetButton
                  label={t("settings.general.textGeneration.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  {t("settings.general.textGeneration.connectEnvironment")}
                </span>
              ) : !hasTextGenerationProvider ? (
                <span className="text-sm text-muted-foreground">
                  {t("settings.general.textGeneration.noProviders")}
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={textGenInstanceId}
                    model={textGenModel}
                    lockedProvider={null}
                    instanceEntries={textGenerationModelInstanceEntries}
                    modelOptionsByInstance={textGenerationModelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    {...(mixedTextGenerationModel ? { triggerLabel: "Mixed" } : {})}
                    getModelDisabledReason={textGenerationModelDisabledReason}
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = textGenerationModelDisabledReason(instanceId, model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: t("settings.general.textGeneration.notSaved"),
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        textGenerationModelSelection: resolveAppModelSelectionState(
                          {
                            ...settings,
                            textGenerationModelSelection: createModelSelection(instanceId, model),
                          },
                          textGenerationProviders,
                        ),
                      });
                    }}
                  />
                  {textGenInstanceEntry ? (
                    <TraitsPicker
                      provider={textGenProvider}
                      models={textGenInstanceEntry?.models ?? []}
                      model={textGenModel}
                      modelOptions={textGenModelOptions}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={
                        settings.planModeEnabled || selectsPlanAgent(textGenModelOptions)
                      }
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(nextOptions) => {
                        updateSettings({
                          textGenerationModelSelection: resolveAppModelSelectionState(
                            {
                              ...settings,
                              textGenerationModelSelection: createModelSelection(
                                textGenInstanceId,
                                textGenModel,
                                nextOptions,
                              ),
                            },
                            textGenerationProviders,
                          ),
                        });
                      }}
                    />
                  ) : null}
                </div>
              )
            }
          />
        </SettingsSection>

        <SettingsSection id="about" title={t("settings.general.section.about")}>
          {isElectron || HOSTED_APP_CHANNEL ? (
            <AboutVersionSection />
          ) : (
            <>
              <SettingsRow
                id={searchableSetting("app-version").id}
                title={<AboutVersionTitle />}
                description={t("settings.general.version.description")}
              />
            </>
          )}
          <MobileAppSettingsRow />
          <SettingsRow
            {...searchableSetting("privacy-policy", t)}
            description="How we handle your data, including the anonymous usage data T3 Code collects."
            control={
              <Button
                render={<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer noopener" />}
                size="sm"
                variant="outline"
              >
                View policy
              </Button>
            }
          />
        </SettingsSection>
        <SettingsSection title={t("settings.general.section.diagnostics")}>
          <SettingsRow
            {...searchableSetting("diagnostics", t)}
            description={
              isEnvironmentScope
                ? t("settings.general.diagnostics.oneEnvironment")
                : t("settings.general.diagnostics.multipleEnvironments")
            }
            control={
              <Button
                render={
                  <Link
                    to="/settings/diagnostics"
                    search={{ machine: environmentId ?? undefined }}
                  />
                }
                size="sm"
                variant="outline"
              >
                {t("settings.general.diagnostics.view")}
              </Button>
            }
          />
          <SettingsRow
            {...searchableSetting("open-source-licenses", t)}
            description={t("settings.general.licenses.description")}
            control={
              <Button
                render={<Link to="/settings/open-source-licenses" />}
                size="sm"
                variant="outline"
              >
                {t("settings.general.licenses.view")}
              </Button>
            }
          />
        </SettingsSection>

        <LegacyFeaturesSection />
      </SettingsPageContainer>
    </SettingsRowCopyProvider>
  );
}

const RESPONSE_STREAMING_MODE_LABEL_KEYS: Record<ResponseStreamingMode, MessageKey> = {
  turn: "settings.general.streaming.turn",
  paragraph: "settings.general.streaming.paragraph",
  realtime: "settings.general.streaming.realtime",
  smooth: "settings.general.streaming.smooth",
};

const RESPONSE_STREAMING_MODE_DESCRIPTION_KEYS: Record<ResponseStreamingMode, MessageKey> = {
  turn: "settings.general.streaming.turnDescription",
  paragraph: "settings.general.streaming.paragraphDescription",
  realtime: "settings.general.streaming.realtimeDescription",
  smooth: "settings.general.streaming.smoothDescription",
};

const SMOOTH_OUTPUT_MODE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  character: "settings.general.streaming.unit.character",
  token: "settings.general.streaming.unit.token",
  auto: "settings.general.streaming.unit.auto",
};

const SMOOTH_OUTPUT_LINE_MODE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  adaptive: "settings.general.streaming.lines.adaptive",
  parallel: "settings.general.streaming.lines.parallel",
};

const INHERITED_RUNTIME_MODE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  "approval-required": "settings.row.copy.settingValue.runtimeMode.approvalRequired",
  "auto-accept-edits": "settings.row.copy.settingValue.runtimeMode.autoAcceptEdits",
  auto: "settings.row.copy.settingValue.runtimeMode.auto",
  "full-access": "settings.row.copy.settingValue.runtimeMode.fullAccess",
};

const INHERITED_RESPONSE_STREAMING_MODE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  turn: "settings.row.copy.settingValue.streamingMode.turn",
  paragraph: "settings.row.copy.settingValue.streamingMode.paragraph",
  realtime: "settings.row.copy.settingValue.streamingMode.realtime",
  smooth: "settings.row.copy.settingValue.streamingMode.smooth",
  token: "settings.row.copy.settingValue.streamingMode.token",
};

const INHERITED_WORKTREE_SUBMODULE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  recursive: "settings.general.submodules.recursive",
  "top-level": "settings.general.submodules.topLevel",
  none: "settings.general.submodules.none",
};

function inheritedSettingValueLabel(
  key: keyof ServerSettings,
  value: string,
  t: (key: MessageKey) => string,
): string {
  const messageKey =
    key === "defaultRuntimeMode"
      ? INHERITED_RUNTIME_MODE_LABEL_KEYS[value]
      : key === "responseStreamingMode"
        ? INHERITED_RESPONSE_STREAMING_MODE_LABEL_KEYS[value]
        : key === "smoothOutputMode"
          ? SMOOTH_OUTPUT_MODE_LABEL_KEYS[value]
          : key === "smoothOutputLineMode"
            ? SMOOTH_OUTPUT_LINE_MODE_LABEL_KEYS[value]
            : key === "worktreeSubmodules"
              ? INHERITED_WORKTREE_SUBMODULE_LABEL_KEYS[value]
              : undefined;
  return messageKey === undefined ? value : t(messageKey);
}

function useSettingsPanelCopy(): SettingsRowCopy {
  const { t } = useI18n();
  return (() => ({
    settingValueLabel: (key, value) => inheritedSettingValueLabel(key, value, t),
    resetToInheritedTooltip: t("settings.row.copy.inheritedTooltip"),
    resetToDefaultTooltip: t("settings.row.copy.defaultTooltip"),
    resetToInheritedLabel: (label) => t("settings.row.copy.inheritedLabel", { label }),
    resetToDefaultLabel: (label) => t("settings.row.copy.defaultLabel", { label }),
    overrideFallbackLabel: t("settings.row.copy.overrideFallbackLabel"),
    reconnectSelectedEnvironment: t("settings.row.copy.reconnectSelectedEnvironment"),
    selectEnvironment: t("settings.row.copy.selectEnvironment"),
    mixedAcrossEnvironments: t("settings.row.copy.mixedAcrossEnvironments"),
    overriddenForProject: t("settings.row.copy.overriddenForProject"),
    inheritedFrom: (source) => t("settings.row.copy.inheritedFrom", { source }),
    setOnEnvironment: t("settings.row.copy.setOnEnvironment"),
    builtInDefault: t("settings.row.copy.builtInDefault"),
    layerProject: t("settings.row.copy.layerProject"),
    layerEnvironment: t("settings.row.copy.layerEnvironment"),
    layerDefault: t("settings.row.copy.layerDefault"),
    inherits: t("settings.row.copy.inherits"),
    on: t("settings.row.copy.on"),
    off: t("settings.row.copy.off"),
    dayCount: (count) =>
      t(count === 1 ? "settings.row.copy.dayCountOne" : "settings.row.copy.dayCountOther", {
        count,
      }),
    lastSelected: t("settings.row.copy.lastSelected"),
    never: t("settings.row.copy.never"),
    automatic: t("settings.row.copy.automatic"),
    textGenerationModel: t("settings.row.copy.textGenerationModel"),
    notSet: t("settings.row.copy.notSet"),
    empty: t("settings.row.copy.empty"),
    itemCount: (count) =>
      t(count === 1 ? "settings.row.copy.itemCountOne" : "settings.row.copy.itemCountOther", {
        count,
      }),
    custom: t("settings.row.copy.custom"),
    envModeLocal: t("settings.general.workspace.mode.local"),
    envModeWorktree: t("settings.general.workspace.mode.worktree"),
    overriddenBy: t("settings.row.copy.overriddenBy"),
    resetOverride: (count) =>
      t(
        count === 1 ? "settings.row.copy.resetOverrideOne" : "settings.row.copy.resetOverrideOther",
      ),
    projectOverrideSummary: (summary, count) =>
      t(
        count === 1
          ? "settings.row.copy.projectOverrideSummaryOne"
          : "settings.row.copy.projectOverrideSummaryOther",
        { summary, count },
      ),
    showSourceLabel: (summary) => t("settings.row.copy.showSourceLabel", { summary }),
  }))();
}

export function SmoothTextFadeDurationSlider({
  value,
  onCommit,
  ariaLabel,
  formatValue,
}: {
  value: number | null;
  onCommit: (value: number) => void;
  ariaLabel: string;
  formatValue: (value: number | null) => string;
}) {
  return (
    <SettingsRangeSlider
      value={value}
      onCommit={onCommit}
      ariaLabel={ariaLabel}
      formatValue={formatValue}
      min={0}
      max={1000}
      step={50}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.smoothTextFadeDurationMs}
    />
  );
}

export function SmoothTextYieldDurationSlider({
  value,
  onCommit,
  ariaLabel,
  formatValue,
}: {
  value: number | null;
  onCommit: (value: number) => void;
  ariaLabel: string;
  formatValue: (value: number | null) => string;
}) {
  return (
    <SettingsRangeSlider
      value={value}
      onCommit={onCommit}
      ariaLabel={ariaLabel}
      formatValue={formatValue}
      min={100}
      max={300}
      step={10}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.smoothTextYieldDurationMs}
    />
  );
}

function SettingsRangeSlider({
  value,
  onCommit,
  ariaLabel,
  formatValue,
  min,
  max,
  step,
  defaultValue,
}: {
  value: number | null;
  onCommit: (value: number) => void;
  ariaLabel: string;
  formatValue: (value: number | null) => string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState<{ source: number | null; value: number } | null>(null);
  const dirty = useRef(false);
  const lastCommitted = useRef(value);
  const drag = useRef<{ pointerId: number; draft: typeof draft } | null>(null);
  const shown = draft?.source === value ? draft.value : value;
  const rangeValue = shown ?? defaultValue;
  const ratio = Math.max(0, Math.min(1, (rangeValue - min) / (max - min)));
  const sliderStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;

  if (draft !== null && draft.source !== value) {
    setDraft(null);
  }

  useEffect(() => {
    dirty.current = false;
    lastCommitted.current = value;
    drag.current = null;
  }, [value]);

  function commit(next: number, explicit = false) {
    if (!dirty.current && !explicit) return;
    dirty.current = false;
    if (next === lastCommitted.current) return;
    lastCommitted.current = next;
    // Keep the preview until settings acknowledge the write or an external value replaces it.
    setDraft({ source: value, value: next });
    onCommit(next);
  }

  return (
    <div className="flex w-full items-center gap-3 sm:w-64">
      <output
        className="min-w-16 shrink-0 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={id}
      >
        {formatValue(shown)}
      </output>
      <input
        aria-label={ariaLabel}
        className="settings-slider min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        onChange={(event) => {
          dirty.current = true;
          setDraft({ source: value, value: Number(event.currentTarget.value) });
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { pointerId: event.pointerId, draft };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          commit(Number(event.currentTarget.value), true);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          setDraft(drag.current.draft);
          drag.current = null;
          dirty.current = false;
        }}
        onKeyUp={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          ) {
            commit(Number(event.currentTarget.value), true);
          }
        }}
        onBlur={(event) => {
          drag.current = null;
          commit(Number(event.currentTarget.value));
        }}
        step={step}
        style={sliderStyle}
        type="range"
        value={rangeValue}
      />
    </div>
  );
}

const RESTORE_LABEL_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  Theme: "settings.restore.label.theme",
  "Follow system": "settings.restore.label.followSystem",
  "Theme mix": "settings.restore.label.themeMix",
  Contrast: "settings.restore.label.contrast",
  "Glass opacity": "settings.restore.label.glassOpacity",
  "Diff colors": "settings.restore.label.diffColors",
  "Panel animations": "settings.restore.label.panelAnimations",
  "Environment identification": "settings.restore.label.environmentIdentification",
  Language: "settings.restore.label.language",
  "Time format": "settings.restore.label.timeFormat",
  "Thread notifications": "settings.restore.label.threadNotifications",
  "In-app notifications": "settings.restore.label.inAppNotifications",
  "Visible threads": "settings.restore.label.visibleThreads",
  "Project Grouping": "settings.restore.label.projectGrouping",
  "Auto-settle inactive threads": "settings.restore.label.autoSettleInactive",
  "Auto-settle merged threads": "settings.restore.label.autoSettleMerged",
  "Auto-resume limited threads": "settings.restore.label.autoResumeLimitedThreads",
  "Snooze limited threads": "settings.restore.label.snoozeLimitedThreads",
  "Word wrap": "settings.restore.label.wordWrap",
  "Interface font": "settings.restore.label.interfaceFont",
  "Prompt font": "settings.restore.label.promptFont",
  "Code font": "settings.restore.label.codeFont",
  "Terminal font": "settings.restore.label.terminalFont",
  "Default diff file state": "settings.restore.label.defaultDiffFileState",
  "Diff whitespace changes": "settings.restore.label.diffWhitespaceChanges",
  "Diff layout": "settings.restore.label.diffLayout",
  "Proactive panels": "settings.restore.label.proactivePanels",
  "Show skills in slash menu": "settings.restore.label.skillsInSlashMenu",
  "Collapse composer on scroll": "settings.restore.label.composerCollapse",
  "Follow-up behavior": "settings.restore.label.followUpBehavior",
  "Context window indicator": "settings.restore.label.contextWindowIndicator",
  "Response streaming": "settings.restore.label.responseStreaming",
  "Provider update checks": "settings.restore.label.providerUpdateChecks",
  "Continue threads after restarts": "settings.restore.label.continueThreads",
  "Background activity": "settings.restore.label.backgroundActivity",
  "New thread mode": "settings.restore.label.defaultThreadEnvMode",
  "New worktrees start from origin": "settings.restore.label.newWorktreesStartFromOrigin",
  "Add project base directory": "settings.restore.label.addProjectBaseDirectory",
  "Unpin confirmation": "settings.restore.label.unpinConfirmation",
  "Archive confirmation": "settings.restore.label.archiveConfirmation",
  "Delete confirmation": "settings.restore.label.deleteConfirmation",
  "Quit shortcut": "settings.restore.label.quitShortcut",
  "Text generation model": "settings.restore.label.textGenerationModel",
  "Agent browser access": "settings.restore.label.agentBrowserAccess",
  "Browser viewport": "settings.restore.label.browserViewport",
  "Browser zoom": "settings.restore.label.browserZoom",
  "Browser appearance": "settings.restore.label.browserAppearance",
  "Recording frame rate": "settings.restore.label.recordingFrameRate",
  "Open links in": "settings.restore.label.openLinksIn",
  "Floating preview": "settings.restore.label.floatingPreview",
  "No-project chats base directory": "settings.search.item.scratch-base-directory.title",
  "Automatically expand workspace details": "settings.search.item.auto-expand-thread-details.title",
  "Composer context": "settings.search.item.composer-context.title",
  "Rich text composer": "settings.search.item.composer-rich-text.title",
  "Send shortcut": "settings.search.item.send-shortcut.title",
  "Conversation structure": "settings.search.item.conversation-structure.title",
};
