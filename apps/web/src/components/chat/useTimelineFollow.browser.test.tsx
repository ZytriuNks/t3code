import { MessageId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, fakeTimers } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { useTimelineFollow } from "./useTimelineFollow";

type Controller = ReturnType<typeof useTimelineFollow>;

async function setup() {
  await using stack = new AsyncDisposableStack();
  const scroll = document.createElement("div");
  scroll.style.cssText = "height:200px;width:400px;overflow:auto";
  const content = document.createElement("div");
  content.style.height = "1000px";
  scroll.append(content);
  document.body.append(scroll);
  stack.defer(() => scroll.remove());
  scroll.scrollTop = 800;
  const listState = {
    contentLength: 1000,
    scroll: 800,
    scrollLength: 200,
    data: ["message"],
    positionAtIndex: () => 0,
    sizeAtIndex: () => 1000,
  };
  const list = {
    getScrollableNode: () => scroll,
    getState: () => listState,
    scrollToItem: vi.fn().mockResolvedValue(undefined),
    scrollToEnd: vi.fn().mockResolvedValue(undefined),
  };
  const legendListRef = createRef<LegendListRef>();
  legendListRef.current = list as unknown as LegendListRef;
  const composerRef = createRef<ChatComposerHandle>();
  const restore = vi.fn();
  const collapse = vi.fn();
  composerRef.current = {
    restoreAfterTimelineReachedEnd: restore,
    collapseForTimelineScrollKey: collapse,
  } as unknown as ChatComposerHandle;
  const smoothScrollRef =
    createRef<Parameters<typeof useTimelineFollow>[0]["smoothScrollRef"]["current"]>();
  const smoothRequest = vi.fn();
  const publication = {
    controller: null as Controller | null,
    anchor: MessageId.make("sent") as MessageId | null,
  };
  const threadKey = `test:${Math.random().toString(36).slice(2)}`;
  function Probe() {
    const [anchor, setAnchor] = useState<{
      threadKey: string | null;
      messageId: MessageId | null;
    }>({
      threadKey,
      messageId: MessageId.make("sent") as MessageId | null,
    });
    const controller = useTimelineFollow({
      smoothScrollRef,
      setSmoothEndRequest: smoothRequest,
      smoothOutputEnabled: true,
      paintOnlyDisplayedTimeline: false,
      prefersReducedMotion: true,
      setTimelineOverflows: () => {},
      legendListRef,
      composerRef,
      composerOverlayElement: null,
      composerTimelineInset: 0,
      routeThreadKey: threadKey,
      activeThreadKey: threadKey,
      activeThreadId: ThreadId.make("thread"),
      isServerThread: false,
      serverProjection: null,
      threadStatus: "live",
      activeActivityRun: null,
      activeRunningTurnId: null,
      timelineEntries: [],
      timelineAnchorMessageId: anchor.messageId,
      setTimelineAnchor: setAnchor,
    });
    useLayoutEffect(() => {
      publication.controller = controller;
      publication.anchor = anchor.messageId;
    });
    return (
      <output data-testid="follow-state">
        {controller.timelineLiveFollowEnabled ? "following" : "reading"}
      </output>
    );
  }
  // 夹具验证真实跟随 hook 与 DOM 事件，不依赖页面路由。
  const screen = stack.use(await render(null, { router: false }));
  stack.use(fakeTimers());
  await screen.rerender(<Probe />);
  await act(() => vi.advanceTimersToNextFrame());
  const controller = () => publication.controller!;
  const wheel = (deltaY: number) =>
    act(() => scroll.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true })));
  const report = (atEnd: boolean) => act(() => controller().onIsAtEndChangeStable(atEnd));
  const detach = async () => {
    await wheel(-100);
    listState.scroll = 500;
    await report(false);
    await expect.element(screen.getByTestId("follow-state")).toHaveTextContent("reading");
  };
  return Object.assign(stack.move(), {
    screen,
    controller,
    listState,
    scroll,
    publication,
    threadKey,
    restore,
    collapse,
    smoothRequest,
    wheel,
    report,
    detach,
  });
}

describe("timeline follow entry points", () => {
  it("does not re-arm when collapsing content clamps an upward reader to the end", async () => {
    await using f = await setup();
    await f.detach();
    f.listState.scroll = 800;
    await f.report(true);
    await expect.element(f.screen.getByTestId("follow-state")).toHaveTextContent("reading");
    expect(f.publication.anchor).toBe("sent");
  });

  it.each([-1, undefined] as const)(
    "clears stale downward intent on manual detach (%s)",
    async (direction) => {
      await using f = await setup();
      await f.wheel(100);
      await act(() => f.controller().cancelTimelineLiveFollowForUserNavigationStable(direction));
      await f.report(false);
      await f.report(true);
      await expect.element(f.screen.getByTestId("follow-state")).toHaveTextContent("reading");
    },
  );

  it.each(["wheel", "timeline", "keyboard", "page"] as const)(
    "re-arms after deliberate downward %s navigation",
    async (kind) => {
      await using f = await setup();
      await f.detach();
      await f.report(true);
      if (kind === "wheel") await f.wheel(100);
      else if (kind === "timeline")
        await act(() => f.controller().cancelTimelineLiveFollowForUserNavigationStable(1));
      else if (kind === "keyboard")
        await act(() =>
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          ),
        );
      else {
        f.scroll.scrollTop = 500;
        await act(() => f.controller().onComposerPageScrollKeyDownStable("PageDown"));
        await act(() => f.controller().onComposerPageScrollKeyUpStable("PageDown"));
      }
      f.listState.scroll = 800;
      await f.report(true);
      await expect.element(f.screen.getByTestId("follow-state")).toHaveTextContent("following");
      expect(f.publication.anchor).toBeNull();
      expect(f.restore).toHaveBeenCalled();
    },
  );

  it("preserves a sent-turn anchor across transient end reports", async () => {
    await using f = await setup();
    await act(() => f.controller().anchorNewTurn(f.threadKey, MessageId.make("new-send")));
    await f.report(false);
    await f.report(true);
    expect(f.publication.anchor).toBe("new-send");
    await expect.element(f.screen.getByTestId("follow-state")).toHaveTextContent("following");
  });

  it("returns to follow through the production scroll-to-end action", async () => {
    await using f = await setup();
    await f.detach();
    await act(() => f.controller().scrollToEnd(true));
    await expect.element(f.screen.getByTestId("follow-state")).toHaveTextContent("following");
    expect(f.publication.anchor).toBeNull();
    expect(f.smoothRequest).toHaveBeenCalledOnce();
  });
});
