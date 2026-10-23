// @vitest-environment jsdom
import * as NodeModule from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";
import chatViewSource from "./ChatView.tsx?raw";
import { shouldRearmTimelineFollow } from "./chat/MessagesTimeline.logic";

// Execute the candidate's actual closures. This is a production callback boundary
// test, not a full ChatView mount or a browser geometry/event-ordering test.
function between(start: string, end: string) {
  const from = chatViewSource.indexOf(start);
  if (from < 0 || chatViewSource.indexOf(start, from + start.length) !== -1)
    throw new Error(`Expected unique ChatView start marker: ${start}`);
  const to = chatViewSource.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`Missing ChatView end marker: ${end}`);
  return chatViewSource.slice(from, to);
}

interface Entry {
  onManualNavigation: (direction?: -1 | 1) => void;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onPillClick: () => void;
  onWheel: (event: { ctrlKey: boolean; target: null; deltaY: number }) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onPageScrollStart: (key: "PageUp" | "PageDown") => void;
}
type Anchor = { messageId: string | null; threadKey: string };
type ScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";
const ref = <T>(current: T) => ({ current });

function setup() {
  const refs = {
    isAtEndRef: ref(true),
    timelineScrollModeRef: ref<ScrollMode>("following-end"),
    timelineScrollIntentRef: ref<"toward-end" | "away-from-end" | null>(null),
    liveFollowUserScrollGenerationRef: ref<number | null>(0),
    anchorUserScrollGenerationRef: ref(0),
  };
  const state = { follow: true, anchor: { messageId: "sent", threadKey: "env:thread" } as Anchor };
  const setTimelineAnchor = vi.fn((update: (anchor: Anchor) => Anchor) => {
    state.anchor = update(state.anchor);
  });
  const setSmoothEndRequest = vi.fn();
  const restore = vi.fn();
  const bindings = {
    ...refs,
    shouldRearmTimelineFollow,
    cancelTimelineSendMotion: vi.fn(),
    smoothScrollRef: ref({ cancel: vi.fn() }),
    cancelPositionRestoreRef: ref(vi.fn()),
    pendingTimelineAnchorRef: ref(null),
    positionedTimelineAnchorRef: ref(null),
    settledTimelineAnchorRef: ref(null),
    activeTimelineAnchorIndexRef: ref(null),
    pendingAnchorScrollRestoreRef: ref(null),
    anchorScrollRestoreFrameRef: ref(null),
    TIMELINE_SCROLL_CANCEL_SENTINEL: {},
    legendListRef: ref({
      scrollToItem: vi.fn(),
      getScrollableNode: () => null,
      scrollToEnd: vi.fn(),
    }),
    showScrollDebouncer: ref({ cancel: vi.fn(), maybeExecute: vi.fn() }),
    composerRef: ref({
      restoreAfterTimelineReachedEnd: restore,
      collapseForTimelineScrollKey: vi.fn(),
    }),
    setTimelineLiveFollowEnabled: (follow: boolean) => {
      state.follow = follow;
    },
    setTimelineAnchor,
    setSmoothEndRequest,
    setShowScrollToBottom: vi.fn(),
    smoothOutputEnabled: true,
    paintOnlyDisplayedTimeline: false,
    cancelAnimationFrame: vi.fn(),
    requestAnimationFrame: vi.fn(),
    scrollNode: document.createElement("div"),
    isTimelineScrollTarget: () => true,
    contentScrollsUp: () => true,
    viewportIsAwayFromEnd: () => true,
    isTimelineAtLogicalEndStable: () => false,
    timelineRealContentOverflowsViewportStable: () => true,
    eventPathContainsSelector: () => false,
    TYPE_TO_FOCUS_EDITABLE_SELECTOR: "input,textarea",
    TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR: "[data-slot=dialog-popup]",
    useEffectEvent: <T>(callback: T) => callback,
  };
  const release = between(
    "function releaseChatTimelineAnchor<",
    "/** Runs with a workspace preparation retry",
  );
  const cancel = between(
    "  const cancelTimelineLiveFollowForUserNavigation =",
    "  const cancelTimelineLiveFollowForUserNavigationStable =",
  );
  const end = between("  const onIsAtEndChange =", "  const onIsAtEndChangeStable =");
  const scroll = between("  const scrollToEnd =", "  const scrollToEndStable =");
  const manual = between("        const handleManualNavigation =", "        // The gestures below");
  const wheel = between("        const handleWheel =", "        // Touch direction");
  const keyboard = between(
    "        const handleKeyDown =",
    '        scrollNode.addEventListener("wheel"',
  );
  const page = between(
    "  const handlePageScrollStart =",
    "  useEffect(() => {\n    const controller = createPageScrollController",
  );
  const pill = between('aria-label="Scroll to end"\n', 'className="pointer-events-auto"');
  const pillClickAttribute = pill.slice(pill.indexOf("onClick={"));
  const pillHandler = pillClickAttribute.slice(
    pillClickAttribute.indexOf("{") + 1,
    pillClickAttribute.lastIndexOf("}"),
  );
  const code = NodeModule.stripTypeScriptTypes(
    [
      release,
      cancel,
      end,
      scroll,
      "const cancelTimelineLiveFollowForUserNavigationRef = { current: cancelTimelineLiveFollowForUserNavigation };",
      manual,
      wheel,
      keyboard,
      "const cancelTimelineLiveFollowForUserNavigationStable = cancelTimelineLiveFollowForUserNavigation;",
      page,
      `const onPillClick = ${pillHandler};`,
    ].join("\n"),
    { mode: "strip" },
  );
  const factory = new Function(
    ...Object.keys(bindings),
    `${code}\nreturn { onManualNavigation: cancelTimelineLiveFollowForUserNavigation, onIsAtEndChange, onPillClick, onWheel: handleWheel, onKeyDown: handleKeyDown, onPageScrollStart: handlePageScrollStart };`,
  ) as (...args: unknown[]) => Entry;
  const entry = factory(...Object.values(bindings));
  return { refs, state, entry, setTimelineAnchor, setSmoothEndRequest, restore };
}

