import { observeResize } from "~/lib/observeResize";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Component, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

import { SMOOTH_TEXT_LAYOUT_EVENT, type SmoothTextLayoutDetail } from "../lib/smoothTextLayout";

export interface SmoothScrollTailLayout {
  element: HTMLElement;
  /** Natural-minus-published height of the owning virtual row and all following rows. */
  fraction: number;
}

export interface SmoothScrollHandle {
  request(): boolean;
  jumpToEnd(): void;
  cancel(): void;
  isFollowing(): boolean;
  /**
   * Whether the viewport sits on the content's bottom edge, including its
   * fractional compositor compensation. This is a pure geometry read: it says
   * nothing about who last moved the
   * viewport, so a reader who scrolled back down to the end reports `true`
   * even after follow was cancelled.
   */
  isAtEdge(): boolean;
  beginLayout(): ((follow?: boolean) => void) | null;
  /** Called only after the Timeline's list DOM has committed. */
  commitLayout(rowFraction?: number, tails?: readonly SmoothScrollTailLayout[]): boolean;
}

/** Capture ownership before React can shrink and regrow the scrollable layout. */
export class SmoothScrollLayoutBoundary extends Component<{
  controlRef: RefObject<SmoothScrollHandle | null>;
  children: ReactNode;
}> {
  override getSnapshotBeforeUpdate() {
    return this.props.controlRef.current?.beginLayout() ?? null;
  }

  override componentDidUpdate(
    _previousProps: Readonly<typeof this.props>,
    _previousState: unknown,
    finish: (() => void) | null,
  ) {
    finish?.();
  }

  override render() {
    return this.props.children;
  }
}

