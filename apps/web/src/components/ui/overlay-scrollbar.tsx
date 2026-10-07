"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  SCROLLBAR_TRIANGLE_SIZE,
  SCROLLBAR_TRIANGLE_PATH,
  SCROLLBAR_TRIANGLE_VIEWBOX,
  SCROLLBAR_TRIANGLE_DOWN_TRANSFORM,
} from "~/lib/scrollbar-style";
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

/** Compact bars overlay content with 3px clearance at the right edge. */
type ThumbInset = "edge" | "gutter";

/** Height reserved at each end for a step triangle. */
const TRIANGLE_SIZE_PX = SCROLLBAR_TRIANGLE_SIZE;

/** How long a press must be sustained before the bar starts coasting, so a
 * plain click produces exactly one step.
 */
const HOLD_START_DELAY_MS = 180;
/** Coasting speed in pixels per second. */
const HOLD_SPEED_PX_PER_SECOND = 1100;

const COMPACT_REVEAL_PROPERTY = "--compact-scrollbar-reveal";
const COMPACT_FADE_IN_MS = 150;
const COMPACT_FADE_OUT_MS = 300;

type StepDirection = -1 | 1;

type OverlayScrollbarProps = {
  /** Native scroll element being represented. */
  scrollable: HTMLElement | null;
  orientation?: "vertical" | "horizontal";
  /** Controlled visibility. Hover is layered on top of this. */
  visible?: boolean;
  /** Reveal on scroll, hover or drag, then fade after 700ms at rest. */
  autoHide?: boolean;
  /** Render up/down step triangles at the ends of the lane. */
  triangles?: boolean;
  /** Fired for a short triangle click; holding advances the native offset. */
  onStep?: (direction: StepDirection) => void;
  /** Release any host-owned scroll animation or live-follow before navigation. */
  onScrollStart?: () => void;
  /**
   * Thumb width. Defaults to the shared --app-scrollbar-width. The model
   * picker passes a thinner bar: it sits over dense two-line rows, where a
   * 6px thumb reads as heavier than it needs to be.
   */
  width?: string;
  /** Inset of the thumb and triangles from the lane's right edge. */
  thumbInset?: ThumbInset;
  /** Embedded panes use their own edge rather than the desktop resize inset. */
  embedded?: boolean;
  /** Show remaining content at the vertical edges. Compact lists enable this by default. */
  scrollFade?: boolean;
  className?: string;
};

/** Equilateral outline with 1px circular corners at the default 6px width. */
function StepTriangle({ direction }: { direction: StepDirection }) {
  return (
    <svg
      aria-hidden="true"
      className="h-[calc(var(--app-scrollbar-thumb-width)*0.911)] w-[var(--app-scrollbar-thumb-width)]"
      viewBox={SCROLLBAR_TRIANGLE_VIEWBOX}
      preserveAspectRatio="none"
    >
      <path
        d={SCROLLBAR_TRIANGLE_PATH}
        transform={direction === 1 ? SCROLLBAR_TRIANGLE_DOWN_TRANSFORM : undefined}
        fill="currentColor"
      />
    </svg>
  );
}

