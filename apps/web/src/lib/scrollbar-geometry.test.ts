import { describe, expect, it } from "vite-plus/test";

import {
  MIN_SCROLLBAR_THUMB_HEIGHT,
  scrollbarGeometry,
  scrollbarOffsetAtPointer,
} from "./scrollbar-geometry";

describe("scrollbarGeometry", () => {
  it("maps scroll state to a proportional thumb", () => {
    expect(scrollbarGeometry({ total: 100, offset: 40, len: 20 }, 200)).toEqual({
      thumbHeight: 40,
      thumbTop: 80,
      maxOffset: 80,
    });
  });

  it("returns null when there is nothing to scroll", () => {
    expect(scrollbarGeometry({ total: 100, offset: 0, len: 100 }, 200)).toBeNull();
    expect(scrollbarGeometry({ total: 0, offset: 0, len: 0 }, 200)).toBeNull();
    expect(scrollbarGeometry({ total: 100, offset: 0, len: 0 }, 200)).toBeNull();
    expect(scrollbarGeometry({ total: 100, offset: 0, len: 20 }, 0)).toBeNull();
  });

  it("keeps a short thumb usable for long content", () => {
    const geometry = scrollbarGeometry({ total: 10_000, offset: 0, len: 20 }, 200);
    expect(geometry?.thumbHeight).toBe(MIN_SCROLLBAR_THUMB_HEIGHT);
  });

  it("clamps out-of-range input instead of producing a broken thumb", () => {
    // offset past the end pins the thumb to the bottom of its travel.
    expect(scrollbarGeometry({ total: 100, offset: 500, len: 20 }, 200)?.thumbTop).toBe(160);
    // negative offset pins to the top.
    expect(scrollbarGeometry({ total: 100, offset: -50, len: 20 }, 200)?.thumbTop).toBe(0);
    // len larger than total is treated as "everything visible".
    expect(scrollbarGeometry({ total: 100, offset: 0, len: 500 }, 200)).toBeNull();
  });
});

describe("scrollbarOffsetAtPointer", () => {
  const state = { total: 10_000, offset: 0, len: 20 };

  it("maps a pointer position back to a scroll offset", () => {
    expect(scrollbarOffsetAtPointer(state, 200, 191, 9)).toBe(9_980);
  });

  it("does not move the thumb when it is not offset yet", () => {
    expect(scrollbarOffsetAtPointer(state, 200, 0, 0)).toBe(0);
  });

  it("clamps a drag past either end", () => {
    expect(scrollbarOffsetAtPointer(state, 200, -500, 0)).toBe(0);
    expect(scrollbarOffsetAtPointer(state, 200, 9999, 0)).toBe(9_980);
  });

  it("returns 0 when there is nothing to scroll", () => {
    expect(scrollbarOffsetAtPointer({ total: 100, offset: 0, len: 100 }, 200, 50, 0)).toBe(0);
  });
});