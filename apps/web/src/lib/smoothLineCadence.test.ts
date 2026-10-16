import { describe, expect, it } from "vite-plus/test";
import {
  createSmoothLineCadence,
  estimatePendingLines,
  SMOOTH_LINE_PEAK_VELOCITY,
} from "./smoothLineCadence";
import {
  createSmoothLinePulse,
  smoothLinePulseVelocity,
  smoothLineCurveDuration,
  smoothLineCurveVelocity,
} from "./smoothLineMotion";

describe("smooth output line cadence", () => {
  const physicalPlan = (
    cadence: ReturnType<typeof createSmoothLineCadence>,
    now: number,
    overlap = true,
  ) =>
    cadence.plan(now, {
      interval: 0.001,
      pendingCharacters: 10000,
      pendingLines: 1000,
      lineCharacters: 1,
      distance: 20,
      physical: true,
      overlap,
    });

  it("requires real physical arrivals and an overlapping motion before bridging", () => {
    const cadence = createSmoothLineCadence();
    cadence.observeDemand(0, 20);
    cadence.observeDemand(1000, 40);
    expect(physicalPlan(cadence, 1000).continuous).toBe(0);
    cadence.observeDemand(1180, 60);
    expect(physicalPlan(cadence, 1180, false).continuous).toBe(0);
    const bridge = physicalPlan(cadence, 1180);
    expect(bridge.continuous).toBeGreaterThan(0);
    expect(bridge.continuous).toBeLessThan(1);
    expect(bridge.peakVelocity).toBe(SMOOTH_LINE_PEAK_VELOCITY);
  });

  it.each([-100, 100, 1000])(
    "excludes %s px of old geometry while retaining the arrival interval",
    (shift) => {
      const cadence = createSmoothLineCadence();
      cadence.observeDemand(300, 76);
      cadence.observeDemand(600, 96);
      cadence.rebaseDemand(96 + shift);
      cadence.observeDemand(680, 116 + shift);
      expect(physicalPlan(cadence, 680).peakVelocity).toBeCloseTo(20 / 80, 10);
      cadence.rebaseDemand(116);
      cadence.observeDemand(720, 136);
      expect(physicalPlan(cadence, 720).peakVelocity).toBeCloseTo(20 / 40, 10);
    },
  );

  it.each([-0.001, 0, 0.001])(
    "enters continuous travel at the basic peak, boundary %s",
    (offset) => {
      const cadence = createSmoothLineCadence();
      const period = 20 / SMOOTH_LINE_PEAK_VELOCITY + offset;
      cadence.observeDemand(0, 20);
      cadence.observeDemand(period, 40);
      const plan = physicalPlan(cadence, period);
      expect(plan.endVelocity).toBeCloseTo(SMOOTH_LINE_PEAK_VELOCITY, 4);
      expect(plan.peakVelocity).toBeCloseTo(SMOOTH_LINE_PEAK_VELOCITY, 4);
    },
  );

  it("counts each physical distance in a source delivery once without inventing elapsed time", () => {
    const cadence = createSmoothLineCadence();
    cadence.observeDemand(0, 20);
    cadence.observeDemand(100, 80);
    cadence.observeDemand(100, 80);
    const plan = physicalPlan(cadence, 100);
    expect(plan.endVelocity).toBeCloseTo(60 / 100, 10);
    expect(plan.peakVelocity).toBeCloseTo(60 / 100, 10);
  });

  it("does not use an initial DOM batch as proof of a fast source", () => {
    const cadence = createSmoothLineCadence();
    cadence.observeDemand(1000, 400);
    expect(physicalPlan(cadence, 1000).continuous).toBe(0);
  });
  it.each([0.09, 0.12, 0.15, SMOOTH_LINE_PEAK_VELOCITY])(
    "does not raise the basic peak while bridging at %s px/ms",
    (velocity) => {
      const plan = createSmoothLineCadence().plan(0, {
        interval: 20 / (velocity * 40),
        pendingCharacters: 400,
        pendingLines: 10,
        lineCharacters: 40,
        distance: 20,
      });
      expect(plan.peakVelocity).toBeCloseTo(SMOOTH_LINE_PEAK_VELOCITY, 10);
    },
  );

  it("does not grant more frame budget after one missed presentation", () => {
    const cadence = createSmoothLineCadence();
    for (let at = 0; at <= 1000; at += 10) cadence.frame(at);
    const before = cadence.frameMs;
    cadence.frame(1081);
    expect(cadence.frameMs).toBeCloseTo(before, 8);
  });
  it.each([16, 20, 24, 28, 40])(
    "keeps the same low-speed pixel peak while making room for %s px",
    (distance) => {
      const plan = createSmoothLineCadence().plan(0, {
        interval: 30,
        pendingCharacters: 80,
        pendingLines: 2,
        lineCharacters: 40,
        distance,
      });
      const pulse = createSmoothLinePulse(distance, 0, 0, plan.peakVelocity!);
      const peak = Math.max(
        ...Array.from({ length: 101 }, (_, index) =>
          smoothLinePulseVelocity(pulse, (index * pulse.duration) / 100),
        ),
      );
      expect(peak).toBeGreaterThan(0.169);
      expect(peak).toBeLessThan(0.171);
    },
  );

  it.each([60, 80, 120])(
    "does not turn a %s px code/header gap into a higher text velocity",
    (distance) => {
      const plan = createSmoothLineCadence().plan(0, {
        interval: 5,
        pendingCharacters: 80,
        pendingLines: 2,
        lineCharacters: 40,
        distance,
        lineHeight: 20,
      });
      expect(plan.peakVelocity).toBeLessThan(0.18);
      expect(plan.duration).toBeGreaterThan(distance / 0.18);
      expect(plan.endVelocity).toBeLessThan(SMOOTH_LINE_PEAK_VELOCITY);
    },
  );

  it("keeps the fitted peak continuous and bounded through the joined-curve midpoint", () => {
    let previousPeak = 0;
    for (let index = 0; index <= 200; index++) {
      const velocity = 0.12 + index * 0.0001;
      const plan = createSmoothLineCadence().plan(0, {
        interval: 20 / (velocity * 40),
        pendingCharacters: 400,
        pendingLines: 10,
        lineCharacters: 40,
        distance: 20,
      });
      const endVelocity = (20 * plan.continuous) / plan.duration;
      const duration = smoothLineCurveDuration(
        20,
        plan.duration,
        0,
        endVelocity,
        plan.peakVelocity!,
      );
      const peak = Math.max(
        ...Array.from(
          { length: 201 },
          (_, sample) =>
            20 *
            smoothLineCurveVelocity(
              (sample * duration) / 200,
              duration,
              0,
              (endVelocity * duration) / 20,
            ),
        ),
      );
      expect(peak).toBeLessThanOrEqual(plan.peakVelocity! + 0.000001);
      if (index > 0) expect(Math.abs(peak - previousPeak)).toBeLessThan(0.0002);
      previousPeak = peak;
    }
  });

  it.each([0.045, 0.09, 0.13, 0.17, 0.3, 0.8])(
    "retains a finite profile cap at %s px/ms rather than bypassing the fit",
    (velocity) => {
      const plan = createSmoothLineCadence().plan(0, {
        interval: 20 / (velocity * 40),
        pendingCharacters: 400,
        pendingLines: 10,
        lineCharacters: 40,
        distance: 20,
      });
      expect(plan.peakVelocity).toBeGreaterThanOrEqual(0.17045454545454544);
      expect(plan.peakVelocity).toBeCloseTo(Math.max(SMOOTH_LINE_PEAK_VELOCITY, velocity), 10);
      const endVelocity = (20 * plan.continuous) / plan.duration;
      const duration = smoothLineCurveDuration(
        20,
        plan.duration,
        0,
        endVelocity,
        plan.peakVelocity!,
      );
      const endSlope = (endVelocity * duration) / 20;
      for (let sample = 0; sample <= 100; sample++) {
        expect(
          20 * smoothLineCurveVelocity((sample * duration) / 100, duration, 0, endSlope),
        ).toBeLessThanOrEqual(plan.peakVelocity! + 0.000001);
      }
      if (velocity >= 0.3) {
        const settled = createSmoothLinePulse(
          20,
          plan.endVelocity,
          plan.endVelocity,
          plan.peakVelocity!,
        );
        expect(settled.duration).toBeCloseTo(20 / velocity, 6);
      }
    },
  );

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
      const pulse = createSmoothLinePulse(
        20,
        plan.endVelocity,
        plan.endVelocity,
        plan.peakVelocity!,
      );
      expect(smoothLinePulseVelocity(pulse, pulse.rise)).toBeCloseTo(SMOOTH_LINE_PEAK_VELOCITY, 8);
      expect(pulse.duration).toBeCloseTo(1000 / hz, 8);
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
  it("paces a complete short row locally even when longer rows follow it", () => {
    const mixed = createSmoothLineCadence().plan(0, {
      interval: 1,
      pendingCharacters: 800,
      pendingLines: 20,
      lineCharacters: 4,
      distance: 20,
    });
    expect(mixed.wholeLine).toBe(true);
    expect(mixed.duration).toBeLessThanOrEqual(4);
    const shortBurst = createSmoothLineCadence().plan(0, {
      interval: 1,
      pendingCharacters: 800,
      pendingLines: 200,
      lineCharacters: 4,
      distance: 20,
    });
    expect(shortBurst.wholeLine).toBe(true);
    expect(shortBurst.duration).toBeLessThanOrEqual(4);
  });

  it("filters an isolated short row without replacing the established travel velocity", () => {
    const cadence = createSmoothLineCadence();
    cadence.plan(0, {
      interval: 1,
      pendingCharacters: 800,
      pendingLines: 20,
      lineCharacters: 40,
      distance: 20,
    });
    const short = cadence.plan(4, {
      interval: 1,
      pendingCharacters: 800,
      pendingLines: 20,
      lineCharacters: 4,
      distance: 20,
    });
    const following = cadence.plan(8, {
      interval: 1,
      pendingCharacters: 796,
      pendingLines: 20,
      lineCharacters: 40,
      distance: 20,
    });
    expect(short.duration).toBeGreaterThan(30);
    expect(short.duration).toBeLessThan(35);
    expect(following.duration).toBeGreaterThan(30);
    expect(following.peakVelocity).toBeLessThan(0.85);
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

  it("does not learn deliberate playback gaps as low refresh capacity", () => {
    const cadence = createSmoothLineCadence();
    for (let now = 0; now <= 3_000; now += 7) cadence.frame(now);
    for (let burst = 0; burst < 20; burst++) {
      const start = 3_100 + burst * 80;
      cadence.frame(start, false);
      cadence.frame(start + 7);
    }
    expect(cadence.frameMs).toBeCloseTo(7, 1);
    expect(
      cadence.plan(5_000, {
        interval: 0.15,
        pendingCharacters: 80,
        pendingLines: 2,
        distance: 20,
      }).wholeLine,
    ).toBe(false);
  });

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
    expect(slow.duration).toBeCloseTo(40 / SMOOTH_LINE_PEAK_VELOCITY, 8);
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
