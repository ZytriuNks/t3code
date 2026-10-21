// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { registerSmoothTextLayoutScope } from "../../lib/smoothTextLayout";
import { createTimelineSendMotion } from "./timelineSendMotion";

let time = 0;
let nextFrame = 0;
let frames = new Map<number, FrameRequestCallback>();

function advanceFrame(ms = 16) {
  time += ms;
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(time);
}

function scene({ contentTop = 76, scrollTop = 0 } = {}) {
  const viewport = document.createElement("div");
  const row = document.createElement("div");
  const bubble = document.createElement("div");
  row.dataset.timelineRowId = "user-1";
  bubble.textContent = "A real sent message";
  row.append(bubble);
  viewport.append(row);
  document.body.append(viewport);
  viewport.scrollTop = scrollTop;
  const visualTop = () =>
    contentTop -
    viewport.scrollTop +
    (Number.parseFloat(bubble.style.translate.split(" ")[1] ?? "0") || 0);
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
    () => ({ top: 52, bottom: 800, height: 748 }) as DOMRect,
  );
  vi.spyOn(row, "getBoundingClientRect").mockImplementation(
    () => ({ top: contentTop - viewport.scrollTop, height: 70 }) as DOMRect,
  );
  vi.spyOn(bubble, "getBoundingClientRect").mockImplementation(
    () => ({ top: visualTop(), height: 70 }) as DOMRect,
  );
  return { viewport, row, bubble, visualTop };
}

