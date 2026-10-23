import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import { SettingsGroup } from "./SettingsGroup";
import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { Spinner } from "~/components/ui/spinner";
import { NotificationSettings } from "./NotificationSettings";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { ArchiveIcon, ArchiveX, CheckIcon, ChevronRightIcon, SettingsIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useId, useEffect, useMemo, useRef, useState } from "react";
import {
  type BackgroundActivityProfile,
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  ServerSettings,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type DiffLayout,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MAX_PROMPT_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_PROMPT_FONT_SIZE,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  type ConversationStructure,
  type TimestampFormat,
  MIN_TERMINAL_FONT_SIZE,
  type QuitConfirmationMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import { IS_NIGHTLY_BUILD, NightlyMobileBetaRow } from "../NightlyMobileBeta";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import {
  canCheckForUpdate,
  type DesktopUpdateCopy,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
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
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { getRelativeTimeState } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { CodeFontPreview, PromptFontPreview, TerminalFontPreview } from "./SettingsFontPreviews";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThemeLibrary } from "./ThemeSettings";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsRowCopyProvider,
  type SettingsRowCopy,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { isProjectScopedSettingKey, type ScopedSettingsPatch } from "./scopedSettings";
import { ProjectFavicon } from "../ProjectFavicon";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { ForkSidebarPreferences } from "./ForkPreferencesSettings";

const ENVIRONMENT_IDENTIFICATION_LABEL_KEYS: Record<EnvironmentIdentificationMode, MessageKey> = {
  artwork: "settings.appearance.environmentIdentification.option.artwork",
  pill: "settings.appearance.environmentIdentification.option.versionPill",
  none: "settings.appearance.environmentIdentification.option.none",
};

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
const SMOOTH_OUTPUT_MODE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  character: "settings.general.streaming.unit.character",
  token: "settings.general.streaming.unit.token",
  auto: "settings.general.streaming.unit.auto",
};

const SMOOTH_OUTPUT_LINE_MODE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  adaptive: "settings.general.streaming.lines.adaptive",
  parallel: "settings.general.streaming.lines.parallel",
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
  return useMemo(
    () => ({
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
          count === 1
            ? "settings.row.copy.resetOverrideOne"
            : "settings.row.copy.resetOverrideOther",
        ),
      projectOverrideSummary: (summary, count) =>
        t(
          count === 1
            ? "settings.row.copy.projectOverrideSummaryOne"
            : "settings.row.copy.projectOverrideSummaryOther",
          { summary, count },
        ),
      showSourceLabel: (summary) => t("settings.row.copy.showSourceLabel", { summary }),
    }),
    [t],
  );
}

const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder);

const TIMESTAMP_FORMAT_LABEL_KEYS: Readonly<Record<TimestampFormat, MessageKey>> = {
  locale: "settings.general.timeFormat.locale",
  "12-hour": "settings.general.timeFormat.12Hour",
  "24-hour": "settings.general.timeFormat.24Hour",
};

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

const DIFF_LAYOUT_LABEL_KEYS: Record<DiffLayout, MessageKey> = {
  stacked: "settings.general.diffLayout.stacked",
  split: "settings.general.diffLayout.split",
};

const QUIT_CONFIRMATION_MODE_LABEL_KEYS: Record<QuitConfirmationMode, MessageKey> = {
  direct: "settings.general.confirmQuit.direct",
  hold: "settings.general.confirmQuit.hold",
  "double-click": "settings.general.confirmQuit.doubleClick",
};

const BACKGROUND_ACTIVITY_PROFILE_LABEL_KEYS: Record<BackgroundActivityProfile, MessageKey> = {
  balanced: "settings.general.backgroundActivity.balanced",
  performance: "settings.general.backgroundActivity.performance",
  "battery-saver": "settings.general.backgroundActivity.batterySaver",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABEL_KEYS: Record<
  BackgroundActivityProfileOption,
  MessageKey
> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABEL_KEYS,
  advanced: "settings.general.backgroundActivity.advanced",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTION_KEYS: Record<BackgroundActivityProfile, MessageKey> =
  {
    balanced: "settings.general.backgroundActivity.balancedDescription",
    performance: "settings.general.backgroundActivity.performanceDescription",
    "battery-saver": "settings.general.backgroundActivity.batterySaverDescription",
  };
const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION_KEY: MessageKey =
  "settings.general.backgroundActivity.advancedDescription";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly labelKey: MessageKey;
}> = [
  {
    key: "pauseWhenHostLocked",
    labelKey: "settings.general.backgroundActivity.pauseWhenHostLocked",
  },
  {
    key: "pauseWhenHostLowPower",
    labelKey: "settings.general.backgroundActivity.pauseWhenHostLowPower",
  },
  {
    key: "pauseWhenClientLowPower",
    labelKey: "settings.general.backgroundActivity.pauseWhenClientLowPower",
  },
  { key: "pauseWhenOnBattery", labelKey: "settings.general.backgroundActivity.pauseWhenOnBattery" },
];

