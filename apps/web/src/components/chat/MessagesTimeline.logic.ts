import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { isLiveSubagentTurnItem } from "@t3tools/client-runtime/state/subagentRuntime";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { shallow } from "zustand/vanilla/shallow";
import { claudeResumeCompactionAge } from "@t3tools/shared/claudeCompaction";
import {
  IDLE_COMPACTING_LABELS,
  IDLE_COMPACTION_TITLES,
} from "@t3tools/client-runtime/user-message";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { renderCodexDirectivesForCopy } from "@t3tools/shared/codexMarkdownDirectives";
import {
  commandDisplayText,
  commandProgramName,
} from "@t3tools/client-runtime/work-log/command-label";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  contextCompactionTokenCounts,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type ThreadShell,
  type TurnDiffSummary,
} from "../../types";
import {
  type ConversationStructure,
  idleCompactionOf,
  isCompactionCommandMessage,
  type MessageId,
  type OrchestrationV2IdleCompaction,
  type WorktreeSetupSnapshot,
  type OrchestrationV2ProjectedTurnItem,
  type RunAttemptId,
  type RuntimeRequestId,
  RunId,
  type ThreadId,
  type TurnItemId,
  type ProviderTurnId,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { mcpAppReferencesEqual, type McpAppReference } from "@t3tools/shared/mcpApp";
import { dynamicToolTitle } from "@t3tools/shared/toolActivity";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  if (entry.kind === "html-render" || entry.kind === "mcp-app") return entry.runId;
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.itemType === "reasoning") return entry.detail?.trim().replace(/\s+/g, " ") || "Thought";
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  if (entry.itemType === "web_search") return entry.toolTitle ?? "Web search";
  return workEntryDisplayLabel(entry, undefined);
}

function workEntryToolDataRecord(entry: WorkLogEntry): Record<string, unknown> | undefined {
  return entry.toolData !== null &&
    typeof entry.toolData === "object" &&
    !Array.isArray(entry.toolData)
    ? (entry.toolData as Record<string, unknown>)
    : undefined;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  return collectToolFilePaths(workEntryToolDataRecord(entry));
}

