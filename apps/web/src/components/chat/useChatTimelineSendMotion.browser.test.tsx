import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { createTimelineLayout, TimelineLayoutCommit } from "./timelineLayout";
import { TimelineSendMotionContext, useTimelineSendMotionTarget } from "./timelineSendMotion";
import { useChatTimelineSendMotion } from "./useChatTimelineSendMotion";

function setup() {
  const stack = new AsyncDisposableStack();
  let time = 0;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  stack.use(
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  stack.use(
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    }),
  );
  async function frame(ms = 16) {
    await act(async () => {
      time += ms;
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(time);
    });
  }

  async function chatViewSend({
    existing = false,
    long = false,
    reducedMotion = false,
    anchorReceipt = true,
  } = {}) {
    const viewport = document.createElement("div");
    let nativeOffset = long ? 700 : 0;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => nativeOffset,
      set: (value: number) => {
        nativeOffset = value;
      },
    });
    // 此夹具验证发送与布局回执，不依赖路由。
    const screen = stack.use(await render(null, { container: viewport, router: false }));
    const naturalTop = existing ? (long ? 1300 : 302) : 76;
    const maximumScroll = long ? 1300 : 0;
    const settled = vi.fn();
    const positioned = vi.fn(() => settled);
    const anchorReady = vi.fn();
    const sizes = new Map<string, number>();
    const rows = () => [...viewport.querySelectorAll<HTMLElement>("[data-timeline-row-id]")];
    const list = {
      getScrollableNode: () => viewport,
      getState: () => ({
        sizes,
        indexByKey: (key: string) => {
          const index = rows().findIndex((row) => row.dataset.timelineRowId === key);
          return index < 0 ? undefined : index;
        },
        elementAtIndex: (index: number) => rows()[index],
      }),
      setItemSize: (id: string, size: { height: number; width: number }) => {
        sizes.set(id, Math.round(size.height));
      },
      scrollToIndex: vi.fn(() => {
        viewport.scrollTop = Math.max(0, Math.min(naturalTop - 76, maximumScroll));
      }),
    };
    Object.defineProperties(viewport, {
      clientHeight: { value: 748 },
      scrollHeight: { value: 748 + maximumScroll },
    });
    const top = (element: HTMLElement) =>
      naturalTop -
      viewport.scrollTop +
      (Number.parseFloat(element.style.translate.split(" ")[1] ?? "0") || 0);
    stack.use(
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this === viewport) return new DOMRect(0, 52, 500, 748);
        return new DOMRect(
          0,
          this.hasAttribute("data-send-bubble") ? top(this) : naturalTop - viewport.scrollTop,
          400,
          70,
        );
      }),
    );

    function UserRow({ messageId }: { messageId: string }) {
      const ref = useTimelineSendMotionTarget(messageId);
      return (
        <div data-timeline-row-id={messageId}>
          <div ref={ref} data-send-bubble={messageId}>
            {messageId}
          </div>
        </div>
      );
    }

    function ChatViewSendHarness() {
      const listRef = useRef(list);
      const { motion, positionAtIndex } = useChatTimelineSendMotion({
        listRef,
        onPosition: positioned,
      });
      const [sent, setSent] = useState(false);
      const [secondSent, setSecondSent] = useState(false);
      const layoutRef = useRef<ReturnType<typeof createTimelineLayout> | null>(null);
      const requestRef =
        useRef<Parameters<typeof TimelineLayoutCommit>[0]["requestRef"]["current"]>(null);
      useLayoutEffect(() => {
        const layout = createTimelineLayout(viewport, {
          list: () => list,
          control: () => null,
          requestCommit: (generation) => requestRef.current?.({ owner: layout, generation }),
          synchronous: (write) => write(),
        });
        layoutRef.current = layout;
        return () => {
          layout.dispose();
          layoutRef.current = null;
        };
      }, []);
      useLayoutEffect(() => {
        if (!sent) return;
        // Use the production eligibility rule: an existing thread's later send
        // has no reserved end space and receives no Legend anchor-ready receipt.
        const items = [
          ...(existing ? ["history-1"] : []),
          "send-1",
          ...(secondSent ? ["send-2"] : []),
        ];
        const messageId = secondSent ? "send-2" : "send-1";
        const anchor = resolveChatListAnchoredEndSpace(items, messageId, (id) => id);
        if (anchor && anchorReceipt) {
          anchorReady();
          positionAtIndex(messageId, anchor.anchorIndex);
        }
      }, [positionAtIndex, secondSent, sent]);
      return (
        <TimelineSendMotionContext value={motion}>
          <button
            data-action="send"
            onClick={() => {
              motion.begin({
                threadKey: "thread-a",
                messageId: "send-1",
                fromTop: 636,
                viewport: () => viewport,
                reducedMotion,
              });
              setSent(true);
            }}
          >
            Send
          </button>
          <button data-action="cancel" onClick={() => motion.cancel()}>
            Cancel
          </button>
          <button data-action="hide" onClick={() => setSent(false)}>
            Hide
          </button>
          <button data-action="return" onClick={() => setSent(true)}>
            Return
          </button>
          <button
            data-action="switch"
            onClick={() => {
              motion.leaveThread("thread-b");
              setSent(false);
            }}
          >
            Switch thread
          </button>
          <button data-action="reduce" onClick={() => motion.reduceMotion()}>
            Reduce motion
          </button>
          <button
            data-action="late-ready"
            onClick={() => positionAtIndex("send-1", existing ? 1 : 0)}
          >
            Late anchor-ready
          </button>
          <button
            data-action="send-again"
            onClick={() => {
              motion.begin({
                threadKey: "thread-a",
                messageId: "send-2",
                fromTop: 636,
                viewport: () => viewport,
                reducedMotion,
              });
              setSecondSent(true);
            }}
          >
            Send again
          </button>
          {existing ? <UserRow key="history" messageId="history-1" /> : null}
          {sent ? <UserRow key="sent" messageId="send-1" /> : null}
          {secondSent ? <UserRow key="second-sent" messageId="send-2" /> : null}
          <TimelineLayoutCommit layoutRef={layoutRef} requestRef={requestRef} />
        </TimelineSendMotionContext>
      );
    }

    return {
      viewport,
      list,
      settled,
      positioned,
      anchorReady,
      top,
      bubble: (id = "send-1") => viewport.querySelector<HTMLElement>(`[data-send-bubble="${id}"]`)!,
      mount: () =>
        act(async () =>
          screen.rerender(
            <StrictMode>
              <ChatViewSendHarness />
            </StrictMode>,
          ),
        ),
      send: () =>
        act(async () => {
          viewport
            .querySelector('[data-action="send"]')!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }),
      action: (name: string) =>
        act(async () => {
          viewport
            .querySelector(`[data-action="${name}"]`)!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }),
    };
  }

  return {
    chatViewSend,
    frame,
    frames,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}

