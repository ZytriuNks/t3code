import { describe, expect, it } from "vite-plus/test";
import { createSmoothLineCadence, estimatePendingLines } from "./smoothLineCadence";
import { smoothLineCurveVelocity } from "./smoothLineMotion";

describe("smooth output line cadence", () => {
  it("joins overlapping steps at their peak before raising continuous scroll speed", () => {
    for (const hz of [4.6, 5, 6, 7, 8]) {
      const plan = createSmoothLineCadence().plan(0, {
        interval: 1_000 / (hz * 40),
        pendingCharacters: 400,
        pendingLines: 10,
        lineCharacters: 40,
        distance: 20,
      });
      expect(plan.continuous).toBeGreaterThan(0);
      expect(plan.continuous).toBeLessThan(1);
      expect(
        smoothLineCurveVelocity(plan.duration / 2, plan.duration, plan.continuous, plan.continuous),
      ).toBeCloseTo(1.875 / 220, 8);
    }
  });
  it("does not mistake a partially received physical row for a high line rate", () => {
    const cadence = createSmoothLineCadence();
    const partial = cadence.plan(0, {
      interval: 10,
      pendingCharacters: 8,
      pendingLines: 1,
      lineCharacters: 40,
      distance: 20,
    });
    expect(partial.duration).toBeGreaterThan(200);
    expect(partial.continuous).toBeLessThan(0.1);
    const authored = cadence.plan(1000, {
      interval: 10,
      pendingCharacters: 80,
      pendingLines: 10,
      lineCharacters: 8,
      distance: 20,
    });
    expect(authored.duration).toBeLessThanOrEqual(100);
    expect(authored.continuous).toBe(1);
  });
  it("uses a measured short row's pace while the unread average still describes long rows", () => {
    const cadence = createSmoothLineCadence();
    const plan = cadence.plan(0, {
      interval: 1,
      pendingCharacters: 800,
      pendingLines: 20,
      lineCharacters: 4,
      distance: 20,
    });
    expect(plan.wholeLine).toBe(true);
    expect(plan.duration).toBeLessThanOrEqual(4);
  });

  it("lets unread line pressure shorten a partially measured row without a rate jump", () => {
    const cadence = createSmoothLineCadence();
    const sparse = cadence.plan(0, {
      interval: 10,
      pendingCharacters: 4,
      pendingLines: 4,
      lineCharacters: 40,
      distance: 20,
    });
    const sustained = cadence.plan(1_000, {
      interval: 10,
      pendingCharacters: 800,
      pendingLines: 20,
      lineCharacters: 40,
      distance: 20,
    });
    expect(sparse.duration).toBeLessThan(sustained.duration);
    expect(sparse.continuous).toBeGreaterThan(sustained.continuous);
  });
  it.each([30, 60, 120, 240])(
    "learns %s Hz delivered frames without counting a suspension",
    (fps) => {
      const cadence = createSmoothLineCadence();
      for (let index = 0; index <= fps * 3; index++) cadence.frame((index * 1_000) / fps);
      expect(cadence.frameMs).toBeCloseTo(1_000 / fps, 2);
      const before = cadence.frameMs;
      cadence.frame(8_000);
      expect(cadence.frameMs).toBe(before);
    },
  );

  it("counts short authored lines and estimates wraps without treating every break as a screenful", () => {
    expect(estimatePendingLines(240, 0, [0], 40)).toBe(6);
    expect(estimatePendingLines(240, 0, [0, 80, 160], 40)).toBe(6);
    expect(estimatePendingLines(9, 0, [0, 3, 6], 40)).toBe(3);
    expect(estimatePendingLines(240, 80, [0, 80, 160], 40)).toBe(4);
  });

  it("learns sustained slow frames without treating background throttling as capacity", () => {
    const cadence = createSmoothLineCadence();
    for (let now = 0; now <= 2400; now += 120) cadence.frame(now);
    expect(cadence.frameMs).toBeCloseTo(120, 1);
    cadence.frame(3400);
    expect(cadence.frameMs).toBeCloseTo(120, 1);
  });

  it("estimates a long message's unread tail without scanning every completed line", () => {
    const starts = Array.from({ length: 10000 }, (_, index) => index * 40);
    let reads = 0;
    const measured = new Proxy(starts, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(estimatePendingLines(400000, 399880, measured, 40)).toBe(3);
    expect(reads).toBeLessThan(20);
  });

  it("learns line capacity from automatic wrapping rather than short manual lines", () => {
    const cadence = createSmoothLineCadence();
    cadence.measureColumns(2, false);
    expect(cadence.columns).toBe(40);
    for (let index = 0; index < 20; index++) cadence.measureColumns(80, true);
    expect(cadence.columns).toBeCloseTo(80, 0);
  });

  it("changes from individual easing to a steady glide as physical lines arrive faster", () => {
    const cadence = createSmoothLineCadence();
    const slow = cadence.plan(0, {
      interval: 30,
      pendingCharacters: 80,
      pendingLines: 2,
      distance: 20,
    });
    expect(slow.duration).toBe(220);
    expect(slow.exponent).toBe(2);
    const medium = cadence.plan(1_000, {
      interval: 4,
      pendingCharacters: 80,
      pendingLines: 2,
      distance: 20,
    });
    expect(medium.exponent).toBeGreaterThan(1);
    expect(medium.exponent).toBeLessThan(2);
    const fast = cadence.plan(2_000, {
      interval: 1,
      pendingCharacters: 80,
      pendingLines: 2,
      distance: 20,
    });
    expect(fast.exponent).toBe(1);
    expect(fast.duration).toBeLessThan(41);
  });

  it("filters a sudden line-rate change before choosing its duration and curve", () => {
    const cadence = createSmoothLineCadence();
    const input = {
      interval: 10,
      pendingCharacters: 800,
      pendingLines: 20,
      distance: 20,
    };
    const slow = cadence.plan(0, input);
    const accelerating = cadence.plan(16, { ...input, interval: 1 });
    expect(accelerating.duration).toBeGreaterThan(slow.duration / 2);
    let fast = accelerating;
    for (let now = 32; now <= 1000; now += 16) fast = cadence.plan(now, { ...input, interval: 1 });
    expect(fast.duration).toBeLessThan(41);
    expect(fast.continuous).toBe(1);
    const decelerating = cadence.plan(1016, input);
    expect(decelerating.duration).toBeLessThan(fast.duration * 1.5);
    expect(decelerating.continuous).toBe(1);
    let settled = decelerating;
    for (let now = 1032; now <= 2200; now += 16) settled = cadence.plan(now, input);
    expect(settled.duration).toBeGreaterThan(200);
    expect(settled.continuous).toBeLessThan(0.1);
  });

  it("only offers a whole-line fade when both text and displacement fit inside one delivered frame", () => {
    const cadence = createSmoothLineCadence();
    for (let frame = 0; frame < 240; frame++) cadence.frame((frame * 1_000) / 240);
    const at240 = cadence.plan(1_000, {
      interval: 0.15,
      pendingCharacters: 80,
      pendingLines: 2,
      distance: 20,
    });
    expect(at240.wholeLine).toBe(false);
    for (let frame = 0; frame < 180; frame++) cadence.frame(1_000 + (frame * 1_000) / 60);
    const at60 = cadence.plan(4_000, {
      interval: 0.15,
      pendingCharacters: 80,
      pendingLines: 2,
      distance: 20,
    });
    expect(at60.wholeLine).toBe(true);
    expect(
      cadence.plan(4_000, {
        interval: 0.15,
        pendingCharacters: 80,
        pendingLines: 2,
        distance: 20,
        parallel: true,
      }).wholeLine,
    ).toBe(false);
  });
});
