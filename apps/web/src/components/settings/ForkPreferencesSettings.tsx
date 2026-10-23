import { useI18n } from "../../i18n/I18nProvider";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ForkSidebarPreferences() {
  const { t } = useI18n();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const statusMode = settings.legacySidebarThreadStatusDots
    ? settings.legacySidebarHideStatusLabels
      ? "dots"
      : "labels"
    : "off";

  return (
    <SettingsSection id="sidebar-appearance" title={t("settings.appearance.sidebar.title")}>
      <SettingsRow
        {...searchableSetting("legacy-sidebar", t)}
        description={t("settings.appearance.sidebar.description")}
        control={
          <Select
            value={settings.legacySidebarEnabled ? "legacy" : "default"}
            onValueChange={(value) => {
              if (value === "legacy" || value === "default")
                update({ legacySidebarEnabled: value === "legacy" });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-auto"
              aria-label={t("settings.search.item.legacy-sidebar.title")}
            >
              <SelectValue>
                {t(
                  settings.legacySidebarEnabled
                    ? "settings.appearance.sidebar.option.legacy"
                    : "settings.appearance.sidebar.option.default",
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="default">
                {t("settings.appearance.sidebar.option.default")}
              </SelectItem>
              <SelectItem value="legacy">
                {t("settings.appearance.sidebar.option.legacy")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {settings.legacySidebarEnabled ? (
        <>
          <SettingsRow
            {...searchableSetting("legacy-sidebar-project-guides", t)}
            description={t("settings.appearance.sidebarProjectGuides.description")}
            control={
              <Switch
                checked={settings.legacySidebarProjectGuides}
                onCheckedChange={(value) => update({ legacySidebarProjectGuides: Boolean(value) })}
                aria-label={t("settings.search.item.legacy-sidebar-project-guides.title")}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("legacy-sidebar-thread-status-dots", t)}
            description={t("settings.appearance.sidebarThreadStatusDots.description")}
            control={
              <Select
                value={statusMode}
                onValueChange={(value) => {
                  if (value === "off" || value === "labels" || value === "dots")
                    update({
                      legacySidebarThreadStatusDots: value !== "off",
                      legacySidebarHideStatusLabels: value === "dots",
                    });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto"
                  aria-label={t("settings.search.item.legacy-sidebar-thread-status-dots.title")}
                >
                  <SelectValue>
                    {t(
                      statusMode === "dots"
                        ? "settings.appearance.sidebarThreadStatusDots.dots"
                        : statusMode === "labels"
                          ? "settings.appearance.sidebarThreadStatusDots.labels"
                          : "settings.appearance.sidebarThreadStatusDots.off",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="off">
                    {t("settings.appearance.sidebarThreadStatusDots.off")}
                  </SelectItem>
                  <SelectItem value="labels">
                    {t("settings.appearance.sidebarThreadStatusDots.labels")}
                  </SelectItem>
                  <SelectItem value="dots">
                    {t("settings.appearance.sidebarThreadStatusDots.dots")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
