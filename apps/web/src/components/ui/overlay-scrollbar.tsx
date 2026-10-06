"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  scrollbarGeometry,
  scrollbarOffsetAtPointer,
  type ScrollbarGeometry,
} from "~/lib/scrollbar-geometry";

/** Visual thumb width. Reads --app-scrollbar-thumb-width, which the lane
 * initialises from the shared --app-scrollbar-width and a host may narrow via
 * the `width` prop. The default must stay equal to --app-scrollbar-width
 * because the virtualized-list fade masks carve out a lane of exactly that
 * width to keep the gradient from dimming the scrollbar.
 */
const THUMB_CLASS = "w-[var(--app-scrollbar-thumb-width)]";

/** The lane is twice the thumb width so the whole strip is an easy hover and
 * grab target, while the thumb itself stays flush against the right edge.
 */
const LANE_CLASS = "w-3";

/** Inset of the thumb and triangles from the lane's right edge. The lane sits
 * flush with the viewport, so this inset *is* the visible gap between the bar
 * and the edge. "edge" keeps a 1px hairline; "gutter" pushes the bar further
 * in so it sits centred inside a content gutter reserved by the host.
 */
type ThumbInset = "edge" | "gutter";

/** Gap left below the bar. A surface whose content ends flush with the panel
 * floor needs more clearance here, or the thumb reads as touching it.
 */
type BottomGap = "hairline" | "roomy";

/** Height reserved at each end for a step triangle. */
const TRIANGLE_SIZE_PX = 12;

/** How long a press must be sustained before the bar starts coasting, so a
 * plain click produces exactly one step.
 */
const HOLD_START_DELAY_MS = 180;
/** Coasting speed in pixels per second. */
const HOLD_SPEED_PX_PER_SECOND = 1100;

type StepDirection = -1 | 1;

type OverlayScrollbarProps = {
  /** Native scroll element being represented. */
  scrollable: HTMLElement | null;
  /** Controlled visibility. Hover is layered on top of this. */
  visible?: boolean;
  /** Render up/down step triangles at the ends of the lane. */
  triangles?: boolean;
  /** Fired on triangle click and repeatedly while it is held. */
  onStep?: (direction: StepDirection) => void;
  /**
   * Thumb width. Defaults to the shared --app-scrollbar-width. The model
   * picker passes a thinner bar: it sits over dense two-line rows, where a
   * 6px thumb reads as heavier than it needs to be.
   */
  width?: string;
  /** Inset of the thumb and triangles from the lane's right edge. */
  thumbInset?: ThumbInset;
  /** Clearance kept below the bar and above the bottom edge. */
  bottomGap?: BottomGap;
  className?: string;
};

/** Up/down triangle in a box as wide as the thumb.
 *
 * Drawn as an equilateral triangle (apex centred, base corners pulled in by
 * half the height so the three sides are equal) rather than the squat arrow
 * used before. The corners are rounded by stroking the path in the same
 * colour with a round line join, which rounds all three vertices at once
 * without needing a filter or a per-corner arc.
 */
