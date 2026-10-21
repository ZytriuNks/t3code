// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createTimelineSendMotion,
  TimelineSendMotionContext,
  useTimelineSendMotionTarget,
} from "./timelineSendMotion";

let time = 0;
let frameId = 0;
let frames = new Map<number, FrameRequestCallback>();
const roots = new Set<Root>();

function frame(ms = 16) {
  time += ms;
  const batch = [...frames.values()];
  frames.clear();
  for (const callback of batch) callback(time);
}

function strictTimeline({ existing = false } = {}) {
  const viewport = document.createElement("div");
  document.body.append(viewport);
  viewport.scrollTop = existing ? 700 : 0;
  const root = createRoot(viewport);
  roots.add(root);
  const motion = createTimelineSendMotion();
  const attached = vi.spyOn(motion, "attach");
  const positioned = vi.fn(() => {
    viewport.scrollTop = existing ? 1224 : 0;
  });
  const settled = vi.fn();
  const contentTop = existing ? 1300 : 76;
  const top = (element: HTMLElement) =>
    contentTop -
    viewport.scrollTop +
    (Number.parseFloat(element.style.translate.split(" ")[1] ?? "0") || 0);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 52, 500, 748));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(
      0,
      this.hasAttribute("data-motion-bubble") ? top(this) : contentTop - viewport.scrollTop,
      400,
      70,
    );
  });

  function Bubble({ messageId }: { messageId: string }) {
    const ref = useTimelineSendMotionTarget(messageId);
    useLayoutEffect(() => {
      if (messageId === "send-1") motion.position(messageId, positioned, settled);
    }, [messageId]);
    return (
      <div data-timeline-row-id={messageId}>
        <div ref={ref} data-motion-bubble={messageId}>
          Sent message
        </div>
      </div>
    );
  }

  const render = (showSent: boolean, key = "sent") =>
    act(async () => {
      root.render(
        <StrictMode>
          <TimelineSendMotionContext value={motion}>
            {existing ? <Bubble key="history" messageId="history-1" /> : null}
            {showSent ? <Bubble key={key} messageId="send-1" /> : null}
          </TimelineSendMotionContext>
        </StrictMode>,
      );
    });
  const bubble = () => viewport.querySelector<HTMLElement>('[data-motion-bubble="send-1"]')!;
  const begin = (reducedMotion = false) =>
    motion.begin({
      threadKey: "thread-a",
      messageId: "send-1",
      fromTop: 600,
      viewport: () => viewport,
      reducedMotion,
    });
  return { viewport, root, motion, attached, positioned, settled, render, bubble, begin, top };
}

beforeEach(() => {
  time = 0;
  frameId = 0;
  frames = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("StrictMode live send refs", () => {
  it.each([false, true])(
    "moves a live send after real StrictMode ref replay (existing=%s)",
    async (existing) => {
      const view = strictTimeline({ existing });
      await view.render(false);
      view.begin();
      await view.render(true);

      expect(view.attached.mock.calls.filter(([messageId]) => messageId === "send-1")).toHaveLength(
        2,
      );
      expect(view.top(view.bubble())).toBe(600);
      const positions = [view.top(view.bubble())];
      for (let index = 0; index < 30; index++) {
        frame();
        positions.push(view.top(view.bubble()));
        expect(view.bubble().parentElement!.getBoundingClientRect().height).toBe(70);
      }
      expect(positions.some((position) => position > 76 && position < 600)).toBe(true);
      expect(
        positions.every((position, index) => index === 0 || position <= positions[index - 1]!),
      ).toBe(true);
      expect(view.top(view.bubble())).toBe(76);
      expect(view.positioned).toHaveBeenCalledOnce();
      expect(view.settled).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
    },
  );

  it("does not replay a sent bubble after a real unmount and later historical remount", async () => {
    const view = strictTimeline();
    await view.render(false);
    view.begin();
    await view.render(true);
    frame();
    frame(100);
    expect(view.top(view.bubble())).toBeGreaterThan(76);
    await view.render(false);
    expect(frames.size).toBe(0);
    expect(view.motion.isPending()).toBe(false);
    await view.render(true);
    frame(1000);
    expect(view.top(view.bubble())).toBe(76);
    expect(view.settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("does not resume an intent on replacement DOM in the same React commit", async () => {
    const view = strictTimeline();
    await view.render(false);
    view.begin();
    await view.render(true);
    frame();
    frame(100);
    const original = view.bubble();
    expect(view.top(original)).toBeGreaterThan(76);
    await view.render(true, "replacement");
    expect(view.bubble()).not.toBe(original);
    expect(view.top(view.bubble())).toBe(76);
    frame(1000);
    expect(view.top(view.bubble())).toBe(76);
    expect(view.motion.isPending()).toBe(false);
    expect(view.settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it.each(["user", "thread"] as const)(
    "does not revive after explicit %s cancellation and StrictMode remount",
    async (reason) => {
      const view = strictTimeline();
      await view.render(false);
      view.begin();
      await view.render(true);
      frame();
      frame(100);
      expect(view.top(view.bubble())).toBeGreaterThan(76);
      if (reason === "user") view.motion.cancel();
      else view.motion.leaveThread("thread-b");
      view.viewport.scrollTop = 30;
      await view.render(false);
      view.motion.leaveThread("thread-a");
      await view.render(true);
      frame(1000);
      expect(view.top(view.bubble())).toBe(46);
      expect(view.viewport.scrollTop).toBe(30);
      expect(view.settled).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
    },
  );

  it("keeps historical refs still through the real StrictMode replay", async () => {
    const view = strictTimeline();
    await view.render(true);
    expect(view.attached.mock.calls.filter(([messageId]) => messageId === "send-1")).toHaveLength(
      2,
    );
    expect(view.top(view.bubble())).toBe(76);
    frame(1000);
    expect(view.top(view.bubble())).toBe(76);
    expect(view.positioned).not.toHaveBeenCalled();
    expect(view.settled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("honors reduced motion through the real StrictMode replay", async () => {
    const view = strictTimeline();
    await view.render(false);
    view.begin(true);
    await view.render(true);
    expect(view.top(view.bubble())).toBe(76);
    expect(view.positioned).toHaveBeenCalledOnce();
    expect(view.settled).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});
