import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
} from "./chat/threadDetailsPanelStyles";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceDisplayName,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useI18n } from "../i18n/I18nProvider";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  workspaceRoot?: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  displayMode?: "toolbar" | "panel";
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  workspaceRoot = null,
  onEnvModeChange,
  displayMode = "toolbar",
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const { t } = useI18n();
  const workspacePath = displayMode === "panel" ? (activeWorktreePath ?? workspaceRoot) : null;
  const workspaceDisplayName = resolveWorkspaceDisplayName(workspacePath);
  const workspaceKind = activeWorktreePath ? "Worktree" : "Project folder";
  const composerFloatingLayerProps = useComposerMenuProps();
  const currentWorkspaceLabel = activeWorktreePath
    ? t("toolbar.workspace.currentWorktree")
    : t("settings.general.workspace.mode.local");
  const worktreeLabel = t("settings.general.workspace.mode.worktree");
  const lockedWorkspaceLabel = activeWorktreePath
    ? t("toolbar.workspace.worktree")
    : t("toolbar.workspace.localCheckout");
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(
    () => [
      { value: "local", label: workspaceDisplayName ?? currentWorkspaceLabel },
      { value: "worktree", label: worktreeLabel },
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
    ],
    [
      currentWorkspaceLabel,
      previousWorktreeLabel,
      showPreviousWorktree,
      workspaceDisplayName,
      worktreeLabel,
    ],
  );

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(2)-1px)] font-normal text-muted-foreground/70 text-xs sm:h-6",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
      >
        {forceNewWorktree ? (
          <FolderGit2Icon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : activeWorktreePath ? (
          <FolderGitIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : (
          <FolderIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        )}
        <ComposerContextLabel displayMode={displayMode}>
          {forceNewWorktree ? worktreeLabel : (workspaceDisplayName ?? lockedWorkspaceLabel)}
        </ComposerContextLabel>
        {displayMode === "panel" ? (
          <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
            {forceNewWorktree ? "Worktree" : workspaceKind}
          </span>
        ) : null}
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger
          render={<span />}
          className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
          data-composer-context-control
        >
          {activeWorktreePath ? (
            <FolderGitIcon className="size-3 shrink-0" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3 shrink-0" />
          ) : (
            <FolderIcon className="size-3 shrink-0" />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsSelectControl
              panel={displayMode === "panel"}
              className="min-w-0 shrink"
              aria-label={t("toolbar.workspace.title")}
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
            />
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          ) : activeWorktreePath ? (
            <FolderGitIcon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          ) : (
            <FolderIcon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              <SelectValue />
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {workspacePath ??
            (effectiveEnvMode === "worktree"
              ? resolveEnvModeLabel("worktree")
              : resolveCurrentWorkspaceLabel(activeWorktreePath))}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
        {...composerFloatingLayerProps}
      >
        <SelectGroup>
          <SelectGroupLabel>{t("toolbar.workspace.title")}</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {currentWorkspaceLabel}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {worktreeLabel}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