/** Drags locally and saves once on release, so a drag is one settings write. */
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

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function AboutVersionTitle({ version }: { readonly version: string }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{t("settings.general.version.title")}</span>
      <code className="text-2xs font-medium text-muted-foreground">{version}</code>
    </span>
  );
}

export function AboutVersionSection() {
  const { t } = useI18n();
  const updateState = useDesktopUpdateState();
  const updateCopy = useMemo<DesktopUpdateCopy>(
    () => ({
      availableTooltip: (version) =>
        version === null
          ? t("settings.general.version.tooltip.available")
          : t("settings.general.version.tooltip.availableVersion", { version }),
      downloadingTooltip: (percent) =>
        percent === null
          ? t("settings.general.version.tooltip.downloading")
          : t("settings.general.version.tooltip.downloadingPercent", {
              percent: Math.floor(percent),
            }),
      downloadedTooltip: (version) =>
        version === null
          ? t("settings.general.version.tooltip.downloadedReady")
          : t("settings.general.version.tooltip.downloaded", { version }),
      downloadFailedTooltip: (version) =>
        t("settings.general.version.tooltip.downloadFailed", { version }),
      installFailedTooltip: (version) =>
        t("settings.general.version.tooltip.installFailed", { version }),
      failedTooltip: t("settings.general.version.tooltip.failed"),
      upToDateTooltip: t("settings.general.version.tooltip.upToDate"),
      installConfirmation: (version) =>
        version === null
          ? t("settings.general.version.installConfirmation")
          : t("settings.general.version.installConfirmationWithVersion", { version }),
    }),
    [t],
  );
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;
  // Show the beta app links as soon as someone picks Nightly, before the update installs.
  const showNightlyMobileBeta =
    IS_NIGHTLY_BUILD || (hasDesktopBridge && selectedUpdateChannel === "nightly");

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
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
    },
    [selectedUpdateChannel, t],
  );

  const handleButtonClick = useCallback(async () => {
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
            updateCopy,
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
  }, [isUpdateActionPending, updateState, t, updateCopy]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState, updateCopy) : null;
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
      : t("settings.general.version.description");

  return (
    <>
      <SettingsRow
        id={searchableSetting("app-version", t).id}
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
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
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
      {showNightlyMobileBeta ? <NightlyMobileBetaRow /> : null}
      {hasDesktopBridge ? <CliCommandSettingsRow /> : null}
    </>
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

  const changedSettingLabels = useMemo(
    () =>
      [
        ...(theme !== "system" ? ["Theme"] : []),
        ...(!followSystem ? ["Follow system"] : []),
        ...(themeHalves !== null ? ["Theme mix"] : []),
        ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
          ? ["Contrast"]
          : []),
        ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity
          ? ["Glass opacity"]
          : []),
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
        ...(settings.inAppNotificationsEnabled !==
        DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
          ? ["In-app notifications"]
          : []),
        ...(settings.sidebarThreadPreviewCount !==
        DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
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
        ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut
          ? ["Send shortcut"]
          : []),
        ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
          ? ["Follow-up behavior"]
          : []),
        ...(settings.contextWindowMeterEnabled !==
        DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
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
        ...(settings.smoothTextYieldDurationMs !==
        DEFAULT_UNIFIED_SETTINGS.smoothTextYieldDurationMs
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
      }),
    [
      isTextGenerationModelDirty,
      t,
      isBackgroundActivityDirty,
      settings.browserDefaultViewport,
      settings.browserDefaultZoomFactor,
      settings.browserDefaultAppearance,
      settings.browserRecordingFrameRate,
      settings.browserRecordingShowKeyPresses,
      settings.browserRecordingShowMousePresses,
      settings.browserLinkTarget,
      settings.browserAutoShowFloatingPreview,
      settings.pullRequestLinksOpenInApp,
      settings.appearanceContrast,
      settings.diffColorScheme,
      settings.chatWidth,
      settings.enableAgentBrowserAccess,
      settings.confirmQuit,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.confirmThreadUnpin,
      settings.composerCollapseOnScroll,
      settings.composerRichTextEnabled,
      settings.sendShortcut,
      settings.followUpBehavior,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffFilesCollapsed,
      settings.diffIgnoreWhitespace,
      settings.diffLayout,
      settings.proactivePanelsEnabled,
      settings.environmentIdentificationMode,
      settings.contextWindowMeterEnabled,
      settings.fontFamilyCode,
      settings.fontFamilyComposer,
      settings.fontFamilySans,
      settings.fontFamilyTerminal,
      settings.fontSizeCode,
      settings.fontSizeInterface,
      settings.fontSizePrompt,
      settings.fontSizeTerminal,
      settings.glassOpacity,
      settings.panelAnimationDurationMs,
      settings.responseStreamingMode,
      settings.smoothOutputMode,
      settings.smoothOutputLineMode,
      settings.smoothMarkdownPreload,
      settings.smoothTextFadeDurationMs,
      settings.smoothTextYieldDurationMs,
      settings.footnotesAutoCollapse,
      settings.conversationStructure,
      settings.conversationStructureThinkingLabel,
      settings.conversationStructureIdleLabel,

      settings.persistComposerContextStrip,
      settings.enableProviderUpdateChecks,
      settings.continueThreadsAfterServerUpdate,
      settings.sidebarAutoSettleAfterDays,
      settings.sidebarAutoSettleKeepPullRequests,
      settings.sidebarAutoSettleOnMerge,
      settings.autoResumeLimitedThreads,
      settings.snoozeLimitedThreads,
      settings.sidebarProjectGroupingMode,
      settings.sidebarProjectSortOrder,
      settings.sidebarWorkingShelfEnabled,
      settings.sidebarThreadPreviewCount,
      settings.showSkillsInSlashMenu,
      settings.language,
      settings.autoExpandThreadDetailsPanel,
      settings.hideUnavailableContextMenuItems,
      settings.scratchBaseDirectory,
      settings.legacySidebarEnabled,
      settings.legacySidebarProjectGuides,
      settings.legacySidebarThreadStatusDots,
      settings.legacySidebarHideStatusLabels,
      settings.timestampFormat,
      settings.notificationMode,
      settings.inAppNotificationsEnabled,
      settings.wordWrap,
      followSystem,
      theme,
      themeHalves,
    ],
  );

  const restoreDefaults = useCallback(async () => {
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
  }, [
    changedSettingLabels,
    clearThemeHalves,
    isProjectScope,
    onRestored,
    setFollowSystem,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
    updateSettings,
    t,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.general.backgroundActivity.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.general.backgroundActivity.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {t("settings.general.backgroundActivity.sharedPolicy")}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.general.backgroundActivity.sharedPolicyDescription")}
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("settings.general.backgroundActivity.sharedPolicyAriaLabel")}
                >
                  <SelectValue>
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABEL_KEYS[activeProfile])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {t("settings.general.backgroundActivity.balanced")}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {t("settings.general.backgroundActivity.performance")}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {t("settings.general.backgroundActivity.batterySaver")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {searchableSetting("git-fetch-interval", t).title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.general.backgroundActivity.gitFetchIntervalDescription")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement
                      aria-label={t("settings.general.backgroundActivity.decreaseGitFetchInterval")}
                    />
                    <NumberFieldInput
                      aria-label={t(
                        "settings.general.backgroundActivity.gitFetchIntervalAriaLabel",
                      )}
                    />
                    <NumberFieldIncrement
                      aria-label={t("settings.general.backgroundActivity.increaseGitFetchInterval")}
                    />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">
                  {t("settings.general.backgroundActivity.seconds")}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {t("settings.general.backgroundActivity.providerHealthInterval")}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh provider availability, versions, and auth state. Model catalog updates
                  follow Provider update checks.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement
                      aria-label={t(
                        "settings.general.backgroundActivity.decreaseProviderHealthInterval",
                      )}
                    />
                    <NumberFieldInput
                      aria-label={t(
                        "settings.general.backgroundActivity.providerHealthIntervalAriaLabel",
                      )}
                    />
                    <NumberFieldIncrement
                      aria-label={t(
                        "settings.general.backgroundActivity.increaseProviderHealthInterval",
                      )}
                    />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">
                  {t("settings.general.backgroundActivity.seconds")}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {t("settings.general.backgroundActivity.hostPowerMonitor")}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.general.backgroundActivity.hostPowerMonitorDescription")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement
                      aria-label={t(
                        "settings.general.backgroundActivity.decreaseActiveHostPowerInterval",
                      )}
                    />
                    <NumberFieldInput
                      aria-label={t(
                        "settings.general.backgroundActivity.activeHostPowerIntervalAriaLabel",
                      )}
                    />
                    <NumberFieldIncrement
                      aria-label={t(
                        "settings.general.backgroundActivity.increaseActiveHostPowerInterval",
                      )}
                    />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">
                  {t("settings.general.backgroundActivity.seconds")}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {t("settings.general.backgroundActivity.idleHostMonitor")}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.general.backgroundActivity.idleHostMonitorDescription")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement
                      aria-label={t(
                        "settings.general.backgroundActivity.decreaseIdleHostPowerInterval",
                      )}
                    />
                    <NumberFieldInput
                      aria-label={t(
                        "settings.general.backgroundActivity.idleHostPowerIntervalAriaLabel",
                      )}
                    />
                    <NumberFieldIncrement
                      aria-label={t(
                        "settings.general.backgroundActivity.increaseIdleHostPowerInterval",
                      )}
                    />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">
                  {t("settings.general.backgroundActivity.seconds")}
                </span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, labelKey }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{t(labelKey)}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={t(labelKey)}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            {t("settings.general.backgroundActivity.resetAll")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            {t("settings.general.backgroundActivity.done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AppearanceSettingsPanel() {
  const { t } = useI18n();
  const copy = useSettingsPanelCopy();
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsRowCopyProvider copy={copy}>
        <SettingsSection
          id="appearance"
          title={t("settings.appearance.colorsAndThemes.title")}
          variant="plain"
          hideTitle
        >
          <div id={searchableSetting("theme", t).id}>
            <ThemeLibrary
              appearanceMode={appearanceMode}
              customThemes={customThemes}
              initialAppearance={resolvedTheme}
              refreshTheme={refreshTheme}
              isImportOpen={isImportThemeOpen}
              setAppearanceMode={setAppearanceMode}
              setTheme={setTheme}
              setThemeHalf={setThemeHalf}
              theme={theme}
              themeHalves={themeHalves}
              onImportOpenChange={setIsImportThemeOpen}
            />
          </div>
        </SettingsSection>

        <SettingsSection id="appearance-interface" title={t("settings.appearance.interface.title")}>
          <SettingsRow
            {...searchableSetting("setting-appearance-contrast", t)}
            description={t("settings.appearance.contrast.description")}
            resetAction={
              settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
                <SettingResetButton
                  label={t("settings.appearance.contrast.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="appearance-contrast"
                >
                  {settings.appearanceContrast}%
                </output>
                <input
                  aria-label={t("settings.restore.label.contrast")}
                  className="settings-slider min-w-0 flex-1"
                  id="appearance-contrast"
                  max={MAX_APPEARANCE_CONTRAST}
                  min={MIN_APPEARANCE_CONTRAST}
                  onChange={(event) => {
                    const appearanceContrast = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(appearanceContrast) &&
                      appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                      appearanceContrast <= MAX_APPEARANCE_CONTRAST
                    ) {
                      updateSettings({ appearanceContrast });
                    }
                  }}
                  step={5}
                  style={appearanceContrastSliderStyle}
                  type="range"
                  value={settings.appearanceContrast}
                />
              </div>
            }
          />

          <SettingsRow
            {...searchableSetting("setting-glass-opacity", t)}
            description={t("settings.appearance.glassOpacity.description")}
            resetAction={
              settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
                <SettingResetButton
                  label={t("settings.appearance.glassOpacity.resetLabel")}
                  onClick={() =>
                    updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="glass-opacity"
                >
                  {settings.glassOpacity}%
                </output>
                <input
                  aria-label={t("settings.restore.label.glassOpacity")}
                  className="settings-slider min-w-0 flex-1"
                  id="glass-opacity"
                  max={MAX_GLASS_OPACITY}
                  min={MIN_GLASS_OPACITY}
                  onChange={(event) => {
                    const glassOpacity = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(glassOpacity) &&
                      glassOpacity >= MIN_GLASS_OPACITY &&
                      glassOpacity <= MAX_GLASS_OPACITY
                    ) {
                      updateSettings({ glassOpacity });
                    }
                  }}
                  step={5}
                  style={glassOpacitySliderStyle}
                  type="range"
                  value={settings.glassOpacity}
                />
              </div>
            }
          />

          {showEnvironmentIdentification ? (
            <SettingsRow
              {...searchableSetting("environment-identification", t)}
              description={t("settings.appearance.environmentIdentification.description")}
              resetAction={
                settings.environmentIdentificationMode !==
                DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                  <SettingResetButton
                    label={t("settings.appearance.environmentIdentification.resetLabel")}
                    onClick={() =>
                      updateSettings({
                        environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.environmentIdentificationMode}
                  onValueChange={(value) => {
                    if (value === "artwork" || value === "pill" || value === "none") {
                      updateSettings({ environmentIdentificationMode: value });
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full sm:w-40"
                    aria-label={t("settings.restore.label.environmentIdentification")}
                  >
                    <SelectValue>
                      {t(
                        ENVIRONMENT_IDENTIFICATION_LABEL_KEYS[
                          settings.environmentIdentificationMode
                        ],
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {Object.entries(ENVIRONMENT_IDENTIFICATION_LABEL_KEYS).map(
                      ([value, labelKey]) => (
                        <SelectItem hideIndicator key={value} value={value}>
                          {t(labelKey)}
                        </SelectItem>
                      ),
                    )}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}

          <SettingsRow
            {...searchableSetting("diff-color-scheme", t)}
            description={t("settings.appearance.diffColors.description")}
            resetAction={
              settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
                <SettingResetButton
                  label={t("settings.appearance.diffColors.resetLabel")}
                  onClick={() =>
                    updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                  }
                />
              ) : null
            }
            control={
              <div className="w-full sm:w-40">
                <Select
                  value={settings.diffColorScheme}
                  onValueChange={(value) => {
                    if (value === "red-green" || value === "blue-orange")
                      updateSettings({ diffColorScheme: value });
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0"
                    aria-label={t("settings.restore.label.diffColors")}
                  >
                    <span
                      aria-hidden="true"
                      className={
                        settings.diffColorScheme === "blue-orange"
                          ? "flex shrink-0 flex-row-reverse gap-1"
                          : "flex shrink-0 gap-1"
                      }
                    >
                      <span className="size-2 rounded-full bg-diff-deletion" />
                      <span className="size-2 rounded-full bg-diff-addition" />
                    </span>
                    <SelectValue>
                      {settings.diffColorScheme === "blue-orange"
                        ? t("settings.appearance.diffColors.option.blueOrange")
                        : t("settings.appearance.diffColors.option.redGreen")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="red-green">
                      {t("settings.appearance.diffColors.option.redGreenDefault")}
                    </SelectItem>
                    <SelectItem value="blue-orange">
                      {t("settings.appearance.diffColors.option.blueOrange")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            }
          />

          <SettingsRow
            {...searchableSetting("composer-context", t)}
            description={t("settings.general.composerContext.description")}
            resetAction={
              settings.persistComposerContextStrip !==
              DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
                <SettingResetButton
                  label={t("settings.general.composerContext.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      persistComposerContextStrip:
                        DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.persistComposerContextStrip}
                onCheckedChange={(checked) =>
                  updateSettings({ persistComposerContextStrip: Boolean(checked) })
                }
                aria-label={t("settings.general.composerContext.ariaLabel")}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("chat-width", t)}
            description="Set how wide messages and the composer can grow on large screens."
            resetAction={
              settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
                <SettingResetButton
                  label="chat width"
                  onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
                />
              ) : null
            }
            control={
              <div className="w-full sm:w-40">
                <Select
                  value={settings.chatWidth}
                  onValueChange={(value) => {
                    if (value === "comfortable" || value === "wide" || value === "full")
                      updateSettings({ chatWidth: value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Chat width">
                    <SelectValue>{CHAT_WIDTH_LABELS[settings.chatWidth]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="comfortable">Comfortable (default)</SelectItem>
                    <SelectItem value="wide">Wide</SelectItem>
                    <SelectItem value="full">Full</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            }
          />
        </SettingsSection>

        <ForkSidebarPreferences />

        <SettingsSection id="motion" title={t("settings.appearance.motion.title")}>
          <SettingsRow
            {...searchableSetting("panel-animations", t)}
            description={t("settings.appearance.panelAnimations.description")}
            control={
              <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
                <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
                <div className="flex w-full items-center gap-3">
                  <output
                    className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="panel-animation-duration"
                  >
                    {settings.panelAnimationDurationMs} ms
                  </output>
                  <input
                    aria-label={t("settings.appearance.panelAnimations.durationAriaLabel")}
                    className="settings-slider min-w-0 flex-1"
                    id="panel-animation-duration"
                    max={MAX_PANEL_ANIMATION_DURATION_MS}
                    min={MIN_PANEL_ANIMATION_DURATION_MS}
                    onChange={(event) => {
                      const panelAnimationDurationMs = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(panelAnimationDurationMs) &&
                        panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                        panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                      ) {
                        updateSettings({ panelAnimationDurationMs });
                      }
                    }}
                    step={25}
                    style={panelAnimationDurationSliderStyle}
                    type="range"
                    value={settings.panelAnimationDurationMs}
                  />
                </div>
              </div>
            }
            resetAction={
              settings.panelAnimationDurationMs !==
              DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
                <SettingResetButton
                  label={t("settings.appearance.panelAnimations.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                    })
                  }
                />
              ) : null
            }
          />
        </SettingsSection>

        <TypographySection />
      </SettingsRowCopyProvider>
    </SettingsPageContainer>
  );
}

function useFontDefaultFamilies() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  // An unset preference shows the font it resolves to on this machine; the
  // default stacks are the platform's own faces, so the name is probed, not
  // hardcoded.
  const defaults = useMemo(
    () => ({
      sans:
        resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ??
        t("settings.appearance.typography.systemDefault"),
      code:
        resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ??
        t("settings.appearance.typography.systemMonospace"),
    }),
    [t],
  );
  return {
    sans: defaults.sans,
    code: defaults.code,
    // The composer inherits whatever the interface preference resolves to.
    interfaceFamily: settings.fontFamilySans.trim() || defaults.sans,
  };
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font", t)}
      description={t("settings.appearance.interfaceFont.description")}
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: t("settings.appearance.interfaceFont.sizeLabel"),
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  );
}

function PromptFontRow() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("prompt-font", t)}
      description={t("settings.appearance.promptFont.description")}
      defaultFamily={defaults.interfaceFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      onReset={() =>
        updateSettings({
          fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
          fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        })
      }
      size={{
        label: t("settings.appearance.promptFont.sizeLabel"),
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  );
}

function CodeFontRow({
  title,
  description,
  preview,
}: {
  title?: string;
  description?: string;
  preview?: ReactNode;
}) {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("code-font", t)}
      {...(title !== undefined ? { title } : {})}
      description={description ?? t("settings.appearance.codeFont.description")}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyCode}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      onReset={() =>
        updateSettings({
          fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
          fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        })
      }
      requireMonospace
      size={{
        label: t("settings.appearance.codeFont.sizeLabel"),
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  );
}

function TerminalFontRow() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("terminal-font", t)}
      description={t("settings.appearance.terminalFont.description")}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      onReset={() =>
        updateSettings({
          fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
          fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        })
      }
      requireMonospace
      size={{
        label: t("settings.appearance.terminalFont.sizeLabel"),
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  );
}

function FontSmoothingRow() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing", t)}
      description={t("settings.appearance.fontSmoothing.description")}
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label={t("settings.appearance.fontSmoothing.resetLabel")}
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label={t("settings.search.item.font-smoothing.title")}
        />
      }
    />
  );
}

function WordWrapRow() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap", t)}
      description={t("settings.appearance.wordWrap.description")}
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label={t("settings.appearance.wordWrap.resetLabel")}
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label={t("settings.appearance.wordWrap.ariaLabel")}
        />
      }
    />
  );
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <PromptFontRow />
      <CodeFontRow />
      <TerminalFontRow />
      <FontSmoothingRow />
    </>
  );
}

/**
 * The two-font view: one sans, one monospace. The prompt follows the
 * interface font and the terminal follows the monospace font, so the demos
 * under each row show every surface the choice reaches.
 */
function SimpleFontRows() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <CodeFontRow
        title={t("settings.appearance.monospaceFont.title")}
        description={t("settings.appearance.monospaceFont.description")}
        preview={
          <>
            <CodeFontPreview />
            <TerminalFontPreview
              family={resolveTerminalFontPreference({
                advanced: false,
                code: settings.fontFamilyCode,
                terminal: settings.fontFamilyTerminal,
              })}
              size={resolveTerminalFontSizePreference({
                advanced: false,
                code: settings.fontSizeCode,
                terminal: settings.fontSizeTerminal,
              })}
            />
          </>
        }
      />
    </>
  );
}

// Font smoothing only renders on macOS, so a search jump to it elsewhere
// must not flip the section - the target would never mount to be scrolled to.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
  ...(typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
    ? ["font-smoothing"]
    : []),
]);

/**
 * The two-font view by default - one sans, one monospace, each cascading to
 * every surface it reaches - with an Advanced switch in the section header
 * that reveals the per-surface override rows. The choice persists locally,
 * and a settings-search jump to an override row flips Advanced on so the
 * target exists to scroll to.
 */
function TypographySection() {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const searchTargetId = useSettingsSearchTargetId();
  // Flip Advanced on once per search jump so the hidden target can mount and
  // scroll; tracking the handled id lets the user turn it back off without
  // the still-set target immediately re-expanding the section.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null || !ADVANCED_TYPOGRAPHY_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setAdvanced(true);
  }, [searchTargetId, setAdvanced]);
  return (
    <SettingsSection
      id="typography"
      title={t("settings.appearance.typography.title")}
      headerAction={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          {t("settings.appearance.typography.advanced")}
          <Switch
            checked={advanced}
            onCheckedChange={(checked) => setAdvanced(Boolean(checked))}
            aria-label={t("settings.appearance.typography.advancedAriaLabel")}
          />
        </label>
      }
    >
      {advanced ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  description: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** The persisted family value supplied by the unified settings defaults. */
  defaultValue: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size: {
    label: string;
    min: number;
    max: number;
    value: number;
    defaultValue: number;
    onChange: (v: number) => void;
  };
}) {
  const { t } = useI18n();
  const trimmed = value.trim();
  // The fallback input edits a draft; the preference only commits once typing
  // pauses and the text probes as an available font (or is an explicit
  // clear), so the current font holds and nothing reflows mid-word.
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  const commitTimerRef = useRef<number | null>(null);
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    // The committed value changed externally (hydration, reset, picker
    // selection); adopt it and drop any pending commit of a stale draft.
    lastValueRef.current = value;
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(value);
    setDraftSettled(true);
  }
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    // A rejected name stays in the field, flagged: the terminal would silently
    // fall back to its default, so the row must not claim it took the value.
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    if (commitTimerRef.current === null) return;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  // Flag an unknown name only once typing pauses, and never for an empty
  // field - that is the starting state, not a rejected entry.
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetToDefault = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(defaultValue);
    setDraftSettled(true);
    onReset();
  };
  const resetAction =
    value !== defaultValue || size.value !== size.defaultValue ? (
      <SettingResetButton label={title.toLowerCase()} onClick={resetToDefault} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  // Everyone starts on the plain input; focusing it is the user gesture that
  // runs font discovery. Where the engine can enumerate, the control then
  // upgrades to the picker - popped open when the swap happens under focus,
  // so the interaction continues without a second click.
  const inputFocusedRef = useRef(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={t("settings.appearance.fontFamily.familyAriaLabel", { title })}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocusedRef.current}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={t("settings.appearance.fontFamily.familyAriaLabel", { title })}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          inputFocusedRef.current = true;
          discoverInstalledFonts();
        }}
        onBlur={() => {
          inputFocusedRef.current = false;
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
          }
          commitTimerRef.current = window.setTimeout(() => {
            commitTimerRef.current = null;
            commitDraft(next);
          }, 400);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            if (commitTimerRef.current !== null) {
              window.clearTimeout(commitTimerRef.current);
              commitTimerRef.current = null;
            }
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      <Select
        value={String(size.value)}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          const parsed = Number(next);
          if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
            size.onChange(parsed);
          }
        }}
      >
        <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={size.label}>
          <SelectValue>{size.value} px</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
            (px) => (
              <SelectItem hideIndicator key={px} value={String(px)}>
                {px} px
              </SelectItem>
            ),
          )}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    >
      {preview}
    </SettingsRow>
  );
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
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

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
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
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