/** Keeps the real scroll edge pinned while the text frame animates its height. */
export function useSmoothScroll({
  element,
  enabled,
  identity,
  controlRef,
  footerRef,
  endRequest = 0,
  onDetach,
  onFollowingChange,
  onLayoutRequest,
}: {
  element: HTMLElement | null;
  enabled: boolean;
  identity: string;
  reducedMotion: boolean;
  controlRef: RefObject<SmoothScrollHandle | null>;
  footerRef?: RefObject<HTMLElement | null> | undefined;
  endRequest?: number;
  onDetach?: (() => void) | undefined;
  onFollowingChange?: ((following: boolean) => void) | undefined;
  onLayoutRequest?: (() => void) | undefined;
}) {
  const controllerRef = useRef<SmoothScrollHandle | null>(null);
  const handledEndRequestRef = useRef({ identity, value: endRequest });
  const request = useStableCallback(() => controllerRef.current?.request() ?? false);

  useLayoutEffect(() => {
    if (!enabled || !element) return;
    let cancelled = false;
    let lastPinnedTop: number | null = null;
    let chaseFrame: number | null = null;
    let pendingGrowth = 0;
    let readThisFrame = false;
    let following = false;
    let layoutDepth = 0;
    let viewportHeight = 0;
    let trackedWidth = element.clientWidth;
    let trackedHeight = element.clientHeight;
    let viewportResized = false;
    let lastPinnedEnd: number | null = null;
    let rowFraction: number | null = null;
    let tailLayouts: readonly SmoothScrollTailLayout[] = [];
    const previousTailTranslates = new Map<HTMLElement, string>();
    let fractionalScrollInset = 0;
    let nativeEnd = 0;
    const readEnd = () => {
      const height = element.scrollHeight;
      viewportHeight = element.clientHeight;
      const end = Math.max(0, height - viewportHeight);
      nativeEnd = end;
      if (rowFraction !== null && content && !previousTranslate)
        fractionalScrollInset = rowFraction < 0 && end > 0 ? 1 : 0;
      if (end === 0) fractionalScrollInset = 0;
      return Math.max(0, end - fractionalScrollInset);
    };
    const content =
      typeof HTMLElement !== "undefined" && element.firstElementChild instanceof HTMLElement
        ? element.firstElementChild
        : null;
    const previousTranslate = content?.style.translate ?? "";
    const previousFooterTranslate = footerRef?.current?.style.translate ?? "";
    const clearFraction = () => {
      fractionalScrollInset = 0;
      rowFraction = null;
      if (content && content.style.translate !== previousTranslate)
        content.style.translate = previousTranslate;
      const footer = footerRef?.current;
      if (footer && footer.style.translate !== previousFooterTranslate)
        footer.style.translate = previousFooterTranslate;
      for (const [tail, previous] of previousTailTranslates) tail.style.translate = previous;
      previousTailTranslates.clear();
      tailLayouts = [];
    };
    const pinFraction = () => {
      if (!content || previousTranslate) return;
      if (lastPinnedTop === 0 && fractionalScrollInset === 0) {
        clearFraction();
        return;
      }
      // Native scrollHeight/scrollTop can round to whole CSS pixels even on
      // a high-refresh page. Keep that native edge pinned and move only its
      // fractional remainder on the compositor, so slow growth does not
      // hold several frames and then step upward by one pixel.
      const contentHeight =
        rowFraction === null || tailLayouts.length > 0 ? content.getBoundingClientRect().height : 0;
      const exactEnd = rowFraction === null ? Math.max(0, contentHeight - viewportHeight) : 0;
      const remainder = rowFraction ?? exactEnd - nativeEnd;
      const naturalFraction = contentHeight - viewportHeight - nativeEnd;
      const containerFraction = Math.abs(naturalFraction) < 1 ? naturalFraction : 0;
      // A positive content translation creates extra native overflow. Instead
      // move the owned scroll offset back one pixel and use only an upward
      // translation. Together they preserve the exact edge without a feedback
      // loop when a virtual row crosses its rounding boundary.
      const inset = Math.abs(remainder) < 1 && remainder < 0 && nativeEnd > 0 ? 1 : 0;
      if (fractionalScrollInset !== inset) fractionalScrollInset = inset;
      const end = Math.max(0, nativeEnd - inset);
      if (element.scrollTop !== end) element.scrollTop = end;
      const fraction = remainder + inset;
      const translate = Math.abs(remainder) < 1 ? `0 ${-fraction}px` : previousTranslate;
      if (content.style.translate !== translate) {
        content.style.translate = translate;
      }
      const footer = footerRef?.current;
      if (footer) {
        const counter =
          footer.parentElement?.style.position === "sticky" && Math.abs(remainder) < 1
            ? `0 ${fraction}px`
            : previousFooterTranslate;
        if (footer.style.translate !== counter) {
          footer.style.translate = counter;
        }
      }
      const activeTails = new Set<HTMLElement>();
      const scrollCompensation = fraction - (nativeEnd - element.scrollTop);
      for (const tail of tailLayouts) {
        if (
          !element.contains(tail.element) ||
          Math.abs(remainder) >= 1 ||
          (footer?.contains(tail.element) && footer.parentElement?.style.position === "sticky")
        )
          continue;
        if (!previousTailTranslates.has(tail.element))
          previousTailTranslates.set(tail.element, tail.element.style.translate);
        activeTails.add(tail.element);
        // A tail's own animation still moves naturally. Only the difference
        // between virtual/native rounding and that suffix belongs to follow.
        const counter = `0 ${scrollCompensation - tail.fraction - containerFraction}px`;
        if (tail.element.style.translate !== counter) tail.element.style.translate = counter;
      }
      for (const [tail, previous] of previousTailTranslates) {
        if (activeTails.has(tail)) continue;
        tail.style.translate = previous;
        previousTailTranslates.delete(tail);
      }
      lastPinnedTop = element.scrollTop;
    };
    const reportFollowing = (next: boolean) => {
      if (following === next) return;
      following = next;
      if (next) element.setAttribute("data-smooth-scroll-following", "");
      else element.removeAttribute("data-smooth-scroll-following");
      if (!next) clearFraction();
      onFollowingChange?.(next);
    };
    const isFollowing = () =>
      !cancelled &&
      lastPinnedTop !== null &&
      (layoutDepth > 0 || element.scrollTop === lastPinnedTop || element.scrollTop >= readEnd());
    /**
     * A panel resize reflows the whole list while the virtualizer keeps its
     * old offset. That movement is layout, not navigation: follow must adopt
     * the new edge instead of detaching and letting the stream walk away from
     * the bottom. Every other off-edge movement remains the reader's.
     */
    const layoutResized = () => viewportResized;
    /**
     * A collapsing disclosure shrinks the end under a viewport that was pinned
     * to the old edge. The virtualizer's correction and the browser's clamp can
     * leave the owned offset short of the new edge, which looks like a reader
     * walking up the page. Shrinking content never moves the reader down, so
     * adopt the new edge instead of detaching.
     */
    const layoutShrank = (end: number) =>
      lastPinnedEnd !== null &&
      end < lastPinnedEnd - 0.5 &&
      lastPinnedTop !== null &&
      element.scrollTop <= lastPinnedTop;
    const writeEnd = (end = readEnd()) => {
      // A full re-pin supersedes anything the growth path had accumulated.
      pendingGrowth = 0;
      viewportResized = false;
      lastPinnedEnd = end;
      if (element.scrollTop !== end) element.scrollTop = end;
      // Read back the browser's clamped value, including fractional geometry.
      lastPinnedTop = element.scrollTop;
      pinFraction();
      reportFollowing(true);
    };
    /**
     * The frame reports how far its content edge moved, so following it needs
     * one clamped write instead of a `scrollHeight` read on both sides of every
     * height write. Those reads forced layout right after the height write, on
     * every animation frame.
     *
     * The first write of a frame settles immediately, so the viewport moves in
     * the same frame the content did. Further writes inside that frame only
     * accumulate, and the frame's settling pass reads the layout once more.
     */
    const followGrowth = (event: Event) => {
      if (cancelled) return;
      const detail = (event as CustomEvent<SmoothTextLayoutDetail>).detail;
      if (detail?.rowFraction !== undefined) rowFraction = detail.rowFraction;
      // A sub-frame line explicitly committed its virtual row in capture.
      // Follow that edge now, even after an earlier line wrote in this frame.
      if (detail?.synchronous) {
        pin();
        return;
      }
      const delta = detail?.delta ?? 0;
      if (delta === 0) {
        readThisFrame = false;
        settleGrowth();
        return;
      }
      pendingGrowth += delta;
      if (readThisFrame) return;
      if (layoutDepth === 0 && element.scrollTop !== lastPinnedTop) {
        // Only a viewport still sitting on our own pinned offset is ours to
        // move; anything else is the reader's.
        if (layoutResized() || layoutShrank(readEnd())) {
          // Adopt the reflowed edge in one pass. The settling pass checks
          // ownership again and would otherwise detach once the flag cleared.
          writeEnd(readEnd());
          // A delayed spacer or disclosure can still grow after this adopt;
          // keep the same bounded chase a settled growth would have started.
          chaseIdleFrames = 0;
          scheduleChase();
          return;
        }
        pendingGrowth = 0;
        if (element.scrollTop < readEnd()) {
          cancelled = true;
          reportFollowing(false);
          onDetach?.();
        }
        return;
      }
      settleGrowth();
    };
    const settleGrowth = () => {
      if (cancelled || pendingGrowth === 0 || lastPinnedTop === null) return;
      const max = readEnd();
      // A reader can move after the first write and before the batched settling
      // pass. Ownership must be checked there too, before we touch scrollTop.
      if (
        layoutDepth === 0 &&
        element.scrollTop !== lastPinnedTop &&
        element.scrollTop < max &&
        !layoutResized() &&
        !layoutShrank(max)
      ) {
        pendingGrowth = 0;
        cancelled = true;
        reportFollowing(false);
        onDetach?.();
        return;
      }
      // The virtualizer can publish this delta after it has already committed
      // the new edge, or before its spacer has caught up. Follow the native
      // edge we just read; applying a negative delta to an already pinned edge
      // would create an upward scroll through unchanged layout and detach us.
      const end = max;
      pendingGrowth = 0;
      readThisFrame = true;
      if (element.scrollTop !== end) element.scrollTop = end;
      lastPinnedTop = element.scrollTop;
      lastPinnedEnd = end;
      viewportResized = false;
      pinFraction();
      reportFollowing(true);
      chaseIdleFrames = 0;
      scheduleChase();
    };
    // Growth that arrives between layout events leaves the viewport short of
    // the edge until the next event, and catching up a frame later shows the
    // content moving and then snapping back. Chase the edge for a few frames
    // after each pin so the compensation lands in the same frame as the growth
    // no matter which pass produced it. The chase stops once the edge holds
    // still, so an idle timeline runs no loop at all.
    const CHASE_IDLE_FRAMES = 3;
    let chaseIdleFrames = 0;
    const scheduleChase = () => {
      if (onLayoutRequest) return;
      if (cancelled || chaseFrame !== null) return;
      chaseFrame = requestAnimationFrame(() => {
        chaseFrame = null;
        if (cancelled) return;
        const end = readEnd();
        // Only a viewport still sitting on our own pinned offset is ours to
        // move; anything else is the reader's.
        if (layoutDepth === 0 && element.scrollTop !== lastPinnedTop) {
          if (!layoutResized() && !layoutShrank(end)) {
            if (element.scrollTop < end) {
              cancelled = true;
              reportFollowing(false);
              onDetach?.();
              return;
            }
          }
          // A shrinking layout clamps the viewport to its new edge, or a
          // panel resize reflows it. Adopt that edge before later growth can
          // look like reader navigation.
          writeEnd(end);
        }
        if (element.scrollTop !== end) {
          writeEnd(end);
          chaseIdleFrames = 0;
        } else {
          pinFraction();
          chaseIdleFrames++;
        }
        if (chaseIdleFrames < CHASE_IDLE_FRAMES) scheduleChase();
      });
    };
    const pin = () => {
      if (cancelled) return false;
      const end = readEnd();
      if (layoutDepth === 0 && element.scrollTop < end && element.scrollTop !== lastPinnedTop) {
        // Layout may grow the end while leaving our last pinned offset intact.
        // Any other off-end position belongs to the reader, even before the
        // browser dispatches scroll and even if it differs by less than 1px.
        if (!layoutResized() && !layoutShrank(end)) {
          if (lastPinnedTop !== null) {
            cancelled = true;
            reportFollowing(false);
            onDetach?.();
          }
          return false;
        }
      }
      writeEnd(end);
      chaseIdleFrames = 0;
      scheduleChase();
      return true;
    };
    const handle: SmoothScrollHandle = {
      request: () => {
        if (!onLayoutRequest) return pin();
        onLayoutRequest();
        return isFollowing();
      },
      commitLayout(fraction, tails = []) {
        rowFraction = fraction ?? null;
        tailLayouts = tails;
        return pin();
      },
      jumpToEnd() {
        cancelled = false;
        writeEnd();
      },
      cancel() {
        cancelled = true;
        reportFollowing(false);
      },
      isFollowing,
      isAtEdge: () => element.scrollTop >= readEnd(),
      beginLayout() {
        if (!isFollowing()) return null;
        layoutDepth++;
        return (follow = true) => {
          try {
            if (!cancelled) {
              if (!follow) lastPinnedTop = element.scrollTop;
              else if (onLayoutRequest) {
                lastPinnedTop = element.scrollTop;
                onLayoutRequest();
              } else pin();
            }
          } finally {
            layoutDepth--;
          }
        };
      },
    };
    const frameLayouts: boolean[] = [];
    const followLayout = (event: Event) => {
      if ((event as CustomEvent<SmoothTextLayoutDetail>).detail?.managed) return;
      const phase = (event as CustomEvent<SmoothTextLayoutDetail>).detail?.phase;
      if (phase === "before") {
        const owned = isFollowing();
        frameLayouts.push(owned);
        if (owned) layoutDepth++;
        return;
      }
      const owned = phase === "after" && frameLayouts.pop() === true;
      try {
        if (owned && element.scrollTop !== lastPinnedTop) {
          lastPinnedTop = element.scrollTop;
          readThisFrame = false;
        }
        followGrowth(event);
      } finally {
        if (owned) layoutDepth--;
      }
    };
    controllerRef.current = handle;
    controlRef.current = handle;
    element.addEventListener(SMOOTH_TEXT_LAYOUT_EVENT, followLayout);
    const stopResize = observeResize(
      [element, ...(element.firstElementChild ? [element.firstElementChild] : [])],
      () => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (width !== trackedWidth || height !== trackedHeight) {
          trackedWidth = width;
          trackedHeight = height;
          viewportResized = true;
        }
        (onLayoutRequest ?? pin)();
      },
    );
    pin();

    return () => {
      handle.cancel();
      if (chaseFrame !== null) cancelAnimationFrame(chaseFrame);
      stopResize();
      element.removeEventListener(SMOOTH_TEXT_LAYOUT_EVENT, followLayout);
      if (controllerRef.current === handle) controllerRef.current = null;
      if (controlRef.current === handle) controlRef.current = null;
    };
  }, [
    controlRef,
    element,
    enabled,
    footerRef,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch must discard the controller even when the DOM is reused.
    identity,
    onDetach,
    onFollowingChange,
    onLayoutRequest,
  ]);

  useLayoutEffect(() => {
    const handled = handledEndRequestRef.current;
    if (handled.identity !== identity) {
      handledEndRequestRef.current = { identity, value: endRequest };
    } else if (enabled && handled.value !== endRequest) {
      handled.value = endRequest;
      // Only an explicit navigation request may move a viewport that is above
      // the end. Mounting after a layout/disclosure change is not such a request.
      controllerRef.current?.jumpToEnd();
    }
  }, [enabled, endRequest, identity]);

  return request;
}
