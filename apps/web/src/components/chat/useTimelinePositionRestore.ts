import { useLayoutEffect, useRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { resolveTimelineDomIsAtEnd } from "./MessagesTimeline.logic";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";

/**
 * Scrolls a newly shown thread back to where the user left it, or to its end,
 * and reports the thread positioned once the saved row settles.
 */
export function useTimelinePositionRestore({
  listRef,
  listIdentityKey,
  restoringThreadPosition,
  rememberedPosition,
  rows,
  smoothStreaming,
  loadedThreadKeyRef,
  onRestoredEnd,
  citationRequest,
  cancelPositionRestoreRef,
  onManualNavigation,
  onPositioned,
}: {
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly listIdentityKey: string;
  readonly restoringThreadPosition: boolean;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly rows: MessagesTimelineRow[];
  readonly smoothStreaming: boolean;
  readonly loadedThreadKeyRef: React.RefObject<string | null>;
  readonly onRestoredEnd: () => void;
  readonly citationRequest: AssistantCitationRequest | null;
  readonly cancelPositionRestoreRef: React.RefObject<(() => void) | null> | undefined;
  readonly onManualNavigation: () => void;
  readonly onPositioned: (identity: string) => void;
}) {
  // Preserve initialScrollAtEnd's measured target until the list is reused
  // for another thread; scrollToEnd would replace it with an estimated offset.
  const listOpenedOnRef = useRef<{
    readonly list: LegendListRef;
    identity: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const opened = listOpenedOnRef.current;
    if (!list) return;
    if (opened?.list !== list) {
      listOpenedOnRef.current = { list, identity: listIdentityKey };
    } else if (opened.identity !== listIdentityKey) {
      opened.identity = null;
    }
  });
  const restoreEndRowId = rows.at(-1)?.id;
  useLayoutEffect(() => {
    if (!restoringThreadPosition || rows.length === 0) return;
    const list = listRef.current;
    if (!list) return;
    if (citationRequest !== null) {
      // The citation scroll owns positioning once the list has mounted.
      onPositioned(listIdentityKey);
      return;
    }
    let cancelled = false;
    let settleFrame: number | null = null;
    const viewport: HTMLElement | null = list.getScrollableNode();
    const cancelRestoration = () => {
      if (cancelled) return;
      cancelled = true;
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      if (viewport) void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
      onPositioned(listIdentityKey);
    };
    const cancelForNavigation = () => {
      cancelRestoration();
      onManualNavigation();
    };
    const onScrollKey = (event: globalThis.KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancelForNavigation();
    };
    viewport?.addEventListener("wheel", cancelForNavigation, { passive: true });
    viewport?.addEventListener("touchmove", cancelForNavigation, { passive: true });
    viewport?.addEventListener("pointerdown", cancelForNavigation, { passive: true });
    viewport?.ownerDocument.addEventListener("keydown", onScrollKey);
    const position = rememberedPosition;
    const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
    if (position?.atEnd === false) onManualNavigation();
    if (cancelPositionRestoreRef) cancelPositionRestoreRef.current = cancelRestoration;
    const scrolling =
      position?.atEnd === false
        ? index >= 0
          ? list.scrollToIndex({
              index,
              animated: false,
              viewPosition: 0,
              viewOffset: -position.offsetWithinRow,
            })
          : list.scrollToOffset({ offset: position.scrollOffset, animated: false })
        : listOpenedOnRef.current?.identity === listIdentityKey
          ? undefined
          : list.scrollToEnd({ animated: false });
    void Promise.resolve(scrolling).then(() => {
      if (cancelled) return;
      if (position?.atEnd !== false || index < 0) {
        if (position?.atEnd !== false) {
          // Estimated-index scrolling can resolve before the rows load. Keep
          // the timeline unpainted until its measured edge holds across layout
          // frames, then let the smooth controller take over from that edge.
          // A row that never reports its size must not keep the timeline
          // hidden, or keep this loop running, for the rest of the visit.
          let stableFrames = 0;
          const reconcileDeadline = performance.now() + 1_000;
          const reconcileEnd = () => {
            if (cancelled) return;
            const element = list.getScrollableNode();
            if (element) {
              element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
            }
            // LegendList only calls onLoad once when it stays mounted across
            // thread switches. A mounted, measured end row confirms this new
            // thread's layout without waiting for a second onLoad callback.
            const state = list.getState?.();
            const endIndex =
              restoreEndRowId === undefined ? undefined : state?.indexByKey?.(restoreEndRowId);
            if (
              endIndex !== undefined &&
              state?.elementAtIndex?.(endIndex) &&
              state?.sizeAtIndex?.(endIndex) > 0
            ) {
              loadedThreadKeyRef.current = listIdentityKey;
            }
            if (
              element &&
              loadedThreadKeyRef.current === listIdentityKey &&
              resolveTimelineDomIsAtEnd(element)
            ) {
              stableFrames++;
            } else {
              stableFrames = 0;
            }
            if (stableFrames >= 2 || performance.now() >= reconcileDeadline) {
              // A child can grow between this measured pin and the commit
              // enabling smooth follow. Hand over the saved end destination
              // explicitly so the new controller cannot mistake that gap for
              // a reading position.
              if (smoothStreaming) onRestoredEnd();
              onPositioned(listIdentityKey);
            } else {
              settleFrame = requestAnimationFrame(reconcileEnd);
            }
          };
          reconcileEnd();
          return;
        }
        onPositioned(listIdentityKey);
        return;
      }
      // Index scrolling starts from estimates. Keep the saved row mounted
      // until its measured position and the DOM agree for two layout frames.
      let stableFrames = 0;
      const reconcile = () => {
        if (cancelled) return;
        const state = list.getState();
        const rowIndex = state.indexByKey(position.rowId);
        const row = rowIndex === undefined ? undefined : state.elementAtIndex(rowIndex);
        const element = list.getScrollableNode();
        if (!row || !element) return;
        const offset = Math.max(
          0,
          Math.min(
            element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              position.offsetWithinRow,
            element.scrollHeight - element.clientHeight,
          ),
        );
        if (Math.abs(element.scrollTop - offset) > 1) {
          stableFrames = 0;
          void list.scrollToOffset({ offset, animated: false }).then(() => {
            if (!cancelled) settleFrame = requestAnimationFrame(reconcile);
          });
          return;
        }
        stableFrames += 1;
        if (stableFrames >= 2) {
          onPositioned(listIdentityKey);
        } else {
          settleFrame = requestAnimationFrame(reconcile);
        }
      };
      settleFrame = requestAnimationFrame(reconcile);
    });
    return () => {
      cancelled = true;
      if (cancelPositionRestoreRef?.current === cancelRestoration) {
        cancelPositionRestoreRef.current = null;
      }
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      viewport?.removeEventListener("wheel", cancelForNavigation);
      viewport?.removeEventListener("touchmove", cancelForNavigation);
      viewport?.removeEventListener("pointerdown", cancelForNavigation);
      viewport?.ownerDocument.removeEventListener("keydown", onScrollKey);
    };
  }, [
    citationRequest,
    cancelPositionRestoreRef,
    listIdentityKey,
    listRef,
    onManualNavigation,
    onPositioned,
    rememberedPosition,
    restoringThreadPosition,
    rows,
    restoreEndRowId,
    smoothStreaming,
    loadedThreadKeyRef,
    onRestoredEnd,
  ]);
}