function workEntryReadPaths(entry: WorkLogEntry, workspaceRoot: string | undefined): string[] {
  return workEntryReadRawPaths(entry).map((filePath) =>
    formatWorkspaceRelativePath(filePath, workspaceRoot),
  );
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  const action = toolGroupAction(entry);
  if (action === "code-search" || action === "search") {
    const searchLabel =
      entry.itemType === "file_search"
        ? entry.label
        : formatSearchToolLabel(workEntryToolDataRecord(entry));
    if (searchLabel) return searchLabel;
  }
  const readPaths = action === "read" ? workEntryReadPaths(entry, workspaceRoot) : [];
  if (action === "read" && readPaths[0]) {
    return formatReadToolLabel(readPaths[0], readPaths.length - 1);
  }
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  const detailIsSearchOutput =
    (action === "code-search" || action === "search") && /[\r\n]/.test(compactDetail ?? "");
  if (compactDetail && !providerRetry && action !== "read" && !detailIsSearchOutput) {
    return compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  if (action === "read" && !entry.viewedImagePath) {
    return "Read file";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

export function threadReadTargetId(entry: Pick<WorkLogEntry, "structuredPayload">) {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool") return null;
  if (resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "thread-read") return null;
  const input = item.input;
  const threadId =
    input !== null && typeof input === "object" && "threadId" in input ? input.threadId : null;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

const THREAD_READ_OBJECT = " a T3 thread";

export function threadReadTargetTitle(
  shell: Pick<ThreadShell, "title" | "archivedAt" | "deletedAt"> | null,
) {
  if (!shell || shell.archivedAt !== null || shell.deletedAt !== null) return null;
  return shell.title.trim() || null;
}

export function threadReadLabelPrefix(label: string) {
  return label.endsWith(THREAD_READ_OBJECT)
    ? `${label.slice(0, -THREAD_READ_OBJECT.length)} thread`
    : null;
}

export function workEntryReadOutput(
  entry: Pick<
    WorkLogEntry,
    "changedFiles" | "detail" | "viewedImagePath" | "structuredPayload" | "toolData"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const paths = [
    ...new Set(
      workEntryReadRawPaths(entry as WorkLogEntry)
        .map((path) => {
          const trimmed = path.trim().replaceAll("\\", "/");
          if (!workspaceRoot || trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
            return trimmed;
          }
          const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
          const relative = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
          return `${root}/${relative}`;
        })
        .filter((path) => path.length > 0),
    ),
  ];
  if (paths.length > 0) {
    return paths.join("\n");
  }
  return null;
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      entry.detail?.trim().replace(/\s+/g, " ") ||
      (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
  preserveToolHistory = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (preserveToolHistory && workLogEntryIsToolLike(entry)) ||
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
  readonly end?: { readonly entryId: string; readonly index: number };
}

export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number; viewPosition?: number } | undefined {
  if (!anchor) return undefined;
  // Preserve follow when an appended call promotes a short native group to a
  // virtual list. Status/detail changes still restore the visible record.
  if (
    anchor.end &&
    entries.length > anchor.end.index + 1 &&
    entries[anchor.end.index]?.id === anchor.end.entryId
  ) {
    return { index: entries.length - 1, viewOffset: 0, viewPosition: 1 };
  }
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ readonly id: string }>,
  entries: ReadonlyArray<{ readonly id: string }>,
  distanceFromEnd: number,
): boolean {
  return (
    previous.length > 0 &&
    entries.length > previous.length &&
    distanceFromEnd <= 1 &&
    previous.every((entry, index) => entry.id === entries[index]?.id)
  );
}

interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/** Reads the actual browser viewport edge without LegendList's near-end band. */
export function resolveTimelineDomIsAtEnd(input: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  // Even a fractional upward step leaves the edge. Animation writes separately
  // track the browser's last clamped bottom so layout growth is not navigation.
  return input.scrollTop >= Math.max(0, input.scrollHeight - input.clientHeight);
}

/**
 * Row-size compensation pins the reader's content to the same screen offset when a row
 * resizes. Smooth output resizes the thinking block every frame, so compensation would
 * keep moving the viewport after the reader left the live edge. Smooth output owns
 * viewport movement instead, in both follow and free-reading states.
 */
export function shouldMaintainVisibleTimelineContent(input: {
  readonly smoothStreaming: boolean;
  readonly liveFollowEnabled: boolean;
}): boolean {
  return !input.smoothStreaming;
}

/**
 * Identifies a user leaving the live edge even when the smooth-scroll hook is
 * temporarily unavailable during another layout transition.
 */
export function shouldCancelTimelineFollowOnNativeScroll(input: {
  readonly smoothStreaming: boolean;
  readonly liveFollowEnabled: boolean;
  readonly nativeIsAtEnd: boolean | undefined;
  readonly previousScrollTop: number | null;
  readonly scrollTop: number;
  readonly layoutChanged: boolean;
  readonly blockedByProgrammaticPositioning: boolean;
}): boolean {
  return (
    input.smoothStreaming &&
    input.liveFollowEnabled &&
    input.nativeIsAtEnd === false &&
    input.previousScrollTop !== null &&
    // Any negative native delta is enough to identify an upward gesture. The
    // event is already filtered by the caller's programmatic-positioning
    // guards; a sub-pixel first trackpad step must not wait for a second step.
    input.scrollTop < input.previousScrollTop &&
    !input.layoutChanged &&
    !input.blockedByProgrammaticPositioning
  );
}

/**
 * Prevents a stale virtual-list end report from re-arming live follow while
 * the user is reading above the end. Returning to follow requires a real
 * downward navigation intent (or an already-following state).
 */
export function shouldRearmTimelineFollow(input: {
  readonly isAtEnd: boolean;
  readonly scrollMode: "following-end" | "anchoring-new-turn" | "free-scrolling";
  readonly scrollIntent: "toward-end" | "away-from-end" | null;
}): boolean {
  return (
    input.isAtEnd && (input.scrollMode === "following-end" || input.scrollIntent === "toward-end")
  );
}

/**
 * When the Markdown body may leave its live streaming state. A run can settle before its
 * last assistant chunk lands, so the body waits for the message's own streaming bit. Stale
 * runs and terminal items can keep that bit after recovery and must not hold the reveal
 * open forever; only the active run's real tail earns the extra wait.
 */
export function resolveSmoothComplete(input: {
  readonly smoothStreaming: boolean;
  readonly messageRunId: RunId | null;
  readonly messageStreaming: boolean;
  readonly itemType: OrchestrationV2ProjectedTurnItem["item"]["type"] | null;
  readonly itemStatus: OrchestrationV2ProjectedTurnItem["item"]["status"] | null;
  readonly latestRunId: RunId | null;
  readonly latestRunStatus?: TimelineLatestRun["status"] | null;
  readonly isWorking: boolean;
}): boolean {
  if (!input.smoothStreaming) return false;
  const staleRun =
    input.messageRunId !== null &&
    input.latestRunId !== null &&
    input.messageRunId !== input.latestRunId;
  if (staleRun) return true;
  if (
    input.latestRunStatus === "completed" ||
    input.latestRunStatus === "failed" ||
    input.latestRunStatus === "interrupted" ||
    input.latestRunStatus === "cancelled" ||
    input.latestRunStatus === "rolled_back"
  )
    return true;
  if (
    input.itemType === "assistant_message" &&
    (input.itemStatus === "cancelled" ||
      input.itemStatus === "failed" ||
      input.itemStatus === "interrupted")
  )
    return true;
  return !input.messageStreaming && !input.isWorking;
}

/**
 * strict isAtEnd flickers false for a frame while streaming content grows under
 * the viewport, so follow re-arms within this distance of the real content
 * bottom instead.
 */
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // LegendList double-subtracts the composer inset, so its isAtEnd is only a fallback.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** Recheck the rendered buffer: LegendList's unbuffered range can lag during scrolling. */
export function resolveTimelineMinimapVisibleRange(state: {
  readonly startBuffered: number | null | undefined;
  readonly endBuffered: number | null | undefined;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}) {
  let start: number | null = null;
  let end: number | null = null;
  if (state.startBuffered == null || state.endBuffered == null || state.startBuffered < 0) {
    return { start, end };
  }
  const bottom = state.scroll + state.scrollLength;
  for (let index = state.startBuffered; index <= state.endBuffered; index += 1) {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
      top != null &&
      Number.isFinite(top) &&
      top < bottom &&
      top + Math.max(1, height != null && Number.isFinite(height) ? height : 1) > state.scroll
    ) {
      start ??= index;
      end = index;
    }
  }
  return { start, end };
}

export function isTimelineMinimapRowVisible(
  rowIndex: number,
  visibleStart: number | null | undefined,
  visibleEnd: number | null | undefined,
): boolean {
  return (
    visibleStart != null && visibleEnd != null && rowIndex >= visibleStart && rowIndex <= visibleEnd
  );
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly visibleStart: number | null | undefined;
  readonly visibleEnd: number | null | undefined;
  readonly rowIndices: ReadonlyArray<number>;
}): number | null {
  if (input.visibleStart == null || input.visibleEnd == null) {
    return null;
  }
  let precedingIndex: number | null = null;
  for (const [index, rowIndex] of input.rowIndices.entries()) {
    if (rowIndex >= input.visibleStart) {
      // Prefer the first visible user message, otherwise the turn being read.
      return rowIndex <= input.visibleEnd ? index : precedingIndex;
    }
    precedingIndex = index;
  }
  return precedingIndex;
}

/** Virtual rows are ordered and non-overlapping; read only the viewport's marker band. */
export function resolveTimelineMinimapViewport(input: {
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly itemCount: number;
  readonly getItemBounds: (index: number) => {
    readonly top: number | null;
    readonly height: number | null;
  };
}): { currentIndex: number | null; inViewIndices: number[] } {
  const inView = (item: ReturnType<typeof input.getItemBounds>) =>
    item.top !== null &&
    item.top < input.scrollBottom &&
    item.top + Math.max(1, item.height ?? 1) > input.scrollTop;
  const firstMatching = (matches: (item: ReturnType<typeof input.getItemBounds>) => boolean) => {
    let low = 0;
    let high = input.itemCount;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const item = input.getItemBounds(middle);
      if (item.top === null) return null;
      if (matches(item)) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const firstVisible = firstMatching(
    (item) => item.top! + Math.max(1, item.height ?? 1) > input.scrollTop,
  );
  const afterVisible = firstMatching((item) => item.top! >= input.scrollBottom);
  const inViewIndices: number[] = [];
  if (firstVisible !== null && afterVisible !== null) {
    for (let index = firstVisible; index < afterVisible; index += 1) {
      if (inView(input.getItemBounds(index))) inViewIndices.push(index);
    }
    if (inViewIndices.length > 0) return { currentIndex: inViewIndices[0]!, inViewIndices };
    const afterPreceding = firstMatching((item) => item.top! > input.scrollTop);
    if (afterPreceding !== null) {
      return { currentIndex: afterPreceding > 0 ? afterPreceding - 1 : null, inViewIndices };
    }
  }

  // An unpositioned list can have holes in its cache; preserve the existing scan semantics.
  let currentIndex: number | null = null;
  for (let index = 0; index < input.itemCount; index += 1) {
    const item = input.getItemBounds(index);
    if (inView(item)) inViewIndices.push(index);
    if (item.top !== null && item.top <= input.scrollTop) currentIndex = index;
  }
  return { currentIndex: inViewIndices[0] ?? currentIndex, inViewIndices };
}

/**
 * Side gutter between the viewport edge and the centered content column.
 * `contentWidth` is the rendered column width, which follows the Chat width
 * setting, so callers measure it rather than assume a fixed maximum.
 */
function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt" | "turnEnded"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
};

type MessagesTimelineRowContent =
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
      thought?: WorkLogEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /** A running compaction owns the working row, so its divider appears only once it ends. */
      compacting?: true;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
      groupId?: string;
      expanded?: boolean;
      idle?: true;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      toolSurface?: WorkLogEntry["toolSurface"];
      toolIcon?: WorkLogEntry["toolIcon"];
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      deferredWorkItemIds?: ReadonlyArray<string>;
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "attempt-fold";
      deferredWorkItemIds?: ReadonlyArray<string>;
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      tokenCounts: ReturnType<typeof contextCompactionTokenCounts>;
      active: boolean;
      /** Replaces "Context compacted" when T3 Code compacted without being asked. */
      title?: string;
      failed?: true;
      /** The provider's reason, when a failed compaction gave one. */
      failure?: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      showAssistantMeta: boolean;
      reserveAssistantMeta?: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
      /** Another of your messages follows directly, so the two sit closer together. */
      groupedWithNext?: boolean;
      /** Another of your messages sits directly above, so the joined corners tighten. */
      groupedWithPrevious?: boolean;
      /** Set when the message above is a steer too, so the label shows once. */
      continuesSteer?: boolean;
    }
  | {
      kind: "assistant-meta";
      reserveAssistantMeta?: boolean;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      resourceSummary?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      kind: "mcp-app";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      itemId: TurnItemId;
      revision: string;
      mcpApp: McpAppReference;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[],
): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id: `${groupId}:details`,
    createdAt,
    groupedEntries,
    isExpandedToolGroup: true,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  /** Every entry in the segment, including the cards a fold never hides. */
  entryIds: ReadonlySet<string>;
  label: string;
}