describe("ChatView production follow callback boundary", () => {
  it("does not re-arm when upward reading is clamped to the end by collapsing content", () => {
    const { entry, state, refs, setTimelineAnchor } = setup();
    entry.onWheel({ ctrlKey: false, target: null, deltaY: -100 });
    entry.onIsAtEndChange(false);
    expect(state.follow).toBe(false);
    entry.onIsAtEndChange(true);
    expect(state.follow).toBe(false);
    expect(refs.timelineScrollModeRef.current).toBe("free-scrolling");
    expect(refs.liveFollowUserScrollGenerationRef.current).toBeNull();
    expect(setTimelineAnchor).not.toHaveBeenCalled();
  });

  it.each([-1, undefined] as const)(
    "clears stale downward intent when Timeline detaches with direction %s",
    (direction) => {
      const { entry, refs, state } = setup();
      refs.timelineScrollIntentRef.current = "toward-end";
      entry.onManualNavigation(direction);
      entry.onIsAtEndChange(false);
      entry.onIsAtEndChange(true);
      expect(state.follow).toBe(false);
    },
  );

  it.each(["wheel", "timeline", "keyboard", "page"] as const)(
    "allows deliberate downward %s return after rejecting a stale end report",
    (kind) => {
      const { entry, state, refs, restore } = setup();
      entry.onManualNavigation(-1);
      entry.onIsAtEndChange(false);
      entry.onIsAtEndChange(true);
      if (kind === "wheel") entry.onWheel({ ctrlKey: false, target: null, deltaY: 100 });
      else if (kind === "keyboard") {
        const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
        document.body.dispatchEvent(event);
        entry.onKeyDown(event);
      } else if (kind === "page") entry.onPageScrollStart("PageDown");
      else entry.onManualNavigation(1);
      entry.onIsAtEndChange(true);
      expect(state.follow).toBe(true);
      expect(refs.timelineScrollModeRef.current).toBe("following-end");
      expect(refs.liveFollowUserScrollGenerationRef.current).toBe(
        refs.anchorUserScrollGenerationRef.current,
      );
      expect(refs.timelineScrollIntentRef.current).toBeNull();
      expect(state.anchor.messageId).toBeNull();
      expect(restore).toHaveBeenCalledOnce();
    },
  );

  it("preserves the upstream owned sent-turn anchor across transient end reports", () => {
    const { entry, refs, state, setTimelineAnchor } = setup();
    refs.timelineScrollModeRef.current = "anchoring-new-turn";
    entry.onIsAtEndChange(false);
    entry.onIsAtEndChange(true);
    expect(refs.timelineScrollModeRef.current).toBe("anchoring-new-turn");
    expect(state.anchor.messageId).toBe("sent");
    expect(state.follow).toBe(true);
    expect(setTimelineAnchor).not.toHaveBeenCalled();
  });

  it("executes the production pill click as an explicit return-to-follow", () => {
    const { entry, state, refs, setSmoothEndRequest, restore } = setup();
    entry.onManualNavigation(-1);
    entry.onIsAtEndChange(false);
    entry.onPillClick();
    expect(state.follow).toBe(true);
    expect(refs.timelineScrollModeRef.current).toBe("following-end");
    expect(state.anchor.messageId).toBeNull();
    expect(setSmoothEndRequest).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });
});