beforeEach(() => {
  time = 0;
  nextFrame = 0;
  frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("live send framing", () => {
  it("moves the first sent bubble up even when the viewport has no scrolling distance", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    expect(view.visualTop()).toBe(600);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();

    const positions = [view.visualTop()];
    for (let index = 0; index < 30; index++) {
      advanceFrame();
      positions.push(view.visualTop());
      expect(view.row.getBoundingClientRect().height).toBe(70);
      expect(view.viewport.scrollTop).toBe(0);
    }
    expect(positions.some((top) => top > 76 && top < 600)).toBe(true);
    expect(positions.every((top, index) => index === 0 || top <= positions[index - 1]!)).toBe(true);
    expect(view.visualTop()).toBe(76);
    expect(view.bubble.style.translate).toBe("");
    expect(settled).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(motion.isPending()).toBe(false);
    advanceFrame(12_000);
    expect(view.visualTop()).toBe(76);
  });

  it("uses the final measured position after framing an existing thread", async () => {
    const view = scene({ contentTop: 1300, scrollTop: 700 });
    const motion = createTimelineSendMotion();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-2",
      fromTop: 650,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-2", view.bubble);
    motion.position(
      "send-2",
      () => {
        view.viewport.scrollTop = 1224;
      },
      () => {},
    );
    await Promise.resolve();
    advanceFrame();
    expect(view.visualTop()).toBe(650);
    advanceFrame(160);
    expect(view.visualTop()).toBeGreaterThan(76);
    expect(view.visualTop()).toBeLessThan(650);
    advanceFrame(500);
    expect(view.visualTop()).toBe(76);
    expect(view.viewport.scrollTop).toBe(1224);
  });

  it("leaves historical mounts and recycled rows still without a send intent", () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const detach = motion.attach("history-1", view.bubble);
    expect(view.visualTop()).toBe(76);
    expect(motion.position("history-1", vi.fn(), vi.fn())).toBe(false);
    detach();
    motion.attach("history-1", view.bubble);
    expect(view.visualTop()).toBe(76);
    expect(frames.size).toBe(0);
  });

  it("places a reduced-motion send immediately without a displaced paint", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: true,
    });
    motion.attach("send-1", view.bubble);
    expect(view.visualTop()).toBe(76);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();
    expect(view.visualTop()).toBe(76);
    expect(frames.size).toBe(0);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("does not restart after navigation cancels a pending positioning receipt", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    let finishPosition = () => {};
    const positioned = new Promise<void>((resolve) => {
      finishPosition = resolve;
    });
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    motion.position("send-1", () => positioned, settled);
    motion.cancel();
    view.viewport.scrollTop = 30;
    finishPosition();
    await Promise.resolve();
    advanceFrame(1000);
    expect(view.visualTop()).toBe(46);
    expect(view.viewport.scrollTop).toBe(30);
    expect(settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("cancels in-flight displacement and never replays it on a thread return", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    const detach = motion.attach("send-1", view.bubble);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();
    advanceFrame();
    advanceFrame(100);
    expect(view.visualTop()).toBeGreaterThan(76);
    motion.leaveThread("thread-b");
    expect(view.visualTop()).toBe(76);
    detach();
    motion.attach("send-1", view.bubble);
    advanceFrame(1000);
    expect(view.visualTop()).toBe(76);
    expect(settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("shares the Timeline frame and starts after its final layout commit", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    let commit: (() => void) | undefined;
    const sharedFrames: FrameRequestCallback[] = [];
    const unregister = registerSmoothTextLayoutScope(view.viewport, {
      frame(callback) {
        sharedFrames.push(callback);
        return () => {
          sharedFrames.splice(sharedFrames.indexOf(callback), 1);
        };
      },
      afterCommit(_element, callback) {
        commit = callback;
        return () => {
          commit = undefined;
        };
      },
    });
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    motion.position(
      "send-1",
      () => {},
      () => {},
    );
    await Promise.resolve();
    expect(sharedFrames).toHaveLength(0);
    expect(frames.size).toBe(0);
    commit?.();
    expect(sharedFrames).toHaveLength(1);
    sharedFrames.shift()?.(0);
    sharedFrames.shift()?.(180);
    expect(view.visualTop()).toBeGreaterThan(76);
    expect(view.visualTop()).toBeLessThan(600);
    motion.cancel();
    unregister();
  });

  it("keeps the displaced bubble inside the viewport without changing the virtual row", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 790,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    expect(view.visualTop() + view.bubble.getBoundingClientRect().height).toBeLessThanOrEqual(800);
    expect(view.row.getBoundingClientRect().top).toBe(76);
    motion.cancel();
  });

  it("cancels a visible entrance immediately when the user starts scrolling", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();
    advanceFrame();
    advanceFrame(100);
    expect(view.visualTop()).toBeGreaterThan(76);
    motion.cancel();
    view.viewport.scrollTop = 30;
    expect(view.visualTop()).toBe(46);
    advanceFrame(1000);
    expect(view.visualTop()).toBe(46);
    expect(view.viewport.scrollTop).toBe(30);
    expect(settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("consumes a late anchor-ready event after cancellation without a replacement scroll", () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    motion.cancel();
    const position = vi.fn(() => {
      view.viewport.scrollTop = 70;
    });
    const settled = vi.fn();
    expect(motion.position("send-1", position, settled)).toBe(true);
    expect(view.visualTop()).toBe(76);
    expect(view.viewport.scrollTop).toBe(0);
    expect(position).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("finishes in place when reduced motion is enabled during the entrance", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();
    advanceFrame();
    advanceFrame(100);
    expect(view.visualTop()).toBeGreaterThan(76);
    motion.reduceMotion();
    expect(view.visualTop()).toBe(76);
    expect(settled).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("preserves the in-flight position through a synchronous ref rebuild on the same DOM", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    const detach = motion.attach("send-1", view.bubble);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();
    advanceFrame();
    advanceFrame(100);
    const before = view.visualTop();
    expect(before).toBeGreaterThan(76);
    detach();
    motion.attach("send-1", view.bubble);
    detach();
    await Promise.resolve();
    expect(view.visualTop()).toBe(before);
    advanceFrame();
    expect(view.visualTop()).toBeLessThan(before);
    advanceFrame(500);
    expect(view.visualTop()).toBe(76);
    expect(settled).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("keeps explicit user cancellation final during the synchronous ref rebuild grace", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    const detach = motion.attach("send-1", view.bubble);
    detach();
    motion.cancel();
    motion.attach("send-1", view.bubble);
    await Promise.resolve();
    advanceFrame(1000);
    expect(view.visualTop()).toBe(76);
    expect(motion.isPending()).toBe(false);
    expect(frames.size).toBe(0);
  });
  it("settles an in-flight entrance in place when smooth output is turned off", async () => {
    const view = scene();
    const motion = createTimelineSendMotion();
    const settled = vi.fn();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => view.viewport,
      reducedMotion: false,
    });
    motion.attach("send-1", view.bubble);
    motion.position("send-1", () => {}, settled);
    await Promise.resolve();
    advanceFrame();
    advanceFrame(100);
    expect(view.visualTop()).toBeGreaterThan(76);
    motion.release();
    expect(view.visualTop()).toBe(76);
    expect(view.bubble.style.translate).toBe("");
    expect(settled).toHaveBeenCalledOnce();
    expect(motion.isPending()).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("hands an unpositioned send back to the native anchor path when released", () => {
    const motion = createTimelineSendMotion();
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => null,
      reducedMotion: false,
    });
    motion.release();
    expect(motion.isPending()).toBe(false);
    // A late onReady must fall through to the native scroll, not be swallowed.
    expect(
      motion.position(
        "send-1",
        () => {},
        () => {},
      ),
    ).toBe(false);
  });
});
