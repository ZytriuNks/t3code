import { XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { useI18n } from "../i18n/I18nProvider";
import { SidebarMenuSubItem, useSidebar } from "./ui/sidebar";
import { cn } from "../lib/utils";
import { readThreadShells } from "../state/entities";
import { filterSidebarVisibleThreads } from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { buildThreadRouteParams } from "../threadRoutes";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

export function LegacySidebarDraftRow(props: { draftId: DraftId; isActive: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <button
        type="button"
        data-active={props.isActive}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        aria-current={props.isActive ? "page" : undefined}
        data-testid={`sidebar-draft-${props.draftId}`}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void navigate({ to: "/draft/$draftId", params: { draftId: props.draftId } });
        }}
      >
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          <span className="size-1.5 rounded-full border border-sidebar-muted-foreground/15" />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("sidebar.newThread")}</span>
        <span aria-hidden="true" className="w-4 shrink-0" />
      </button>
      <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("sidebar.closeDraft")}
                className="inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  void (async () => {
                    if (props.isActive) {
                      const nextThread = sortThreads(
                        filterSidebarVisibleThreads(readThreadShells()),
                        "updated_at",
                      )[0];
                      if (nextThread) {
                        await navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(nextThread.environmentId, nextThread.id),
                          ),
                          replace: true,
                        });
                      }
                    }
                    releaseComposerDraftUploads(props.draftId);
                    useComposerDraftStore.getState().clearDraftThread(props.draftId);
                  })().catch(() => {
                    toastManager.add({ type: "error", title: t("sidebar.closeDraftFailed") });
                  });
                }}
              />
            }
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{t("sidebar.closeDraft")}</TooltipPopup>
        </Tooltip>
      </div>
    </SidebarMenuSubItem>
  );
}
