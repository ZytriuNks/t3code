import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_FILE_BACKED_SETTINGS,
  type ProjectFileBackedSettingKey,
  resolveEnvironmentMachineKind,
  type ServerSettings,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { CheckIcon, LayersIcon } from "lucide-react";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ProjectOverrideEntry, ScopedSettingsTarget } from "./scopedSettings";
import { isProjectScopedSettingKey } from "./scopedSettings";

interface InheritanceLayer {
  readonly key: "project" | "environment" | "t3.json" | "built-in";
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

/**
 * Words and value formatters for the resolution chain. Pages that translate
 * themselves provide a copy; every other page keeps the defaults below, so its
 * popover renders exactly as it did before.
 */
export interface SettingInheritanceCopy {
  /**
   * Labels a stored string setting value before the chain renders it. Pages
   * that translate an enum setting provide a mapping; the identity default
   * keeps the stored value, so single-language pages render as before.
   */
  readonly settingValueLabel?: (key: keyof ServerSettings, value: string) => string;
  readonly layerProject: string;
  readonly layerEnvironment: string;
  readonly layerDefault: string;
  readonly inherits: string;
  readonly on: string;
  readonly off: string;
  readonly dayCount: (count: number) => string;
  readonly lastSelected: string;
  readonly never: string;
  readonly automatic: string;
  readonly textGenerationModel: string;
  readonly notSet: string;
  readonly empty: string;
  readonly itemCount: (count: number) => string;
  readonly custom: string;
  readonly envModeLocal: string;
  readonly envModeWorktree: string;
  readonly overriddenBy: string;
  readonly resetOverride: (count: number) => string;
  readonly projectOverrideSummary: (summary: string, count: number) => string;
  readonly showSourceLabel: (summary: string) => string;
}

export const SETTING_INHERITANCE_COPY_DEFAULTS: SettingInheritanceCopy = {
  settingValueLabel: (key, value) =>
    key === "worktreeSubmodules" && value in WORKTREE_SUBMODULES_LABELS
      ? WORKTREE_SUBMODULES_LABELS[value as WorktreeSubmodules]
      : value,
  layerProject: "Project",
  layerEnvironment: "Environment",
  layerDefault: "Default",
  inherits: "Inherits",
  on: "On",
  off: "Off",
  dayCount: (count) => `${count} ${count === 1 ? "day" : "days"}`,
  lastSelected: "Last selected",
  never: "Never",
  automatic: "Automatic",
  textGenerationModel: "Text generation model",
  notSet: "Not set",
  empty: "Empty",
  itemCount: (count) => `${count} ${count === 1 ? "item" : "items"}`,
  custom: "Custom",
  envModeLocal: "Current checkout",
  envModeWorktree: "New worktree",
  overriddenBy: "Overridden by",
  resetOverride: (count) => (count === 1 ? "Reset it" : "Reset all"),
  projectOverrideSummary: (summary, count) =>
    `${summary} · ${count} project ${count === 1 ? "override" : "overrides"}`,
  showSourceLabel: (summary) => `${summary}. Show where this value comes from`,
};

const WRITING_STYLE_LABELS: Record<string, string> = {
  repo_conventions: "Repository conventions",
  conventional_commits: "Conventional Commits",
  custom: "Custom instructions",
};

/** Human labels for the values the chain can show; falls back to a type summary. */
function formatValue(
  key: keyof ServerSettings,
  value: unknown,
  copy: SettingInheritanceCopy,
): string {
  if (value === null || value === undefined) {
    return key === "pullRequestMergeMethod"
      ? copy.lastSelected
      : key === "sidebarAutoSettleAfterDays"
        ? copy.never
        : key === "defaultModelSelection"
          ? copy.automatic
          : key === "sourceControlWriterModelSelection"
            ? copy.textGenerationModel
            : key === "defaultThreadEnvMode" || key === "worktreeSubmodules"
              ? copy.inherits
              : copy.notSet;
  }
  if (typeof value === "boolean") return value ? copy.on : copy.off;
  if (typeof value === "number") {
    return key === "sidebarAutoSettleAfterDays" ? copy.dayCount(value) : String(value);
  }
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return value === "worktree" ? copy.envModeWorktree : copy.envModeLocal;
    }
    if (key === "pullRequestMergeMethod" && value in PULL_REQUEST_MERGE_METHOD_LABELS) {
      return PULL_REQUEST_MERGE_METHOD_LABELS[
        value as keyof typeof PULL_REQUEST_MERGE_METHOD_LABELS
      ];
    }
    if (value === "") return copy.empty;
    return copy.settingValueLabel?.(key, value) ?? value;
  }
  if (Array.isArray(value)) return copy.itemCount(value.length);
  if (typeof value === "object") {
    if ("model" in value && typeof value.model === "string") return value.model;
    if ("mode" in value && typeof value.mode === "string") {
      return WRITING_STYLE_LABELS[value.mode] ?? value.mode;
    }
  }
  return copy.custom;
}

