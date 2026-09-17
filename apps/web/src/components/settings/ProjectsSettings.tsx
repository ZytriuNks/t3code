import { useI18n } from "../../i18n/I18nProvider";
import { EnvironmentId } from "@t3tools/contracts";

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

/** Project identity and checkout management for the selected project. */
export function ProjectsSettings() {
  const { t } = useI18n();
  const { search: value, scope } = useSettingsScope();
  // The panel follows remembered members when grouping replaces a project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
        />
      ) : scope.kind === "unavailable" ? (
        <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>
      ) : (
        <SettingsScopeNotice target="project">
          {t("settings.project.chooseProjectToManage")}
        </SettingsScopeNotice>
      )}
    </div>
  );
}
