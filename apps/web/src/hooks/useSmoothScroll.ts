import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { SMOOTH_TEXT_BEFORE_LAYOUT_EVENT, SMOOTH_TEXT_LAYOUT_EVENT } from "../lib/smoothTextLayout";

export interface SmoothScrollHandle {
  request(): boolean;
  jumpToEnd(): void;
  cancel(): void;
  isFollowing(): boolean;
  /**
   * Whether the viewport currently sits on the content's bottom edge. This is
   * a pure read of the geometry: it says nothing about who last moved the
   * viewport, so a reader who scrolled back down to the end reports `true`
   * even after follow was cancelled.
   */
  isAtEdge(): boolean;
}

/** Keeps the real scroll edge pinned while the text frame animates its height. */
export function useSmoothScroll({
  element,
  enabled,
  identity,
  controlRef,
  endRequest = 0,
  onDetach,
}: {
  element: HTMLElement | null;
  enabled: boolean;
  identity: string;
  reducedMotion: boolean;
  controlRef: RefObject<SmoothScrollHandle | null>;
  endRequest?: number;
  onDetach?: (() => void) | undefined;
}) {
  const controllerRef = useRef<SmoothScrollHandle | null>(null);
  const handledEndRequestRef = useRef({ identity, value: endRequest });
  const request = useCallback(() => controllerRef.current?.request() ?? false, []);

  useLayoutEffect(() => {
    if (!enabled || !element) return;
    let cancelled = false;
    let lastPinnedTop: number | null = null;
    let chaseFrame: number | null = null;
    const writeEnd = () => {
      const end = Math.max(0, element.scrollHeight - element.clientHeight);
      if (element.scrollTop !== end) element.scrollTop = end;
      // Read back the browser's clamped value, including fractional geometry.
      lastPinnedTop = element.scrollTop;
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
      if (cancelled || chaseFrame !== null) return;
      chaseIdleFrames = 0;
      chaseFrame = requestAnimationFrame(() => {
        chaseFrame = null;
        if (cancelled) return;
        const end = Math.max(0, element.scrollHeight - element.clientHeight);
        // Only a viewport still sitting on our own pinned offset is ours to
        // move; anything else is the reader's.
        if (element.scrollTop === lastPinnedTop && element.scrollTop !== end) {
          writeEnd();
          chaseIdleFrames = 0;
        } else if (++chaseIdleFrames < CHASE_IDLE_FRAMES) {
          scheduleChase();
        }
      });
    };
    const pin = () => {
      if (cancelled) return false;
      const end = Math.max(0, element.scrollHeight - element.clientHeight);
      if (element.scrollTop < end && element.scrollTop !== lastPinnedTop) {
        // Layout may grow the end while leaving our last pinned offset intact.
        // Any other off-end position belongs to the reader, even before the
        // browser dispatches scroll and even if it differs by less than 1px.
        if (lastPinnedTop !== null) {
          cancelled = true;
          onDetach?.();
        }
        return false;
      }
      writeEnd();
      scheduleChase();
      return true;
    };
    const handle: SmoothScrollHandle = {
      request: pin,
      jumpToEnd() {
        cancelled = false;
        writeEnd();
      },
      cancel() {
        cancelled = true;
      },
      isFollowing: () => !cancelled && lastPinnedTop !== null,
      isAtEdge: () => element.scrollTop >= Math.max(0, element.scrollHeight - element.clientHeight),
    };
    controllerRef.current = handle;
    controlRef.current = handle;
    element.addEventListener(SMOOTH_TEXT_BEFORE_LAYOUT_EVENT, pin);
    element.addEventListener(SMOOTH_TEXT_LAYOUT_EVENT, pin);
    const resize = new ResizeObserver(pin);
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    pin();

    return () => {
      handle.cancel();
      if (chaseFrame !== null) cancelAnimationFrame(chaseFrame);
      resize.disconnect();
      element.removeEventListener(SMOOTH_TEXT_BEFORE_LAYOUT_EVENT, pin);
      element.removeEventListener(SMOOTH_TEXT_LAYOUT_EVENT, pin);
      if (controllerRef.current === handle) controllerRef.current = null;
      if (controlRef.current === handle) controlRef.current = null;
    };
    // A thread switch must discard the previous thread's controller even if the DOM is reused.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [controlRef, element, enabled, identity, onDetach]);

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
