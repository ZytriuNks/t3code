import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import {
  type MessageId,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Option from "effect/Option";
import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentThread } from "~/state/threads";
import {
  useProject,
  useThreadProjection,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";
import { cn } from "~/lib/utils";
import { deriveTimelineEntriesFromVisibleTurnItemsWithState } from "~/session-logic";
import type { TimelineEntriesProjection } from "~/session-logic";
import { Button } from "~/components/ui/button";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import type { ExpandedImagePreview as TimelineImagePreview } from "~/components/chat/ExpandedImagePreview";
import type { LegendListRef } from "@legendapp/list/react";
import { resolveSubagentModelInfo, SubagentModelInfo } from "./SubagentModelInfo";

type PanelMode = "sidebar" | "overlay";

export interface SubagentConversationPanelProps {
  threadRef: ScopedThreadRef;
  mode: PanelMode;
  title?: string;
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  closing?: boolean | undefined;
  onClosed?: (() => void) | undefined;
  onMaximize?: (() => void) | undefined;
  onOpenThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  onReadyChange?: ((ready: boolean) => void) | undefined;
}

const EMPTY_ATTACHMENT_URLS = new Map<string, string>();
const EMPTY_TURN_DIFF_SUMMARIES: readonly never[] = [];
const EMPTY_PROVIDER_STATUSES = [] as const;
const EMPTY_SKILLS = [] as const;
const NOOP = () => {};
const NOOP_RUN = (_runId: RunId, _filePath?: string) => {};
const NOOP_REVERT = (_turnCount: number, _messageId: MessageId) => {};
const NOOP_ROLLBACK = (_input: { checkpointId: string; scopeId: string }) => {};
const NOOP_IMAGE = (_preview: TimelineImagePreview) => {};

function isActiveRun(status: string | undefined): boolean {
  return status === "preparing" || status === "starting" || status === "running";
}

function ThreadPanelHeader({
  title,
  mode,
  onBack,
  onClose,
  onMaximize,
  modelInfo,
}: Pick<SubagentConversationPanelProps, "title" | "mode" | "onBack" | "onClose" | "onMaximize"> & {
  modelInfo: ReturnType<typeof resolveSubagentModelInfo>;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 px-2">
      {onBack ? (
        <Button variant="ghost" size="icon-xs" aria-label="Back to agents" onClick={onBack}>
          <ArrowLeft className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      <h2 className="min-w-0 flex-1 truncate px-1 text-xs font-semibold text-foreground">
        {title ?? "Subagent"}
      </h2>
      <SubagentModelInfo
        info={modelInfo}
        className="max-w-2/3 text-right text-3xs text-muted-foreground"
      />
      {mode === "overlay" && onMaximize ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open subagent conversation"
          onClick={onMaximize}
        >
          <Maximize2 className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      {onClose ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close subagent conversation"
          onClick={onClose}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

export function SubagentConversationPanel({
  threadRef,
  mode,
  title,
  onBack,
  onClose,
  closing = false,
  onClosed,
  onMaximize,
  onOpenThread,
  onReadyChange,
}: SubagentConversationPanelProps) {
  const shell = useThreadShell(threadRef);
  const detail = useThreadProjection(threadRef);
  const projection = detail?.projection ?? null;
  const threadState = useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  const visibleTurnItems = useThreadVisibleTurnItems(threadRef);
  const parentThreadRef = useMemo(() => {
    const parentThreadId =
      shell?.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null;
    return parentThreadId === null ? null : scopeThreadRef(threadRef.environmentId, parentThreadId);
  }, [shell?.lineage.parentThreadId, shell?.lineage.relationshipToParent, threadRef.environmentId]);
  const parentShell = useThreadShell(parentThreadRef);
  const parentProjection = useThreadProjection(parentThreadRef)?.projection ?? null;
  const project = useProject(
    shell === null ? null : scopeProjectRef(threadRef.environmentId, shell.projectId),
  );
  const { environments } = useEnvironments();
  const { resolvedTheme } = useTheme();
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const listRef = useRef<LegendListRef | null>(null);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const timelineProjection = useMemo<TimelineEntriesProjection>(
    () =>
      deriveTimelineEntriesFromVisibleTurnItemsWithState({
        visibleTurnItems,
        optimisticMessages: [],
        anchoredMessages: [],
        attachmentUrlById: EMPTY_ATTACHMENT_URLS,
        ...(projection === null
          ? {}
          : {
              attempts: projection.attempts,
              nodes: projection.nodes,
              plans: projection.plans,
            }),
      }),
    [projection, visibleTurnItems],
  );
  const activityRun = useMemo(
    () => (projection === null ? null : deriveThreadActivityRun(projection)),
    [projection],
  );
  const providerStatuses =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.serverConfig?.providers ?? EMPTY_PROVIDER_STATUSES;
  const subagent = parentProjection?.subagents.find(
    (candidate) => candidate.childThreadId === threadRef.threadId,
  );
  const modelInfo = resolveSubagentModelInfo({
    modelSelection: shell?.modelSelection,
    subagent,
    providers: providerStatuses,
  });
  const workspaceRoot = shell?.worktreePath ?? project?.workspaceRoot ?? undefined;
  const threadTitle = title ?? shell?.title ?? "Subagent";
  const routeKey = scopedThreadKey(threadRef);
  const [readyThreadKey, setReadyThreadKey] = useState<string | null>(null);
  const [layoutThreadKey, setLayoutThreadKey] = useState<string | null>(null);
  const onTimelineInitialLayout = useCallback(() => setLayoutThreadKey(routeKey), [routeKey]);
  const loadError = Option.getOrNull(threadState.error);
  const unavailableMessage =
    loadError ??
    (threadState.status === "deleted" ? "This conversation is no longer available." : null);
  const ready = readyThreadKey === routeKey || unavailableMessage !== null;
  useLayoutEffect(() => {
    if (ready || layoutThreadKey !== routeKey) return;
    const viewport = timelineViewportRef.current;
    if (viewport === null) return;

    // Legend's onLoad precedes the React commit that removes its opacity gate.
    // Keep the pane hidden until the visible rows and their code have committed.
    let frame: number | null = null;
    let previousGeometry: string | null = null;
    let disposed = false;
    const contentIsVisible = () => {
      const bounds = viewport.getBoundingClientRect();
      if (bounds.height <= 0 || bounds.width <= 0) return false;
      const intersectsViewport = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
      };
      if (viewport.querySelector('[data-timeline-empty="true"]') !== null) {
        if (threadState.status !== "live") return false;
      } else {
        const rows = [...viewport.querySelectorAll<HTMLElement>("[data-timeline-root]")].filter(
          intersectsViewport,
        );
        if (rows.length === 0) return false;
        for (const row of rows) {
          for (
            let element: HTMLElement | null = row;
            element !== null && element !== viewport;
            element = element.parentElement
          ) {
            if (element.style.opacity === "0" || element.hidden) return false;
          }
          if (
            [...row.querySelectorAll<HTMLElement>("[data-markdown-code-pending]")].some(
              intersectsViewport,
            )
          )
            return false;
        }
      }
      return true;
    };
    const settleContent = () => {
      frame = null;
      if (disposed) return;
      if (!contentIsVisible()) {
        previousGeometry = null;
        return;
      }
      const scroller = listRef.current?.getScrollableNode() ?? viewport;
      const bounds = viewport.getBoundingClientRect();
      // A newly highlighted block can resize the list and move its end pin.
      const geometry = `${scroller.scrollTop}:${scroller.scrollHeight}:${bounds.width}:${bounds.height}`;
      if (geometry === previousGeometry) {
        disposed = true;
        observer.disconnect();
        resizeObserver.disconnect();
        setReadyThreadKey(routeKey);
      } else {
        previousGeometry = geometry;
        frame = requestAnimationFrame(settleContent);
      }
    };
    const scheduleContentCheck = () => {
      if (!disposed && frame === null) frame = requestAnimationFrame(settleContent);
    };
    const observer = new MutationObserver(scheduleContentCheck);
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "hidden", "data-markdown-code-pending", "data-timeline-empty"],
    });
    const resizeObserver = new ResizeObserver(scheduleContentCheck);
    resizeObserver.observe(viewport);
    scheduleContentCheck();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, [layoutThreadKey, ready, routeKey, threadState.status]);
  useLayoutEffect(() => {
    onReadyChange?.(ready);
  }, [onReadyChange, ready]);
  const PanelSurface = mode === "overlay" ? ComposerSurface.Shell : "div";
  const parentThreadLink =
    parentThreadRef === null
      ? null
      : { threadId: parentThreadRef.threadId, title: parentShell?.title ?? "Parent conversation" };
  const onOpenNestedThread = (childThreadId: ThreadId) => {
    onOpenThread?.(scopeThreadRef(threadRef.environmentId, childThreadId));
  };

  return (
    <PanelSurface
      className={cn(
        "subagent-conversation-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        mode === "overlay"
          ? "subagent-conversation-overlay rounded-xl shadow-composer dark:shadow-none before:rounded-xl"
          : "bg-background",
      )}
      data-subagent-conversation-panel={mode}
      data-subagent-panel-ready={ready ? "true" : "false"}
      data-subagent-panel-closing={closing ? "true" : "false"}
      aria-hidden={!ready || closing}
      inert={!ready || closing}
    >
      <div
        className={cn(
          "relative z-10 flex min-h-0 flex-1 flex-col",
          mode === "overlay" && "subagent-conversation-overlay-content",
        )}
        onAnimationEnd={(event) => {
          if (closing && event.animationName === "subagent-conversation-exit") {
            onClosed?.();
          }
        }}
      >
        <ThreadPanelHeader
          title={threadTitle}
          mode={mode}
          onBack={onBack}
          onClose={onClose}
          onMaximize={onMaximize}
          modelInfo={modelInfo}
        />
        <div ref={timelineViewportRef} className="min-h-0 flex-1">
          {unavailableMessage !== null && projection === null ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {unavailableMessage}
            </p>
          ) : projection !== null ? (
            <MessagesTimeline
              key={routeKey}
              onInitialLayout={onTimelineInitialLayout}
              isWorking={isActiveRun(activityRun?.status)}
              activeTurnInProgress={isActiveRun(activityRun?.status)}
              activeTurnStartedAt={activityRun?.startedAt ?? null}
              listRef={listRef}
              timelineEntries={timelineProjection.entries}
              latestRun={activityRun}
              runningRunId={isActiveRun(activityRun?.status) ? (activityRun?.runId ?? null) : null}
              turnDiffSummaries={EMPTY_TURN_DIFF_SUMMARIES}
              routeThreadKey={routeKey}
              displayThreadKey={routeKey}
              onOpenTurnDiff={NOOP_RUN}
              onOpenThread={onOpenNestedThread}
              parentThreadLink={parentThreadLink}
              onForkFromRun={async () => {}}
              onRollbackCheckpoint={NOOP_ROLLBACK}
              supportsConversationRollback={false}
              onRevertToTurnCount={NOOP_REVERT}
              isRevertingCheckpoint={false}
              onImageExpand={NOOP_IMAGE}
              activeThreadEnvironmentId={threadRef.environmentId}
              markdownCwd={workspaceRoot}
              resolvedTheme={resolvedTheme}
              timestampFormat={settings.timestampFormat}
              workspaceRoot={workspaceRoot}
              skills={EMPTY_SKILLS}
              providerStatuses={providerStatuses}
              runs={projection?.runs ?? []}
              anchorMessageId={null}
              onAnchorReady={NOOP}
              onAnchorSizeChanged={NOOP}
              contentInsetEndAdjustment={0}
              onIsAtEndChange={NOOP}
              liveFollowEnabled
              onManualNavigation={NOOP}
              hideEmptyPlaceholder={false}
              topFadeEnabled={false}
            />
          ) : null}
        </div>
      </div>
    </PanelSurface>
  );
}