function StepTriangle({ direction }: { direction: StepDirection }) {
  // 6 wide x 5.196 tall: the exact height of an equilateral triangle with a
  // 6px side, so the shape reads as a triangle and not a chevron.
  const height = 5.196;
  return (
    <svg
      aria-hidden="true"
      className="h-[calc(var(--app-scrollbar-thumb-width)*0.866)] w-[var(--app-scrollbar-thumb-width)]"
      viewBox="0 0 6 5.196"
      preserveAspectRatio="none"
    >
      <path
        d={
          direction === -1
            ? `M3 .4 L5.55 ${height - 0.4} L.45 ${height - 0.4} Z`
            : `M3 ${height - 0.4} L5.55 .4 L.45 .4 Z`
        }
        fill="currentColor"
        stroke="currentColor"
        strokeWidth=".8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Custom vertical scrollbar drawn over a scroll container.
 *
 * The native scrollbar is hidden by the host (see the three-part
 * `[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`
 * class). Positioning the thumb with `right: 0` rather than insetting it with a
 * transparent border is what lets it sit against the window edge without
 * getting thinner — a border inset can only move where the thumb starts, not
 * free up space on the right.
 */
function OverlayScrollbar({
  scrollable,
  visible,
  triangles,
  onStep,
  width,
  thumbInset = "edge",
  bottomGap = "hairline",
  className,
}: OverlayScrollbarProps) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const trackHeightRef = useRef(0);
  const [laneElement, setLaneElement] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<ScrollbarGeometry | null>(null);
  const [dragging, setDragging] = useState(false);

  // The lane is measured in the effect below, so the element has to exist
  // before that runs. A ref alone cannot express this: on the first layout
  // effect the ref is still null, so measuring there would always bail out
  // and the bar would never appear. Holding the node in state breaks the
  // cycle — the effect re-runs once it mounts.
  const laneCallbackRef = useCallback((node: HTMLDivElement | null) => {
    laneRef.current = node;
    setLaneElement(node);
  }, []);

  // Re-measure whenever the content resizes. Virtualized lists change content
  // height without the viewport changing, so observe the content element too.
  useLayoutEffect(() => {
    if (!scrollable || !laneElement) return;
    const measure = () => {
      const trackHeight =
        laneElement.clientHeight - (triangles ? TRIANGLE_SIZE_PX * 2 : 0);
      trackHeightRef.current = trackHeight;
      setGeometry(
        scrollbarGeometry(
          {
            total: scrollable.scrollHeight,
            offset: scrollable.scrollTop,
            len: scrollable.clientHeight,
          },
          trackHeight,
        ),
      );
    };
    measure();
    const frame = requestAnimationFrame(measure);
    scrollable.addEventListener("scroll", measure, { passive: true });
    // Guard for render environments without ResizeObserver; the scroll
    // listener above still keeps the thumb in sync there.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scrollable);
    if (scrollable.firstElementChild) {
      observer?.observe(scrollable.firstElementChild);
    }
    return () => {
      cancelAnimationFrame(frame);
      scrollable.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [scrollable, triangles, laneElement]);

  const scrollByPage = useCallback(
    (direction: StepDirection) => {
      onStep?.(direction);
    },
    [onStep],
  );

  // Holding a triangle scrolls at a steady rate. A timer that re-issued the
  // same step produced a stutter — a long dead pause, then a series of discrete
  // jumps — so this advances scrollTop once per frame instead, which reads as
  // continuous motion. The click step is handled by the host's onStep; this
  // only takes over once the press is sustained. The pointer may leave the
  // button while held, so stop on the next pointerup anywhere.
  const startHold = useCallback(
    (direction: StepDirection) => {
      const element = scrollable;
      if (!element) return;
      let frame: number | null = null;
      let lastFrameAt = 0;
      const stop = () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
      };
      const coast = (now: number) => {
        // Clamp the step so a dropped frame cannot jump a long way.
        const elapsedSeconds = Math.min((now - lastFrameAt) / 1000, 0.05);
        lastFrameAt = now;
        const before = element.scrollTop;
        element.scrollTop += direction * HOLD_SPEED_PX_PER_SECOND * elapsedSeconds;
        if (element.scrollTop === before) {
          return; // Reached the end; stop requesting frames.
        }
        frame = window.requestAnimationFrame(coast);
      };
      // Short grace period so an ordinary click does not also start coasting.
      const startTimer = window.setTimeout(() => {
        lastFrameAt = performance.now();
        frame = window.requestAnimationFrame(coast);
      }, HOLD_START_DELAY_MS);
      const stopAll = () => {
        window.clearTimeout(startTimer);
        stop();
      };
      window.addEventListener("pointerup", stopAll, true);
      window.addEventListener("pointercancel", stopAll, true);
    },
    [scrollable],
  );

  const onThumbPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!scrollable || !geometry) return;
      event.preventDefault();
      const lane = laneRef.current;
      const thumb = thumbRef.current;
      if (!lane || !thumb) return;
      const pointerOffset = event.clientY - thumb.getBoundingClientRect().top;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      // React nulls `event.currentTarget` once the handler returns, and the
      // window-level safety net below can fire after that. Capture the element
      // now so teardown never dereferences a dead event.
      const captureTarget = event.currentTarget;
      // Both the thumb and the window can deliver the terminating event, so
      // the teardown must be idempotent.
      let settled = false;

      const onMove = (moveEvent: PointerEvent) => {
        const laneRect = lane.getBoundingClientRect();
        const trackHeight =
          laneRect.height - (triangles ? TRIANGLE_SIZE_PX * 2 : 0);
        const trackTop = laneRect.top + (triangles ? TRIANGLE_SIZE_PX : 0);
        const next = scrollbarOffsetAtPointer(
          {
            total: scrollable.scrollHeight,
            offset: scrollable.scrollTop,
            len: scrollable.clientHeight,
          },
          trackHeight,
          moveEvent.clientY - trackTop,
          // Where inside the thumb the pointer grabbed it. This must be the
          // offset from the thumb's top, unchanged since pointerdown —
          // subtracting it from the pointer position beforehand as well made
          // the thumb accelerate away from the cursor and come to rest at the
          // wrong offset, which then read as a jump on the next hover.
          pointerOffset,
        );
        scrollable.scrollTop = next;
      };
      const onUp = () => {
        if (settled) return;
        settled = true;
        // Remove the listeners *before* releasing capture. releasePointerCapture
        // throws NotFoundError once the pointer id is no longer active, and that
        // exception would skip every removal below — leaving a live pointermove
        // handler that drags the list to the cursor on each later hover.
        captureTarget.removeEventListener("pointermove", onMove);
        captureTarget.removeEventListener("pointerup", onUp);
        captureTarget.removeEventListener("pointercancel", onUp);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setDragging(false);
        try {
          captureTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Already released; the removals above are what mattered.
        }
      };
      event.currentTarget.addEventListener("pointermove", onMove);
      event.currentTarget.addEventListener("pointerup", onUp);
      event.currentTarget.addEventListener("pointercancel", onUp);
      // Safety net: if the thumb is re-rendered or loses capture mid-drag, the
      // element listener may never fire and the drag would otherwise stick.
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [geometry, scrollable, triangles],
  );

  const onLaneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!scrollable || !geometry) return;
      const page = scrollable.clientHeight;
      const step = 40;
      const max = geometry.maxOffset;
      const clamp = (value: number) => Math.max(0, Math.min(value, max));
      switch (event.key) {
        case "ArrowUp":
          scrollable.scrollTop = clamp(scrollable.scrollTop - step);
          break;
        case "ArrowDown":
          scrollable.scrollTop = clamp(scrollable.scrollTop + step);
          break;
        case "PageUp":
          scrollable.scrollTop = clamp(scrollable.scrollTop - page);
          break;
        case "PageDown":
          scrollable.scrollTop = clamp(scrollable.scrollTop + page);
          break;
        case "Home":
          scrollable.scrollTop = 0;
          break;
        case "End":
          scrollable.scrollTop = max;
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [geometry, scrollable],
  );

  // The lane itself is always hit-testable so a hover can reach a bar that is
  // currently faded out; only its contents fade. That makes the hover branch
  // load-bearing again, but it is applied to the thumb and triangles below
  // rather than to the lane, so the lane's own className never changes and
  // hovering cannot make the track itself jump.
  const shown = visible ?? true;
  // Hover is handled entirely in CSS (`group-hover`), so no React state is
  // involved and crossing the lane cannot restart a transition.
  const contentsVisible = shown || dragging;
  // The lane itself must always mount: it is what the measuring effect reads
  // its height from, so returning early on a null geometry would leave the
  // thumb permanently unmeasured. Only the thumb and triangles wait for it.
  const ready = geometry !== null;
  const travel = Math.max(1, trackHeightRef.current - (geometry?.thumbHeight ?? 0));

  return (
    <div
      ref={laneCallbackRef}
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={geometry?.maxOffset ?? 0}
      aria-valuenow={
        geometry === null
          ? 0
          : Math.round(geometry.maxOffset * (geometry.thumbTop / travel))
      }
      tabIndex={ready ? 0 : -1}
      onKeyDown={onLaneKeyDown}
      className={cn(
        // The lane sits flush with the viewport's right edge; `bottomGap` sets how
        // much clearance is kept below the bar. A surface whose content runs to
        // the panel floor needs the roomier value or the thumb reads as
        // touching it when scrolled to the end.
        // Positioned against the host's padding box, not the viewport. When the bar is
        // a child of a scroll container that itself has horizontal padding
        // (LegendList uses px-3 sm:px-5), `right-0` lands inside that gutter and
        // leaves the bar visibly short of the window edge. The inset token
        // subtracts the host padding so the thumb still reaches the edge.
        "group absolute right-0 top-0 z-30 flex touch-none flex-col items-end outline-none",
        bottomGap === "roomy" ? "bottom-2" : "bottom-px",
        LANE_CLASS,
        // The lane is always fully transparent-but-present: it must stay
        // hit-testable so a hover can reach a bar that is currently faded out.
        // Fading the *lane* instead of its contents also multiplied the
        // children's opacity down, which is why a host-controlled bar could
        // never be revealed by hovering it.
        className,
      )}
      style={
        {
          "--app-scrollbar-thumb-width":
            width ?? "var(--app-scrollbar-width)",
          // One knob for both the thumb and the triangles, so they can never
          // drift out of alignment with each other.
          "--overlay-scrollbar-edge": thumbInset === "gutter" ? "0.25rem" : "0px",
        } as React.CSSProperties
      }
    >
      {triangles && ready ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Scroll up"
          onClick={() => scrollByPage(-1)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            startHold(-1);
          }}
          className={cn(
            "flex shrink-0 items-center justify-center text-[var(--app-scrollbar-thumb)] transition-[opacity,color] duration-150 mr-[var(--overlay-scrollbar-edge)]",
            contentsVisible ? "opacity-100" : "opacity-0",
            // Pure-CSS hover reveal: no state, no re-render, no transition
            // restart when the pointer crosses the lane.
            "group-hover:opacity-100",
            "group-hover:text-[var(--app-scrollbar-thumb-hover)]",
          )}
          style={{ height: TRIANGLE_SIZE_PX }}
        >
          <StepTriangle direction={-1} />
        </button>
      ) : null}

      {ready ? (
        <div
          ref={thumbRef}
          onPointerDown={onThumbPointerDown}
          className={cn(
            "absolute right-[var(--overlay-scrollbar-edge)] rounded-[3px] bg-[var(--app-scrollbar-thumb)] transition-[opacity,background-color] duration-150 ease-out",
            "group-hover:bg-[var(--app-scrollbar-thumb-hover)]",
            dragging && "bg-[var(--app-scrollbar-thumb-hover)]",
            contentsVisible ? "opacity-100" : "opacity-0",
            // Pure-CSS hover reveal: no state, no re-render, no transition
            // restart when the pointer crosses the lane.
            "group-hover:opacity-100",
            THUMB_CLASS,
          )}
          style={{
            height: `${geometry.thumbHeight}px`,
            transform: `translateY(${triangles ? TRIANGLE_SIZE_PX + geometry.thumbTop : geometry.thumbTop}px)`,
          }}
        />
      ) : null}

      {triangles && ready ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Scroll down"
          onClick={() => scrollByPage(1)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            startHold(1);
          }}
          className={cn(
            "mt-auto flex shrink-0 items-center justify-center text-[var(--app-scrollbar-thumb)] transition-[opacity,color] duration-150 mr-[var(--overlay-scrollbar-edge)]",
            contentsVisible ? "opacity-100" : "opacity-0",
            // Pure-CSS hover reveal: no state, no re-render, no transition
            // restart when the pointer crosses the lane.
            "group-hover:opacity-100",
            "group-hover:text-[var(--app-scrollbar-thumb-hover)]",
          )}
          style={{ height: TRIANGLE_SIZE_PX }}
        >
          <StepTriangle direction={1} />
        </button>
      ) : null}
    </div>
  );
}

export { OverlayScrollbar };