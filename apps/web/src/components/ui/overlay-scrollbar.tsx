"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  scrollbarGeometry,
  scrollbarOffsetAtPointer,
  type ScrollbarGeometry,
} from "~/lib/scrollbar-geometry";

/** Visual thumb width. Kept equal to --app-scrollbar-width because the
 * virtualized-list fade masks carve out a lane of exactly that width to keep
 * the gradient from dimming the scrollbar.
 */
const THUMB_CLASS = "w-[var(--app-scrollbar-width)]";

/** The lane is twice the thumb width so the whole strip is an easy hover and
 * grab target, while the thumb itself stays flush against the right edge.
 */
const LANE_CLASS = "w-3";

/** Height reserved at each end for a step triangle. */
const TRIANGLE_SIZE_PX = 12;

const HOLD_REPEAT_DELAY_MS = 420;
const HOLD_REPEAT_INTERVAL_MS = 90;

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
  className?: string;
};

/** Triangle path in a 6x5 box, stroked with a round join so all three corners
 * read as rounded. Sized to the thumb width.
 */
function StepTriangle({ direction }: { direction: StepDirection }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-[var(--app-scrollbar-width)]"
      viewBox="0 0 6 5"
      preserveAspectRatio="none"
    >
      <path
        d={direction === -1 ? "M3 1 L5.3 4.2 L.7 4.2 Z" : "M3 4 L5.3 .8 L.7 .8 Z"}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth=".9"
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
  className,
}: OverlayScrollbarProps) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const trackHeightRef = useRef(0);
  const [laneElement, setLaneElement] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<ScrollbarGeometry | null>(null);
  const [hovered, setHovered] = useState(false);
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

  // Holding a triangle keeps stepping. The pointer may leave the button while
  // held, so listen on the window and stop on the next pointerup.
  const startHold = useCallback(
    (direction: StepDirection) => {
      if (!onStep) return;
      let interval: number | null = null;
      let delay: number | null = null;
      const stop = () => {
        if (delay !== null) window.clearTimeout(delay);
        if (interval !== null) window.clearInterval(interval);
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
      };
      delay = window.setTimeout(() => {
        interval = window.setInterval(
          () => scrollByPage(direction),
          HOLD_REPEAT_INTERVAL_MS,
        );
      }, HOLD_REPEAT_DELAY_MS);
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("pointercancel", stop, true);
    },
    [onStep, scrollByPage],
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

      const onMove = (moveEvent: PointerEvent) => {
        const laneRect = lane.getBoundingClientRect();
        const trackHeight =
          laneRect.height - (triangles ? TRIANGLE_SIZE_PX * 2 : 0);
        const top =
          laneRect.top + (triangles ? TRIANGLE_SIZE_PX : 0) + pointerOffset;
        const next = scrollbarOffsetAtPointer(
          {
            total: scrollable.scrollHeight,
            offset: scrollable.scrollTop,
            len: scrollable.clientHeight,
          },
          trackHeight,
          moveEvent.clientY - top,
          pointerOffset,
        );
        scrollable.scrollTop = next;
      };
      const onUp = () => {
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.currentTarget.removeEventListener("pointermove", onMove);
        event.currentTarget.removeEventListener("pointerup", onUp);
        event.currentTarget.removeEventListener("pointercancel", onUp);
      };
      event.currentTarget.addEventListener("pointermove", onMove);
      event.currentTarget.addEventListener("pointerup", onUp);
      event.currentTarget.addEventListener("pointercancel", onUp);
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

  // Only render when there is something to scroll. `visible` lets a host keep
  // the bar hidden until it decides otherwise; hover reveals it regardless so
  // the whole lane stays an easy grab target.
  const shown = visible ?? true;
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
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={onLaneKeyDown}
      className={cn(
        "group absolute inset-y-0 right-0 z-30 flex touch-none flex-col items-end outline-none",
        LANE_CLASS,
        "transition-opacity duration-150 ease-out",
        ready && (shown || hovered || dragging)
          ? "opacity-100"
          : "pointer-events-none opacity-0",
        className,
      )}
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
            "flex shrink-0 items-center justify-center text-[var(--app-scrollbar-thumb)] transition-colors duration-150",
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
            "absolute right-0 rounded-[3px] bg-[var(--app-scrollbar-thumb)] transition-colors duration-150 ease-out",
            "group-hover:bg-[var(--app-scrollbar-thumb-hover)]",
            dragging && "bg-[var(--app-scrollbar-thumb-hover)]",
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
            "mt-auto flex shrink-0 items-center justify-center text-[var(--app-scrollbar-thumb)] transition-colors duration-150",
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