/**
 * The layers a setting resolves through for one target, top-down: the
 * project override when the target is a project, the environment's value,
 * the checkout's t3.json for file-backed keys, and the built-in default. The
 * first layer that is set wins. Same order as `resolveProjectSettings`.
 */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  environmentSettings: ServerSettings,
  key: keyof ServerSettings,
  copy: SettingInheritanceCopy = SETTING_INHERITANCE_COPY_DEFAULTS,
): readonly InheritanceLayer[] {
  const environmentValue = environmentSettings[key];
  const source = isProjectScopedSettingKey(key) ? target.sources[key] : "environment";
  const environmentSet = !Equal.equals(environmentValue, DEFAULT_SERVER_SETTINGS[key]);
  const fileBacked = isProjectFileBackedSettingKey(key);
  const layers: InheritanceLayer[] = [];
  if (target.projectId !== null && isProjectScopedSettingKey(key)) {
    layers.push({
      key: "project",
      label: copy.layerProject,
      value: source === "project" ? formatValue(key, target.settings[key], copy) : copy.inherits,
      effective: source === "project",
      set: source === "project",
    });
  }
  layers.push({
    key: "environment",
    label: target.label,
    value: environmentSet ? formatValue(key, environmentValue, copy) : copy.inherits,
    effective: source === "environment" && environmentSet,
    set: environmentSet,
  });
  if (fileBacked && target.projectId !== null) {
    layers.push({
      key: "t3.json",
      label: "t3.json",
      value: source === "t3.json" ? formatValue(key, target.settings[key], copy) : copy.inherits,
      effective: source === "t3.json",
      set: source === "t3.json",
    });
  }
  // For a file-backed key the built-in is what the resolver produced with
  // nothing set, not the null the schema decodes to.
  const builtIn = fileBacked
    ? PROJECT_FILE_BACKED_SETTINGS[key].builtIn
    : DEFAULT_SERVER_SETTINGS[key];
  layers.push({
    key: "built-in",
    label: copy.layerDefault,
    value: formatValue(key, builtIn, copy),
    effective: source === "environment" && !environmentSet,
    set: true,
  });
  return layers;
}

function isProjectFileBackedSettingKey(
  key: keyof ServerSettings,
): key is ProjectFileBackedSettingKey {
  return Object.hasOwn(PROJECT_FILE_BACKED_SETTINGS, key);
}

export type SettingInheritanceState =
  | "default"
  | "environment"
  | "inherited"
  | "overridden"
  | "mixed";

/**
 * A small indicator beside a row's title that opens a top-down view of where
 * the setting's value comes from on each selected target. It sits inline so
 * narrowing to a project does not add a caption line to every row.
 */
export interface SettingOverridingProject extends ProjectOverrideEntry {
  readonly label: string;
  /** Jumps the breadcrumb to this project so its override can be edited. */
  readonly open: () => void;
}

export function SettingInheritance({
  state,
  summary,
  targets,
  environments,
  keys,
  overridingProjects = [],
  onClearOverrides,
  copy = SETTING_INHERITANCE_COPY_DEFAULTS,
}: {
  state: SettingInheritanceState;
  summary: string;
  targets: readonly ScopedSettingsTarget[];
  environments: readonly Pick<EnvironmentPresentation, "environmentId" | "serverConfig">[];
  keys: readonly (keyof ServerSettings)[];
  /** At environment scope: projects whose own value hides the environment's. */
  overridingProjects?: readonly SettingOverridingProject[];
  onClearOverrides?: (entries: readonly ProjectOverrideEntry[]) => void;
  /** Localized words for the chain; defaults keep the English copy. */
  copy?: SettingInheritanceCopy;
}) {
  const key = keys[0];
  if (!key || targets.length === 0) return null;
  const overrideSummary =
    overridingProjects.length > 0
      ? copy.projectOverrideSummary(summary, overridingProjects.length)
      : summary;
  const chains = targets.flatMap((target) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === target.environmentId,
    );
    if (!environment?.serverConfig) return [];
    return [
      {
        target,
        environment: { ...environment, serverConfig: environment.serverConfig },
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        layers: settingInheritanceLayers(target, environment.serverConfig.settings, key, copy),
      },
    ];
  });
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={copy.showSourceLabel(overrideSummary)}
                />
              }
            />
          }
        >
          <LayersIcon
            className={cn(
              "size-3",
              state === "overridden" && "text-primary",
              state === "mixed" && "text-warning",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{overrideSummary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="md" padding="none">
        <div className="divide-y divide-border/60">
          {chains.map(({ target, environment, machine, layers }) => (
            <section
              key={`${target.environmentId}:${target.projectId ?? ""}`}
              className="px-3 py-2.5"
            >
              <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
                <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{target.label}</span>
              </h4>
              <ol role="list" className="text-sm">
                {layers.map((layer) => (
                  <li
                    key={layer.key}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                      layer.effective && "bg-foreground/[0.06]",
                    )}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {layer.key === "environment" ? copy.layerEnvironment : layer.label}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 tabular-nums",
                        layer.effective
                          ? "text-foreground"
                          : layer.set
                            ? "text-muted-foreground"
                            : "text-muted-foreground/60",
                      )}
                    >
                      <span className="max-w-32 truncate">{layer.value}</span>
                      {layer.effective ? (
                        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span aria-hidden className="size-3.5 shrink-0" />
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              {(() => {
                const overriding = overridingProjects.filter(
                  (project) => project.environmentId === target.environmentId,
                );
                if (overriding.length === 0) return null;
                const overrides = environment.serverConfig.settings.projectSettingsOverrides;
                return (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
                      <span>{copy.overriddenBy}</span>
                      {onClearOverrides ? (
                        <InlineButton onClick={() => onClearOverrides(overriding)}>
                          {copy.resetOverride(overriding.length)}
                        </InlineButton>
                      ) : null}
                    </div>
                    <ul role="list" className="mt-0.5 text-sm">
                      {overriding.map((project) => (
                        <li
                          key={project.projectId}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1"
                        >
                          <InlineButton className="min-w-0 justify-start" onClick={project.open}>
                            <span className="truncate">{project.label}</span>
                          </InlineButton>
                          <span className="max-w-32 truncate text-muted-foreground tabular-nums">
                            {isProjectScopedSettingKey(key)
                              ? formatValue(key, overrides[project.projectId]?.[key], copy)
                              : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
            </section>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
