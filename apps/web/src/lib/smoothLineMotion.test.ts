import { describe, expect, it } from "vite-plus/test";

import {
  smoothGlyphOpacity,
  smoothLineEnterVisible,
  smoothLineCurveProgress,
  smoothLineCurveVelocity,
  smoothLineCurveTime,
  smoothLineCurveDuration,
  createSmoothLinePulse,
  createSmoothLineBridge,
  smoothLinePulsePosition,
  smoothLinePulseVelocity,
  SMOOTH_LINE_PIPELINE,
  SMOOTH_TEXT_FADE_BUCKETS,
  SMOOTH_TEXT_FADE_NAMES,
} from "./smoothLineMotion";

describe("smooth line motion", () => {
  it.each([1, 16, 20, 28, 40, 120])(
    "reaches the same isolated peak and integrates exactly %s px",
    (distance) => {
      const cap = 0.17045454545454544;
      const pulse = createSmoothLinePulse(distance, 0, 0, cap);
      expect(pulse.rise).toBeCloseTo(2 * (pulse.duration - pulse.rise), 8);
      expect(smoothLinePulseVelocity(pulse, 0)).toBe(0);
      expect(smoothLinePulseVelocity(pulse, pulse.rise)).toBeCloseTo(cap, 12);
      expect(smoothLinePulseVelocity(pulse, pulse.duration)).toBe(0);
      expect(smoothLinePulseVelocity(pulse, pulse.duration + 100)).toBe(0);
      let integral = 0;
      let previous = 0;
      for (let index = 0; index < 2000; index++) {
        const at = (pulse.duration * (index + 0.5)) / 2000;
        integral += (smoothLinePulseVelocity(pulse, at) * pulse.duration) / 2000;
        const position = smoothLinePulsePosition(pulse, at);
        expect(position).toBeGreaterThanOrEqual(previous);
        expect(position).toBeLessThanOrEqual(distance);
        previous = position;
      }
      expect(integral).toBeCloseTo(distance, 8);
      expect(smoothLinePulsePosition(pulse, pulse.duration)).toBe(distance);
    },
  );

  it.each([180, 200, 220])("connects a %s ms tail without a new interior velocity peak", (at) => {
    const cap = 0.17045454545454544;
    const original = createSmoothLinePulse(20, 0, 0, cap);
    const start = smoothLinePulseVelocity(original, at);
    const end = Math.max(0, 40 / at - cap);
    const remaining = 20 - smoothLinePulsePosition(original, at);
    const bridge = createSmoothLineBridge(remaining, start, end);
    expect(smoothLinePulseVelocity(bridge, 0)).toBe(start);
    expect(smoothLinePulseVelocity(bridge, bridge.duration)).toBe(end);
    expect(smoothLinePulsePosition(bridge, bridge.duration)).toBe(remaining);
    let integral = 0;
    let previous = start;
    for (let step = 0; step <= 1000; step++) {
      const velocity = smoothLinePulseVelocity(bridge, (bridge.duration * step) / 1000);
      expect(velocity).toBeGreaterThanOrEqual(Math.min(start, end) - 1e-12);
      expect(velocity).toBeLessThanOrEqual(Math.max(start, end) + 1e-12);
      expect((velocity - previous) * Math.sign(end - start)).toBeGreaterThanOrEqual(-1e-12);
      if (step > 0 && step < 1000) integral += (velocity * bridge.duration) / 1000;
      previous = velocity;
    }
    integral += ((start + end) * bridge.duration) / 2000;
    expect(integral).toBeCloseTo(remaining, 10);
  });

  it.each([0, 0.04, 0.12, 0.17045454545454544, 0.4])(
    "changes pace from the actual %s px/ms boundary without changing x/v",
    (velocity) => {
      for (const end of [0, 0.08, 0.17045454545454544, 0.4]) {
        const pulse = createSmoothLinePulse(13, velocity, end, 0.17045454545454544);
        expect(smoothLinePulsePosition(pulse, 0)).toBe(0);
        expect(smoothLinePulseVelocity(pulse, 0)).toBe(velocity);
        expect(smoothLinePulseVelocity(pulse, pulse.duration)).toBe(end);
        expect(smoothLinePulsePosition(pulse, pulse.duration)).toBe(13);
        for (let step = 0; step <= 100; step++) {
          expect(smoothLinePulseVelocity(pulse, (pulse.duration * step) / 100)).toBeLessThanOrEqual(
            Math.max(velocity, end, 0.17045454545454544) + 1e-12,
          );
        }
      }
    },
  );
  it.each([
    { distance: 20, nominal: 220, velocity: 0, endSlope: 0.5 },
    { distance: 20, nominal: 140, velocity: 0, endSlope: 1 },
    { distance: 24, nominal: 180, velocity: 0.11, endSlope: 0.5 },
    { distance: 20, nominal: 1, velocity: 0.04, endSlope: 0 },
  ])("bounds the actual curve peak while retaining its incoming velocity: %j", (input) => {
    const endVelocity = (input.distance * input.endSlope) / input.nominal;
    const duration = smoothLineCurveDuration(
      input.distance,
      input.nominal,
      input.velocity,
      endVelocity,
      0.171,
    );
    const slope = (input.velocity * duration) / input.distance;
    const endSlope = (endVelocity * duration) / input.distance;
    expect(
      input.distance * smoothLineCurveVelocity(0, duration, slope, input.endSlope),
    ).toBeCloseTo(input.velocity, 8);
    const peak = Math.max(
      ...Array.from(
        { length: 201 },
        (_, index) =>
          input.distance *
          smoothLineCurveVelocity((index * duration) / 200, duration, slope, endSlope),
      ),
    );
    expect(peak).toBeLessThanOrEqual(0.171001);
    expect(duration).toBeGreaterThanOrEqual(input.distance / 0.171);
    expect(smoothLineCurveProgress(duration, duration, slope, endSlope)).toBeCloseTo(1);
  });

  it.each([0.1306, 0.1307, 0.17, 0.3])(
    "fits an accelerating curve without reducing its terminal %s px/ms travel rate",
    (endVelocity) => {
      const duration = smoothLineCurveDuration(
        20,
        20 / endVelocity,
        0,
        endVelocity,
        Math.max(0.171, endVelocity),
      );
      const endSlope = (endVelocity * duration) / 20;
      expect(20 * smoothLineCurveVelocity(duration, duration, 0, endSlope)).toBeCloseTo(
        endVelocity,
        8,
      );
      const peak = Math.max(
        ...Array.from(
          { length: 201 },
          (_, index) =>
            20 * smoothLineCurveVelocity((index * duration) / 200, duration, 0, endSlope),
        ),
      );
      expect(peak).toBeLessThanOrEqual(Math.max(0.171, endVelocity) + 0.000001);
      let previous = 0;
      for (let index = 1; index <= 200; index++) {
        const progress = smoothLineCurveProgress((index * duration) / 200, duration, 0, endSlope);
        expect(progress).toBeGreaterThanOrEqual(previous - 1e-9);
        expect(progress).toBeLessThanOrEqual(1 + 1e-9);
        previous = progress;
      }
    },
  );

  it("does not rewind when a slow nominal curve hands off at a faster terminal rate", () => {
    const duration = smoothLineCurveDuration(20, 400, 0, 0.3, 0.3);
    const endSlope = (0.3 * duration) / 20;
    let previous = 0;
    for (let index = 1; index <= 200; index++) {
      const progress = smoothLineCurveProgress((index * duration) / 200, duration, 0, endSlope);
      expect(progress).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(progress).toBeLessThanOrEqual(1 + 1e-9);
      previous = progress;
    }
  });

  it("decelerates an inherited fast curve without dropping its starting velocity", () => {
    const duration = smoothLineCurveDuration(20, 220, 0.3, 0, 0.171);
    const slope = (0.3 * duration) / 20;
    expect(20 * smoothLineCurveVelocity(0, duration, slope, 0)).toBeCloseTo(0.3, 8);
    for (let index = 0; index <= 100; index++) {
      expect(
        20 * smoothLineCurveVelocity((duration * index) / 100, duration, slope, 0),
      ).toBeLessThanOrEqual(0.300001);
    }
  });

  it("does not stretch a cap-compliant handoff because of endpoint roundoff", () => {
    const nominal = 51.837237713255966;
    const duration = smoothLineCurveDuration(
      20,
      nominal,
      0.39336605006405395,
      0.3858230276588512,
      0.3858230276588512,
    );
    expect(duration).toBeCloseTo(nominal, 8);
  });

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