interface SupersededAttemptFold {
  readonly deferredWorkItemIds: ReadonlyArray<string>;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

// Interrupted streams can be `completed`; only the attempt's last output proves completion.
function completeSupersededReplyEntryIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlySet<string> {
  const lastOutputByAttemptId = new Map<RunAttemptId, TimelineEntry>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "work" &&
        (entry.entry.itemType === "system_notice" || entry.entry.itemType === "notification")) ||
      (entry.kind !== "message" && entry.kind !== "work")
    ) {
      continue;
    }
    const previous = lastOutputByAttemptId.get(entry.attempt.id);
    const deferredEnd =
      previous?.kind === "work"
        ? previous.entry.projectedItem?.item.deferredWork?.lastOrdinal
        : undefined;
    const ordinal =
      entry.kind === "work"
        ? entry.entry.projectedItem?.item.ordinal
        : entry.kind === "message"
          ? entry.projectedItem?.item.ordinal
          : undefined;
    if (deferredEnd !== undefined && ordinal !== undefined && deferredEnd > ordinal) continue;
    lastOutputByAttemptId.set(entry.attempt.id, entry);
  }
  const replyEntryIds = new Set<string>();
  for (const entry of lastOutputByAttemptId.values()) {
    const supersededAt = entry.attempt?.completedAt ?? null;
    const item = entry.kind === "message" ? entry.projectedItem?.item : undefined;
    if (
      entry.kind === "message" &&
      !entry.message.streaming &&
      item?.type === "assistant_message" &&
      item.status === "completed" &&
      item.completedAt !== null &&
      supersededAt !== null &&
      DateTime.isLessThan(item.completedAt, supersededAt)
    ) {
      replyEntryIds.add(entry.id);
    }
  }
  return replyEntryIds;
}

function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unfoldedRunIds: ReadonlySet<RunId>,
  liveSubagentEntryIds: ReadonlySet<string>,
  completeReplyEntryIds: ReadonlySet<string>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const completeAttemptIds = new Set(
    timelineEntries.flatMap((entry) =>
      entry.attempt !== undefined && completeReplyEntryIds.has(entry.id) ? [entry.attempt.id] : [],
    ),
  );
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      completeAttemptIds.has(entry.attempt.id) ||
      unfoldedRunIds.has(entry.attempt.runId) ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "event" && entry.projectedItem.item.type === "handoff") ||
      entry.kind === "html-render" ||
      entry.kind === "mcp-app" ||
      timelineEntryIsPersistentResourceCard(entry) ||
      liveSubagentEntryIds.has(entry.id) ||
      (entry.kind === "work" && entry.entry.itemType === "system_notice")
    ) {
      continue;
    }
    const entries = entriesByAttemptId.get(entry.attempt.id) ?? [];
    entries.push(entry);
    entriesByAttemptId.set(entry.attempt.id, entries);
  }

  const foldsByAnchorEntryId = new Map<string, SupersededAttemptFold>();
  for (const entries of entriesByAttemptId.values()) {
    const firstEntry = entries[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorEntryId.set(firstEntry.id, {
      deferredWorkItemIds: entries.flatMap((entry) =>
        entry.kind === "work" && entry.entry.projectedItem?.item.deferredWork
          ? [String(entry.entry.projectedItem.sourceItemId)]
          : [],
      ),
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

// After send, the previous turn stays active until the server creates its replacement.
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

// Children can outlive their launching turn; keep cards visible while the footer counts them.
function liveSubagentCardEntryIds(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<string> {
  const visible = new Set<string>();
  let batch: Array<Extract<TimelineEntry, { kind: "event" }>> = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (batch.some((entry) => isLiveSubagentTurnItem(entry.projectedItem.item))) {
      for (const entry of batch) visible.add(entry.id);
    }
    batch = [];
  };
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") {
      flush();
      continue;
    }
    const item = entry.projectedItem.item;
    const previous = batch.at(-1)?.projectedItem.item;
    if (
      previous !== undefined &&
      (previous.runId !== item.runId || previous.providerTurnId !== item.providerTurnId)
    ) {
      flush();
    }
    batch.push(entry);
  }
  flush();
  return visible;
}

function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "work" && entry.entry.itemType === "system_notice") return null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  if (
    entry.kind === "event" &&
    (timelineEntryIsPersistentResourceCard(entry) || entry.projectedItem.item.type === "subagent")
  ) {
    return entry.projectedItem.item.runId ?? runlessKey;
  }
  return null;
}

function timelineEntryIsSteer(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    (entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer")
  );
}

function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" && entry.message.role === "user" && !timelineEntryIsSteer(entry)) ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

function timelineEntryEnd(entry: TimelineEntry): string {
  return entry.kind === "message" ? entry.message.updatedAt : entry.createdAt;
}

function timelineEntryIsCompaction(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
}

function responseBoundaryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

// Group promptless restarts under the initiating prompt until settled.
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  isWorking: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.isWorking) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