// The legacy rows sit behind the fold, so a settings-search jump has to
// expand the section before its target can mount and scroll.
const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-plan-mode",
  "legacy-context-window-indicator",
]);

/**
 * Retired features kept only for users who still depend on them. Collapsed by
 * default so they stay out of the everyday settings path; a settings-search
 * jump to one of the rows unfolds the section.
 */
function LegacyFeaturesSection() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>("legacy-features");
  // Unfold once per search jump; tracking the handled id lets the user fold
  // the section back up without the still-set target immediately reopening it.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      // A handled jump clears the target; forgetting it here lets a later
      // jump to the same row expand the section again.
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
          </SettingsGroup>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function GeneralSettingsPanel() {
  const { t } = useI18n();
  const copy = useSettingsPanelCopy();
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
  const { scope, environment, connectedEnvironments, target } = useSettingsScope();
  // The representative environment supplies the provider list for pickers;
  // a fanned-out model choice is validated against every target before it
  // is written. Per-machine tuning (background activity overrides) still
  // needs exactly one environment.
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const mixedSmoothOutputMode = useScopedSettingsMixed(["smoothOutputMode"]);
  const mixedSmoothOutputLineMode = useScopedSettingsMixed(["smoothOutputLineMode"]);
  const mixedSmoothTextFadeDuration = useScopedSettingsMixed(["smoothTextFadeDurationMs"]);
  const mixedSmoothTextYieldDuration = useScopedSettingsMixed(["smoothTextYieldDurationMs"]);
  const mixedConversationStructure = useScopedSettingsMixed(["conversationStructure"]);
  // Smooth output animates the restructured timeline only; the current layout
  // already animates the same growing body, and two clocks would compete.
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

  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
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
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedScratchBaseDirectory = useScopedSettingsMixed(["scratchBaseDirectory"]);
  const languageLabels = {
    system: t("settings.language.system"),
    en: t("settings.language.english"),
    "zh-CN": t("settings.language.simplifiedChinese"),
  };
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? t(ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION_KEY, {
          profile: t(BACKGROUND_ACTIVITY_PROFILE_LABEL_KEYS[activeBackgroundActivityProfile]),
        })
      : t(BACKGROUND_ACTIVITY_PROFILE_DESCRIPTION_KEYS[resolvedBackgroundActivity.profile]);
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsPageContainer>
      <SettingsRowCopyProvider copy={copy}>
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
            description="Order of projects in the sidebar project picker and command palette."
            resetAction={
              settings.sidebarProjectSortOrder !==
              DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
                <SettingResetButton
                  label="project order"
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
                <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Project order">
                  <SelectValue>
                    {SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SidebarProjectSortOrder.literals.map((sortOrder) => (
                    <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                      {SIDEBAR_PROJECT_SORT_ORDER_LABELS[sortOrder]}
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
                    {t(TIMESTAMP_FORMAT_LABEL_KEYS.locale)}
                  </SelectItem>
                  <SelectItem hideIndicator value="12-hour">
                    {t(TIMESTAMP_FORMAT_LABEL_KEYS["12-hour"])}
                  </SelectItem>
                  <SelectItem hideIndicator value="24-hour">
                    {t(TIMESTAMP_FORMAT_LABEL_KEYS["24-hour"])}
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
                    {t(DIFF_LAYOUT_LABEL_KEYS.stacked)}
                  </SelectItem>
                  <SelectItem hideIndicator value="split">
                    {t(DIFF_LAYOUT_LABEL_KEYS.split)}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            {...searchableSetting("proactive-panels", t)}
            description="Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines."
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
                aria-label={t("settings.general.richText.ariaLabel")}
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
            description={`${t("settings.general.followUpBehavior.description")} ${
              settings.sendShortcut === "mod-enter-multiline"
                ? t("settings.general.followUpBehavior.oppositeSingleAndMultiline", {
                    modifier: modifierLabel,
                  })
                : t("settings.general.followUpBehavior.opposite", {
                    modifier: modifierLabel,
                    shift: settings.sendShortcut === "mod-enter" ? " + Shift" : "",
                  })
            }`}
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
                    {settings.followUpBehavior === "queue" ? "Queue" : "Steer"}
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
            description="Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear."
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

          <SettingsRow
            serverScoped
            settingKeys={["backgroundActivity"]}
            id={searchableSetting("background-activity", t).id}
            title={
              <span className="inline-flex items-center gap-1.5">
                {searchableSetting("background-activity", t).title}
                <PolicyTooltip
                  detailsLabel={t("settings.general.backgroundActivity.policyDetailsLabel")}
                >
                  {t("settings.general.backgroundActivity.tooltip")}
                </PolicyTooltip>
              </span>
            }
            description={backgroundActivityDescription}
            resetAction={
              canResetBackgroundActivity ? (
                <SettingResetButton
                  label={t("settings.general.backgroundActivity.resetLabel")}
                  onClick={() => updateSettings(resetBackgroundActivitySettings())}
                />
              ) : null
            }
            control={
              <>
                <Select
                  value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
                  onValueChange={(value) => {
                    if (value === "advanced") {
                      if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                      return;
                    }
                    if (
                      value === "balanced" ||
                      value === "performance" ||
                      value === "battery-saver"
                    ) {
                      updateSettings(backgroundActivityProfileSettings(value));
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full sm:w-40"
                    aria-label={t("settings.general.backgroundActivity.ariaLabel")}
                  >
                    <SelectValue>
                      {(value: BackgroundActivityProfileOption | null) =>
                        value === null
                          ? t("settings.general.backgroundActivity.mixedValue")
                          : t(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABEL_KEYS[value])
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="balanced">
                      {t("settings.general.backgroundActivity.balanced")}
                    </SelectItem>
                    <SelectItem hideIndicator value="performance">
                      {t("settings.general.backgroundActivity.performance")}
                    </SelectItem>
                    <SelectItem hideIndicator value="battery-saver">
                      {t("settings.general.backgroundActivity.batterySaver")}
                    </SelectItem>
                    <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                      {isEnvironmentScope
                        ? t("settings.general.backgroundActivity.advanced")
                        : t("settings.general.backgroundActivity.advancedOneEnvironment")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
                {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label={t("settings.general.backgroundActivity.configureAriaLabel")}
                          onClick={() => setBackgroundActivityDialogOpen(true)}
                        >
                          <SettingsIcon className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">
                      {t("settings.general.backgroundActivity.configureTooltip")}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                <BackgroundActivityAdvancedDialog
                  open={backgroundActivityDialogOpen && isEnvironmentScope}
                  onOpenChange={setBackgroundActivityDialogOpen}
                />
              </>
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
                  label={t("settings.general.startFromOrigin.resetLabel")}
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
                aria-label={t("settings.general.startFromOrigin.ariaLabel")}
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
                    <SelectValue>
                      {t(QUIT_CONFIRMATION_MODE_LABEL_KEYS[settings.confirmQuit])}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(["direct", "hold", "double-click"] as const).map((value) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {t(QUIT_CONFIRMATION_MODE_LABEL_KEYS[value])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
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
                      models={
                        // Use the exact instance's models (rather than the
                        // first-kind-match) so a custom text-gen instance like
                        // `codex_personal` gets its own model list, not the
                        // default Codex one.
                        textGenInstanceEntry?.models ?? []
                      }
                      model={textGenModel}
                      prompt=""
                      onPromptChange={() => {}}
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
                id={searchableSetting("app-version", t).id}
                title={<AboutVersionTitle version={APP_VERSION} />}
                description={t("settings.general.version.description")}
              />
              {IS_NIGHTLY_BUILD ? <NightlyMobileBetaRow /> : null}
            </>
          )}
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
      </SettingsRowCopyProvider>
    </SettingsPageContainer>
  );
}

function formatArchivedRelativeTime(isoDate: string, t: ReturnType<typeof useI18n>["t"]): string {
  const relative = getRelativeTimeState(isoDate);
  if (relative.status !== "relative") return "";
  const match = /^(\d+)([mhd])$/.exec(relative.value);
  if (!match) return t("settings.archive.relative.justNow");
  const key =
    match[2] === "m"
      ? "settings.archive.relative.minutes"
      : match[2] === "h"
        ? "settings.archive.relative.hours"
        : "settings.archive.relative.days";
  return t(key, { count: Number(match[1]) });
}

export function ArchivedThreadsPanel() {
  const { t } = useI18n();
  const { scope } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const archivedGroups = useMemo(() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots, scope]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: t("settings.archive.unarchive") },
          { id: "delete", label: t("settings.archive.delete"), destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("settings.archive.unarchiveFailed"),
              description:
                error instanceof Error ? error.message : t("settings.archive.errorOccurred"),
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("settings.archive.deleteFailed"),
              description:
                error instanceof Error ? error.message : t("settings.archive.errorOccurred"),
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread, t],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive", t).id}
          title={searchableSetting("archive", t).title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? t("settings.archive.loading")
                  : archiveError
                    ? t("settings.archive.loadFailed")
                    : t("settings.archive.empty")}
              </span>
            }
            description={
              isLoadingArchive
                ? t("settings.archive.checking")
                : (archiveError ?? t("settings.archive.emptyDescription"))
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
            id={index === 0 ? searchableSetting("archive", t).id : undefined}
            title={project.title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: t("settings.archive.actionFailed"),
                          description:
                            error instanceof Error
                              ? error.message
                              : t("settings.archive.errorOccurred"),
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <>
                    {t("settings.archive.archivedAt", {
                      value: formatArchivedRelativeTime(thread.archivedAt ?? thread.createdAt, t),
                    })}
                    {" · "}
                    {t("settings.archive.createdAt", {
                      value: formatArchivedRelativeTime(thread.createdAt, t),
                    })}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: t("settings.archive.unarchiveFailed"),
                              description:
                                error instanceof Error
                                  ? error.message
                                  : t("settings.archive.errorOccurred"),
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>{t("settings.archive.unarchive")}</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
