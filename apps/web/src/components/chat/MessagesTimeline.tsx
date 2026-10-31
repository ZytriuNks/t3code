import { type TimelineMinimapItem } from "./timelineMinimapItems";

import { TimelineTailAnchor } from "./TimelineTailAnchor";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ToolCallDiffTarget } from "../../diffPanelStore";
import { AudioPreviewUnmountContext } from "../files/AudioPreview";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { MarkdownFindContext } from "./markdownFindContext";
import { useChatCanvas } from "./ChatCanvasContext";
import { WorkLogBlock } from "./WorkLog";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";

import type {
  ConversationStructure,
  SmoothOutputMode,
  SmoothOutputLineMode,
} from "@t3tools/contracts";
import type { ThreadTextPlaybackState } from "@t3tools/client-runtime/state/threads";

import { deriveTimelineMinimapItems } from "./timelineMinimapItems";
import {
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type ServerProviderSkill,
  type RunId,
  ThreadId,
  type ProviderTurnId,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { observeResize } from "~/lib/observeResize";
import { useStableCallback } from "~/hooks/useStableCallback";

const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const EMPTY_PENDING_APPROVALS: ReadonlyArray<PendingApproval> = [];
const EMPTY_RESPONDING_REQUEST_IDS: TimelineRowSharedState["respondingRequestIds"] = [];

const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};

import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { StreamingFootnoteHost, StreamingFootnoteProvider } from "./StreamingMarkdownFootnotes";
import {
  memo,
  use,
  useContext,
  useLayoutEffect,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type MaintainScrollAtEndOptions,
} from "@legendapp/list/react";
import { type PendingApproval, type TimelineEntry } from "../../session-logic";
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { type ChatFileAttachment, type TurnDiffSummary } from "../../types";
import { ArrowRightIcon, BotIcon, CircleAlertIcon, Minimize2Icon } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { Skeleton } from "../ui/skeleton";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  readTimelinePosition,
  type RememberedTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type AssistantCitationRequest } from "./AssistantCitationSource";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { resolveCitationPhase, type CitedHistory } from "./citationProcedure";
import {
  resolveTimelineDomIsAtEnd,
  resolveTimelineIsAtEnd,
  shouldCancelTimelineFollowOnNativeScroll,
  shouldMaintainVisibleTimelineContent,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapVisibleRange,
  resolveTimelineMinimapHitStripWidth,
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import { type ThreadFindMatch } from "./threadFind";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { TooltipScrollDismissArea } from "../ui/tooltip";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useMediaQuery } from "~/hooks/useMediaQuery";

import {
  SmoothScrollLayoutBoundary,
  useSmoothScroll,
  type SmoothScrollHandle,
} from "~/hooks/useSmoothScroll";
import { cn } from "~/lib/utils";
import {
  createTimelineLayout,
  TimelineLayoutCommit,
  type TimelineLayoutCommitRequest,
} from "./timelineLayout";
import { createTimelineListLayout, TimelineListLayoutCommit } from "./timelineListLayout";

import { flushSync } from "react-dom";
import { OverlayScrollbar } from "~/components/ui/overlay-scrollbar";

import { type TimestampFormat } from "@t3tools/contracts/settings";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

import { useI18n } from "../../i18n/I18nProvider";

import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import { TimelineMinimap } from "./TimelineMinimap";
import {
  type TimelineRowSharedState,
  type TimelineRowActivityState,
  TimelineRowCtx,
  TimelineRowActivityCtx,
  TimelineRowDataCtx,
  type WorkGroupViewState,
  type TimelineRow,
} from "./timelineRowContext";
import { TimelineRowTimestamp, ActivityShimmerOverlay } from "./TimelineRowParts";
import {
  WorkGroupSection,
  WorkingTimelineRow,
  ThinkingTimelineRow,
  LiveWorkEntryTimelineRow,
  WorkGroupToggleTimelineRow,
} from "./TimelineWorkGroupRows";
import { UserMessageRow } from "./TimelineUserMessageRow";
import {
  AssistantTimelineRow,
  AssistantMetaTimelineRow,
  ProposedPlanTimelineRow,
  HtmlRenderTimelineRow,
  McpAppTimelineRow,
} from "./TimelineAssistantRows";
import { V2EventTimelineRow } from "./TimelineV2EventRow";
import { startTimelinePositionRestore } from "./useTimelinePositionRestore";
import {
  attachTimelineViewport,
  navigationReleasesFollow,
  nextListOpening,
  type TimelineListOpening,
  type TimelineNavigation,
  type TimelineViewport,
} from "./timelineViewport";
import { useThreadFindPositionReader } from "./useThreadFindPositionReader";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";
import { useStableHandoffRuns, useIncrementalTimelineRows, useStableRows } from "./useTimelineRows";

function timelineListStateFor(identity: string): {
  readonly identity: string;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly workGroupViewState: WorkGroupViewState;
} {
  const rememberedPosition = readTimelinePosition(identity);
  return {
    identity,
    rememberedPosition,
    workGroupViewState: rememberedPosition?.disclosures?.workGroupState ?? {
      scrollPositions: new Map(),
      expandedEntries: new Set(),
    },
  };
}

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);

/** The footer keeps the live label and composer gap in the same scroll flow. */
const TimelineListFooter = memo(
  function TimelineListFooter({
    composerInset,
    liveActivityRows,
    footerRef,
    onGrow,
    children,
  }: {
    readonly children?: ReactNode;
    readonly composerInset: number;
    readonly liveActivityRows: ReadonlyArray<TimelineLiveActivityRow>;
    readonly footerRef: React.RefObject<HTMLDivElement | null>;
    readonly onGrow: (() => void) | undefined;
  }) {
    const contentRef = useRef<HTMLDivElement>(null);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports growth of the footer's content, which the list does not follow
    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content || !onGrow) return;
      let height = content.offsetHeight;
      return observeResize(content, () => {
        const next = content.offsetHeight;
        if (next > height) onGrow();
        height = next;
      });
    }, [onGrow]);
    return (
      <div ref={footerRef}>
        <TimelineTailAnchor
          kind="footnotes"
          className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
        >
          <StreamingFootnoteHost fallback />
        </TimelineTailAnchor>
        {liveActivityRows.length > 0 ? (
          <div
            data-testid="timeline-live-activity-layer"
            className={cn(
              "mx-auto w-full min-w-0 max-w-(--chat-content-max-width)",
              liveActivityRows.at(-1)?.kind !== "thinking" && "pb-2",
            )}
          >
            {liveActivityRows.map((row) => (
              <div key={row.id} data-timeline-live-row-kind={row.kind}>
                {row.kind === "work-live" ? (
                  <LiveWorkEntryTimelineRow row={row} />
                ) : row.kind === "work" ? (
                  <TimelineRowContent row={row} />
                ) : (
                  <ThinkingTimelineRow row={row} />
                )}
              </div>
            ))}
          </div>
        ) : null}
        <div ref={contentRef}>{children}</div>
        <div aria-hidden style={{ height: composerInset }} />
        <div aria-hidden className="h-3 sm:h-4" />
      </div>
    );
  },
  // Streaming text rebuilds the live row array on every fragment while its
  // stable rows stay the same objects. Compare them so the footer skips that.
  (previous, next) =>
    previous.children === next.children &&
    previous.composerInset === next.composerInset &&
    previous.footerRef === next.footerRef &&
    previous.onGrow === next.onGrow &&
    previous.liveActivityRows.length === next.liveActivityRows.length &&
    previous.liveActivityRows.every((row, index) => row === next.liveActivityRows[index]),
);
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
/** Stable empty so the default path never allocates a new overlay array. */
const EMPTY_LIVE_ACTIVITY_ROWS: ReadonlyArray<TimelineLiveActivityRow> = [];
// Keep the footer on the visible edge while LegendList catches up with a
// smooth text frame's height. Its normal flow resumes as soon as follow ends.
const TIMELINE_LIVE_FOOTER_STYLE = { position: "sticky", bottom: 0 } as const;
/** Fraction of the viewport a scrollbar step triangle moves per step. */
const TIMELINE_SCROLLBAR_STEP_RATIO = 0.3;
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    footerLayout: false,
    itemLayout: true,
    layout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