/** Usage-limit pauses keep their tool groups; any other failure itemizes the run's work. */
function itemizedFailedRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  failedRunIds: ReadonlySet<RunId>,
) {
  const usageLimited = new Set<RunId>();
  const otherFailures = new Set<RunId>();
  for (const entry of entries) {
    const item = timelineEntryFailedItem(entry);
    if (item?.runId) {
      (item.failure.class === "usage_limit" ? usageLimited : otherFailures).add(item.runId);
    }
  }
  return new Set(
    [...failedRunIds].filter((runId) => !usageLimited.has(runId) || otherFailures.has(runId)),
  );
}

function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  unfoldedRunIds: ReadonlySet<RunId>;
  runlessWorkActive: boolean;
  liveSubagentEntryIds: ReadonlySet<string>;
  completeSupersededReplyEntryIds: ReadonlySet<string>;
}): ReadonlyMap<string, TurnFold> {
  const interruptedRunIds = new Set<RunId>();
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const runId = responseBoundaryRunId(entry);
      if (runId !== null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
    }
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      (entry.projectedItem.item.type === "run_interrupt_request" ||
        entry.projectedItem.item.type === "run_interrupt_result")
    ) {
      interruptedRunIds.add(entry.projectedItem.item.runId);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    // Entry timestamps omit startup and can collapse steered turns to an instant.
    startBoundary: string | null;
    anchorEntryId: string;
    /**
     * Each steer after the turn has produced output starts a new segment at
     * this index into `entries`, so the steer sits between the work it split.
     */
    steerSegments: Array<{ startIndex: number; steer: TimelineEntry }>;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();

  // Key runless responses per prompt to prevent V2 runs unfolding imported turns.
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let pendingBoundary: { createdAt: string; anchorEntryId: string } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? { createdAt: entry.createdAt, anchorEntryId: nextEntry.id }
        : null;
      const boundaryRunId = responseBoundaryRunId(entry);
      runlessKey = boundaryRunId == null ? RunId.make(`runless:${entry.id}`) : null;
      responseKey = boundaryRunId ?? runlessKey;
      continue;
    }
    if (entry.kind === "message" && timelineEntryIsSteer(entry)) {
      const steerRunId = entry.message.runId ?? responseKey;
      const group = steerRunId === null ? undefined : groupsByRunId.get(steerRunId);
      if (group !== undefined && group.entries.length > 0) {
        // Back-to-back steers split once, after the last of them.
        if (group.steerSegments.at(-1)?.startIndex === group.entries.length) {
          group.steerSegments.pop();
        }
        group.steerSegments.push({ startIndex: group.entries.length, steer: entry });
      }
      continue;
    }
    const ownRunId = timelineEntryFoldRunId(entry, runlessKey);
    if (!ownRunId) {
      continue;
    }
    // Resumed subagents keep their position and fold with their original turn.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
        steerSegments: [],
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      input.unfoldedRunIds.has(runId) ||
      interruptedRunIds.has(runId) ||
      runlessFailedKeys.has(runId) ||
      (input.runlessWorkActive && runId === runlessKey)
    ) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction = timelineEntryIsCompaction(entry);
      const isFoldableTrailingActivity =
        entry.kind === "work" &&
        entry.entry.toolLifecycleStatus !== "inProgress" &&
        !workEntryDisplayIndicatesToolFailure(entry.entry);
      if (!isCompaction && index > terminalEntryIndex && !isFoldableTrailingActivity) {
        continue;
      }
      if (
        isCompaction ||
        timelineEntryIsPersistentResourceCard(entry) ||
        input.liveSubagentEntryIds.has(entry.id) ||
        input.completeSupersededReplyEntryIds.has(entry.id)
      ) {
        continue;
      }
      if (entry.kind === "work" && entry.entry.itemType === "notification") continue;
      if (entry.kind === "work" && entry.entry.questionAnswer !== undefined) continue;
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    const hidesNonCompactionWork = (entries: ReadonlyArray<TimelineEntry>) =>
      entries.some((entry) => hiddenEntryIds.has(entry.id) && !timelineEntryIsCompaction(entry));
    if (!hidesNonCompactionWork(group.entries)) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestRun?.runId === runId && input.latestRun.status === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd = timelineEntryEnd(lastEntry);
    const elapsedMs =
      input.latestRun?.runId === runId && input.latestRun.startedAt && input.latestRun.completedAt
        ? computeElapsedMs(input.latestRun.startedAt, input.latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    // The top row keeps the whole turn's time, steers included. Work after a
    // steer folds under its own row below that steer, keyed apart from the run
    // so each segment opens on its own.
    const segmentHiddenIds = (entries: ReadonlyArray<TimelineEntry>) =>
      new Set(entries.flatMap((entry) => (hiddenEntryIds.has(entry.id) ? [entry.id] : [])));
    const firstSegment = group.entries.slice(0, group.steerSegments[0]?.startIndex);
    foldsByAnchorEntryId.set(group.anchorEntryId, {
      runId,
      anchorEntryId: group.anchorEntryId,
      createdAt: group.startBoundary ?? firstEntry.createdAt,
      hiddenEntryIds: segmentHiddenIds(firstSegment),
      entryIds: new Set(firstSegment.map((entry) => entry.id)),
      label,
    });
    for (const [index, { startIndex, steer }] of group.steerSegments.entries()) {
      const entries = group.entries.slice(startIndex, group.steerSegments[index + 1]?.startIndex);
      const anchorEntry = entries[0];
      if (anchorEntry === undefined || !hidesNonCompactionWork(entries)) continue;
      const segmentMs = computeElapsedMs(
        steer.createdAt,
        entries.map(timelineEntryEnd).reduce<string | null>(maxIsoTimestamp, null) ??
          steer.createdAt,
      );
      foldsByAnchorEntryId.set(anchorEntry.id, {
        runId: RunId.make(`${runId}:steer:${steer.id}`),
        anchorEntryId: anchorEntry.id,
        createdAt: steer.createdAt,
        hiddenEntryIds: segmentHiddenIds(entries),
        entryIds: new Set(entries.map((entry) => entry.id)),
        label: segmentMs !== null ? `Continued for ${formatDuration(segmentMs)}` : "Continued",
      });
    }
  }
  return foldsByAnchorEntryId;
}

function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      (!row.showAssistantMeta && !row.reserveAssistantMeta) ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.item.type === "error" &&
                entry.projectedItem.item.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
      reserveAssistantMeta: row.reserveAssistantMeta === true,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({
        ...row,
        showAssistantMeta: false,
        reserveAssistantMeta: false,
        showAssistantCopyButton: false,
      });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

