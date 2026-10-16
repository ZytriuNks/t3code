import { describe, expect, it } from "vite-plus/test";

import { createSmoothScroll } from "./smoothScroll";

function simulateAtRate(rate: number) {
  const controller = createSmoothScroll(0);
  controller.retarget(100, 0);
  const frameCount = Math.round((rate * 300) / 1000);
  for (let frame = 1; frame <= frameCount; frame += 1) {
    controller.advance((frame * 1000) / rate);
  }
  return controller.position;
}

describe("createSmoothScroll", () => {
  it("follows the same critically damped path at common refresh rates", () => {
    const positions = [60, 120, 240].map(simulateAtRate);

    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.001);
    expect(positions[0]).toBeGreaterThan(90);
    expect(positions[0]).toBeLessThan(100);
  });

  it("carries progress through frequent target updates without restarting", () => {
    const controller = createSmoothScroll(0);
    controller.retarget(100, 0);

    for (let time = 16; time <= 240; time += 16) {
      controller.retarget(100 + time / 4, time);
    }

    expect(controller.position).toBeGreaterThan(100);
    expect(controller.position).toBeLessThan(160);
    expect(controller.pending).toBe(true);
  });

  it("moves monotonically toward a target moved behind its current position", () => {
    const controller = createSmoothScroll(0);
    controller.retarget(1_000, 0);
    const beforeRetarget = controller.advance(80);
    const target = beforeRetarget - 80;
    controller.retarget(target, 80);

    let previous = controller.position;
    for (let time = 88; time < 530; time += 8) {
      const position = controller.advance(time);
      expect(Number.isFinite(position)).toBe(true);
      expect(position).toBeLessThanOrEqual(previous);
      expect(position).toBeGreaterThanOrEqual(target);
      previous = position;
    }

    expect(beforeRetarget).toBeGreaterThan(target);
    expect(controller.advance(530)).toBe(target);
    expect(controller.pending).toBe(false);
  });

  it("preserves velocity when a retarget stays in its direction", () => {
    const controller = createSmoothScroll(0);
    controller.retarget(1_000, 0);
    const beforeRetarget = controller.advance(80);
    controller.retarget(1_200, 80);
    const fromRest = createSmoothScroll(beforeRetarget);
    fromRest.retarget(1_200, 80);

    expect(controller.advance(88)).toBeGreaterThan(fromRest.advance(88));
  });

  it("settles exactly at a final target within 450ms and stays idle", () => {
    const controller = createSmoothScroll(12);
    controller.retarget(180, 1_000);
    expect(controller.position).toBe(12);
    expect(controller.pending).toBe(true);

    controller.retarget(240, 1_120);
    controller.retarget(240, 1_300);
    expect(controller.pending).toBe(true);
    expect(controller.advance(1_569)).toBeLessThan(240);
    expect(controller.advance(1_570)).toBe(240);
    expect(controller.pending).toBe(false);

    controller.advance(5_000);
    expect(controller.position).toBe(240);
    expect(controller.pending).toBe(false);
  });

  it("settles safely after a long pause and resets the motion immediately", () => {
    const controller = createSmoothScroll(0);
    controller.retarget(100, 0);
    expect(controller.advance(10_000)).toBe(100);
    expect(controller.pending).toBe(false);

    controller.retarget(400, 10_000);
    controller.advance(10_100);
    controller.reset(32);

    expect(controller.position).toBe(32);
    expect(controller.pending).toBe(false);
    expect(controller.advance(20_000)).toBe(32);
  });

  it("stops immediately when reset interrupts a user's motion", () => {
    const controller = createSmoothScroll(0);
    controller.retarget(100, 0);
    controller.advance(100);
    controller.reset(37);

    expect(controller.position).toBe(37);
    expect(controller.pending).toBe(false);
    expect(controller.advance(116)).toBe(37);
  });
});
