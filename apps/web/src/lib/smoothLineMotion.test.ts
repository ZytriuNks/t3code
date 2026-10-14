import { describe, expect, it } from "vite-plus/test";

import {
  smoothGlyphOpacity,
  smoothLineEnterVisible,
  smoothLineCurveProgress,
  smoothLineCurveVelocity,
  smoothLineCurveTime,
  SMOOTH_LINE_PIPELINE,
  SMOOTH_TEXT_FADE_BUCKETS,
  SMOOTH_TEXT_FADE_NAMES,
} from "./smoothLineMotion";

describe("smooth line motion", () => {
  it("accelerates and decelerates an isolated step with zero endpoint acceleration", () => {
    const velocity = (at: number) => smoothLineCurveVelocity(at, 220, 0, 0);
    expect(velocity(0)).toBe(0);
    expect(velocity(220)).toBe(0);
    expect(velocity(1)).toBeLessThan(velocity(50) / 100);
    expect(velocity(50)).toBeLessThan(velocity(110));
    expect(velocity(170)).toBeCloseTo(velocity(50), 10);
    expect(velocity(110) * 220).toBeCloseTo(1.875);
  });
  it("keeps position and velocity when a moving reservation changes pace", () => {
    const duration = 240,
      distance = 20,
      at = 80;
    const from = distance * smoothLineCurveProgress(at, duration, 2, 0);
    const velocity = distance * smoothLineCurveVelocity(at, duration, 2, 0);
    for (const requested of [16, 100, 240]) {
      const remaining = distance - from;
      const nextDuration = Math.min(requested, (3 * remaining) / velocity);
      const slope = (velocity * nextDuration) / remaining;
      expect(from + remaining * smoothLineCurveProgress(0, nextDuration, slope, 1)).toBe(from);
      expect(remaining * smoothLineCurveVelocity(0, nextDuration, slope, 1)).toBeCloseTo(
        velocity,
        8,
      );
      let previous = from;
      for (let elapsed = 1; elapsed <= nextDuration; elapsed++) {
        const position =
          from + remaining * smoothLineCurveProgress(elapsed, nextDuration, slope, 1);
        expect(position).toBeGreaterThanOrEqual(previous);
        expect(position).toBeLessThanOrEqual(distance);
        previous = position;
      }
    }
  });
  it("preserves a moving boundary's velocity while smoothly approaching the next rate", () => {
    const distance = 20;
    const duration = 100;
    const velocity = 0.15;
    const startSlope = (velocity * duration) / distance;
    const step = 0.001;
    expect((smoothLineCurveProgress(step, duration, startSlope, 1) * distance) / step).toBeCloseTo(
      velocity,
      4,
    );
    for (const start of [0, 0.5, 1, 2, 3]) {
      for (const end of [0, 0.5, 1]) {
        let previous = 0;
        for (let at = 0; at <= duration; at++) {
          const progress = smoothLineCurveProgress(at, duration, start, end);
          expect(progress).toBeGreaterThanOrEqual(previous - 1e-12);
          expect(progress).toBeLessThanOrEqual(1 + 1e-12);
          previous = progress;
        }
        const ready = smoothLineCurveTime(0.9, duration, start, end);
        expect(smoothLineCurveProgress(ready, duration, start, end)).toBeCloseTo(0.9, 6);
      }
    }
    expect(smoothLineCurveProgress(25, 100, 1, 1)).toBe(0.25);
    expect(smoothLineCurveProgress(25, 100, 3, 0)).toBe(0.578125);
  });
  it("draws a line's own rise only while its displacement lasts long enough to see", () => {
    // Under a dense stream the height itself grows every frame, so a second
    // per-line motion on top would fight it rather than link with it.
    expect(smoothLineEnterVisible(160)).toBe(true);
    expect(smoothLineEnterVisible(80)).toBe(true);
    expect(smoothLineEnterVisible(47)).toBe(false);
    expect(smoothLineEnterVisible(1.6)).toBe(false);
    // Admission stays strictly one line at a time.
    expect(SMOOTH_LINE_PIPELINE).toBe(1);
  });

  it("keeps one highlight rule per alpha step in a bounded palette", () => {
    expect(SMOOTH_TEXT_FADE_NAMES).toHaveLength(SMOOTH_TEXT_FADE_BUCKETS);
    expect(smoothGlyphOpacity(1)).toBeGreaterThan(0);
    expect(smoothGlyphOpacity(1)).toBeLessThan(0.2);
    expect(smoothGlyphOpacity(15)).toBe(1);
    for (let fade = 0; fade < SMOOTH_TEXT_FADE_BUCKETS; fade++) {
      expect(smoothGlyphOpacity(fade)).toBeGreaterThanOrEqual(0);
      expect(smoothGlyphOpacity(fade)).toBeLessThanOrEqual(1);
    }
  });
});