describe("ChatView send-to-position lifecycle", () => {
  it.each([
    { existing: false, long: false },
    { existing: false, long: false, anchorReceipt: false },
    { existing: true, long: false },
    { existing: true, long: true },
  ])("settles the mounted send using ChatView's positioning hook (%j)", async (options) => {
    await using fixture = setup();
    const view = await fixture.chatViewSend(options);
    await view.mount();
    await view.send();
    const positions = [view.top(view.bubble())];
    for (let index = 0; index < 36; index++) {
      await fixture.frame();
      positions.push(view.top(view.bubble()));
    }
    const finalTop = options.existing && !options.long ? 302 : 76;
    if (options.existing) expect(view.anchorReady).not.toHaveBeenCalled();
    expect(positions.some((position) => position > finalTop && position < 636)).toBe(true);
    expect(view.top(view.bubble())).toBe(finalTop);
    expect(view.bubble().style.translate).toBe("");
    expect(view.viewport.scrollTop).toBe(options.long ? 1224 : 0);
    expect(view.list.scrollToIndex).toHaveBeenCalledTimes(options.long ? 1 : 0);
    expect(view.positioned).toHaveBeenCalledOnce();
    expect(view.settled).toHaveBeenCalledOnce();
    expect(fixture.frames.size).toBe(0);
    await fixture.frame(14_000);
    expect(view.top(view.bubble())).toBe(finalTop);
  });

  it("automatically frames a second real send without remounting ChatView", async () => {
    await using fixture = setup();
    const view = await fixture.chatViewSend({ existing: true });
    await view.mount();
    await view.send();
    for (let index = 0; index < 36; index++) await fixture.frame();
    await view.action("send-again");
    expect(view.top(view.bubble("send-2"))).toBe(636);
    for (let index = 0; index < 36; index++) await fixture.frame();
    expect(view.top(view.bubble("send-1"))).toBe(302);
    expect(view.top(view.bubble("send-2"))).toBe(302);
    expect(view.bubble("send-2").style.translate).toBe("");
    expect(view.settled).toHaveBeenCalledTimes(2);
    expect(view.anchorReady).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });

  it.each(["cancel", "hide", "switch"])(
    "does not position or revive an existing send after %s before its layout receipt",
    async (action) => {
      await using fixture = setup();
      const view = await fixture.chatViewSend({ existing: true, long: true });
      await view.mount();
      await view.send();
      expect(view.top(view.bubble())).toBe(636);
      await view.action(action);
      view.viewport.scrollTop = 650;
      if (action !== "cancel") await view.action("return");
      for (let index = 0; index < 36; index++) await fixture.frame();
      await view.action("late-ready");
      await fixture.frame(14_000);
      expect(view.top(view.bubble())).toBe(650);
      expect(view.viewport.scrollTop).toBe(650);
      expect(view.bubble().style.translate).toBe("");
      expect(view.list.scrollToIndex).not.toHaveBeenCalled();
      expect(view.positioned).not.toHaveBeenCalled();
      expect(view.settled).not.toHaveBeenCalled();
      expect(fixture.frames.size).toBe(0);
    },
  );

  it("honors reduced motion on an existing send without an anchor-ready receipt", async () => {
    await using fixture = setup();
    const view = await fixture.chatViewSend({ existing: true, reducedMotion: true });
    await view.mount();
    await view.send();
    expect(view.top(view.bubble())).toBe(302);
    for (let index = 0; index < 8; index++) await fixture.frame();
    expect(view.top(view.bubble())).toBe(302);
    expect(view.bubble().style.translate).toBe("");
    expect(view.settled).toHaveBeenCalledOnce();
    expect(fixture.frames.size).toBe(0);
  });

  it("finishes an existing send when reduced motion changes during the entrance", async () => {
    await using fixture = setup();
    const view = await fixture.chatViewSend({ existing: true });
    await view.mount();
    await view.send();
    for (let index = 0; index < 7; index++) await fixture.frame();
    expect(view.top(view.bubble())).toBeGreaterThan(302);
    expect(view.top(view.bubble())).toBeLessThan(636);
    await view.action("reduce");
    await fixture.frame(14_000);
    expect(view.top(view.bubble())).toBe(302);
    expect(view.bubble().style.translate).toBe("");
    expect(view.settled).toHaveBeenCalledOnce();
    expect(fixture.frames.size).toBe(0);
  });

  it("keeps the user's position after cancelling an automatically started entrance", async () => {
    await using fixture = setup();
    const view = await fixture.chatViewSend({ existing: true, long: true });
    await view.mount();
    await view.send();
    for (let index = 0; index < 7; index++) await fixture.frame();
    expect(view.top(view.bubble())).toBeGreaterThan(76);
    expect(view.top(view.bubble())).toBeLessThan(636);
    await view.action("cancel");
    view.viewport.scrollTop = 650;
    await view.action("late-ready");
    await view.action("hide");
    await view.action("return");
    await fixture.frame(14_000);
    expect(view.top(view.bubble())).toBe(650);
    expect(view.viewport.scrollTop).toBe(650);
    expect(view.bubble().style.translate).toBe("");
    expect(view.list.scrollToIndex).toHaveBeenCalledOnce();
    expect(view.settled).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });

  it("keeps a historical mount still without a local send", async () => {
    await using fixture = setup();
    const view = await fixture.chatViewSend({ existing: true });
    await view.mount();
    await view.action("return");
    for (let index = 0; index < 36; index++) await fixture.frame();
    expect(view.top(view.bubble())).toBe(302);
    expect(view.bubble().style.translate).toBe("");
    expect(view.positioned).not.toHaveBeenCalled();
    expect(view.list.scrollToIndex).not.toHaveBeenCalled();
    expect(view.settled).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });
});