// Hide delegation rows only when task ids identify durable child cards; prompts can repeat.
function withoutSubagentDelegationRows(entries: ReadonlyArray<TimelineEntry>) {
  const childrenByRun = new Map<RunId, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    const item = entry.projectedItem.item;
    if (item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? new Set<string>();
    children.add(item.subagentId);
    childrenByRun.set(item.runId, children);
  }
  return entries.filter((entry) => {
    if (entry.kind !== "work" || workEntryDisplayIndicatesToolFailure(entry.entry)) return true;
    const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
    if (
      item?.type !== "dynamic_tool" ||
      item.runId === null ||
      (item.status !== "running" && item.status !== "completed") ||
      resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "delegate"
    )
      return true;
    const output = compactDynamicToolOutput(item.output);
    if (output?.isError) return true;
    if (output?.taskId !== undefined) {
      return !childrenByRun.get(item.runId)?.has(output.taskId);
    }
    return true;
  });
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

function timelineRowEntries(entries: ReadonlyArray<TimelineEntry>) {
  return withoutSubagentDelegationRows(settleSupersededReasoning(entries));
}

function deriveTimelineTurnFolds(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
) {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  return deriveTurnFolds({
    timelineEntries,
    terminalAssistantMessageIds: deriveTerminalAssistantMessageIds(timelineEntries),
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
    runlessWorkActive: input.isWorking && input.runlessWorkActive === true,
    liveSubagentEntryIds: liveSubagentCardEntryIds(timelineEntries),
    completeSupersededReplyEntryIds: completeSupersededReplyEntryIds(timelineEntries),
  });
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  pendingApprovalRequestIds?: ReadonlySet<RuntimeRequestId>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  /** Native subagent work has no app run; runless entries form the live response. */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  /** Drives live-label scope and tool archiving. Undefined behaves as "default". */
  conversationStructure?: ConversationStructure | undefined;
  /** Smooth output keeps the terminal metadata footprint reserved while the response streams. */
  smoothStreaming?: boolean | undefined;
  /**
   * Native subagent turns have no application run. Their tool items carry this
   * provider turn instead, and it scopes the live activity like a running run.
   */
  activeProviderTurnId?: ProviderTurnId | null | undefined;
  worktreeSetup?: WorktreeSetupSnapshot | null;
}): MessagesTimelineRow[] {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const isPendingApproval = (entry: WorkLogEntry) => {
    const item = entry.projectedItem?.item;
    return (
      item?.type === "approval_request" &&
      input.pendingApprovalRequestIds?.has(item.requestId) === true
    );
  };
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
        threadStartCheckpointReady: input.threadStartCheckpointReady === true,
        unsettledRunId,
        availableRevertTurnCounts: input.availableRevertTurnCounts,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const itemizedRunIds = itemizedFailedRunIds(timelineEntries, failedRunIds);
  const liveSubagentEntryIds = liveSubagentCardEntryIds(timelineEntries);
  const completeSupersededReplyIds = completeSupersededReplyEntryIds(timelineEntries);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(
    timelineEntries,
    failedRunIds,
    liveSubagentEntryIds,
    completeSupersededReplyIds,
  );
  const supersededWorkItemIds = new Set(
    [...supersededFoldsByAnchorEntryId.values()].flatMap((fold) => fold.deferredWorkItemIds),
  );
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runlessWorkActive = input.isWorking && input.runlessWorkActive === true;
  const restructured = input.conversationStructure === "restructured";
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
    runlessWorkActive,
    liveSubagentEntryIds,
    completeSupersededReplyEntryIds: completeSupersededReplyIds,
  });
  const timelineEntryById = new Map(timelineEntries.map((entry) => [entry.id, entry]));
  const collapsedEntryIds = new Set<string>();
  const collapsedFoldMemberIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedRunIds?.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
      for (const entryId of fold.entryIds) {
        collapsedFoldMemberIds.add(entryId);
      }
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    if (!input.expandedAttemptIds?.has(fold.attemptId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedSupersededEntryIds.add(entryId);
      }
    }
  }
  if (input.pendingApprovalRequestIds?.size) {
    for (const entry of timelineEntries) {
      if (entry.kind === "work" && isPendingApproval(entry.entry)) {
        collapsedEntryIds.delete(entry.id);
        collapsedSupersededEntryIds.delete(entry.id);
      }
    }
  }
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const activeProviderTurnId =
    unsettledRunId === null ? (input.activeProviderTurnId ?? null) : null;
  const workEntryInActiveScope = (entry: WorkLogEntry) =>
    unsettledRunId !== null
      ? entry.runId === unsettledRunId
      : entry.runId == null &&
        (runlessWorkActive ||
          (activeProviderTurnId !== null &&
            entry.structuredPayload?.providerTurnId === activeProviderTurnId));
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (
    input.isWorking &&
    (unsettledRunId !== null ||
      runlessWorkActive ||
      (restructured && activeProviderTurnId !== null))
  ) {
    if (restructured) {
      for (const entry of timelineEntries) {
        if (
          entry.kind === "work" &&
          workEntryInActiveScope(entry.entry) &&
          entry.attempt?.status !== "superseded" &&
          entry.entry.sourceActivityKind !== "context-compaction" &&
          entry.entry.itemType !== "system_notice" &&
          entry.entry.itemType !== "notification" &&
          entry.entry.itemType !== "error" &&
          entry.entry.questionAnswer === undefined &&
          !isPendingApproval(entry.entry) &&
          !collapsedSupersededEntryIds.has(entry.id)
        )
          activeToolEntries.push(entry);
      }
    } else {
      let tailAttemptId: string | null | undefined;
      for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
        const entry = timelineEntries[index]!;
        if (
          entry.kind !== "work" ||
          entry.entry.tone === "error" ||
          entry.entry.sourceActivityKind === "runtime.error" ||
          entry.entry.itemType === "system_notice" ||
          entry.entry.itemType === "notification" ||
          entry.entry.questionAnswer !== undefined ||
          isPendingApproval(entry.entry) ||
          !runIdIsActiveResponse(entry.entry.runId) ||
          entry.entry.sourceActivityKind === "context-compaction" ||
          collapsedEntryIds.has(entry.id) ||
          collapsedSupersededEntryIds.has(entry.id) ||
          foldsByAnchorEntryId.has(entry.id) ||
          supersededFoldsByAnchorEntryId.has(entry.id)
        ) {
          break;
        }
        if (tailAttemptId === undefined) {
          tailAttemptId = entry.attempt?.id ?? null;
        } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
          break;
        }
        activeToolEntries.unshift(entry);
      }
    }
  }
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true, restructured),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry) &&
      !input.pendingApprovalRequestIds?.size);
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );

  const activeWorkPlacementEntryId = restructured
    ? latestRunningToolEntry?.id
    : latestVisibleToolEntry?.id;
  // Restructured releases each tool when it finishes so grouping archives it upward. The
  // live label carries only what is still running, the same predicate `activeWorkEntryIds`
  // uses below; keeping a finished tool in `groupedEntries` would render it twice, under
  // the label and in the body work group.
  const restructuredLiveToolEntries = latestRunningToolEntry ? [latestRunningToolEntry] : [];
  // Restructured narrows the live label to the running operation, so it empties once the
  // tail has nothing in flight. A row built from latestVisibleToolEntry would double-render
  // the just-finished tool, which the body pass already archives into its own `work` row.
  // The gap renders as the thinking/idle row instead.
  const restructuredLiveScope =
    input.conversationStructure === "restructured" && latestRunningToolEntry === undefined;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed && !restructuredLiveScope
      ? (() => {
          const groupId = workGroupId(
            restructured ? latestRunningToolEntry!.id : activeWorkAnchor.id,
          );
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: (input.conversationStructure === "restructured"
              ? restructuredLiveToolEntries
              : visibleActiveToolEntries
            ).map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive,
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  // Default keeps the whole trailing tool set live until the turn ends, so the label can
  // expand to the full turn history. Restructured releases each tool when it finishes and
  // the label narrows to the running operation. The body pass below skips entries in this
  // set, so it holds the tools that stay live, not the ones being archived.
  const activeWorkEntryIds = new Set(
    input.conversationStructure === "restructured"
      ? restructuredLiveToolEntries.map((entry) => entry.id)
      : activeWorkRow !== null || latestToolFailed
        ? activeToolEntries.map((entry) => entry.id)
        : [],
  );
  // A bare `/compact` turn is the compaction itself: one compaction row stands in for its prompt
  // and working indicator, from the moment the turn starts. Likewise an answered "compact before
  // continuing?" question folds into the compaction it asked for.
  const compactionRuns = new Map<RunId, OrchestrationV2IdleCompaction | undefined>();
  const compactedRunIds = new Set<RunId>();
  const pendingResumeCompactionAgeByRunId = new Map<RunId, string>();
  const resumeCompactionAgeByEntryId = new Map<string, string>();
  for (const entry of timelineEntries) {
    if (
      entry.kind === "message" &&
      entry.message.runId !== null &&
      isCompactionCommandMessage(entry.message)
    ) {
      compactionRuns.set(entry.message.runId, idleCompactionOf(entry.message));
    } else if (entry.kind === "work" && entry.entry.runId) {
      if (timelineEntryIsCompaction(entry)) {
        compactedRunIds.add(entry.entry.runId);
        const age = pendingResumeCompactionAgeByRunId.get(entry.entry.runId);
        if (age !== undefined) {
          resumeCompactionAgeByEntryId.set(entry.id, age);
          pendingResumeCompactionAgeByRunId.delete(entry.entry.runId);
        }
      }
      const age = entry.entry.questionAnswer
        ? claudeResumeCompactionAge(entry.entry.questionAnswer)
        : null;
      if (age !== null) pendingResumeCompactionAgeByRunId.set(entry.entry.runId, age);
    }
  }
  const compactionTitle = (runId: RunId | null | undefined, entryId: string) => {
    if (runId == null) return undefined;
    const reason = compactionRuns.get(runId);
    if (reason !== undefined) return IDLE_COMPACTION_TITLES[reason];
    const age = resumeCompactionAgeByEntryId.get(entryId);
    return age ? `Context compacted after ${age} idle` : undefined;
  };
  const activeCompactionEntry = timelineEntries.find(
    (entry): entry is Extract<TimelineEntry, { kind: "work" }> =>
      timelineEntryIsCompaction(entry) &&
      entry.kind === "work" &&
      workEntryIsInActiveRun(entry.entry),
  );
  const activeRunIsCompaction =
    input.isWorking && unsettledRunId !== null && compactionRuns.has(unsettledRunId);
  // The item can finish before its run settles; only other work should keep activity visible.
  const compactionRunFinished =
    activeRunIsCompaction &&
    compactedRunIds.has(unsettledRunId) &&
    activeCompactionEntry === undefined;
  const compactionOnlyRunFinished =
    compactionRunFinished &&
    !timelineEntries.some(
      (entry) =>
        timelineEntryRunId(entry) === unsettledRunId &&
        !timelineEntryIsCompaction(entry) &&
        !(entry.kind === "message" && isCompactionCommandMessage(entry.message)),
    );
  const runningCompactionRunId =
    activeRunIsCompaction && !compactionRunFinished ? unsettledRunId : null;
  // Compacting on return holds back the message the user just sent, so the working row says why
  // it is waiting. Any other compaction shows only its live divider, never both.
  const compactsOnReturn =
    runningCompactionRunId !== null && compactionRuns.get(runningCompactionRunId) === "onReturn";
  // The question is answered mid-turn, so the row times this compaction, not the turn.
  const resumeCompactionEntry =
    activeCompactionEntry?.entry.runId != null &&
    resumeCompactionAgeByEntryId.has(activeCompactionEntry.id)
      ? activeCompactionEntry
      : undefined;
  const activeCompactionRunId = compactsOnReturn
    ? runningCompactionRunId
    : (resumeCompactionEntry?.entry.runId ?? null);
  const appendWorkingRow = () => {
    if (compactionOnlyRunFinished) return;
    if (runningCompactionRunId !== null && activeCompactionRunId === null) return;
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt:
        (compactsOnReturn ? undefined : resumeCompactionEntry?.entry.createdAt) ??
        input.activeTurnStartedAt ??
        null,
      ...(activeCompactionRunId !== null ? { compacting: true as const } : {}),
    });
  };
  let hasActivityRow = false;
  const hasActiveCompaction =
    activeCompactionEntry !== undefined || (activeRunIsCompaction && !compactionRunFinished);
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
      ),
    );
  };

  // Prose, run changes and attempt changes end a tool batch. Removing the
  // live operation must not split the rest of that batch into smaller groups.
  const bodyWorkGroups = new Map<string, Array<Extract<TimelineEntry, { kind: "work" }>>>();
  const groupedBodyEntryIds = new Set<string>();
  let liveBodyGroupAnchorId: string | undefined;
  const liveBodyGroupRows: MessagesTimelineRow[] = [];
  if (restructured) {
    const batches: Array<Array<Extract<TimelineEntry, { kind: "work" }>>> = [];
    let batch: Array<Extract<TimelineEntry, { kind: "work" }>> | undefined;
    for (const entry of timelineEntries) {
      if (
        entry.kind !== "work" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification"
      ) {
        batch = undefined;
        continue;
      }
      const previous = batch?.at(-1);
      if (
        !batch ||
        previous?.entry.runId !== entry.entry.runId ||
        previous?.attempt?.id !== entry.attempt?.id
      ) {
        batch = [];
        batches.push(batch);
      }
      batch.push(entry);
    }
    for (const batch of batches) {
      const group = batch.filter((entry) => !activeWorkEntryIds.has(entry.id));
      const anchor = group[0];
      if (!anchor) continue;
      bodyWorkGroups.set(anchor.id, group);
      for (const entry of group.slice(1)) groupedBodyEntryIds.add(entry.id);
      if (batch.some((entry) => activeWorkEntryIds.has(entry.id)))
        liveBodyGroupAnchorId = anchor.id;
    }
  }

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    // A stopped compaction's own divider already says it stopped.
    if (
      timelineEntry.kind === "event" &&
      (timelineEntry.projectedItem.item.type === "run_interrupt_request" ||
        (timelineEntry.projectedItem.item.type === "run_interrupt_result" &&
          timelineEntry.projectedItem.item.runId !== null &&
          compactionRuns.has(timelineEntry.projectedItem.item.runId) &&
          compactedRunIds.has(timelineEntry.projectedItem.item.runId)))
    ) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      const deferredWorkItemIds = [...turnFold.entryIds].flatMap((entryId) => {
        const entry = timelineEntryById.get(entryId);
        return entry?.kind === "work" &&
          entry.entry.projectedItem?.item.deferredWork &&
          !supersededWorkItemIds.has(String(entry.entry.projectedItem.sourceItemId))
          ? [String(entry.entry.projectedItem.sourceItemId)]
          : [];
      });
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        ...(deferredWorkItemIds.length > 0 ? { deferredWorkItemIds } : {}),
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        expanded: input.expandedRunIds?.has(turnFold.runId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        deferredWorkItemIds: supersededFold.deferredWorkItemIds,
        id: `attempt-fold:${supersededFold.attemptId}`,
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: input.expandedAttemptIds?.has(supersededFold.attemptId) ?? false,
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id) || groupedBodyEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      if (
        active &&
        activeCompactionRunId !== null &&
        timelineEntry.entry.runId === activeCompactionRunId
      )
        continue;
      const compaction = timelineEntry.entry.structuredPayload;
      const compactionRunId = timelineEntry.entry.runId;
      const title = compactionTitle(compactionRunId, timelineEntry.id);
      const reason = compactionRunId == null ? undefined : compactionRuns.get(compactionRunId);
      const failed = compaction?.type === "compaction" && compaction.status === "failed";
      const failure = failed ? compaction.summary?.trim() || undefined : undefined;
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        ...(title ? { title } : {}),
        ...(failed ? { failed: true } : {}),
        ...(failure ? { failure } : {}),
        createdAt: timelineEntry.createdAt,
        label: active && reason ? IDLE_COMPACTING_LABELS[reason] : timelineEntry.entry.label,
        tokenCounts:
          compaction?.type === "compaction" ? contextCompactionTokenCounts(compaction) : null,
        active,
      });
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.runId != null &&
      compactedRunIds.has(timelineEntry.entry.runId) &&
      timelineEntry.entry.questionAnswer !== undefined &&
      claudeResumeCompactionAge(timelineEntry.entry.questionAnswer) !== null
    ) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        isPendingApproval(timelineEntry.entry) ||
        (!restructured &&
          timelineEntry.entry.runId != null &&
          itemizedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        (!restructured && timelineEntry.entry.tone === "error") ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification" ||
        timelineEntry.entry.questionAnswer !== undefined
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const batchGroup = bodyWorkGroups.get(timelineEntry.id);
      const groupedEntries = batchGroup
        ? batchGroup.map((entry) => entry.entry)
        : [timelineEntry.entry];
      const groupRowStart = nextRows.length;
      let cursor = index + 1;
      if (!restructured) {
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (
            !nextEntry ||
            nextEntry.kind !== "work" ||
            nextEntry.entry.sourceActivityKind === "context-compaction" ||
            (nextEntry.entry.itemType === "error" &&
              nextEntry.entry.toolLifecycleStatus === "failed") ||
            nextEntry.entry.tone === "error" ||
            nextEntry.entry.sourceActivityKind === "runtime.error" ||
            nextEntry.entry.itemType === "system_notice" ||
            nextEntry.entry.itemType === "notification" ||
            nextEntry.entry.questionAnswer !== undefined ||
            isPendingApproval(nextEntry.entry) ||
            activeWorkEntryIds.has(nextEntry.id) ||
            collapsedEntryIds.has(nextEntry.id) ||
            collapsedSupersededEntryIds.has(nextEntry.id) ||
            foldsByAnchorEntryId.has(nextEntry.id) ||
            supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
            (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
            nextEntry.attempt?.id !== timelineEntry.attempt?.id
          ) {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry), restructured),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (!restructured && activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        } else if (
          !restructured &&
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries).summary
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolSurface =
            primarySourceEntry?.toolSurface ??
            visibleGroupedEntries.findLast((entry) => entry.toolSurface !== undefined)?.toolSurface;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary:
              singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryKind,
            ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        }
      }
      // A tool can remain in flight while more prose arrives. Keep the
      // finished calls from that live batch at the bottom of the body.
      if (timelineEntry.id === liveBodyGroupAnchorId) {
        liveBodyGroupRows.push(...nextRows.splice(groupRowStart));
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "mcp-app") {
      nextRows.push({
        kind: "mcp-app",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        itemId: timelineEntry.itemId,
        revision: timelineEntry.revision,
        mcpApp: timelineEntry.mcpApp,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const previous = nextRows.at(-1);
      if (
        timelineEntry.projectedItem.item.type === "subagent" &&
        previous?.kind === "event" &&
        previous.projectedItem.item.type === "subagent" &&
        previous.projectedItem.item.runId === timelineEntry.projectedItem.item.runId &&
        previous.projectedItem.item.providerTurnId ===
          timelineEntry.projectedItem.item.providerTurnId
      ) {
        nextRows[nextRows.length - 1] = {
          ...previous,
          subagents: [
            ...(previous.subagents ?? [previous.projectedItem]),
            timelineEntry.projectedItem,
          ],
        };
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const compactionRunId = timelineEntry.message.runId;
    const compactionRun =
      compactionRunId !== null && isCompactionCommandMessage(timelineEntry.message);
    if (compactionRun) {
      if (!compactedRunIds.has(compactionRunId) && compactionRunId !== activeCompactionRunId) {
        const pending = compactionRunId === runningCompactionRunId;
        const reason = compactionRuns.get(compactionRunId);
        nextRows.push({
          kind: "context-compaction",
          id: `compaction:${compactionRunId}`,
          createdAt: timelineEntry.createdAt,
          label: pending
            ? reason
              ? IDLE_COMPACTING_LABELS[reason]
              : "Compacting context"
            : "Context compaction",
          tokenCounts: null,
          active: pending,
        });
      }
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;
    // Activity can end before its run projection settles. Reserve the final
    // controls' footprint now so their later arrival cannot move the footnotes.
    const reserveAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !showAssistantMeta &&
      (input.smoothStreaming === true || !input.isWorking);

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      showAssistantMeta,
      reserveAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant" && !assistantResponseStillInProgress
          ? turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  nextRows.push(...liveBodyGroupRows);

  // Until the agent's turn is live (in the timeline, not just dispatched), the setup card
  // sits under the send with the working header above it, so nothing moves at the handoff.
  // Once live, the stage list leaves the timeline and the header surfaces a running script.
  // A failed or cancelled setup stays under the send so its outcome and actions stay reachable.
  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (
    input.isWorking &&
    input.latestRun?.turnEnded !== true &&
    !setupOwnsWorkingSlot &&
    !hasActiveCompaction &&
    !compactionOnlyRunFinished &&
    (latestToolFailed || (!hasActivityRow && !input.pendingApprovalRequestIds?.size))
  ) {
    // A failed latest tool hands the row back to thinking, but its group
    // stays reachable through the same disclosure the live row offers.
    const failedGroupAnchor = !restructured && latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        expanded,
      });
      if (expanded) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
          ),
        );
      }
    } else {
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        ...(restructured &&
        latestVisibleToolEntry !== undefined &&
        timelineEntries.at(-1)?.id === latestVisibleToolEntry.id &&
        !latestToolFailed
          ? { idle: true as const }
          : {}),
      });
    }
  }

  const result = attachTrailingToolGroupsToAssistant(
    attachCreatedThreadSummaries(nextRows, timelineEntries, collapsedFoldMemberIds),
  );
  const visibleRows = result.map((row, index) => {
    if (timelineRowIsWorkLog(row) && timelineRowIsWorkLog(result[index + 1])) {
      return { ...row, continuesWorkLog: true };
    }
    if (!timelineRowIsOwnUserMessage(row)) return row;
    const previous = result[index - 1];
    const groupedWithNext = timelineRowIsOwnUserMessage(result[index + 1]);
    const groupedWithPrevious = timelineRowIsOwnUserMessage(previous);
    const continuesSteer =
      groupedWithPrevious && messageIsSteer(row.message) && messageIsSteer(previous.message);
    if (!groupedWithNext && !groupedWithPrevious) return row;
    return { ...row, groupedWithNext, groupedWithPrevious, continuesSteer };
  });
  return visibleRows;
}

