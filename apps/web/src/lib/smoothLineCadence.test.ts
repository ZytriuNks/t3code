import { describe, expect, it } from "vite-plus/test";
import { createSmoothLineCadence, estimatePendingLines } from "./smoothLineCadence";
import { createSmoothLinePulse, smoothLinePulseVelocity } from "./smoothLineMotion";

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
    expect(bridge.duration).toBeCloseTo(180, 8);
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
    "enters continuous travel at half the configured duration, boundary %s",
    (offset) => {
      const cadence = createSmoothLineCadence();
      const period = 100 + offset;
      cadence.observeDemand(0, 20);
      cadence.observeDemand(period, 40);
      const plan = physicalPlan(cadence, period);
      expect(plan.endVelocity).toBeCloseTo(0.2, 4);
      expect(plan.peakVelocity).toBeCloseTo(0.2, 4);
    },
  );

  it.each([
    { yieldDurationMs: 100, onsetPeriod: 100, steadyPeriod: 50 },
    { yieldDurationMs: 200, onsetPeriod: 200, steadyPeriod: 100 },
    { yieldDurationMs: 300, onsetPeriod: 300, steadyPeriod: 150 },
  ])(
    "moves both continuous thresholds with a $yieldDurationMs ms action",
    ({ yieldDurationMs, onsetPeriod, steadyPeriod }) => {
      const planAt = (period: number) => {
        const cadence = createSmoothLineCadence();
        cadence.observeDemand(0, 20);
        cadence.observeDemand(period, 40);
        return cadence.plan(period, {
          interval: 1,
          pendingCharacters: 400,
          pendingLines: 100,
          lineCharacters: 4,
          distance: 20,
          physical: true,
          overlap: true,
          yieldDurationMs,
        });
      };
      expect(planAt(onsetPeriod + 1).continuous).toBe(0);
      expect(planAt(onsetPeriod).endVelocity).toBe(0);
      expect(planAt(onsetPeriod - 1).endVelocity).toBeGreaterThan(0);
      expect(planAt(steadyPeriod + 1).continuous).toBeLessThan(1);
      expect(planAt(steadyPeriod).continuous).toBe(1);
      expect(planAt(steadyPeriod - 1).continuous).toBe(1);
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
  it.each([80, 200, 1000])(
    "keeps isolated actions at %s ms regardless of source or distance",
    (yieldDurationMs) => {
      for (const distance of [16, 20, 40, 120]) {
        const cadence = createSmoothLineCadence();
        cadence.observeDemand(0, 0);
        cadence.observeDemand(20, 100);
        const plan = cadence.plan(20, {
          interval: 0.01,
          pendingCharacters: 1000,
          pendingLines: 100,
          distance,
          physical: true,
          overlap: false,
          yieldDurationMs,
        });
        const pulse = createSmoothLinePulse(distance, 0, plan.endVelocity, plan.duration);
        expect(smoothLinePulseVelocity(pulse, 0)).toBe(0);
        expect(smoothLinePulseVelocity(pulse, yieldDurationMs)).toBe(0);
        expect(plan.duration).toBe(yieldDurationMs);
        expect(plan.continuous).toBe(0);
      }
    },
  );

  it("does not grant more frame budget after one missed presentation", () => {
    const cadence = createSmoothLineCadence();
    for (let at = 0; at <= 1000; at += 10) cadence.frame(at);
    const before = cadence.frameMs;
    cadence.frame(1081);
    expect(cadence.frameMs).toBeCloseTo(before, 8);
  });
  it.each([80, 200, 1000])(
    "joins fast rows at source speed instead of charging %s ms each",
    (yieldDurationMs) => {
      const cadence = createSmoothLineCadence();
      cadence.observeDemand(0, 20);
      cadence.observeDemand(40, 40);
      const plan = cadence.plan(40, {
        interval: 1,
        pendingCharacters: 400,
        pendingLines: 100,
        lineCharacters: 4,
        distance: 20,
        physical: true,
        overlap: true,
        yieldDurationMs,
      });
      expect(plan.duration).toBeCloseTo(40, 8);
      expect(plan.endVelocity).toBeCloseTo(0.5, 8);
      const continuation = createSmoothLinePulse(20, 0.5, plan.endVelocity, plan.duration);
      for (let at = 0; at <= 40; at++)
        expect(smoothLinePulseVelocity(continuation, at)).toBeCloseTo(0.5, 8);
    },
  );

  it("changes the bridge endpoint continuously across the overlap threshold", () => {
    let previous = 0;
    for (let period = 201; period >= 99; period--) {
      const cadence = createSmoothLineCadence();
      cadence.observeDemand(0, 20);
      cadence.observeDemand(period, 40);
      const plan = physicalPlan(cadence, period);
      expect(plan.endVelocity).toBeGreaterThanOrEqual(previous);
      expect(plan.endVelocity - previous).toBeLessThan(0.005);
      previous = plan.endVelocity;
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
    expect(partial.duration).toBe(200);
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
    expect(slow.duration).toBe(200);
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
    expect(settled.duration).toBe(200);
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
