import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useI18n } from "../../i18n/I18nProvider";
import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_MESSAGE_KEYS, type SettingsTranslator } from "./settingsSearch";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

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

export interface SettingsScopeBreadcrumbProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly onChange: (next: SettingsScopeSearch) => void;
}

/**
 * `Settings / Section / Environment / Project`. The last two crumbs are the
 * targets a change applies to and read like the usage page's filter: muted at
 * "all", foreground once narrowed. A project is the same project on every
 * environment, so the environment crumb alone decides where a project
 * override is written.
 */
export function SettingsBreadcrumb({
  pathname,
  scope,
}: {
  pathname: string;
  scope?: SettingsScopeBreadcrumbProps | undefined;
}) {
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
      {scope ? (
        <>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem className="min-w-0 shrink">
            <EnvironmentScopeMenu {...scope} />
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem className="min-w-0 shrink">
            <ProjectScopeMenu {...scope} />
          </WorkspaceBreadcrumbItem>
        </>
      ) : null}
    </WorkspaceBreadcrumb>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  narrowed,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  narrowed: boolean;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex min-w-0 max-w-56 cursor-pointer items-center gap-1.5 rounded-sm text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          narrowed ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        {children}
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
}: SettingsScopeBreadcrumbProps) {
  const { t } = useI18n();
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  return (
    <ScopeMenu
      ariaLabel={t("settings.scope.environmentAriaLabel")}
      narrowed={environmentValue !== ALL_ENVIRONMENTS_VALUE}
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? t("settings.scope.unavailableEnvironment")
            : t("settings.scope.allEnvironments")
      }
    >
      <MenuRadioGroup
        value={environmentValue}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectEnvironmentAxis(value, next));
        }}
      >
        <MenuRadioItem value={ALL_ENVIRONMENTS_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <LayersIcon aria-hidden className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{t("settings.scope.allEnvironments")}</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
        <MenuSeparator />
        {environments.map((environment) => (
          <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                className="size-3.5"
              />
              <span className="min-w-0 flex-1 truncate">
                {settingsScopeEnvironmentLabel(environment, environments)}
              </span>
              {environment.connection.phase === "connected" ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("settings.scope.offline")}
                </span>
              )}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </ScopeMenu>
  );
}

function ProjectScopeMenu({ value, groups, onChange }: SettingsScopeBreadcrumbProps) {
  const { t } = useI18n();
  const selected = groups.find((group) => group.projectKey === value.project);
  return (
    <ScopeMenu
      ariaLabel={t("settings.scope.projectAriaLabel")}
      narrowed={value.project !== undefined}
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={
        selected?.displayName ??
        (value.project ? t("settings.scope.unavailableProject") : t("settings.scope.allProjects"))
      }
    >
      <MenuRadioGroup
        value={projectAxisValue(value)}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectProjectAxis(value, next));
        }}
      >
        <MenuRadioItem value={ALL_PROJECTS_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{t("settings.scope.allProjects")}</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
        <MenuSeparator />
        {groups.map((group) => (
          <MenuRadioItem key={group.projectKey} value={group.projectKey}>
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={group} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </ScopeMenu>
  );
}