function timelineRowIsOwnUserMessage(
  row: MessagesTimelineRow | undefined,
): row is Extract<MessagesTimelineRow, { kind: "message" }> {
  return (
    row?.kind === "message" &&
    row.message.role === "user" &&
    resolveUserMessagePresentation(row.message).attribution === null
  );
}

function messageIsSteer(message: ChatMessage): boolean {
  return message.inputIntent === "steer" || message.inputIntent === "promoted_queued_to_steer";
}

function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "work-live" ||
      row.kind === "thinking")
  );
}

function attachCreatedThreadSummaries(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
  collapsedFoldMemberIds: ReadonlySet<string>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  const createdByRun = new Map<RunId, Array<Extract<MessagesTimelineRow, { kind: "event" }>>>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
  }
  for (const entry of timelineEntries) {
    const projectedItem =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projectedItem?.item.type === "thread_created" && projectedItem.item.runId) {
      const runId = projectedItem.item.runId;
      const entries = createdByRun.get(runId) ?? [];
      entries.push({ kind: "event", id: entry.id, createdAt: entry.createdAt, projectedItem });
      createdByRun.set(runId, entries);
    }
  }
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (
        terminalIndex !== undefined &&
        (collapsedFoldMemberIds.has(row.id) || index > terminalIndex)
      )
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      return [
        row,
        ...(createdByRun.get(row.message.runId) ?? []).map((entry) => ({
          ...entry,
          id: `summary:${entry.id}`,
          resourceSummary: true,
        })),
      ];
    }
    return [row];
  });
}

