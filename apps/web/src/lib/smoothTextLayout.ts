export const SMOOTH_TEXT_LAYOUT_EVENT = "t3-smooth-text-layout";

/**
 * How far the frame's bottom edge moved down, in CSS pixels. The scroll
 * controller only needs this to keep the viewport on the content's edge: it
 * used to read `scrollHeight` before and after every height write to
 * rediscover the same number, which forced layout twice per animation frame.
 * A viewport follows growth by moving down by exactly this much.
 */
export interface SmoothTextLayoutDetail {
  readonly delta: number;
  readonly synchronous?: boolean;
  readonly phase?: "before" | "after";
  /** Filled by the virtual list's capture listener before end-follow runs. */
  rowFraction?: number;
}

const scheduledFrameLayout = new WeakSet<HTMLElement>();

/**
 * Commit a new frame height and tell listeners exactly how far the edge moved.
 * A callback can write more than once before the browser paints. Settle its
 * last write in a microtask, so a second text/footnote edge does not wait for
 * the next delivered frame to move the viewport.
 */
export function setSmoothTextFrameHeight(
  element: HTMLElement,
  height: number | null,
  synchronous = false,
) {
  const previous = element.style.height;
  const value = height === null ? "" : `${height}px`;
  if (previous === value && !synchronous) return;
  // Native overflow may clamp the viewport during this direct DOM write,
  // before the virtual row can publish its new size. Capture ownership first.
  element.dispatchEvent(
    new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
      bubbles: true,
      detail: { delta: 0, phase: "before" },
    }),
  );
  if (previous !== value) element.style.height = value;
  const from = Number.parseFloat(previous);
  // Clearing an explicit height restores natural layout; it does not remove
  // the content. Reporting zero made end-follow scroll backwards by the whole
  // response exactly when its Thinking label closed.
  const to = height ?? element.getBoundingClientRect().height;
  element.dispatchEvent(
    new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
      bubbles: true,
      detail: {
        delta: to - (Number.isFinite(from) ? from : 0),
        phase: "after",
        ...(synchronous ? { synchronous } : {}),
      },
    }),
  );
  if (scheduledFrameLayout.has(element)) return;
  scheduledFrameLayout.add(element);
  queueMicrotask(() => {
    scheduledFrameLayout.delete(element);
    if (!element.isConnected) return;
    element.dispatchEvent(
      new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
        bubbles: true,
        detail: { delta: 0 },
      }),
    );
  });
}

const revealedEnds = new WeakMap<HTMLElement, { range: Range | null; fullRange: Range | null }>();

/** Publish the visible text edge without changing Markdown's layout or source text. */
export function setSmoothTextEnd(
  element: HTMLElement,
  range: Range | null,
  fullRange: Range | null = range,
) {
  revealedEnds.set(element, { range, fullRange });
  if (element.dataset.smoothTextEnd === undefined) element.dataset.smoothTextEnd = "";
}

export function clearSmoothTextEnd(element: HTMLElement) {
  revealedEnds.delete(element);
  delete element.dataset.smoothTextEnd;
}

export function readSmoothTextEnd(
  root: HTMLElement,
): { element: HTMLElement; bottom: number | null; hiddenTailHeight: number } | undefined {
  // Virtualized DOM order can differ from timeline order. Ignore status/footer
  // rows, but let a later tool result or user message take over from old text.
  let latestRow: HTMLElement | undefined;
  let latestTop = -Infinity;
  for (const row of root.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")) {
    if (["working", "thinking", "assistant-meta"].includes(row.dataset.timelineRowKind!)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.top >= latestTop) {
      latestRow = row;
      latestTop = rect.top;
    }
  }
  const elements = (latestRow ?? root).querySelectorAll<HTMLElement>("[data-smooth-text-end]");
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    const end = revealedEnds.get(element);
    if (!end) continue;
    const { range, fullRange } = end;
    if (range === null) return { element, bottom: null, hiddenTailHeight: 0 };
    if (!element.contains(range.endContainer)) continue;
    const rect = range.getBoundingClientRect();
    if (rect.height > 0) {
      const fullRect =
        fullRange && element.contains(fullRange.endContainer)
          ? fullRange.getBoundingClientRect()
          : null;
      return {
        element,
        bottom: rect.bottom,
        hiddenTailHeight:
          fullRect && fullRect.height > 0 ? Math.max(0, fullRect.bottom - rect.bottom) : 0,
      };
    }
  }
  return undefined;
}
