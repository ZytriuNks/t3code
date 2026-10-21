import { describe, expect, it } from "vite-plus/test";

import {
  smoothGlyphOpacity,
  smoothLineEnterVisible,
  smoothLineCurveProgress,
  smoothLineCurveVelocity,
  smoothLineCurveTime,
  smoothLineCurveDuration,
  createSmoothLinePulse,
  smoothLinePulsePosition,
  smoothLinePulseVelocity,
  SMOOTH_LINE_PIPELINE,
  SMOOTH_TEXT_FADE_BUCKETS,
  SMOOTH_TEXT_FADE_NAMES,
} from "./smoothLineMotion";

describe("smooth line motion", () => {
  it.each([80, 200, 1000])(
    "uses ease-in-out Bezier throughout a %s ms isolated action",
    (duration) => {
      expect(smoothLineCurveProgress(0, duration, 0, 0)).toBe(0);
      expect(smoothLineCurveProgress(duration / 4, duration, 0, 0)).toBeCloseTo(0.12916193, 7);
      expect(smoothLineCurveProgress(duration / 2, duration, 0, 0)).toBeCloseTo(0.5, 10);
      expect(smoothLineCurveProgress(duration * 0.75, duration, 0, 0)).toBeCloseTo(0.87083807, 7);
      expect(smoothLineCurveProgress(duration, duration, 0, 0)).toBe(1);
    },
  );
  it.each([16, 20, 40, 120])("finishes an isolated %s px action in 200ms", (distance) => {
    const pulse = createSmoothLinePulse(distance, 0, 0);
    expect(pulse.duration).toBe(200);
    expect(smoothLinePulsePosition(pulse, 50)).toBeCloseTo(distance * 0.12916193, 5);
    expect(smoothLinePulsePosition(pulse, 100)).toBeCloseTo(distance / 2, 10);
    expect(smoothLinePulsePosition(pulse, 199)).toBeLessThan(distance);
    expect(smoothLinePulsePosition(pulse, 200)).toBe(distance);
    expect(smoothLinePulseVelocity(pulse, 0)).toBe(0);
    expect(smoothLinePulseVelocity(pulse, 200)).toBe(0);
  });

  it.each([
    { duration: 100, peak: 0.3448275862 },
    { duration: 200, peak: 0.1724137931 },
    { duration: 300, peak: 0.1149425287 },
  ])("scales the painted 20px peak to $peak px/ms at $duration ms", ({ duration, peak }) => {
    const pulse = createSmoothLinePulse(20, 0, 0, duration);
    const velocities = Array.from({ length: 101 }, (_, step) =>
      smoothLinePulseVelocity(pulse, (duration * step) / 100),
    );
    expect(Math.max(...velocities)).toBeCloseTo(peak, 8);
    expect(velocities[0]).toBe(0);
    expect(velocities[100]).toBe(0);
  });

  it.each([80, 200, 1000])(
    "keeps a redirect's painted position and velocity at %s ms",
    (duration) => {
      const original = createSmoothLinePulse(20, 0, 0, duration);
      const at = duration * 0.4;
      const from = smoothLinePulsePosition(original, at);
      const velocity = smoothLinePulseVelocity(original, at);
      for (const target of [20, 40, 200]) {
        const next = createSmoothLinePulse(target - from, velocity, 0, duration - at);
        expect(from + smoothLinePulsePosition(next, 0)).toBe(from);
        expect(smoothLinePulseVelocity(next, 0)).toBeCloseTo(velocity, 10);
        expect(next.duration).toBeLessThanOrEqual(duration - at);
        let previous = from;
        for (let step = 1; step <= 100; step++) {
          const position = from + smoothLinePulsePosition(next, (next.duration * step) / 100);
          expect(position).toBeGreaterThanOrEqual(previous - 1e-10);
          expect(position).toBeLessThanOrEqual(target);
          previous = position;
        }
      }
    },
  );

  it("shortens a fast continuation to keep it monotone without resetting its speed", () => {
    const duration = smoothLineCurveDuration(3, 1000, 0.4, 0.1);
    expect(duration).toBe(18);
    const pulse = createSmoothLinePulse(3, 0.4, 0.1, 1000);
    expect(smoothLinePulseVelocity(pulse, 0)).toBeCloseTo(0.4, 10);
    let previous = 0;
    for (let at = 0; at <= duration; at += 0.1) {
      const position = smoothLinePulsePosition(pulse, at);
      expect(position).toBeGreaterThanOrEqual(previous - 1e-10);
      expect(position).toBeLessThanOrEqual(3);
      previous = position;
    }
  });

  it.each([
    {
      distance: 17.5980521,
      start: 0.7381429,
      end: 0.5872825,
      duration: 14.9307675,
      peak: 0.7381429,
    },
    { distance: 20, start: 0, end: 0.4, duration: 8, peak: 0.4 },
    { distance: 20, start: 0.4, end: 0, duration: 8, peak: 0.4 },
    { distance: 20, start: 0, end: 0, duration: 8, peak: 20 / 116 },
    { distance: 20, start: 1.2, end: 1.2, duration: 20 / 1.2, peak: 1.2 },
  ])("bounds the whole continuation at $peak px/ms", ({ distance, start, end, duration, peak }) => {
    const pulse = createSmoothLinePulse(distance, start, end, duration, peak);
    expect(smoothLinePulseVelocity(pulse, 0)).toBeCloseTo(start, 10);
    expect(smoothLinePulseVelocity(pulse, pulse.duration)).toBeCloseTo(end, 10);
    expect(smoothLinePulsePosition(pulse, pulse.duration)).toBeCloseTo(distance, 10);
    let previous = 0;
    for (let step = 0; step <= 1000; step++) {
      const at = (pulse.duration * step) / 1000;
      const position = smoothLinePulsePosition(pulse, at);
      expect(position).toBeGreaterThanOrEqual(previous - 1e-10);
      expect(position).toBeLessThanOrEqual(distance + 1e-10);
      expect(smoothLinePulseVelocity(pulse, at)).toBeLessThanOrEqual(peak + 1e-8);
      previous = position;
    }
    // A continuous 60-row/s stream already fits its actual speed budget.
    if (start === end && start > 0) expect(pulse.duration).toBeCloseTo(duration, 10);
  });

  it("uses the Bezier midpoint speed with symmetric acceleration and deceleration", () => {
    const velocity = (at: number) => smoothLineCurveVelocity(at, 200, 0, 0);
    expect(velocity(0)).toBe(0);
    expect(velocity(200)).toBe(0);
    expect(velocity(10)).toBeLessThan(velocity(50));
    expect(velocity(50)).toBeLessThan(velocity(100));
    expect(velocity(150)).toBeCloseTo(velocity(50), 9);
    expect(velocity(100) * 200).toBeCloseTo(1.724137931, 7);
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
  it("draws a line's own rise even when a dense stream opens its space in one frame", () => {
    // Structure must still read as arriving. The entrance is relative to the
    // row's final box, so a one-frame space handoff cannot hide it.
    expect(smoothLineEnterVisible(160)).toBe(true);
    expect(smoothLineEnterVisible(80)).toBe(true);
    expect(smoothLineEnterVisible(47)).toBe(true);
    expect(smoothLineEnterVisible(1.6)).toBe(true);
    expect(smoothLineEnterVisible(0)).toBe(false);
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
