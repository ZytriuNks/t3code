export const SMOOTH_TEXT_LAYOUT_EVENT = "t3-smooth-text-layout";
export const SMOOTH_TEXT_BEFORE_LAYOUT_EVENT = "t3-smooth-text-before-layout";

/** Check the viewport before making room for text, then commit the new height. */
export function setSmoothTextFrameHeight(element: HTMLElement, height: number | null) {
  const value = height === null ? "" : `${height}px`;
  if (element.style.height === value) return;
  element.dispatchEvent(new Event(SMOOTH_TEXT_BEFORE_LAYOUT_EVENT, { bubbles: true }));
  element.style.height = value;
  element.dispatchEvent(new Event(SMOOTH_TEXT_LAYOUT_EVENT, { bubbles: true }));
  // A frame can write more than once before the browser paints. Each write
  // leaves the viewport short of the new edge, so the label above the growing
  // text drops for that frame and springs back once the follow catches up.
  // Settle the viewport against the final height of the frame instead.
  flushSmoothTextFrameLayout(element);
}

/**
 * Runs once per frame, after every height write for that frame has landed, so
 * the follow compensates by the total growth rather than one write at a time.
 */
export function flushSmoothTextFrameLayout(element: HTMLElement) {
  if (scheduledFrameLayout.has(element)) return;
  scheduledFrameLayout.add(element);
  requestAnimationFrame(() => {
    scheduledFrameLayout.delete(element);
    if (!element.isConnected) return;
    element.dispatchEvent(new Event(SMOOTH_TEXT_LAYOUT_EVENT, { bubbles: true }));
  });
}

const scheduledFrameLayout = new WeakSet<HTMLElement>();

const revealedEnds = new WeakMap<HTMLElement, { range: Range | null; fullRange: Range | null }>();

/** Publish the visible text edge without changing Markdown's layout or source text. */
export function setSmoothTextEnd(
  element: HTMLElement,
  range: Range | null,
  fullRange: Range | null = range,
) {
  revealedEnds.set(element, { range, fullRange });
  element.dataset.smoothTextEnd = "";
  element.dispatchEvent(new Event(SMOOTH_TEXT_LAYOUT_EVENT, { bubbles: true }));
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