const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";

export type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

/**
 * Runless (imported V1) turns and work after a steer fold under synthetic
 * keys, so the entry's own run id is not enough to open them.
 */
export function timelineTurnFoldRunIdsByEntryId(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
): ReadonlyMap<string, RunId> {
  const byEntryId = new Map<string, RunId>();
  for (const fold of deriveTimelineTurnFolds(input).values()) {
    for (const entryId of fold.hiddenEntryIds) byEntryId.set(entryId, fold.runId);
  }
  return byEntryId;
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    pendingApprovalRequestIds: previousPendingApprovalRequestIds,
    availableRevertTurnCounts: previousAvailableRevertTurnCounts,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    pendingApprovalRequestIds,
    availableRevertTurnCounts,
    ...context
  } = input;
  // Shell/checkpoint selectors rebuild summaries per event; compare contents.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !shallow(previousPendingApprovalRequestIds, pendingApprovalRequestIds) ||
    !shallow(previousAvailableRevertTurnCounts, availableRevertTurnCounts) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index]!;
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt && a.compacting === (b as typeof a).compacting
      );
    case "thinking": {
      const bt = b as typeof a;
      return (
        a.idle === bt.idle &&
        a.createdAt === bt.createdAt &&
        a.groupId === bt.groupId &&
        a.expanded === bt.expanded
      );
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.reserveAssistantMeta === bm.reserveAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "attempt-fold":
    case "turn-fold": {
      const bf = b as typeof a;
      const anchors = a.deferredWorkItemIds ?? [];
      const nextAnchors = bf.deferredWorkItemIds ?? [];
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.expanded === bf.expanded &&
        anchors.length === nextAnchors.length &&
        anchors.every((id, index) => id === nextAnchors[index])
      );
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return (
        a.createdAt === bc.createdAt &&
        a.label === bc.label &&
        a.active === bc.active &&
        a.title === bc.title &&
        a.failed === bc.failed &&
        a.failure === bc.failure
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Tool updates rebuild entries; preserve frames for unchanged pages.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "mcp-app": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.revision === bm.revision &&
        mcpAppReferencesEqual(a.mcpApp, bm.mcpApp)
      );
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.toolSurface === bw.toolSurface &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.reserveAssistantMeta === bm.reserveAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.groupedWithNext === bm.groupedWithNext &&
        a.groupedWithPrevious === bm.groupedWithPrevious &&
        a.continuesSteer === bm.continuesSteer
      );
    }
  }
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

function visibleUserMessageText(text: string): string {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  return visible + linkLabels(text.slice(cursor));
}

export function shouldCollapseUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text);
  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

export function handoffRunsSignature(runs: ReadonlyArray<HandoffTimelineRun>): string {
  return runs
    .map(
      (run) =>
        `${run.id}\0${run.providerInstanceId}\0${run.ordinal}\0${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
    )
    .join("\n");
}

// Expanded-id sets can be rebuilt during render; comparing them by content keeps
// the render-time state update in useIncrementalTimelineRows from repeating forever.
export function sameRowsInput(
  left: MessagesTimelineRowsInput,
  right: MessagesTimelineRowsInput,
): boolean {
  for (const key of Object.keys(right) as Array<keyof MessagesTimelineRowsInput>) {
    const previous = left[key];
    const next = right[key];
    if (Object.is(previous, next)) continue;
    if (previous instanceof Set && next instanceof Set && shallow(previous, next)) continue;
    return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}