const TIMELINE_MAINTAIN_SCROLL_AT_END_RESTRUCTURED = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  on: {
    ...TIMELINE_MAINTAIN_SCROLL_AT_END.on,
    // The restructured footer owns the live Thinking row. Keep the viewport
    // pinned when that row appears or changes height, but leave the default
    // layout's composer-only footer changes out of end maintenance.
    footerLayout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
const EMPTY_RUN_IDS: ReadonlySet<RunId> = new Set();
const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;
const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH_RESTRUCTURED = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END_RESTRUCTURED,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;

const CITED_HISTORY_LOADING: CitedHistory = { _tag: "loading" };

export interface MessagesTimelineHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

interface MessagesTimelineProps {
  textPlayback?: ThreadTextPlaybackState | null;
  /** The navigation target can precede the switch away from a held timeline. */
  textPlaybackNavigation?: {
    readonly threadKey: string;
    readonly entries: ReadonlyArray<TimelineEntry>;
  };
  smoothStreaming?: boolean;
  smoothOutputMode?: SmoothOutputMode;
  smoothOutputLineMode?: SmoothOutputLineMode;
  smoothMarkdownPreload?: boolean;
  smoothTextFadeDurationMs?: number;
  smoothTextYieldDurationMs?: number;
  footnotesAutoCollapse?: boolean;
  smoothScrollRef?: React.RefObject<SmoothScrollHandle | null>;
  smoothEndRequest?: number;
  onScrollableNodeChange?: (element: HTMLElement | null) => void;
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  heldApprovalRequestIds?: ReadonlySet<string> | undefined;
  respondingRequestIds?: TimelineRowSharedState["respondingRequestIds"];
  canOperateThread?: boolean;
  onRespondToApproval?: TimelineRowSharedState["onRespondToApproval"];
  citationRequest?: AssistantCitationRequest | null;
  citationHistory?: CitedHistory;
  /** The thread's detail is still loading; its first loaded snapshot is history, not new text. */
  threadDetailLoading?: boolean;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  isWorking: boolean;
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  /**
   * Drives live-label scope and tool archiving. Undefined behaves as "default",
   * which leaves the timeline byte-identical to the pre-restructuring shape.
   */
  conversationStructure?: ConversationStructure | undefined;
  /** Text shown while the turn's tools are done and the response has not started. */
  conversationStructureIdleLabel?: string | undefined;
  /** Text shown while the agent is thinking before any tool runs. */
  conversationStructureThinkingLabel?: string | undefined;
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  retryableWorkspacePreparationRunIds?: ReadonlySet<RunId>;
  onRetryWorkspacePreparation?: (runId: RunId) => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  awaitingUser?: "approval" | "input" | null;
  /** Which request is waiting, so a second one of the same kind is announced too. */
  awaitingRequestId?: string | null;
  footer?: ReactNode;

  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  /** The run the screen reader announcer follows; see announcedRun. */
  announcedRun?: { readonly runId: RunId; readonly status: TimelineLatestRun["status"] } | null;
  /** See isDetailBehindShell. */
  detailBehindShell?: boolean;
  runningRunId?: RunId | null;
  /** Current native provider turn when no application run owns the activity. */
  activeProviderTurnId?: ProviderTurnId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  displayThreadKey?: string;
  /** Off where another region already speaks the thread's status, like a subagent's bar. */
  announceTurnStatus?: boolean;
  onOpenToolDiff?: (target: ToolCallDiffTarget) => void;
  onOpenTurnDiff?: (runId: RunId, filePath?: string) => void;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  renderHtmlRender?: TimelineRowSharedState["renderHtmlRender"];
  turnItemSource?: TimelineRowSharedState["turnItemSource"];
  /** The thread this one is a subagent of; `open` is absent when it cannot be opened from here. */
  parentThreadLink?: {
    readonly title: string;
    /** Where it runs, when that is another environment. */
    readonly environmentLabel?: string;
    readonly open?: () => void;
  } | null;
  workflowOpening?: WorkflowOpening | null;
  onForkFromRun?: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  onSendAppMessage?: (text: string) => Promise<void>;
  onRunShellCommand?: (command: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: (attachment: ChatFileAttachment) => void;
  onFileDownload?: (attachment: ChatFileAttachment) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<ServerProviderSkill>;
  runs: ReadonlyArray<HandoffTimelineRun>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  onInitialLayout?: (() => void) | undefined;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /** Disable while reading history to prevent LegendList re-pinning near the bottom. */
  liveFollowEnabled: boolean;
  /**
   * Whether the real rows extend past the viewport above the composer, with the live
   * activity footer's height. Reported after scrolls, row size changes, and resizes.
   */
  onContentOverflowChange?: (overflows: boolean, liveFooterHeight: number) => void;
  /** Hears navigation away from the live end, for hosts without a follow store. */
  onManualNavigation?: () => void;
  /** Receives the list's viewport when it mounts; the returned cleanup runs when it goes away. */
  onViewportAttach?: (viewport: TimelineViewport) => () => void;
  /** The footer's content grew, such as a new queued turn or status line. */
  onFooterGrow?: () => void;
  findOpen?: boolean;
  hideEmptyPlaceholder?: boolean;
  /** Composer space to center the empty state against; held steady through collapse. */
  emptyPlaceholderInset: number;
  topFadeEnabled?: boolean;
  historyControls?: MessagesTimelineHistoryControls | undefined;
  findExpanded?: boolean;
  findQuery?: string;
  activeFindMatch?: ThreadFindMatch | null;
  findNavigationId?: number;
}

export function MessagesTimeline(props: MessagesTimelineProps) {
  const find = useContext(ThreadFindTimelineContext);
  const findOpen = find?.findOpen ?? props.findOpen;
  return (
    <ConversationTimeline
      {...props}
      {...find}
      liveFollowEnabled={!findOpen && props.liveFollowEnabled}
    />
  );
}

const ConversationTimeline = memo(function ConversationTimeline({
  textPlayback = null,
  textPlaybackNavigation,
  smoothStreaming = false,
  smoothOutputMode = "character",
  smoothOutputLineMode = "adaptive",
  smoothMarkdownPreload = true,
  smoothTextFadeDurationMs = 200,
  smoothTextYieldDurationMs = 200,
  footnotesAutoCollapse = false,
  smoothScrollRef,
  smoothEndRequest = 0,
  onScrollableNodeChange,
  onContentOverflowChange,
  onManualNavigation,
  pendingApprovals = EMPTY_PENDING_APPROVALS,
  heldApprovalRequestIds,
  respondingRequestIds = EMPTY_RESPONDING_REQUEST_IDS,
  canOperateThread = false,
  onRespondToApproval,
  citationRequest = null,
  citationHistory = CITED_HISTORY_LOADING,
  threadDetailLoading = false,
  onCiteAssistantText,
  isWorking,
  runlessWorkActive = false,
  activeTurnStartedAt = null,
  conversationStructure,
  conversationStructureIdleLabel = "",
  conversationStructureThinkingLabel = "",
  worktreeSetup = null,
  footer = null,
  onCancelWorktreeSetup,
  retryableWorkspacePreparationRunIds = EMPTY_RUN_IDS,
  onRetryWorkspacePreparation,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  awaitingUser = null,
  awaitingRequestId = null,
  listRef,
  timelineEntries,
  findOpen = false,
  findExpanded = false,
  findQuery = "",
  activeFindMatch = null,
  findNavigationId = 0,
  latestRun,
  announcedRun = null,
  detailBehindShell = false,
  runningRunId = null,
  activeProviderTurnId = null,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  announceTurnStatus = true,
  onOpenToolDiff,
  onOpenTurnDiff,
  onOpenThread,
  renderHtmlRender,
  turnItemSource,
  parentThreadLink = null,
  workflowOpening = null,
  onForkFromRun,
  supportsConversationRollback,
  threadStartCheckpointReady = false,
  availableRevertTurnCounts,
  onRevertToTurnCount,
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onSendAppMessage,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  runs: runsProp,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onInitialLayout,
  onIsAtEndChange,
  liveFollowEnabled,
  onViewportAttach,
  onFooterGrow,
  hideEmptyPlaceholder = false,
  emptyPlaceholderInset,
  topFadeEnabled = false,
  historyControls,
}: MessagesTimelineProps) {
  const { language } = useI18n();
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  const navigationThreadKey = textPlaybackNavigation?.threadKey ?? listIdentityKey;
  const createPlaybackSnapshot = (threadKey: string, entries: ReadonlyArray<TimelineEntry>) => ({
    threadKey,
    text: new Map(
      entries.flatMap((entry) =>
        entry.kind === "message"
          ? [[entry.id, entry.message.text] as const]
          : entry.kind === "work" && entry.entry.itemType === "reasoning"
            ? [[entry.id, entry.entry.detail ?? ""] as const]
            : [],
      ),
    ),
    mountedSurfaces: new Set<string>(),
  });
  const createNavigationSnapshot = () =>
    createPlaybackSnapshot(navigationThreadKey, textPlaybackNavigation?.entries ?? timelineEntries);
  const [navigationSnapshot, setNavigationSnapshot] = useState(createNavigationSnapshot);
  let activeNavigationSnapshot = navigationSnapshot;
  if (navigationSnapshot.threadKey !== navigationThreadKey) {
    activeNavigationSnapshot = createNavigationSnapshot();
    setNavigationSnapshot(activeNavigationSnapshot);
  }
  const [playbackSnapshot, setPlaybackSnapshot] = useState(() => activeNavigationSnapshot);
  let mountedPlaybackSnapshot = playbackSnapshot;
  if (playbackSnapshot.threadKey !== listIdentityKey) {
    mountedPlaybackSnapshot =
      activeNavigationSnapshot.threadKey === listIdentityKey
        ? activeNavigationSnapshot
        : createPlaybackSnapshot(listIdentityKey, timelineEntries);
    setPlaybackSnapshot(mountedPlaybackSnapshot);
  }
  const committedPlaybackEntries =
    useRef<TimelineRowSharedState["committedPlaybackEntries"]["current"]>(null);
  const mountedNavigationText = mountedPlaybackSnapshot.text;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed text to playback surfaces, which read it outside render
  useLayoutEffect(() => {
    // Child surfaces read the previous committed data before this effect. Keep
    // the array itself so live deltas do not scan or copy the full history.
    committedPlaybackEntries.current = {
      navigation: mountedNavigationText,
      entries: timelineEntries,
    };
  }, [committedPlaybackEntries, mountedNavigationText, timelineEntries]);
  const createTextHistory = () => ({
    threadKey: listIdentityKey,
    ready: !threadDetailLoading,
    entries: new Set(threadDetailLoading ? [] : timelineEntries.map((entry) => entry.id)),
    newestCreatedAt: threadDetailLoading
      ? ""
      : timelineEntries.reduce(
          (newest, entry) => (entry.createdAt > newest ? entry.createdAt : newest),
          "",
        ),
  });
  const [smoothTextHistory, setSmoothTextHistory] = useState(createTextHistory);
  let paintedTextHistory = smoothTextHistory;
  if (
    smoothTextHistory.threadKey !== listIdentityKey ||
    (!smoothTextHistory.ready && !threadDetailLoading)
  ) {
    // The first loaded snapshot is history, including a stream resumed by navigation.
    paintedTextHistory = createTextHistory();
    setSmoothTextHistory(paintedTextHistory);
  }
  const claimInitialSmoothText = (entryId: string, createdAt: string) => {
    if (!paintedTextHistory.ready || paintedTextHistory.entries.has(entryId)) return false;
    paintedTextHistory.entries.add(entryId);
    // Older pages and virtualized remounts keep their already received text visible.
    return createdAt >= paintedTextHistory.newestCreatedAt;
  };
  // Snapshot restore positions on identity changes; ongoing scroll writes must not move them.
  // Find open at the opening is part of the snapshot: opening find later
  // announces its own navigation (threadFindStore's announceOpening).
  const [listState, setListState] = useState(() => ({
    ...timelineListStateFor(listIdentityKey),
    findOpenAtOpening: findOpen,
  }));
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(
    () => listState.rememberedPosition?.disclosures?.runs ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<ReadonlySet<RunAttemptId>>(
    () => listState.rememberedPosition?.disclosures?.attempts ?? new Set(),
  );
  // A list that opens on a thread with find open takes the opening step below,
  // so the restore runs and releases follow once for find.
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    listState.rememberedPosition?.atEnd === false || findOpen ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  const [restoredEndRequest, setRestoredEndRequest] = useState(0);
  const onRestoredEnd = () => setRestoredEndRequest((request) => request + 1);
  const loadedThreadKeyRef = useRef<string | null>(null);
  const initialLayoutSignaledThreadKeyRef = useRef<string | null>(null);
  const signalInitialLayout = () => {
    if (initialLayoutSignaledThreadKeyRef.current === listIdentityKey) return;
    initialLayoutSignaledThreadKeyRef.current = listIdentityKey;
    onInitialLayout?.();
  };
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [settlingListIdentity, setSettlingListIdentity] = useState<string | null>(listIdentityKey);
  const [playingAudioRows, setPlayingAudioRows] = useState<ReadonlyMap<HTMLAudioElement, string>>(
    () => new Map(),
  );
  const [fullscreenAppRowId, setFullscreenAppRowId] = useState<string | null>(null);
  let paintedExpandedRunIds = expandedRunIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedAttemptIds = expandedAttemptIds;
  const identityChanged = listState.identity !== listIdentityKey;
  const { rememberedPosition, workGroupViewState } = identityChanged
    ? timelineListStateFor(listIdentityKey)
    : listState;
  if (identityChanged) {
    setPlayingAudioRows(new Map());
    setListState({
      identity: listIdentityKey,
      rememberedPosition,
      workGroupViewState,
      findOpenAtOpening: findOpen,
    });
    setPositionedThreadKey(null);
    setSettlingListIdentity(listIdentityKey);
    // A viewer pinned in another thread must not keep live follow off here,
    // nor when that thread comes back.
    setFullscreenAppRowId(null);
    paintedExpandedRunIds = rememberedPosition?.disclosures?.runs ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedAttemptIds = rememberedPosition?.disclosures?.attempts ?? new Set();
    setExpandedRunIds(paintedExpandedRunIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedAttemptIds(paintedExpandedAttemptIds);
  }
  const citationThreadRef = parseScopedThreadKey(routeThreadKey);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const normalizedFindQuery = findQuery.trim();
  const findActive = findExpanded;

  const disclosurePinsEndRef = useRef(false);
  const pinDisclosureToEnd = () => {
    if (!disclosurePinsEndRef.current) return;
    const element = listRef.current?.getScrollableNode();
    if (element) element.scrollTop = element.scrollHeight;
  };

  const scheduleDisclosureSettle = () => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      pinDisclosureToEnd();
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        pinDisclosureToEnd();
        disclosurePinsEndRef.current = false;
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  };

  const suspendEndScrollMaintenanceForDisclosure = (anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey;
    disclosurePinsEndRef.current = resolveTimelineIsAtEnd(listRef.current?.getState()) === true;
    setDisclosureToggleSettling(true);
    scheduleDisclosureSettle();
  };

  const shouldRestoreVisibleContentPosition = (row: MessagesTimelineRow) => {
    if (disclosurePinsEndRef.current) return false;
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  };

  const onToggleTurnFold = (runId: RunId) => {
    suspendEndScrollMaintenanceForDisclosure(`turn-fold:${runId}`);
    setExpandedRunIds((existing) => {
      const next = new Set(existing);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };
  const onToggleWorkGroup = (groupId: string, anchorKey: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey);
    setExpandedWorkGroupIds((existing) => {
      const next = new Set(existing);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };
  const onToggleAttemptFold = (attemptId: RunAttemptId) => {
    suspendEndScrollMaintenanceForDisclosure(`attempt-fold:${attemptId}`);
    setExpandedAttemptIds((existing) => {
      const next = new Set(existing);
      if (next.has(attemptId)) {
        next.delete(attemptId);
      } else {
        next.add(attemptId);
      }
      return next;
    });
  };

  // An interrupted run opens its fold; a newer run closes the previous run's.
  const [observedLatestRun, setObservedLatestRun] = useState({
    identity: listIdentityKey,
    runId: latestRun?.runId,
    status: latestRun?.status,
  });
  if (
    observedLatestRun.identity !== listIdentityKey ||
    observedLatestRun.runId !== latestRun?.runId ||
    observedLatestRun.status !== latestRun?.status
  ) {
    setObservedLatestRun({
      identity: listIdentityKey,
      runId: latestRun?.runId,
      status: latestRun?.status,
    });
    const previousRunId = observedLatestRun.runId;
    if (
      observedLatestRun.identity === listIdentityKey &&
      latestRun &&
      previousRunId !== undefined
    ) {
      if (latestRun.runId === previousRunId) {
        if (observedLatestRun.status === "running" && latestRun.status === "interrupted") {
          setExpandedRunIds((existing) => new Set(existing).add(latestRun.runId));
        }
      } else {
        setExpandedRunIds((existing) => {
          if (!existing.has(previousRunId)) return existing;
          const next = new Set(existing);
          next.delete(previousRunId);
          return next;
        });
      }
    }
  }

  // Imported turns and post-steer work fold under synthetic keys, not the entries' run ids.
  const findFoldRunIds = findActive
    ? timelineTurnFoldRunIdsByEntryId({
        timelineEntries,
        latestRun,
        runningRunId,
        isWorking,
        runlessWorkActive,
      })
    : null;
  const activeFindRunId =
    findActive && activeFindMatch ? findFoldRunIds?.get(activeFindMatch.entryId) : undefined;
  const [expandedFindRunId, setExpandedFindRunId] = useState<RunId | undefined>();
  if (expandedFindRunId !== activeFindRunId) {
    setExpandedFindRunId(activeFindRunId);
    if (activeFindRunId) {
      setExpandedRunIds((previous) =>
        previous.has(activeFindRunId) ? previous : new Set(previous).add(activeFindRunId),
      );
    }
  }
  // A cited response folded inside a turn opens its fold once per activation;
  // the user can fold it again. Only a citation that can still land opens one.
  // The marker stops the O(entries) fold lookup once the entry is found, since
  // the href stays in the URL after the citation settles.
  const [citationExpandedFor, setCitationExpandedFor] = useState<string | null>(null);
  // Back/Forward can restore an earlier activation key, so the marker clears
  // between activations and a revisit opens the fold again.
  if (!citationRequest && citationExpandedFor !== null) setCitationExpandedFor(null);
  const citedEntry =
    citationRequest &&
    citationExpandedFor !== citationRequest.key &&
    citationHistory._tag !== "failed"
      ? timelineEntries.find(
          (entry) =>
            entry.kind === "message" &&
            entry.message.role === "assistant" &&
            entry.message.id === citationRequest.citation.messageId,
        )
      : undefined;
  if (citationRequest && citedEntry) {
    const citedRunId = (
      findFoldRunIds ??
      timelineTurnFoldRunIdsByEntryId({
        timelineEntries,
        latestRun,
        runningRunId,
        isWorking,
        runlessWorkActive,
      })
    ).get(citedEntry.id);
    setCitationExpandedFor(citationRequest.key);
    if (citedRunId) {
      setExpandedRunIds((previous) =>
        previous.has(citedRunId) ? previous : new Set(previous).add(citedRunId),
      );
    }
    const citedAttempt = citedEntry.attempt;
    if (citedAttempt?.status === "superseded") {
      setExpandedAttemptIds((previous) =>
        previous.has(citedAttempt.id) ? previous : new Set(previous).add(citedAttempt.id),
      );
    }
  }
  const visibleExpandedRunIds =
    !activeFindRunId || paintedExpandedRunIds.has(activeFindRunId)
      ? paintedExpandedRunIds
      : new Set(paintedExpandedRunIds).add(activeFindRunId);

  const activeFindAttemptId = activeFindMatch
    ? timelineEntries.find((entry) => entry.id === activeFindMatch.entryId)?.attempt?.id
    : undefined;
  const [expandedFindAttemptId, setExpandedFindAttemptId] = useState<RunAttemptId | undefined>();
  if (expandedFindAttemptId !== activeFindAttemptId) {
    setExpandedFindAttemptId(activeFindAttemptId);
    if (activeFindAttemptId) {
      setExpandedAttemptIds((previous) =>
        previous.has(activeFindAttemptId) ? previous : new Set(previous).add(activeFindAttemptId),
      );
    }
  }
  const visibleExpandedAttemptIds =
    activeFindAttemptId && !paintedExpandedAttemptIds.has(activeFindAttemptId)
      ? new Set(paintedExpandedAttemptIds).add(activeFindAttemptId)
      : paintedExpandedAttemptIds;

  const pendingApprovalsByRequestId = new Map(
    pendingApprovals
      .filter((approval) => !heldApprovalRequestIds?.has(approval.requestId))
      .map((approval) => [approval.requestId, approval]),
  );
  const pendingApprovalRequestIds = new Set(pendingApprovalsByRequestId.keys());
  const rawRows = useIncrementalTimelineRows(`${listIdentityKey}\0${workspaceRoot ?? ""}`, {
    timelineEntries,
    activeProviderTurnId,
    pendingApprovalRequestIds,
    latestRun,
    runningRunId,
    expandedRunIds: visibleExpandedRunIds,
    expandedAttemptIds: visibleExpandedAttemptIds,
    expandedWorkGroupIds,
    isWorking,
    smoothStreaming,
    runlessWorkActive,
    activeTurnStartedAt,
    conversationStructure,
    turnDiffSummaries,
    supportsConversationRollback,
    threadStartCheckpointReady,
    availableRevertTurnCounts,
    worktreeSetup,
  });
  const rows = useStableRows(rawRows, listIdentityKey);
  const tailAssistantEntry = timelineEntries.findLast(
    (entry) => entry.kind === "message" && entry.message.role === "assistant",
  );
  const tailMessageId =
    tailAssistantEntry?.kind === "message" ? tailAssistantEntry.message.id : null;
  const createStatusHistory = () => ({
    thread: listIdentityKey,
    working: isWorking,
    run: latestRun?.runId ?? null,
    awaitingRun: isWorking && latestRun?.status !== "running",
    turn: 0,
    seen: new Set(isWorking ? ["working", "thinking"] : []),
  });
  const [statusHistory, setStatusHistory] = useState(createStatusHistory);
  let activeStatusHistory = statusHistory;
  const statusRun = latestRun?.runId ?? null;
  if (statusHistory.thread !== listIdentityKey) {
    activeStatusHistory = createStatusHistory();
  } else if (statusHistory.working !== isWorking || statusHistory.run !== statusRun) {
    const started = !statusHistory.working && isWorking;
    const assigned = statusRun !== null && statusRun !== statusHistory.run;
    const newTurn =
      started || (assigned && statusHistory.run !== null && !statusHistory.awaitingRun);
    activeStatusHistory = {
      ...statusHistory,
      working: isWorking,
      run: statusRun,
      // An optimistic status may acquire its new run/startedAt after appearing.
      awaitingRun: started ? !assigned : assigned || !isWorking ? false : statusHistory.awaitingRun,
      turn: statusHistory.turn + (newTurn ? 1 : 0),
      seen: newTurn ? new Set<string>() : statusHistory.seen,
    };
  }
  if (activeStatusHistory !== statusHistory) setStatusHistory(activeStatusHistory);
  const statusEntranceIdentity = `${listIdentityKey}:${activeStatusHistory.turn}`;
  const statusEntranceEnabled = smoothStreaming && !prefersReducedMotion && !threadDetailLoading;
  const seenStatusEntrances = activeStatusHistory.seen;
  const claimStatusEntrance = (identity: string) => {
    const kind = identity.slice(identity.lastIndexOf(":") + 1);
    if (seenStatusEntrances.has(kind)) return false;
    seenStatusEntrances.add(kind);
    return true;
  };
  // The restructured shape pins the live label out of the virtualized rows so it
  // cannot be measured, recycled, or displaced as body rows grow. Those rows
  // leave the list and render in the footer instead, still inside the scroll
  // container. Under "default" both arrays are the full projection, unchanged.
  const [listRows, liveActivityRows] = (() => {
    if (conversationStructure !== "restructured") return [rows, EMPTY_LIVE_ACTIVITY_ROWS];
    const list: MessagesTimelineRow[] = [];
    const live: TimelineLiveActivityRow[] = [];
    const liveDetailsIds = new Set(
      rows.flatMap((row) => (row.kind === "work-live" ? [`${row.groupId}:details`] : [])),
    );
    for (const row of rows) {
      if (
        row.kind === "thinking" ||
        row.kind === "work-live" ||
        (row.kind === "work" && liveDetailsIds.has(row.id))
      )
        live.push(row);
      else list.push(row);
    }
    // Never hand LegendList a fresh array when nothing was filtered out, so the
    // default path keeps its reference identity across renders.
    return [live.length === 0 ? rows : list, live];
  })();
  // Content changes must not reset the virtualizer's positions for every historical row.
  const structuralRows = useStructuralRows(listRows, listIdentityKey);
  const rowData = (() => new Map(listRows.map((row) => [row.id, row])))();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an empty thread has no list load event, so its first layout is signalled here
  useLayoutEffect(() => {
    if (rows.length !== 0) return;
    loadedThreadKeyRef.current = listIdentityKey;
    if (!restoringThreadPosition) signalInitialLayout();
  }, [listIdentityKey, restoringThreadPosition, rows.length, signalInitialLayout]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- signals the first layout once a loaded thread's restore finishes
  useLayoutEffect(() => {
    if (loadedThreadKeyRef.current === listIdentityKey && !restoringThreadPosition) {
      signalInitialLayout();
    }
  }, [listIdentityKey, restoringThreadPosition, signalInitialLayout]);
  const unmatchedPendingApprovals = new Map(pendingApprovalsByRequestId);
  if (unmatchedPendingApprovals.size > 0) {
    for (const row of rows) {
      const entries =
        row.kind === "work" ? row.groupedEntries : row.kind === "work-live" ? [row.entry] : [];
      for (const entry of entries) {
        const item = entry.projectedItem?.item;
        if (item?.type === "approval_request") unmatchedPendingApprovals.delete(item.requestId);
      }
    }
  }
  // Run status/timestamps change per stream event; keep them out of shared row context.
  const runs = useStableHandoffRuns(runsProp);
  // Marker identities and positions follow the virtualizer's stable structure;
  // an open preview reads current text from the independent row data context.
  const minimapItems = (() => deriveTimelineMinimapItems(structuralRows))();
  const onSelectMinimapItem = (item: TimelineMinimapItem) => {
    navigateTimeline();
    void listRef.current?.scrollToIndex({
      index: item.rowIndex,
      animated: true,
      viewOffset: 24,
    });
  };
  const minimapRowIndices = minimapItems.map((item) => item.rowIndex);
  const restoreRowIndex =
    restoringThreadPosition && rememberedPosition?.atEnd === false
      ? listRows.findIndex((row) => row.id === rememberedPosition.rowId)
      : -1;
  const restoringAlwaysRender =
    restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined;
  const showsEmptyState =
    rows.length === 0 &&
    unmatchedPendingApprovals.size === 0 &&
    !isWorking &&
    parentThreadLink === null &&
    historyControls === undefined &&
    footer === null;
  const [listOpening, setListOpening] = useState<TimelineListOpening>(() =>
    nextListOpening({ mounted: false }, !showsEmptyState, listIdentityKey),
  );
  const nextOpening = nextListOpening(listOpening, !showsEmptyState, listIdentityKey);
  if (nextOpening !== listOpening) setListOpening(nextOpening);
  const listOpenedOn = nextOpening.mounted ? nextOpening.identity : null;
  const viewportRef = useRef<TimelineViewport | null>(null);
  const navigateTimeline = () => viewportRef.current?.navigate({ releasesFollow: true });
  const restoreReady = restoringThreadPosition && rows.length > 0;
  // Z: syncs LegendList's scroll position with which thread it shows. The list
  // is not keyed per thread and reports no "new data" event, and the restore
  // must land before paint, after LegendList's own layout effects applied the
  // new data. A citation request that arrives mid-restore takes over.
  const { findOpenAtOpening } = identityChanged ? { findOpenAtOpening: findOpen } : listState;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores LegendList's scroll position for the shown thread before paint, after the list's own layout
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!restoreReady || !list || !viewport) return;
    return startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey,
      listOpenedOn,
      rememberedPosition,
      citationPending: citationRequest !== null,
      releaseForFind: findOpenAtOpening,
      onPositioned: setPositionedThreadKey,
      onRestoredEnd: smoothStreaming ? onRestoredEnd : undefined,
    });
  }, [
    smoothStreaming,
    onRestoredEnd,
    citationRequest,
    findOpenAtOpening,
    listIdentityKey,
    listOpenedOn,
    listRef,
    rememberedPosition,
    restoreReady,
    viewportRef,
  ]);

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  // Native scroll element behind LegendList, for the overlay scrollbar and smooth follow.
  // The list ref callback sets it, so it follows the scroll node's lifetime.
  const [timelineScrollableNode, setTimelineScrollableNode] = useState<HTMLElement | null>(null);
  const previousNativeViewportRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the previous viewport's scroll sample when the thread or scroll node changes
  useLayoutEffect(() => {
    previousNativeViewportRef.current = null;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- 线程和滚动容器切换时丢弃上一视口的滚动采样。
  }, [listIdentityKey, timelineScrollableNode]);
  const {
    target: readyCitationRequest,
    positioning: citationPositioning,
    onListLoad: onCitationListLoad,
    alwaysRender: citationAlwaysRender,
  } = useAssistantCitationTarget({
    request: citationRequest,
    phase: citationRequest
      ? resolveCitationPhase({
          history: citationHistory,
          messageId: citationRequest.citation.messageId,
          entries: timelineEntries,
          rows,
        })
      : null,
    viewport: timelineViewportElement,
    onManualNavigation: navigateTimeline,
  });
  const onTimelineLoad = () => {
    onCitationListLoad();
    loadedThreadKeyRef.current = listIdentityKey;
    if (!restoringThreadPosition) signalInitialLayout();
  };
  const [findListReady, setFindListReady] = useState(false);
  const handleListLoad = () => {
    onTimelineLoad();
    setFindListReady(true);
  };
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  // Every full-screen viewer reports false when it unmounts, so a row that leaves the list
  // while full screen releases its pin too.
  const onAppFullscreenChange = (rowId: string, fullscreen: boolean) => {
    setFullscreenAppRowId((current) => (fullscreen ? rowId : current === rowId ? null : current));
  };
  const alwaysRenderIndices = restoringAlwaysRender?.indices ?? [];
  // Screen readers can only reach headings in the DOM. Keeping the first and
  // last messages mounted lets heading navigation wrap to either end.
  const firstMessageRow = rows.find(isMessageRow);
  const lastMessageRow = rows.findLast(isMessageRow);
  const alwaysRenderKeys = [
    ...(firstMessageRow ? [firstMessageRow.id] : []),
    ...(lastMessageRow && lastMessageRow !== firstMessageRow ? [lastMessageRow.id] : []),
    ...(citationAlwaysRender?.keys ?? []),
    ...(fullscreenAppRowId === null ? [] : [fullscreenAppRowId]),
    ...new Set(
      [...playingAudioRows].filter(([audio]) => audio.isConnected).map(([, rowId]) => rowId),
    ),
  ];
  const alwaysRender =
    alwaysRenderIndices.length === 0 && alwaysRenderKeys.length === 0
      ? undefined
      : {
          ...(alwaysRenderIndices.length === 0 ? {} : { indices: alwaysRenderIndices }),
          ...(alwaysRenderKeys.length === 0 ? {} : { keys: alwaysRenderKeys }),
        };
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = (info: { anchorIndex: number | undefined }) => {
    if (anchorMessageId !== null && info.anchorIndex !== undefined) {
      onAnchorReady(anchorMessageId, info.anchorIndex);
    }
  };
  const handleAnchorSizeChanged = (size: number) => {
    if (anchorMessageId !== null) {
      onAnchorSizeChanged(anchorMessageId, size);
    }
  };
  const anchoredEndSpace = (() => {
    const config = resolveChatListAnchoredEndSpace(
      rows,
      anchorMessageId,
      (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
      { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
    );
    return config
      ? { ...config, onReady: handleAnchorReady, onSizeChanged: handleAnchorSizeChanged }
      : undefined;
  })();
  const maintainVisibleContentPosition = (() => ({
    data: true,
    size: true,
    shouldRestorePosition: shouldRestoreVisibleContentPosition,
  }))();
  const timelineFooterRef = useRef<HTMLDivElement | null>(null);
  const tailAnchors = useRef(new Set<HTMLElement>());

  const localSmoothScrollRef = useRef<SmoothScrollHandle | null>(null);
  const smoothFollowControl = smoothScrollRef ?? localSmoothScrollRef;
  // Save before the smooth controller's cleanup clears its follow state.
  // Shrinking to a non-scrollable list need not dispatch a scroll event.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the reading position when the shown list goes away
  useLayoutEffect(
    () => () => {
      // Leaving during restoration must retain the saved destination, not
      // replace it with an estimated offset from the still-loading list.
      if (restoringThreadPosition || listRef.current?.getState().data !== structuralRows) return;
      const position = readTimelinePosition(listIdentityKey);
      const element = listRef.current?.getScrollableNode();
      if (!position || !element) return;
      rememberTimelinePosition(
        listIdentityKey,
        {
          ...position,
          scrollOffset: element.scrollTop,
          atEnd: smoothFollowControl.current?.isFollowing() || resolveTimelineDomIsAtEnd(element),
        },
        liveFollowEnabled && !anchoredEndSpace,
      );
    },
    [
      listIdentityKey,
      listRef,
      restoringThreadPosition,
      structuralRows,
      smoothFollowControl,
      liveFollowEnabled,
      anchoredEndSpace,
    ],
  );
  const [smoothFollowing, setSmoothFollowing] = useState(false);
  const smoothFollowEnabled =
    smoothStreaming &&
    timelineScrollableNode !== null &&
    liveFollowEnabled &&
    !citationPositioning &&
    !restoringThreadPosition &&
    !anchoredEndSpace &&
    !disclosureToggleSettling &&
    settlingListIdentity === null;
  const layoutRef = useRef<ReturnType<typeof createTimelineLayout> | null>(null);
  const [layoutState, setLayoutState] = useState(() => ({
    identity: listIdentityKey,
    layout: createTimelineListLayout(),
  }));
  const listLayout =
    layoutState.identity === listIdentityKey ? layoutState.layout : createTimelineListLayout();
  if (layoutState.identity !== listIdentityKey)
    setLayoutState({ identity: listIdentityKey, layout: listLayout });
  const layoutCommitRef = useRef<((request: TimelineLayoutCommitRequest) => void) | null>(null);
  const requestTimelineLayout = () => layoutRef.current?.request();
  const registerTailAnchor = (element: HTMLElement) => {
    tailAnchors.current.add(element);
    layoutRef.current?.request();
    return () => {
      tailAnchors.current.delete(element);
      element.style.removeProperty("translate");
      layoutRef.current?.request();
    };
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the smooth layout scheduler attached to the scroll node
  useLayoutEffect(() => {
    if (!smoothStreaming || !timelineScrollableNode) return;
    const layout = createTimelineLayout(timelineScrollableNode, {
      list: () => listRef.current,
      footer: () => timelineFooterRef.current,
      tails: () => tailAnchors.current,
      control: () => smoothFollowControl.current,
      requestCommit: (generation) => layoutCommitRef.current?.({ owner: layout, generation }),
      synchronous: flushSync,
    });
    layoutRef.current = layout;
    return () => {
      layout.dispose();
      if (layoutRef.current === layout) layoutRef.current = null;
    };
  }, [
    layoutCommitRef,
    layoutRef,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- 同一容器切换线程时也必须重建布局调度器。
    listIdentityKey,
    listRef,
    smoothFollowControl,
    smoothStreaming,
    tailAnchors,
    timelineFooterRef,
    timelineScrollableNode,
  ]);
  const requestSmoothFollow = useSmoothScroll({
    element: timelineScrollableNode,
    enabled: smoothFollowEnabled,
    identity: listIdentityKey,
    reducedMotion: prefersReducedMotion,
    controlRef: smoothFollowControl,
    footerRef: timelineFooterRef,
    endRequest: smoothEndRequest + restoredEndRequest,
    onDetach: navigateTimeline,
    onFollowingChange: setSmoothFollowing,
    onLayoutRequest: requestTimelineLayout,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-measures the smooth follow target after rows or the composer inset change
  useLayoutEffect(() => {
    requestSmoothFollow();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- 行内容和输入区占位变化后需要重新测量末尾位置。
  }, [requestSmoothFollow, rows, contentInsetEndAdjustment, smoothFollowEnabled]);

  const measureLiveFooterHeight = () =>
    liveActivityRows.length > 0
      ? Math.max(
          0,
          (timelineFooterRef.current?.offsetHeight ?? 0) -
            (anchoredEndSpace ? 0 : contentInsetEndAdjustment),
        )
      : 0;
  const measureContentOverflow = () =>
    timelineContentOverflowsViewport(listRef.current?.getState?.(), {
      composerInset: contentInsetEndAdjustment,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      footerHeight: measureLiveFooterHeight(),
    });
  // LegendList lays rows out from layout effects, so a read on the next frame
  // sees the settled positions.
  const contentOverflowFrameRef = useRef<number | null>(null);
  const cancelContentOverflowFrame = () => {
    if (contentOverflowFrameRef.current !== null) {
      cancelAnimationFrame(contentOverflowFrameRef.current);
      contentOverflowFrameRef.current = null;
    }
  };
  const reportContentOverflow = () => {
    if (!onContentOverflowChange || contentOverflowFrameRef.current !== null) return;
    contentOverflowFrameRef.current = requestAnimationFrame(() => {
      contentOverflowFrameRef.current = null;
      onContentOverflowChange(measureContentOverflow(), measureLiveFooterHeight());
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending overflow measurement frame on unmount
  useEffect(() => cancelContentOverflowFrame, [cancelContentOverflowFrame]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports overflow measured from LegendList's laid-out rows
  useLayoutEffect(() => {
    cancelContentOverflowFrame();
    onContentOverflowChange?.(
      rows.length > 0 && measureContentOverflow(),
      measureLiveFooterHeight(),
    );
  }, [
    cancelContentOverflowFrame,
    measureContentOverflow,
    measureLiveFooterHeight,
    onContentOverflowChange,
    rows.length,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the live activity footer, which the list does not measure
  useLayoutEffect(() => {
    const footer = timelineFooterRef.current;
    if (!footer || liveActivityRows.length === 0) return;
    return observeResize(footer, () => {
      requestTimelineLayout();
      reportContentOverflow();
    });
  }, [liveActivityRows.length, reportContentOverflow, requestTimelineLayout, timelineFooterRef]);

  const liveFooterStyle = (() => {
    if (liveActivityRows.length === 0) return undefined;
    if (smoothFollowEnabled && smoothFollowing) return TIMELINE_LIVE_FOOTER_STYLE;
    // New-turn framing owns the viewport until the footer reaches this same
    // edge. Reserve the composer gap before switching to native end-follow.
    if (
      smoothStreaming &&
      liveFollowEnabled &&
      anchoredEndSpace &&
      !restoringThreadPosition &&
      !citationPositioning
    ) {
      return { ...TIMELINE_LIVE_FOOTER_STYLE, bottom: contentInsetEndAdjustment };
    }
    return undefined;
  })();

  const detectNativeNavigation = () => {
    const scrollElement = listRef.current?.getScrollableNode();
    if (!scrollElement) return;
    const previous = previousNativeViewportRef.current;
    const viewport = {
      scrollTop: scrollElement.scrollTop,
      scrollHeight: scrollElement.scrollHeight,
      clientHeight: scrollElement.clientHeight,
    };
    previousNativeViewportRef.current = viewport;
    // Programmatic scrollTop writes also produce trusted native scroll events. Explicit
    // gestures cancel synchronously; this fallback only treats an upward move through unchanged
    // geometry as navigation. Fractional compensation can clamp an owned offset by a pixel
    // without changing scrollHeight; the controller already adopted that write.
    if (
      shouldCancelTimelineFollowOnNativeScroll({
        smoothStreaming,
        liveFollowEnabled,
        nativeIsAtEnd: resolveTimelineDomIsAtEnd(viewport),
        previousScrollTop: previous?.scrollTop ?? null,
        scrollTop: viewport.scrollTop,
        layoutChanged:
          previous?.scrollHeight !== viewport.scrollHeight ||
          previous?.clientHeight !== viewport.clientHeight,
        blockedByProgrammaticPositioning:
          smoothFollowControl.current?.isFollowing() ||
          citationPositioning ||
          restoringThreadPosition ||
          anchoredEndSpace !== undefined ||
          disclosureToggleSettling ||
          settlingListIdentity !== null,
      })
    ) {
      navigateTimeline();
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to native scrolls before LegendList publishes its end state
  useLayoutEffect(() => {
    detectNativeNavigation();
    // Capture before LegendList handles the event and publishes its end state.
    timelineScrollableNode?.addEventListener("scroll", detectNativeNavigation, {
      capture: true,
      passive: true,
    });
    return () =>
      timelineScrollableNode?.removeEventListener("scroll", detectNativeNavigation, true);
  }, [detectNativeNavigation, timelineScrollableNode]);

  const refreshMinimap = useStableCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== structuralRows) return;
    if (!state || minimapItems.length === 0) {
      return;
    }

    const firstBufferedIndex = state.startBuffered;
    const firstBufferedRow: HTMLElement | undefined =
      firstBufferedIndex == null ? undefined : state.elementAtIndex(firstBufferedIndex);
    const firstBufferedTop =
      firstBufferedIndex == null ? undefined : state.positionAtIndex(firstBufferedIndex);
    const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
    // Cached row positions exclude the header and pending scroll adjustments.
    const scroll =
      firstBufferedRow && viewport && firstBufferedTop !== undefined
        ? firstBufferedTop +
          viewport.getBoundingClientRect().top -
          firstBufferedRow.getBoundingClientRect().top
        : state.scroll;
    const visibleRange = resolveTimelineMinimapVisibleRange({ ...state, scroll });
    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      const inView = isTimelineMinimapRowVisible(
        item.rowIndex,
        visibleRange.start,
        visibleRange.end,
      );
      const next = inView ? "true" : "false";
      // Avoid dirtying style state on every scroll tick for unchanged strips.
      if (strip && strip.dataset.inView !== next) {
        strip.dataset.inView = next;
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      visibleStart: visibleRange.start,
      visibleEnd: visibleRange.end,
      rowIndices: minimapRowIndices,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  });

  const minimapRefreshFrameRef = useRef<number | null>(null);
  const scheduleMinimapRefresh = () => {
    if (minimapRefreshFrameRef.current !== null) return;
    // LegendList recycles row containers before React commits their positions.
    minimapRefreshFrameRef.current = requestAnimationFrame(() => {
      minimapRefreshFrameRef.current = null;
      refreshMinimap();
    });
  };

  // The measurement the last remember wrote, so a follow release can rewrite
  // it without reading render state from a listener.
  const lastRememberedRef = useRef<{
    readonly data: unknown;
    readonly threadKey: string;
    readonly position: Parameters<typeof rememberTimelinePosition>[1];
  } | null>(null);
  const rememberPosition = (followingEnd: boolean) => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== structuralRows) return;
    const scrollElement = listRef.current?.getScrollableNode();
    const nativeIsAtEnd = scrollElement
      ? (smoothFollowControl.current?.isFollowing() && smoothFollowControl.current.isAtEdge()) ||
        resolveTimelineDomIsAtEnd(scrollElement)
      : undefined;
    // Smooth output follows the real DOM edge. LegendList's near-end band must not
    // re-arm live follow after a reader has scrolled up.
    const isAtEnd =
      smoothStreaming && nativeIsAtEnd !== undefined
        ? nativeIsAtEnd
        : resolveTimelineIsAtEnd(state);
    const position = state.data.length ? resolveWorkGroupScrollAnchor(state) : undefined;
    if (position && isAtEnd !== undefined) {
      const index = state.indexByKey(position.rowId);
      const row = index === undefined ? undefined : state.elementAtIndex(index);
      const element = listRef.current?.getScrollableNode();
      if (row && element) {
        const measured = {
          ...position,
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: smoothFollowControl.current?.isFollowing() || isAtEnd,
          disclosures: {
            runs: paintedExpandedRunIds,
            workGroups: paintedExpandedWorkGroupIds,
            attempts: paintedExpandedAttemptIds,
            workGroupState: workGroupViewState,
          },
        };
        lastRememberedRef.current = {
          data: structuralRows,
          threadKey: listIdentityKey,
          position: measured,
        };
        rememberTimelinePosition(listIdentityKey, measured, followingEnd);
      }
    }
    return isAtEnd;
  };
  // A follow release without a scroll after it would leave the position
  // remembered as following.
  const rememberReleasedPosition = () => {
    const last = lastRememberedRef.current;
    if (last && listRef.current?.getState().data === last.data) {
      rememberTimelinePosition(last.threadKey, last.position, false);
    }
  };

  const handleScroll = () => {
    if (restoringThreadPosition || listRef.current?.getState?.().data !== structuralRows) return;
    const isAtEnd = rememberPosition(liveFollowEnabled && !anchoredEndSpace);
    if (isAtEnd !== undefined && !citationPositioning) {
      onIsAtEndChange(isAtEnd);
    }
    scheduleMinimapRefresh();
  };

  const handleItemSizeChanged = (info: { itemKey: string; size: number }) => {
    listLayout.itemSizeChanged(layoutRef.current, info);
    requestSmoothFollow();
    if (disclosurePinsEndRef.current) {
      queueMicrotask(pinDisclosureToEnd);
      scheduleDisclosureSettle();
    }
    scheduleMinimapRefresh();
  };

  // Step triangles at the ends of the overlay scrollbar. A click eases ~30% of
  // the viewport; the overlay advances scrollTop continuously for a hold.
  const handleScrollbarStep = (direction: -1 | 1) => {
    const element = listRef.current?.getScrollableNode();
    if (!element || typeof element.scrollBy !== "function") {
      return;
    }
    element.scrollBy({
      top: direction * element.clientHeight * TIMELINE_SCROLLBAR_STEP_RATIO,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  };

  const measureTimelineGutter = (viewportElement: HTMLElement) => {
    const viewportWidth = viewportElement.getBoundingClientRect().width;
    const contentWidth =
      viewportElement.querySelector<HTMLElement>("[data-timeline-root]")?.getBoundingClientRect()
        .width ?? viewportWidth;
    const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
      viewportWidth,
      contentWidth,
    );
    setMinimapHasPersistentGutter((current) =>
      current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
    );
    setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth));
  };
  // Rows added, removed or rewrapped (chat width) change the content size,
  // which moves the scroll position, the overflow, and the content lane width.
  const handleContentSizeChanged = useStableCallback((laidOutData: unknown) => {
    // The first laid-out content of a newly shown thread ends its settling; a
    // frame the previous thread scheduled laid out the previous thread's rows.
    if (laidOutData === structuralRows) {
      setSettlingListIdentity((current) => (current === listIdentityKey ? null : current));
    }
    handleScroll();
    reportContentOverflow();
  });
  // The content lane only changes width with the viewport or the chat width
  // setting, never with streamed content; measuring per content frame would
  // force a layout on every chunk.
  const measuredLaneWidthRef = useRef<number | null>(null);
  const observeLaneWidth = (lane: HTMLDivElement | null) => {
    if (!lane) return;
    return observeResize(lane, (entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width === undefined || width === measuredLaneWidthRef.current) return;
      measuredLaneWidthRef.current = width;
      const viewportElement = lane.closest<HTMLElement>("[data-assistant-citation-viewport]");
      if (viewportElement) measureTimelineGutter(viewportElement);
    });
  };
  const attachTimelineViewportElement = (viewportElement: HTMLDivElement | null) => {
    setTimelineViewportElement(viewportElement);
    if (!viewportElement) return;
    const stopObserving = observeResize(viewportElement, () => {
      measureTimelineGutter(viewportElement);
      reportContentOverflow();
    });
    return () => {
      stopObserving();
      setTimelineViewportElement(null);
    };
  };

  const sharedState = (() =>
    ({
      pendingApprovals: pendingApprovalsByRequestId,
      respondingRequestIds,
      canOperateThread,
      onRespondToApproval,
      conversationStructure,
      smoothStreaming,
      smoothOutputMode,
      smoothOutputLineMode,
      smoothMarkdownPreload,
      smoothTextFadeDurationMs,
      smoothTextYieldDurationMs,
      statusEntranceIdentity,
      statusEntranceEnabled,
      claimStatusEntrance,
      tailMessageId,
      registerTailAnchor,
      footnotesAutoCollapse,
      textPlayback,
      mountedText: mountedPlaybackSnapshot.text,
      mountedPlaybackSurfaces: mountedPlaybackSnapshot.mountedSurfaces,
      committedPlaybackEntries,
      claimInitialSmoothText,
      citationRequest: readyCitationRequest,
      listRef,
      timestampFormat,
      language,
      routeThreadKey,
      // Keep Markdown callbacks memoized during unrelated activity updates.
      threadRef: citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      workflowOpening,
      runs,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      onRunShellCommand,
      findActive,
      onImageExpand,
      onFileOpen,
      onUseArtifactTemplate,
      onSendAppMessage,
      onAppFullscreenChange,
      onFileDownload,
      openPullRequest,
      onOpenToolDiff,
      onOpenTurnDiff,
      onOpenThread,
      renderHtmlRender,
      turnItemSource,
      onForkFromRun,
      onToggleTurnFold,
      onToggleAttemptFold,
      onToggleWorkGroup,
      onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
      onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
      retryableWorkspacePreparationRunIds,
      onRetryWorkspacePreparation: onRetryWorkspacePreparation ?? null,
      onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
      onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
      workGroupViewState,
    }) satisfies TimelineRowSharedState)();
  const compactionAwaitingRow =
    isCompacting &&
    !rows.some(
      (row) =>
        (row.kind === "context-compaction" && row.active) ||
        (row.kind === "working" && row.compacting),
    );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestRun?.startedAt != null
      ? worktreeSetup
      : null;
  const activityState: TimelineRowActivityState = {
    isWorking,
    isCompacting: compactionAwaitingRow,
    isRevertingCheckpoint,
    backgroundWorktreeSetup,
    awaitingUser: awaitingUser !== null,
    isPreparingWorktree,
    latestRunId: latestRun?.runId ?? null,
    latestRunStatus: latestRun?.status ?? null,
    conversationStructureIdleLabel,
    conversationStructureThinkingLabel,
  };
  // Mounted in both the empty and filled timeline so a thread's first turn
  // starts from a baseline instead of a fresh, silent region.
  const activityAnnouncer = (
    <ThreadActivityAnnouncer
      threadKey={announceTurnStatus ? listIdentityKey : null}
      status={awaitingUser ?? (isWorking ? "working" : "idle")}
      requestId={awaitingRequestId}
      runId={announcedRun?.runId ?? null}
      runStatus={announcedRun?.status ?? null}
      detailBehind={detailBehindShell}
    />
  );
  const listHeaderLeadingContent =
    parentThreadLink === null ? (
      topFadeEnabled ? (
        TIMELINE_LIST_FADE_HEADER
      ) : (
        TIMELINE_LIST_HEADER
      )
    ) : (
      <div className="messages-timeline-row-frame">
        <div className="chat-content-lane pt-1 sm:pt-2">
          <TimelineSystemDivider
            label="Subagent of"
            detail={
              parentThreadLink.environmentLabel === undefined
                ? parentThreadLink.title
                : `${parentThreadLink.title} on ${parentThreadLink.environmentLabel}`
            }
            icon={BotIcon}
            {...(parentThreadLink.open === undefined
              ? {}
              : { actionLabel: "Open parent thread", onAction: parentThreadLink.open })}
          />
        </div>
      </div>
    );
  const listHeader = (
    <>
      {parentThreadLink === null ? listHeaderLeadingContent : null}
      {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
      {parentThreadLink !== null ? listHeaderLeadingContent : null}
    </>
  );

  const canvas = useChatCanvas();
  const registerTimeline = canvas?.registerTimeline;
  const notifyHostNavigation = useStableCallback((navigation: TimelineNavigation) => {
    const state = () => listRef.current?.getState?.();
    if (
      navigationReleasesFollow(navigation, {
        contentScrollsUp: () =>
          timelineContentOverflowsViewport(state(), {
            composerInset: contentInsetEndAdjustment,
            anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
          }),
        awayFromEnd: () => resolveTimelineIsAtEnd(state()) === false,
      })
    ) {
      // A reader who leaves the end while a disclosure settles keeps their position.
      disclosurePinsEndRef.current = false;
      onManualNavigation?.();
    }
  });
  // Stable so the list attaches once per mount, not on every render.
  const setTimelineList = useStableCallback((list: LegendListRef | null) => {
    listRef.current = list;
    const scrollNode: HTMLElement | null = list?.getScrollableNode() ?? null;
    registerTimeline?.(scrollNode);
    setTimelineScrollableNode(scrollNode);
    onScrollableNodeChange?.(scrollNode);
    const viewport = scrollNode ? attachTimelineViewport(scrollNode) : null;
    viewportRef.current = viewport;
    const detachViewport = viewport ? onViewportAttach?.(viewport) : undefined;
    const stopHostNavigation = viewport?.subscribe(notifyHostNavigation);
    const stopRememberingRelease = viewport?.onFollowReleased(rememberReleasedPosition);
    let contentSizeFrame: number | null = null;
    // LegendList lays rows out from layout effects; the next frame sees them settled.
    let scheduledData: unknown = null;
    const scheduleContentSizeChanged = () => {
      if (!list) return;
      const laidOutData = list.getState().data;
      if (contentSizeFrame !== null) {
        if (scheduledData === laidOutData) return;
        cancelAnimationFrame(contentSizeFrame);
      }
      scheduledData = laidOutData;
      contentSizeFrame = requestAnimationFrame(() => {
        contentSizeFrame = null;
        handleContentSizeChanged(laidOutData);
      });
    };
    const stopListeningToContentSize = list
      ?.getState()
      .listen("totalSize", () => scheduleContentSizeChanged());
    scheduleContentSizeChanged();
    return () => {
      stopListeningToContentSize?.();
      stopRememberingRelease?.();
      stopHostNavigation?.();
      if (contentSizeFrame !== null) cancelAnimationFrame(contentSizeFrame);
      detachViewport?.();
      viewport?.dispose();
      if (viewportRef.current === viewport) viewportRef.current = null;
      // Refresh frames only read the list; disclosure frames still run so the
      // settle flag clears.
      if (minimapRefreshFrameRef.current !== null) {
        cancelAnimationFrame(minimapRefreshFrameRef.current);
        minimapRefreshFrameRef.current = null;
      }
      listRef.current = null;
      registerTimeline?.(null);
      setTimelineScrollableNode(null);
      onScrollableNodeChange?.(null);
    };
  });

  useThreadFindPositionReader({
    threadKey: listIdentityKey,
    navigate: navigateTimeline,
    timelineViewportElement,
    findFoldRunIds,
    timelineEntries,
    latestRun,
    runningRunId,
    isWorking,
    runlessWorkActive,
    rows,
    contentInsetEndAdjustment,
  });

  useThreadFindNavigation({
    // Find reveals its match only after the opening restore settles; both
    // scroll the list directly, so the restore would otherwise pull it back.
    listReady: findListReady && !restoringThreadPosition,
    historyControls,
    entries: timelineEntries,
    container: timelineViewportElement,
    query: normalizedFindQuery,
    match: activeFindMatch,
    navigationId: findNavigationId,
    rowIndex: activeFindMatch ? rows.findIndex((row) => row.id === activeFindMatch.entryId) : -1,
    listRef,
    contentInsetEndAdjustment,
  });

  // LegendList moves rows one commit late; per-row providers prevent thread context leaks.
  const onAudioPlaybackChange = (rowId: string, event: SyntheticEvent) => {
    const audio = event.target;
    if (!(audio instanceof HTMLAudioElement)) return;
    setPlayingAudioRows((current) => {
      const playing = !audio.paused && !audio.ended;
      if (playing === current.has(audio)) return current;
      const next = new Map(current);
      if (playing) next.set(audio, rowId);
      else next.delete(audio);
      return next;
    });
  };
  const onAudioUnmount = useStableCallback((audio: HTMLAudioElement) => {
    setPlayingAudioRows((current) => {
      if (!current.has(audio)) return current;
      const next = new Map(current);
      next.delete(audio);
      return next;
    });
  });
  const renderItem = ({ item }: { item: MessagesTimelineRow }) => (
    <TimelineRowCtx value={sharedState}>
      <div
        className="messages-timeline-row-frame"
        onPlayCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onPauseCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onEndedCapture={(event) => onAudioPlaybackChange(item.id, event)}
      >
        <div
          ref={observeLaneWidth}
          className="chat-content-lane overflow-x-clip"
          data-timeline-root="true"
        >
          <AudioPreviewUnmountContext value={onAudioUnmount}>
            <TimelineVirtualRow id={item.id} />
          </AudioPreviewUnmountContext>
        </div>
      </div>
    </TimelineRowCtx>
  );
  const timelineListFooter = (
    <TimelineListFooter
      composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment}
      liveActivityRows={liveActivityRows}
      footerRef={timelineFooterRef}
      onGrow={onFooterGrow}
    >
      {/* Plain `footer` children keep the memoized footer from rendering per streamed chunk. */}
      {unmatchedPendingApprovals.size > 0 ? (
        <>
          {footer}
          <TimelineRowCtx value={sharedState}>
            <div className="messages-timeline-row-frame">
              <div className="chat-content-lane overflow-x-clip" data-timeline-root="true">
                <WorkLogBlock>
                  {[...unmatchedPendingApprovals.values()].map((approval) => (
                    <TimelinePendingApprovalRow key={approval.requestId} approval={approval} />
                  ))}
                </WorkLogBlock>
              </div>
            </div>
          </TimelineRowCtx>
        </>
      ) : (
        footer
      )}
    </TimelineListFooter>
  );

  const forwardMinimapWheel = (event: WheelEvent) => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode) forwardWheelToTimeline(event, scrollNode);
  };

  if (showsEmptyState) {
    if (hideEmptyPlaceholder) {
      // Occupy the pane with the theme surface so a thread switch cannot
      // punch a hole through to the window chrome (white in light mode).
      return (
        <>
          {activityAnnouncer}
          <div
            className="h-full min-h-0 bg-background"
            data-timeline-loading="true"
            data-timeline-empty="true"
          />
        </>
      );
    }
    return (
      <>
        {activityAnnouncer}
        <div
          className="flex h-full items-center justify-center ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
          style={{ paddingBottom: emptyPlaceholderInset }}
        >
          <p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {activityAnnouncer}
      <MarkdownFindContext value={findActive}>
        <StreamingFootnoteProvider>
          <SmoothScrollLayoutBoundary controlRef={smoothFollowControl}>
            <TimelineRowCtx value={sharedState}>
              <TimelineRowActivityCtx value={activityState}>
                <TimelineRowDataCtx value={rowData}>
                  <TooltipScrollDismissArea
                    ref={attachTimelineViewportElement}
                    className="relative h-full min-h-0"
                    style={restoringThreadPosition ? { visibility: "hidden" } : undefined}
                    data-assistant-citation-viewport="true"
                    data-timeline-empty={rows.length === 0 ? "true" : undefined}
                  >
                    {onCiteAssistantText && citationThreadRef ? (
                      <AssistantSelectionToolbar
                        viewport={timelineViewportElement}
                        threadRef={citationThreadRef}
                        onCite={onCiteAssistantText}
                      />
                    ) : null}
                    <LegendList<MessagesTimelineRow>
                      ref={setTimelineList}
                      data={structuralRows}
                      extraData={sharedState}
                      keyExtractor={keyExtractor}
                      getItemType={getItemType}
                      renderItem={renderItem}
                      estimatedItemSize={90}
                      initialScrollAtEnd={
                        !findActive &&
                        citationRequest === null &&
                        rememberedPosition?.atEnd !== false
                      }
                      // Legend needs a data refresh to mount new pins without a scroll event.
                      dataVersion={`${readyCitationRequest?.key ?? listIdentityKey}:${alwaysRenderKeys.join(",")}`}
                      {...(alwaysRender ? { alwaysRender } : {})}
                      onLoad={handleListLoad}
                      {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                      contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
                      maintainScrollAtEnd={
                        smoothStreaming ||
                        fullscreenAppRowId !== null ||
                        citationPositioning ||
                        (restoringThreadPosition && rememberedPosition?.atEnd === false) ||
                        anchoredEndSpace ||
                        !liveFollowEnabled ||
                        disclosureToggleSettling
                          ? false
                          : isWorking && !prefersReducedMotion && settlingListIdentity === null
                            ? conversationStructure === "restructured"
                              ? TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH_RESTRUCTURED
                              : TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH
                            : conversationStructure === "restructured"
                              ? TIMELINE_MAINTAIN_SCROLL_AT_END_RESTRUCTURED
                              : TIMELINE_MAINTAIN_SCROLL_AT_END
                      }
                      maintainVisibleContentPosition={
                        shouldMaintainVisibleTimelineContent({
                          smoothStreaming,
                          liveFollowEnabled,
                        }) &&
                        !findActive &&
                        !citationPositioning &&
                        !(restoringThreadPosition && rememberedPosition?.atEnd === false)
                          ? maintainVisibleContentPosition
                          : false
                      }
                      // The restructured footer must only pull the viewport upward when
                      // it is exactly at the native bottom; a sub-pixel upward gesture
                      // belongs to the reader and lets Thinking move down with content.
                      maintainScrollAtEndThreshold={
                        conversationStructure === "restructured" ? 0 : liveFollowEnabled ? 1 : 0
                      }
                      onScroll={handleScroll}
                      onItemSizeChanged={handleItemSizeChanged}
                      className={cn(
                        "messages-timeline-scroll h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                        topFadeEnabled && "topbar-scroll-fade",
                      )}
                      ListHeaderComponent={listHeader}
                      ListFooterComponent={timelineListFooter}
                      ListFooterComponentStyle={liveFooterStyle}
                    />
                    <OverlayScrollbar
                      scrollable={timelineScrollableNode}
                      triangles
                      onStep={handleScrollbarStep}
                      onScrollStart={navigateTimeline}
                    />
                    <TimelineMinimap
                      onWheel={forwardMinimapWheel}
                      items={minimapItems}
                      rows={structuralRows}
                      hasPersistentGutter={minimapHasPersistentGutter}
                      hitStripWidth={minimapHitStripWidth}
                      currentIndex={minimapCurrentIndex}
                      stripMap={minimapStripMap}
                      onSelect={onSelectMinimapItem}
                    />
                  </TooltipScrollDismissArea>
                </TimelineRowDataCtx>
              </TimelineRowActivityCtx>
            </TimelineRowCtx>
          </SmoothScrollLayoutBoundary>
          <TimelineListLayoutCommit observer={listLayout} layoutRef={layoutRef} />
          <TimelineLayoutCommit layoutRef={layoutRef} requestRef={layoutCommitRef} />
        </StreamingFootnoteProvider>
      </MarkdownFindContext>
    </>
  );
});

function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier turns"
            onClick={() => props.onLoadEarlier()}
            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
            <span className="shrink-0">
              {props.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function isMessageRow(row: MessagesTimelineRow) {
  return row.kind === "message" && row.message.role !== "system";
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// LegendList averages by type; length buckets prevent inflated estimates and nested-update loops.
function getItemType(item: MessagesTimelineRow) {
  if (item.kind !== "message") return item.kind;
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${lengthBucket}`;
}

type TimelineLiveActivityRow = Extract<
  MessagesTimelineRow,
  { kind: "thinking" | "work-live" | "work" }
>;

const TimelineVirtualRow = memo(function TimelineVirtualRow({ id }: { id: string }) {
  const row = use(TimelineRowDataCtx).get(id);
  return row ? <TimelineRowContent row={row} /> : null;
});
const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isSubagentGroup = row.kind === "event" && row.projectedItem.item.type === "subagent";
  const isWorkLogRow =
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "thinking";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") &&
    row.expanded === true;

  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        isWorkLogRow || isSubagentGroup || row.kind === "working"
          ? undefined
          : row.kind === "turn-fold"
            ? "pb-1.5"
            : (row.kind === "message" &&
                  row.message.role === "assistant" &&
                  !row.showAssistantMeta &&
                  !row.reserveAssistantMeta) ||
                row.kind === "worktree-setup" ||
                row.kind === "event" ||
                row.kind === "html-render" ||
                row.kind === "mcp-app" ||
                row.kind === "attempt-fold"
              ? "pb-2"
              : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow && row.kind !== "thinking" ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow key={row.id} row={row} /> : null}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserMessageRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "html-render" ? <HtmlRenderTimelineRow row={row} /> : null}
      {row.kind === "mcp-app" ? <McpAppTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
});

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  const label =
    row.title && row.label.startsWith("Context compacted")
      ? row.title + row.label.slice("Context compacted".length)
      : row.label;
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <Minimize2Icon aria-hidden="true" className="size-3" />
      )}
      {row.tokenCounts ? (
        <>
          {row.title ?? "Context compacted"} {row.tokenCounts.before}
          <ArrowRightIcon aria-hidden="true" className="size-3" />
          {row.tokenCounts.after} tokens
        </>
      ) : (
        label
      )}
      {row.failure ? (
        <span className="min-w-0 truncate opacity-80">&middot; {row.failure}</span>
      ) : null}
    </span>
  );
  return (
    <div
      role="separator"
      aria-label={row.failure ? `${label}: ${row.failure}` : label}
      className={cn(
        "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-xs",
        row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
      <span
        ref={row.active ? observeVisibleAnimation : undefined}
        className="relative min-w-0 overflow-hidden"
      >
        {content}
        {row.active ? <ActivityShimmerOverlay>{content}</ActivityShimmerOverlay> : null}
      </span>
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
    </div>
  );
}

function useDeferredWorkLoading(
  row: { expanded: boolean; deferredWorkItemIds?: ReadonlyArray<string> },
  onToggle: () => void,
) {
  const ctx = use(TimelineRowCtx);
  const loadWork = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const ref = parseScopedThreadKey(ctx.routeThreadKey);
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  const anchorsKey = row.deferredWorkItemIds?.join("\n") ?? "";
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (!anchorsKey || environmentId === undefined || threadId === undefined) return;
    void Promise.all(
      anchorsKey
        .split("\n")
        .map((workAnchorId) => loadWork({ environmentId, input: { threadId, workAnchorId } })),
    ).then((results) =>
      setFailed(
        results.some((result) => result._tag === "Failure" || result.value._tag === "error"),
      ),
    );
  };
  const loadOnExpand = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restored expanded folds load their deferred server history on mount.
  useEffect(() => {
    if (row.expanded && anchorsKey && environmentId && threadId) loadOnExpand();
  }, [row.expanded, anchorsKey, environmentId, threadId]);
  const error = anchorsKey && failed ? "Couldn't load work. Click to retry." : null;
  const loading = ref !== null && row.expanded && anchorsKey !== "" && !failed;
  const toggle = () => {
    setFailed(false);
    if (error && row.expanded) load();
    else onToggle();
  };

  return { loading, error, toggle };
}

function WorkHistorySkeleton() {
  return (
    <div role="status" aria-label="Loading work history" className="space-y-2 px-1 pb-1 pt-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="size-3 shrink-0" />
          <Skeleton
            shape="pill"
            className={index === 0 ? "h-2.5 w-2/5" : index === 1 ? "h-2.5 w-3/5" : "h-2.5 w-1/3"}
          />
        </div>
      ))}
    </div>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const { loading, error, toggle } = useDeferredWorkLoading(row, () =>
    ctx.onToggleTurnFold(row.runId),
  );

  return (
    <div className="group/timeline-row border-b border-border/60 pb-2 pe-0.5 pt-1">
      <div className="relative flex items-center gap-1">
        <button
          type="button"
          aria-expanded={row.expanded}
          data-scroll-anchor-ignore
          onClick={toggle}
          aria-busy={loading}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span>
            {row.label}
            {error ? ` · ${error}` : ""}
          </span>
          <MorphIcon className="size-3.5" icon={row.expanded ? ChevronDown : ChevronRight} />
        </button>
        <TimelineRowTimestamp
          createdAt={row.createdAt}
          timestampFormat={ctx.timestampFormat}
          className="ms-auto"
        />
      </div>
      {loading ? <WorkHistorySkeleton /> : null}
    </div>
  );
}

function AttemptFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "attempt-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const { loading, error, toggle } = useDeferredWorkLoading(row, () =>
    ctx.onToggleAttemptFold(row.attemptId),
  );

  return (
    <div>
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        data-superseded-attempt-id={row.attemptId}
        onClick={toggle}
        aria-busy={loading}
        className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <MorphIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          icon={row.expanded ? ChevronDown : ChevronRight}
        />
        <span className="text-xs font-medium text-foreground/80">
          {row.label}
          {error ? ` · ${error}` : ""}
        </span>
        <span className="text-2xs text-muted-foreground">Cut off by a steer</span>
      </button>
      {loading ? <WorkHistorySkeleton /> : null}
    </div>
  );
}

function useStructuralRows(rows: MessagesTimelineRow[], identity: string): MessagesTimelineRow[] {
  const [previous, setPrevious] = useState({ rows, identity });
  if (
    previous.identity === identity &&
    previous.rows.length === rows.length &&
    rows.every(
      (row, index) =>
        previous.rows[index]!.id === row.id &&
        getItemType(previous.rows[index]!) === getItemType(row),
    )
  )
    return previous.rows;
  setPrevious({ rows, identity });
  return rows;
}