/** Custom scrollbar drawn over a scroll container.
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
  orientation = "vertical",
  visible,
  autoHide = false,
  triangles,
  onStep,
  onScrollStart,
  width,
  thumbInset = "edge",
  embedded = false,
  scrollFade = thumbInset === "gutter",
  className,
}: OverlayScrollbarProps) {
  const horizontal = orientation === "horizontal";
  const showTriangles = triangles && !horizontal;
  const laneRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const trackHeightRef = useRef(0);
  const [laneElement, setLaneElement] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<ScrollbarGeometry | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [horizontalOverflow, setHorizontalOverflow] = useState(false);
  const [atWindowRightEdge, setAtWindowRightEdge] = useState(false);
  const stopHoldRef = useRef<(() => void) | null>(null);
  const stopDragRef = useRef<(() => void) | null>(null);
  const heldRef = useRef(false);
  const updateCompactRevealRef = useRef<((visible: boolean) => void) | null>(null);

  useLayoutEffect(() => {
    if (!autoHide || !scrollable) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      setScrolling(true);
      clearTimeout(timer);
      timer = setTimeout(() => setScrolling(false), 700);
    };
    scrollable.addEventListener("scroll", reveal, { passive: true });
    return () => {
      clearTimeout(timer);
      scrollable.removeEventListener("scroll", reveal);
      setScrolling(false);
    };
  }, [autoHide, scrollable]);

  useLayoutEffect(() => {
    if (!scrollable) return;
    return () => {
      stopHoldRef.current?.();
      stopDragRef.current?.();
    };
  }, [scrollable]);

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
    const measureWindowEdge = () => {
      if (horizontal || embedded || thumbInset !== "edge") return;
      const resizeInset =
        Number.parseFloat(
          getComputedStyle(laneElement).getPropertyValue("--desktop-window-right-resize-inset"),
        ) || 0;
      // Only the outermost pane shares the root's desktop resize clearance.
      setAtWindowRightEdge(
        resizeInset > 0 &&
          Math.abs(
            laneElement.getBoundingClientRect().right -
              (document.documentElement.clientWidth - resizeInset),
          ) < 1,
      );
    };
    const measure = () => {
      if (scrollFade && !horizontal) {
        const remaining = scrollable.scrollHeight - scrollable.clientHeight - scrollable.scrollTop;
        scrollable.style.setProperty(
          "--overlay-scroll-fade-top",
          `${Math.max(0, Math.min(24, scrollable.scrollTop))}px`,
        );
        scrollable.style.setProperty(
          "--overlay-scroll-fade-bottom",
          `${Math.max(0, Math.min(24, remaining))}px`,
        );
      }
      setHorizontalOverflow(
        scrollable.scrollWidth > scrollable.clientWidth &&
          ["auto", "scroll"].includes(getComputedStyle(scrollable).overflowX),
      );
      const trackHeight = horizontal
        ? laneElement.clientWidth
        : laneElement.clientHeight - (showTriangles ? TRIANGLE_SIZE_PX * 2 : 0);
      trackHeightRef.current = trackHeight;
      setGeometry(
        horizontal && !["auto", "scroll"].includes(getComputedStyle(scrollable).overflowX)
          ? null
          : scrollbarGeometry(
              {
                total: horizontal ? scrollable.scrollWidth : scrollable.scrollHeight,
                offset: horizontal ? scrollable.scrollLeft : scrollable.scrollTop,
                len: horizontal ? scrollable.clientWidth : scrollable.clientHeight,
              },
              trackHeight,
            ),
      );
    };
    const frame = requestAnimationFrame(() => {
      measureWindowEdge();
      measure();
    });
    scrollable.addEventListener("scroll", measure, { passive: true });
    // Guard for render environments without ResizeObserver; the scroll
    // listener above still keeps the thumb in sync there.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            measureWindowEdge();
            measure();
          });
    const observeContent = () => {
      observer?.disconnect();
      observer?.observe(scrollable);
      observer?.observe(laneElement);
      for (const child of scrollable.children) observer?.observe(child);
      measureWindowEdge();
      measure();
    };
    observeContent();
    if (scrollFade && !horizontal) scrollable.setAttribute("data-overlay-scroll-fade", "");
    const mutations =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(observeContent);
    mutations?.observe(scrollable, { childList: true });
    scrollable.addEventListener("input", measure);
    window.addEventListener("resize", measureWindowEdge);
    return () => {
      cancelAnimationFrame(frame);
      scrollable.removeEventListener("scroll", measure);
      observer?.disconnect();
      mutations?.disconnect();
      scrollable.removeEventListener("input", measure);
      window.removeEventListener("resize", measureWindowEdge);
      if (scrollFade && !horizontal) {
        scrollable.removeAttribute("data-overlay-scroll-fade");
        scrollable.style.removeProperty("--overlay-scroll-fade-top");
        scrollable.style.removeProperty("--overlay-scroll-fade-bottom");
      }
    };
  }, [scrollable, horizontal, showTriangles, laneElement, scrollFade, embedded, thumbInset]);

  const scrollByPage = useCallback(
    (direction: StepDirection) => {
      if (heldRef.current) {
        heldRef.current = false;
        return;
      }
      if (
        scrollable &&
        (direction < 0
          ? scrollable.scrollTop > 0
          : scrollable.scrollTop < scrollable.scrollHeight - scrollable.clientHeight)
      ) {
        onScrollStart?.();
      }
      if (onStep) {
        onStep(direction);
      } else {
        scrollable?.scrollBy({
          top: direction * scrollable.clientHeight * 0.3,
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      }
    },
    [onScrollStart, onStep, scrollable],
  );

  // Holding a triangle scrolls at a steady rate. A timer that re-issued the
  // same step produced a stutter — a long dead pause, then a series of discrete
  // jumps — so this advances scrollTop once per frame instead, which reads as
  // continuous motion. The click step is handled by the host's onStep; this
  // only takes over once the press is sustained. The pointer may leave the
  // button while held, so stop on the next pointerup anywhere.
  const startHold = useCallback(
    (direction: StepDirection) => {
      stopHoldRef.current?.();
      heldRef.current = false;
      const element = scrollable;
      if (!element) return;
      let frame: number | null = null;
      let lastFrameAt: number | null = null;
      let startTimer: number | undefined;
      const stop = () => {
        window.clearTimeout(startTimer);
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
        window.removeEventListener("blur", stop);
        stopHoldRef.current = null;
      };
      const coast = (now: number) => {
        frame = null;
        // Use only RAF timestamps. A frame can start before the timer fires;
        // subtracting performance.now() can reverse the first step at an edge.
        const elapsedSeconds =
          lastFrameAt === null ? 0 : Math.max(0, Math.min((now - lastFrameAt) / 1000, 0.05));
        lastFrameAt = now;
        const maxOffset = Math.max(0, element.scrollHeight - element.clientHeight);
        if (direction < 0 ? element.scrollTop <= 0 : element.scrollTop >= maxOffset) {
          return;
        }
        element.scrollTop = Math.max(
          0,
          Math.min(
            maxOffset,
            element.scrollTop + direction * HOLD_SPEED_PX_PER_SECOND * elapsedSeconds,
          ),
        );
        frame = window.requestAnimationFrame(coast);
      };
      // Short grace period so an ordinary click does not also start coasting.
      startTimer = window.setTimeout(() => {
        heldRef.current = true;
        if (
          direction < 0
            ? element.scrollTop > 0
            : element.scrollTop < element.scrollHeight - element.clientHeight
        ) {
          onScrollStart?.();
        }
        frame = window.requestAnimationFrame(coast);
      }, HOLD_START_DELAY_MS);
      stopHoldRef.current = stop;
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("pointercancel", stop, true);
      window.addEventListener("blur", stop);
    },
    [onScrollStart, scrollable],
  );

  const onThumbPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !scrollable || !geometry) return;
      stopDragRef.current?.();
      event.preventDefault();
      const lane = laneRef.current;
      const thumb = thumbRef.current;
      if (!lane || !thumb) return;
      const thumbRect = thumb.getBoundingClientRect();
      const pointerOffset = horizontal
        ? event.clientX - thumbRect.left
        : event.clientY - thumbRect.top;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      // React nulls `event.currentTarget` once the handler returns, and the
      // window-level safety net below can fire after that. Capture the element
      // now so teardown never dereferences a dead event.
      const captureTarget = event.currentTarget;
      // Both the thumb and the window can deliver the terminating event, so
      // the teardown must be idempotent.
      let settled = false;
      let started = false;

      const onMove = (moveEvent: PointerEvent) => {
        const laneRect = lane.getBoundingClientRect();
        const trackHeight = horizontal
          ? laneRect.width
          : laneRect.height - (showTriangles ? TRIANGLE_SIZE_PX * 2 : 0);
        const trackTop = horizontal
          ? laneRect.left
          : laneRect.top + (showTriangles ? TRIANGLE_SIZE_PX : 0);
        const next = scrollbarOffsetAtPointer(
          {
            total: horizontal ? scrollable.scrollWidth : scrollable.scrollHeight,
            offset: horizontal ? scrollable.scrollLeft : scrollable.scrollTop,
            len: horizontal ? scrollable.clientWidth : scrollable.clientHeight,
          },
          trackHeight,
          (horizontal ? moveEvent.clientX : moveEvent.clientY) - trackTop,
          // Where inside the thumb the pointer grabbed it. This must be the
          // offset from the thumb's top, unchanged since pointerdown —
          // subtracting it from the pointer position beforehand as well made
          // the thumb accelerate away from the cursor and come to rest at the
          // wrong offset, which then read as a jump on the next hover.
          pointerOffset,
        );
        if (!started && next !== (horizontal ? scrollable.scrollLeft : scrollable.scrollTop)) {
          started = true;
          onScrollStart?.();
        }
        if (horizontal) {
          scrollable.scrollLeft = next;
        } else {
          scrollable.scrollTop = next;
        }
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
        captureTarget.removeEventListener("lostpointercapture", onUp);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onUp);
        stopDragRef.current = null;
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
      event.currentTarget.addEventListener("lostpointercapture", onUp);
      stopDragRef.current = onUp;
      // Safety net: if the thumb is re-rendered or loses capture mid-drag, the
      // element listener may never fire and the drag would otherwise stick.
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onUp);
    },
    [geometry, horizontal, onScrollStart, scrollable, showTriangles],
  );

  const onLaneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!scrollable || !geometry) return;
      const page = horizontal ? scrollable.clientWidth : scrollable.clientHeight;
      const offset = horizontal ? scrollable.scrollLeft : scrollable.scrollTop;
      const step = 40;
      const max = geometry.maxOffset;
      const clamp = (value: number) => Math.max(0, Math.min(value, max));
      let next: number;
      switch (event.key) {
        case horizontal ? "ArrowLeft" : "ArrowUp":
          next = clamp(offset - step);
          break;
        case horizontal ? "ArrowRight" : "ArrowDown":
          next = clamp(offset + step);
          break;
        case "PageUp":
          next = clamp(offset - page);
          break;
        case "PageDown":
          next = clamp(offset + page);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      if (next !== offset) onScrollStart?.();
      scrollable.scrollTo({
        ...(horizontal ? { left: next } : { top: next }),
        behavior: "instant",
      });
      event.preventDefault();
    },
    [geometry, horizontal, onScrollStart, scrollable],
  );

  // The lane itself is always hit-testable so a hover can reach a bar that is
  // currently faded out; only its contents fade. That makes the hover branch
  // load-bearing again, but it is applied to the thumb and triangles below
  // rather than to the lane, so the lane's own className never changes and
  // hovering cannot make the track itself jump.
  const shown = visible ?? (autoHide ? scrolling : true);
  // Hover never flips React state. Compact bars animate one inherited value
  // for both the thumb and row masks; page bars retain their CSS transition.
  const contentsVisible = shown || dragging;
  // The lane itself must always mount: it is what the measuring effect reads
  // its height from, so returning early on a null geometry would leave the
  // thumb permanently unmeasured. Only the thumb and triangles wait for it.
  const ready = geometry !== null;
  const travel = Math.max(1, trackHeightRef.current - (geometry?.thumbHeight ?? 0));

  useLayoutEffect(() => {
    const parent = laneElement?.parentElement;
    if (!parent || !laneElement || horizontal || thumbInset !== "gutter") return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let hovering = laneElement.matches(":hover");
    let contentsShown = laneElement.hasAttribute("data-visible");
    let target = 0;
    parent.style.setProperty(COMPACT_REVEAL_PROPERTY, "0");
    const update = () => {
      const next = laneElement.hasAttribute("data-overflow") && (contentsShown || hovering) ? 1 : 0;
      if (next === target && !reducedMotion?.matches) return;
      // Read before cancellation so interrupted fades continue from the
      // painted value. WAAPI leaves the popup's own transitions untouched.
      const current =
        Number.parseFloat(getComputedStyle(parent).getPropertyValue(COMPACT_REVEAL_PROPERTY)) || 0;
      animation?.cancel();
      target = next;
      parent.style.setProperty(COMPACT_REVEAL_PROPERTY, String(next));
      if (current !== next && !reducedMotion?.matches && parent.animate) {
        animation = parent.animate(
          [{ [COMPACT_REVEAL_PROPERTY]: current }, { [COMPACT_REVEAL_PROPERTY]: next }],
          {
            duration: next ? COMPACT_FADE_IN_MS : COMPACT_FADE_OUT_MS,
            easing: "ease-out",
          },
        );
      }
    };
    const enter = () => {
      hovering = true;
      update();
    };
    const leave = () => {
      hovering = false;
      update();
    };
    updateCompactRevealRef.current = (visible) => {
      contentsShown = visible;
      update();
    };
    laneElement.addEventListener("pointerenter", enter);
    laneElement.addEventListener("pointerleave", leave);
    reducedMotion?.addEventListener("change", update);
    update();
    return () => {
      animation?.cancel();
      updateCompactRevealRef.current = null;
      parent.style.removeProperty(COMPACT_REVEAL_PROPERTY);
      laneElement.removeEventListener("pointerenter", enter);
      laneElement.removeEventListener("pointerleave", leave);
      reducedMotion?.removeEventListener("change", update);
    };
  }, [laneElement, horizontal, thumbInset]);

  useLayoutEffect(() => {
    updateCompactRevealRef.current?.(ready && contentsVisible);
  }, [contentsVisible, ready]);

  // Row padding varies between menus, virtualizers and model lists. Anchor
  // every fade to the thumb, including selected rows, and spare rows that
  // already leave 3px between their background and the thumb.
  useLayoutEffect(() => {
    if (!scrollable || !laneElement || horizontal || thumbInset !== "gutter" || !ready) return;
    let frame: number | undefined;
    let rows = new Set<HTMLElement>();
    const clearRow = (row: HTMLElement) => {
      row.removeAttribute("data-scrollbar-row-fade");
      row.style.removeProperty("--overlay-scrollbar-row-fade-end");
    };
    const measureRows = () => {
      frame = undefined;
      const thumb = thumbRef.current;
      if (!thumb) return;
      const thumbLeft = thumb.getBoundingClientRect().left;
      // Popup opening animations scale the whole lane and its rows. Store
      // unscaled CSS pixels so the fade stays aligned after that animation.
      const scale = laneElement.getBoundingClientRect().width / laneElement.offsetWidth || 1;
      const measurements = [
        ...scrollable.querySelectorAll<HTMLElement>(
          '[role="option"], [role^="menuitem"], [class~="group/timeline-row"]',
        ),
      ]
        .filter((row) => row.closest("[data-overlay-scroll-fade]") === scrollable)
        .map((row) => ({ row, rect: row.getBoundingClientRect() }));
      const nextRows = new Set(measurements.map(({ row }) => row));
      for (const row of rows) {
        if (!nextRows.has(row)) {
          observer?.unobserve(row);
          clearRow(row);
        }
      }
      for (const { row, rect } of measurements) {
        if (!rows.has(row)) observer?.observe(row);
        if ((thumbLeft - rect.right) / scale >= 2.99) {
          clearRow(row);
        } else {
          row.setAttribute("data-scrollbar-row-fade", "");
          row.style.setProperty(
            "--overlay-scrollbar-row-fade-end",
            `${(thumbLeft - rect.left) / scale}px`,
          );
        }
      }
      rows = nextRows;
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(measureRows);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scrollable);
    observer?.observe(laneElement);
    const mutations = new MutationObserver(schedule);
    mutations.observe(scrollable, { childList: true, subtree: true });
    scrollable.addEventListener("scroll", schedule, { passive: true });
    measureRows();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations.disconnect();
      scrollable.removeEventListener("scroll", schedule);
      rows.forEach(clearRow);
    };
  }, [scrollable, laneElement, horizontal, thumbInset, ready]);

  return (
    <div
      ref={laneCallbackRef}
      data-slot="overlay-scrollbar"
      data-variant={thumbInset === "gutter" ? "compact" : "page"}
      data-auto-hide={autoHide || undefined}
      data-overflow={ready || undefined}
      data-visible={(contentsVisible && ready) || undefined}
      role="scrollbar"
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={geometry?.maxOffset ?? 0}
      aria-valuenow={
        geometry === null ? 0 : Math.round(geometry.maxOffset * (geometry.thumbTop / travel))
      }
      tabIndex={ready ? 0 : -1}
      onKeyDown={onLaneKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        // This is a sibling of the scroll container, so list padding does not
        // affect its position. The model list keeps extra bottom clearance.
        "group/overlay-scrollbar absolute z-30 flex touch-none items-end outline-none",
        horizontal
          ? "bottom-0 left-0.5 right-3 h-3"
          : "right-0 top-[var(--overlay-scrollbar-top)] flex-col bottom-[var(--overlay-scrollbar-bottom)]",
        !ready && "pointer-events-none",
        !horizontal && LANE_CLASS,
        // The lane stays hit-testable so a hover can reach a bar that is
        // currently faded out. Code surfaces can supply an opaque background.
        // Fading the *lane* instead of its contents also multiplied the
        // children's opacity down, which is why a host-controlled bar could
        // never be revealed by hovering it.
        className,
      )}
      style={
        {
          "--app-scrollbar-thumb-width": width ?? "var(--app-scrollbar-width)",
          // One knob for both the thumb and the triangles, so they can never
          // drift out of alignment with each other.
          "--overlay-scrollbar-edge":
            thumbInset === "gutter"
              ? "3px"
              : !embedded && atWindowRightEdge
                ? "max(0px, calc(2px - var(--desktop-window-right-resize-inset)))"
                : "2px",
          "--overlay-scrollbar-bottom": `${Math.max(thumbInset === "gutter" ? 6 : 2, horizontalOverflow ? 8 : 0)}px`,
          "--overlay-scrollbar-top": `${thumbInset === "gutter" ? Math.max(6, horizontalOverflow ? 8 : 0) : 0}px`,
          backgroundColor: horizontal
            ? "transparent"
            : "var(--overlay-scrollbar-track, transparent)",
        } as React.CSSProperties
      }
    >
      {showTriangles && ready ? (
        <button
          type="button"
          data-slot="overlay-scrollbar-step"
          tabIndex={-1}
          aria-label="Scroll up"
          onClick={() => scrollByPage(-1)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            startHold(-1);
          }}
          className={cn(
            "flex w-3 shrink-0 items-start justify-end text-[var(--app-scrollbar-thumb)] transition-[opacity,color] duration-150 mr-[var(--overlay-scrollbar-edge)]",
            contentsVisible ? "opacity-100" : "opacity-0",
            // Pure-CSS hover reveal: no state, no re-render, no transition
            // restart when the pointer crosses the lane.
            "group-hover/overlay-scrollbar:opacity-100",
            "group-hover/overlay-scrollbar:text-[var(--app-scrollbar-thumb-hover)]",
          )}
          style={{ height: TRIANGLE_SIZE_PX }}
        >
          <StepTriangle direction={-1} />
        </button>
      ) : null}

      {ready ? (
        <div
          ref={thumbRef}
          data-slot="overlay-scrollbar-thumb"
          onPointerDown={onThumbPointerDown}
          className={cn(
            "absolute rounded-[3px] bg-[var(--app-scrollbar-thumb)] transition-[opacity,background-color] duration-150 ease-out",
            horizontal
              ? "bottom-0.5 left-0 h-[var(--app-scrollbar-thumb-width)]"
              : "right-[var(--overlay-scrollbar-edge)]",
            "group-hover/overlay-scrollbar:bg-[var(--app-scrollbar-thumb-hover)]",
            dragging && "bg-[var(--app-scrollbar-thumb-hover)]",
            contentsVisible ? "opacity-100" : "opacity-0",
            // Pure-CSS hover reveal: no state, no re-render, no transition
            // restart when the pointer crosses the lane.
            "group-hover/overlay-scrollbar:opacity-100",
            !horizontal && THUMB_CLASS,
          )}
          style={
            horizontal
              ? {
                  width: `${geometry.thumbHeight}px`,
                  transform: `translateX(${geometry.thumbTop}px)`,
                }
              : {
                  height: `${geometry.thumbHeight}px`,
                  transform: `translateY(${showTriangles ? TRIANGLE_SIZE_PX + geometry.thumbTop : geometry.thumbTop}px)`,
                }
          }
        />
      ) : null}

      {showTriangles && ready ? (
        <button
          type="button"
          data-slot="overlay-scrollbar-step"
          tabIndex={-1}
          aria-label="Scroll down"
          onClick={() => scrollByPage(1)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            startHold(1);
          }}
          className={cn(
            "mt-auto flex w-3 shrink-0 items-end justify-end text-[var(--app-scrollbar-thumb)] transition-[opacity,color] duration-150 mr-[var(--overlay-scrollbar-edge)]",
            contentsVisible ? "opacity-100" : "opacity-0",
            // Pure-CSS hover reveal: no state, no re-render, no transition
            // restart when the pointer crosses the lane.
            "group-hover/overlay-scrollbar:opacity-100",
            "group-hover/overlay-scrollbar:text-[var(--app-scrollbar-thumb-hover)]",
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
