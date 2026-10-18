import type { StorageCleanupSettings, WorktreeCleanupRules } from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useI18n } from "../../i18n/I18nProvider";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function RetentionControl({
  label,
  daysLabel,
  decreaseLabel,
  increaseLabel,
  inDaysLabel,
  offLabel,
  value,
  onChange,
}: {
  label: string;
  daysLabel: string;
  decreaseLabel: string;
  increaseLabel: string;
  inDaysLabel: string;
  offLabel: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={1}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(1, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={decreaseLabel} />
            <NumberFieldInput
              aria-label={inDaysLabel}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {daysLabel}
            </span>
            <NumberFieldIncrement aria-label={increaseLabel} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{offLabel}</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { t } = useI18n();
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? t("settings.storage.mixedAcrossMachines")
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);
  const retentionControlCopy = (label: string) => ({
    label,
    daysLabel: t("settings.storage.days"),
    decreaseLabel: t("settings.storage.decrease", { label }),
    increaseLabel: t("settings.storage.increase", { label }),
    inDaysLabel: t("settings.storage.inDays", { label }),
    offLabel: t("settings.storage.off"),
  });

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        {t("settings.storage.inheritProjectCleanup")}
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        {t("settings.storage.chooseSupportedEnvironment")}
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-worktrees" title={t("settings.storage.worktrees.title")}>
        {isProjectScope && (
          <SettingsRow
            title={t("settings.storage.automaticCleanup.title")}
            description={
              mode === "off"
                ? t("settings.storage.automaticCleanup.keepDescription")
                : mode === "custom"
                  ? t("settings.storage.automaticCleanup.customDescription")
                  : t("settings.storage.automaticCleanup.inheritDescription")
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <SelectTrigger size="sm" aria-label={t("settings.storage.automaticCleanup.title")}>
                  <SelectValue>
                    {mixedModes
                      ? t("settings.storage.mode.mixed")
                      : mode === "inherit"
                        ? t("settings.storage.mode.inherit")
                        : mode === "off"
                          ? t("settings.storage.mode.off")
                          : t("settings.storage.mode.custom")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">{t("settings.storage.mode.inherit")}</SelectItem>
                  <SelectItem value="off">{t("settings.storage.mode.off")}</SelectItem>
                  <SelectItem value="custom">{t("settings.storage.mode.custom")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title={t("settings.storage.worktreeOnDelete.title")}
              status={ruleStatus("worktreeOnDelete")}
              description={t("settings.storage.worktreeOnDelete.description")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storage.worktreeOnDelete.title")}
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storage.worktreeAfterDays.title")}
              status={ruleStatus("worktreeAfterDays")}
              description={t("settings.storage.worktreeAfterDays.description")}
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  {...retentionControlCopy(t("settings.storage.worktreeAfterDays.title"))}
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storage.worktreeOnMerge.title")}
              status={ruleStatus("worktreeOnMerge")}
              description={t("settings.storage.worktreeOnMerge.description")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storage.worktreeOnMerge.title")}
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storage.worktreeUnchanged.title")}
              status={ruleStatus("worktreeUnchanged")}
              description={t("settings.storage.worktreeUnchanged.description")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storage.worktreeUnchanged.title")}
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
          </>
        )}
      </SettingsSection>

      {!isProjectScope && (
        <SettingsSection id="storage-artifacts" title={t("settings.storage.artifacts.title")}>
          <SettingsRow
            title={t("settings.storage.browserArtifacts.title")}
            status={ruleStatus("browserArtifactsAfterDays")}
            description={t("settings.storage.browserArtifacts.description")}
            serverScoped
            control={
              <RetentionControl
                {...retentionControlCopy(t("settings.storage.browserArtifacts.title"))}
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
              />
            }
          />
          <SettingsRow
            title={t("settings.storage.logs.title")}
            status={ruleStatus("logsAfterDays")}
            description={t("settings.storage.logs.description")}
            serverScoped
            control={
              <RetentionControl
                {...retentionControlCopy(t("settings.storage.logs.title"))}
                value={settings.logsAfterDays}
                onChange={(logsAfterDays) => update({ logsAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
