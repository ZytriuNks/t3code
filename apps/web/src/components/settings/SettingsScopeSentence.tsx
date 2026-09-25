import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { InlineButton } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useI18n } from "../../i18n/I18nProvider";
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

/** Pages whose every row is saved on this client; they have no scope to pick. */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/snap-shot",
  "/settings/connections",
]);

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly onChange: (next: SettingsScopeSearch) => void;
}

/**
 * "Applying settings for <project> across <environment>" at the top of a settings
 * page. The two pickers are the targets a change is written to. A project is
 * the same project on every environment, so the environment alone decides
 * where a project override is written.
 */
export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const { t } = useI18n();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
      {/* Each connective stays with its picker so a wrap never strands "on". */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{t("settings.scope.applyingSettingsFor")}</span>
        <ProjectScopeMenu {...props} t={t} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">
          {/* A legacy checkout link names one environment without `machine`. */}
          {scope.search.machine || scope.scope.kind === "checkout"
            ? t("settings.scope.on")
            : t("settings.scope.across")}
        </span>
        <EnvironmentScopeMenu {...props} t={t} />
      </span>
    </p>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${ariaLabel}: ${label}`}
        render={<InlineButton tone="picker" />}
        className="min-w-0 max-w-72"
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">{children}</MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  t,
}: SettingsScopeMenuProps & { readonly t: ReturnType<typeof useI18n>["t"] }) {
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

function ProjectScopeMenu({
  value,
  groups,
  onChange,
  t,
}: SettingsScopeMenuProps & { readonly t: ReturnType<typeof useI18n>["t"] }) {
  const selected = groups.find((group) => group.projectKey === value.project);
  return (
    <ScopeMenu
      ariaLabel={t("settings.scope.projectAriaLabel")}
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
