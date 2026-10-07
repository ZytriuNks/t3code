/** Thumb geometry for custom overlay scrollbars.
 *
 * Shared by the terminal surface and the React overlay scrollbar so both agree
 * on how a scroll offset maps to a thumb position and back. Pure functions on
 * purpose: they are the only part of a scrollbar worth unit testing.
 */

/** Scroll extent of a scrollable: total content size, current offset, visible size. */
export interface ScrollbarState {
  readonly total: number;
  readonly offset: number;
  readonly len: number;
}

export interface ScrollbarGeometry {
  readonly thumbHeight: number;
  readonly thumbTop: number;
  readonly maxOffset: number;
}

/** Keeps a short thumb grabbable even when the content is very long. */
export const MIN_SCROLLBAR_THUMB_HEIGHT = 18;

/** Maps scroll state to a proportional thumb within `trackHeight`.
 *
 * Returns null when there is nothing to scroll, so callers can hide the bar
 * instead of rendering a full-length thumb.
 */
export function scrollbarGeometry(
  state: ScrollbarState,
  trackHeight: number,
): ScrollbarGeometry | null {
  const total = Math.max(0, state.total);
  const len = Math.max(0, Math.min(state.len, total));
  const maxOffset = Math.max(0, total - len);
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null;
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const offset = Math.max(0, Math.min(state.offset, maxOffset));
  return {
    thumbHeight,
    thumbTop: travel * (offset / maxOffset),
    maxOffset,
  };
}

/** Maps a pointer position back to a scroll offset, for thumb dragging.
 *
 * `pointerOffset` is where within the thumb the pointer grabbed it, so the
 * thumb does not jump to centre itself under the cursor.
 */
export function scrollbarOffsetAtPointer(
  state: ScrollbarState,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number,
): number {
  const geometry = scrollbarGeometry(state, trackHeight);
  if (geometry === null) return 0;
  const travel = Math.max(0, trackHeight - geometry.thumbHeight);
  if (travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel));
  return Math.round((thumbTop / travel) * geometry.maxOffset);
}