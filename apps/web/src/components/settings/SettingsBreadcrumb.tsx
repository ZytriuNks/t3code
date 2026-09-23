import { useI18n } from "../../i18n/I18nProvider";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_MESSAGE_KEYS, type SettingsTranslator } from "./settingsSearch";

const SETTINGS_BREADCRUMB_MESSAGE_KEYS = {
  ...SETTINGS_SECTION_MESSAGE_KEYS,
  "/settings/diagnostics": "settings.header.diagnostics",
  "/settings/open-source-licenses": "settings.header.openSourceLicenses",
} as const;

function settingsBreadcrumbLabel(pathname: string, t: SettingsTranslator): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const key =
    SETTINGS_BREADCRUMB_MESSAGE_KEYS[
      normalizedPathname as keyof typeof SETTINGS_BREADCRUMB_MESSAGE_KEYS
    ];
  return key ? t(key) : null;
}

/**
 * `Settings / Section`. The scope a change applies to lives at the top of the
 * page content, see `SettingsScopeSentence`.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { t } = useI18n();
  const sectionLabel = settingsBreadcrumbLabel(pathname, t);
  const settingsLabel = t("settings.header.settings");

  return (
    <WorkspaceBreadcrumb ariaLabel={t("settings.header.breadcrumbLabel")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{settingsLabel}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? settingsLabel}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
