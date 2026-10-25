import { createRef, useLayoutEffect, type RefObject } from "react";
import { act, render, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import BezierEasing from "bezier-easing";

import {
  setSmoothTextEnd,
  setSmoothTextFrameHeight,
  SMOOTH_TEXT_LAYOUT_EVENT,
} from "../lib/smoothTextLayout";
import {
  SmoothScrollLayoutBoundary,
  useSmoothScroll,
  type SmoothScrollHandle,
} from "./useSmoothScroll";

async function setup() {
  await using stack = new AsyncDisposableStack();
  class MockResizeObserver implements ResizeObserver {
    static instances: MockResizeObserver[] = [];
    readonly observed = new Set<Element>();
    disconnected = false;
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      MockResizeObserver.instances.push(this);
    }

    observe(target: Element) {
      this.observed.add(target);
    }

    unobserve(target: Element) {
      this.observed.delete(target);
    }

    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }

    trigger() {
      this.callback(
        [...this.observed].map(
          (target) =>
            ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry,
        ),
        this,
      );
    }
  }

  type ScrollElement = HTMLElement & {
    setHeight(height: number): void;
    /**
     * Report the same way the text frame does: how far its bottom edge moved,
     * carried on the event, so the controller need not rediscover it by reading
     * layout on both sides of the write.
     */
    notifyGrowth(target?: HTMLElement, delta?: number): void;
  };

  const growthDeltas = new WeakMap<HTMLElement, number>();

  function makeScrollElement(scrollTop: number, scrollHeight: number, clientHeight: number) {
    const element = document.createElement("div");
    let top = scrollTop;
    let height = scrollHeight;
    Object.defineProperties(element, {
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      },
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => clientHeight },
    });
    const content = document.createElement("div");
    element.append(content);
    document.body.append(element);
    return Object.assign(element, {
      setHeight(nextHeight: number) {
        growthDeltas.set(element, nextHeight - height);
        height = nextHeight;
      },
      /**
       * Report the same way the text frame does: the edge movement carried on
       * the event, then one settling pass. The frame only compensates on the
       * first write it sees, so a test that writes twice before a paint must let
       * the settling pass run before asserting the second one — exactly as a real
       * frame boundary does.
       */
      notifyGrowth(target: HTMLElement = element, delta?: number) {
        const amount = delta ?? growthDeltas.get(element) ?? 0;
        growthDeltas.set(element, 0);
        target.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, { bubbles: true, detail: { delta: amount } }),
        );
        target.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, { bubbles: true, detail: { delta: 0 } }),
        );
      },
    }) as ScrollElement;
  }

  function notifyLayout(element: HTMLElement, delta = 0) {
    element.dispatchEvent(
      new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, { bubbles: true, detail: { delta } }),
    );
  }

  const controlRef = createRef<SmoothScrollHandle>();
  const requestRef: { current: (() => boolean) | null } = { current: null };
  const scrollElements: ScrollElement[] = [];

  function Probe({
    element,
    enabled = true,
    identity = "thread-a",
    endRequest = 0,
    onFollowingChange,
    footerRef,
  }: {
    element: HTMLElement;
    enabled?: boolean;
    identity?: string;
    endRequest?: number;
    onFollowingChange?: (following: boolean) => void;
    footerRef?: RefObject<HTMLElement | null>;
  }) {
    const request = useSmoothScroll({
      element,
      enabled,
      identity,
      reducedMotion: false,
      controlRef,
      footerRef,
      endRequest,
      onFollowingChange,
    });
    useLayoutEffect(() => {
      requestRef.current = request;
    }, [request]);
    return null;
  }

  async function renderTimeline(
    element: ScrollElement,
    enabled = true,
    identity = "thread-a",
    endRequest = 0,
  ) {
    await screen.rerender(
      <Probe element={element} enabled={enabled} identity={identity} endRequest={endRequest} />,
    );
  }

  stack.use(stubGlobal("ResizeObserver", MockResizeObserver));
  stack.defer(() => {
    for (const element of scrollElements) element.remove();
  });
  const screen = stack.use(await render(null));
  const owned = stack.move();
  return {
    screen,
    renderTimeline,
    Probe,
    controlRef,
    requestRef,
    scrollElements,
    makeScrollElement,
    notifyLayout,
    MockResizeObserver,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("useSmoothScroll", () => {
  it.each(
    ([80, 200, 1000] as const).flatMap((duration) =>
      ([false, true] as const).map((navigate) => [duration, navigate] as const),
    ),
  )(
    "follows simultaneous %sms eased height changes until the reader navigates: %s",
    async (duration, navigate) => {
      await using fixture = await setup();
      const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
      const element = makeScrollElement(1600, 2000, 400);
      scrollElements.push(element);
      const content = element.firstElementChild as HTMLElement;
      const body = document.createElement("div");
      const footnote = document.createElement("div");
      body.style.height = footnote.style.height = "20px";
      content.append(body, footnote);
      let top = 1600;
      Object.defineProperties(element, {
        scrollHeight: {
          configurable: true,
          get: () =>
            1960 + Number.parseFloat(body.style.height) + Number.parseFloat(footnote.style.height),
        },
        scrollTop: {
          configurable: true,
          get: () => (top = Math.min(top, element.scrollHeight - element.clientHeight)),
          set: (next: number) => {
            top = Math.max(0, Math.min(next, element.scrollHeight - element.clientHeight));
          },
        },
      });
      await renderTimeline(element);
      const easing = BezierEasing(0.42, 0, 0.58, 1);
      let detachedAt: number | null = null;
      const steps = Math.ceil(duration / 16);
      for (let index = 1; index <= steps; index++) {
        if (navigate && index === 3) {
          element.scrollTop -= 32;
          detachedAt = element.scrollTop;
        }
        const progress = easing(Math.min(1, (index * 16) / duration));
        await act(async () => {
          setSmoothTextFrameHeight(body, 20 + 80 * progress);
          setSmoothTextFrameHeight(footnote, 20 + 40 * progress);
          await Promise.resolve();
        });
        // Chromium rounds serialized CSS lengths; retain a tolerance well below one layout pixel.
        expect(element.scrollTop).toBeCloseTo(detachedAt ?? 1600 + 120 * progress, 3);
        expect(controlRef.current?.isFollowing()).toBe(detachedAt === null);
        expect(element.style.scrollBehavior).toBe("");
      }
      if (navigate) {
        expect(controlRef.current?.request()).toBe(false);
        expect(element.scrollTop).toBe(detachedAt);
      } else {
        await act(async () => {
          setSmoothTextFrameHeight(footnote, 0);
          await Promise.resolve();
        });
        expect(element.scrollTop).toBe(1660);
        expect(controlRef.current?.isFollowing()).toBe(true);
      }
    },
  );

  it("keeps fractional row growth monotonic across rounding boundaries without transform overflow", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, notifyLayout } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    const content = element.firstElementChild as HTMLElement;
    const height = Object.getOwnPropertyDescriptor(element, "scrollHeight")!.get!;
    let top = 1600;
    Object.defineProperties(element, {
      scrollHeight: {
        configurable: true,
        get: () =>
          height.call(element) +
          Math.ceil(Math.max(0, Number.parseFloat(content.style.translate.split(" ")[1] ?? "0"))),
      },
      scrollTop: {
        configurable: true,
        get: () => (top = Math.min(top, element.scrollHeight - element.clientHeight)),
        set: (value: number) => {
          top = Math.min(value, element.scrollHeight - element.clientHeight);
        },
      },
    });
    await renderTimeline(element);
    for (let step = 1; step <= 20; step++) {
      const growth = step / 10;
      const rounded = Math.round(growth);
      element.setHeight(2000 + rounded);
      await act(() =>
        content.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, {
            bubbles: true,
            detail: { delta: 0.1, rowFraction: growth - rounded },
          }),
        ),
      );
      await act(() => notifyLayout(content));
      const y = Number.parseFloat(content.style.translate.split(" ")[1] ?? "0");
      expect(element.scrollTop - y).toBeCloseTo(1600 + growth);
      expect(controlRef.current?.isFollowing()).toBe(true);
      expect(controlRef.current?.isAtEdge()).toBe(true);
    }
  });

  it("re-pins the end after a panel resize reflows the list instead of detaching", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, MockResizeObserver } =
      fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    expect(controlRef.current?.isFollowing()).toBe(true);

    // A narrower panel reflows the content and the virtualizer keeps an old
    // anchor, so the owned offset no longer equals its last write. That is a
    // layout change, not reader navigation: follow must adopt the new edge.
    Object.defineProperty(element, "clientWidth", { configurable: true, get: () => 480 });
    element.setHeight(3000);
    element.scrollTop = 1601;
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());

    expect(controlRef.current?.isFollowing()).toBe(true);
    expect(element.scrollTop).toBe(2600);
  });

  it("adopts the collapsed edge when a shrinking footnote panel moves the owned offset", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, MockResizeObserver } =
      fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    expect(controlRef.current?.isFollowing()).toBe(true);

    // The disclosure collapses 120px and the virtualizer leaves the owned
    // offset one step above the new edge. Shrinking content is layout, not a
    // reader walking away from the bottom.
    element.setHeight(1880);
    element.scrollTop = 1479;
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());

    expect(controlRef.current?.isFollowing()).toBe(true);
    expect(element.scrollTop).toBe(1480);
  });

  it("keeps a reader detached after they leave a followed shrinking edge", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    // The panel collapses and follow adopts the new edge through the height
    // event path (settleGrowth), which must record this edge as the last pin.
    element.setHeight(1880);
    await act(() => element.notifyGrowth());
    expect(element.scrollTop).toBe(1480);

    // The reader then scrolls up. A later one-pixel growth is the provider's,
    // not permission to pull them back to the bottom.
    element.scrollTop = 1400;
    element.setHeight(1881);
    await act(() => element.notifyGrowth());

    expect(controlRef.current?.isFollowing()).toBe(false);
    expect(element.scrollTop).toBe(1400);
  });

  it("adopts a shrink after a followed growth instead of detaching", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    // Follow a grown edge through the height event path.
    element.setHeight(2200);
    await act(() => element.notifyGrowth());
    expect(element.scrollTop).toBe(1800);

    // A disclosure collapses 100px and the measured offset lands one step
    // above the new edge. The followed edge must be remembered as 1800, not
    // the original 1600, or this looks like reader navigation.
    element.setHeight(2100);
    element.scrollTop = 1699;
    await act(() => element.notifyGrowth());

    expect(controlRef.current?.isFollowing()).toBe(true);
    expect(element.scrollTop).toBe(1700);
  });

  it("retains follow when a direct frame height write clamps its owned viewport", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    const frame = document.createElement("div");
    frame.style.height = "20px";
    element.firstElementChild?.append(frame);
    let height = 20;
    let top = 1600;
    Object.defineProperties(element, {
      scrollHeight: { get: () => 1980 + Number.parseFloat(frame.style.height) },
      scrollTop: {
        get: () => {
          const next = Number.parseFloat(frame.style.height);
          if (next !== height) {
            height = next;
            top = Math.min(top, 1599);
          }
          return top;
        },
        set: (value: number) => {
          top = value;
        },
      },
    });
    await renderTimeline(element);
    await act(() => setSmoothTextFrameHeight(frame, 20.4));
    expect(element.scrollTop).toBeCloseTo(1600.4);
    expect(controlRef.current?.isFollowing()).toBe(true);
    await act(() => setSmoothTextFrameHeight(frame, 24));
    expect(element.scrollTop).toBe(1604);
    expect(controlRef.current?.isFollowing()).toBe(true);
  });

  it("retains outer layout ownership after an inner virtual-row update finishes", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    const outer = controlRef.current?.beginLayout();
    const inner = controlRef.current?.beginLayout();
    expect(outer).toBeTypeOf("function");
    expect(inner).toBeTypeOf("function");
    await act(() => inner?.());
    element.scrollTop = 1500;
    element.setHeight(2200);
    await act(() => element.notifyGrowth());
    await act(() => outer?.());
    expect(element.scrollTop).toBe(1800);
    expect(controlRef.current?.isFollowing()).toBe(true);
    element.scrollTop -= 0.25;
    element.setHeight(2400);
    await act(() => element.notifyGrowth());
    expect(element.scrollTop).toBe(1799.75);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("avoids native overflow from fractional compensation and preserves ownership through later growth", async () => {
    await using fixture = await setup();
    const {
      renderTimeline,
      controlRef,
      scrollElements,
      makeScrollElement,
      notifyLayout,
      MockResizeObserver,
    } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    const content = element.firstElementChild as HTMLElement;
    const height = Object.getOwnPropertyDescriptor(element, "scrollHeight")!.get!;
    let top = 1600;
    Object.defineProperties(element, {
      scrollHeight: {
        configurable: true,
        get: () =>
          height.call(element) +
          Math.ceil(Math.max(0, Number.parseFloat(content.style.translate.split(" ")[1] ?? "0"))),
      },
      scrollTop: {
        configurable: true,
        get: () => (top = Math.min(top, element.scrollHeight - element.clientHeight)),
        set: (value: number) => {
          top = Math.min(value, element.scrollHeight - element.clientHeight);
        },
      },
    });
    await renderTimeline(element);
    const fraction = async (rowFraction: number) =>
      await act(() => {
        content.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, {
            bubbles: true,
            detail: { delta: 0.4, rowFraction },
          }),
        );
        notifyLayout(content);
      });
    await fraction(-0.4);
    await act(() => MockResizeObserver.instances[0]!.trigger());
    expect(element.scrollTop).toBe(1599);
    expect(element.scrollHeight).toBe(2000);
    await fraction(0.4);
    expect(element.scrollTop).toBe(1600);
    element.setHeight(2020);
    await act(() => MockResizeObserver.instances[0]!.trigger());
    expect(element.scrollTop).toBe(1620);
    expect(controlRef.current?.isFollowing()).toBe(true);
    element.scrollTop -= 0.25;
    element.setHeight(2040);
    await act(() => MockResizeObserver.instances[0]!.trigger());
    expect(element.scrollTop).toBe(1619.75);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("keeps a sticky activity label fixed while its body moves through fractional heights", async () => {
    await using fixture = await setup();
    const { screen, Probe, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    const content = element.firstElementChild as HTMLElement;
    const sticky = document.createElement("div");
    const footer = document.createElement("div");
    sticky.style.position = "sticky";
    sticky.append(footer);
    content.append(sticky);
    const footerRef = createRef<HTMLElement>();
    footerRef.current = footer;
    await act(() => screen.rerender(<Probe element={element} footerRef={footerRef} />));
    for (const fraction of [0.25, -0.4, 0.4, 0]) {
      await act(() =>
        content.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, {
            bubbles: true,
            detail: { delta: 0.25, rowFraction: fraction },
          }),
        ),
      );
      const bodyY = Number.parseFloat(content.style.translate.split(" ")[1] ?? "0");
      const labelY = Number.parseFloat(footer.style.translate.split(" ")[1] ?? "0");
      expect(bodyY + labelY).toBeCloseTo(0);
      expect(controlRef.current?.isAtEdge()).toBe(true);
    }
    await act(() => controlRef.current?.cancel());
    expect(content.style.translate).toBe("");
    expect(footer.style.translate).toBe("");
  });

  it("keeps a virtual Thinking row fixed across streamed row rounding boundaries", async () => {
    await using fixture = await setup();
    const { screen, Probe, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    const content = element.firstElementChild as HTMLElement;
    const thinking = document.createElement("div");
    content.append(thinking);
    let roundedGrowth = 0;
    thinking.getBoundingClientRect = () =>
      new DOMRect(
        0,
        1760 +
          roundedGrowth -
          element.scrollTop +
          Number.parseFloat(content.style.translate.split(" ")[1] ?? "0") +
          Number.parseFloat(thinking.style.translate.split(" ")[1] ?? "0"),
        100,
        28,
      );
    await act(() => screen.rerender(<Probe element={element} />));

    for (const growth of [0.1, 0.4, 0.5, 0.6, 0.9, 1, 1.2, 1.5, 1.9, 2]) {
      roundedGrowth = Math.round(growth);
      element.setHeight(2000 + roundedGrowth);
      await act(() =>
        controlRef.current?.commitLayout(growth - roundedGrowth, [
          { element: thinking, fraction: 0 },
        ]),
      );
      expect(thinking.getBoundingClientRect().top).toBeCloseTo(160, 6);
      const bodyY = Number.parseFloat(content.style.translate.split(" ")[1] ?? "0");
      expect(element.scrollTop - bodyY).toBeCloseTo(1600 + growth, 6);
      expect(controlRef.current?.isFollowing()).toBe(true);
    }

    element.scrollTop -= 32;
    await act(() => controlRef.current?.cancel());
    expect(thinking.style.translate).toBe("");
    expect(content.style.translate).toBe("");
    const detachedTop = element.scrollTop;
    roundedGrowth = 3;
    element.setHeight(2003);
    await act(() => controlRef.current?.commitLayout(0));
    expect(element.scrollTop).toBe(detachedTop);
    expect(thinking.getBoundingClientRect().top).toBe(193);
  });

  it("leaves a non-scrollable body in normal flow as the first rows obtain space", async () => {
    await using fixture = await setup();
    const { renderTimeline, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(0, 300, 400);
    scrollElements.push(element);
    const content = element.firstElementChild as HTMLElement;
    await renderTimeline(element);
    for (let height = 300; height < 400; height += 20) {
      element.setHeight(height);
      await act(() =>
        content.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, {
            bubbles: true,
            detail: { delta: 20, rowFraction: 0.25 },
          }),
        ),
      );
      expect(content.style.translate).toBe("");
      expect(element.scrollTop).toBe(0);
    }
  });
  it("compensates fractional growth while retaining the strict native edge and reader ownership", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1600, 2000, 400);
    scrollElements.push(element);
    const content = element.firstElementChild as HTMLElement;
    let exactHeight = 2000;
    vi.spyOn(content, "getBoundingClientRect").mockImplementation(
      () => ({ height: exactHeight }) as DOMRect,
    );
    await renderTimeline(element);
    const shifts: number[] = [];
    for (let step = 1; step <= 8; step++) {
      exactHeight = 2000 + step / 4;
      element.setHeight(Math.round(exactHeight));
      await act(() => element.notifyGrowth(content, 0.25));
      const translatedY = Number.parseFloat(content.style.translate.split(" ")[1] ?? "0");
      shifts.push(-element.scrollTop + translatedY);
      expect(controlRef.current?.isAtEdge()).toBe(true);
      expect(controlRef.current?.isFollowing()).toBe(true);
    }
    for (let index = 1; index < shifts.length; index++)
      expect(shifts[index]! - shifts[index - 1]!).toBeCloseTo(-0.25);
    await act(() => controlRef.current?.cancel());
    expect(content.style.translate).toBe("");
    element.scrollTop -= 100;
    exactHeight += 20;
    element.setHeight(Math.round(exactHeight));
    await act(() => element.notifyGrowth(content, 20));
    expect(content.style.translate).toBe("");
    expect(element.scrollTop).toBe(1502);
  });
  it("retains owned follow when one React commit clamps then regrows the layout", async () => {
    await using fixture = await setup();
    const {
      screen,
      renderTimeline,
      Probe,
      controlRef,
      requestRef,
      scrollElements,
      makeScrollElement,
    } = fixture;
    const element = makeScrollElement(800, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    const content = (clamp: boolean) => (
      <>
        <Probe element={element} />
        <SmoothScrollLayoutBoundary controlRef={controlRef}>
          <LayoutChange clamp={clamp} />
        </SmoothScrollLayoutBoundary>
      </>
    );
    function LayoutChange({ clamp }: { clamp: boolean }) {
      useLayoutEffect(() => {
        if (!clamp) return;
        element.setHeight(1_169);
        element.scrollTop = 769;
        element.setHeight(1_191);
        requestRef.current?.();
      }, [clamp]);
      return null;
    }
    await act(() => screen.rerender(content(false)));
    await act(() => screen.rerender(content(true)));
    expect(element.scrollTop).toBe(791);
    expect(controlRef.current?.isFollowing()).toBe(true);

    element.scrollTop -= 0.25;
    await act(() => screen.rerender(content(false)));
    element.setHeight(1_240);
    await act(() => requestRef.current?.());
    expect(element.scrollTop).toBe(790.75);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("does not retain ownership after explicit navigation during a layout commit", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(800, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    const finish = controlRef.current?.beginLayout();
    expect(finish).toBeTypeOf("function");
    await act(() => controlRef.current?.cancel());
    element.scrollTop = 600;
    element.setHeight(1_240);
    await act(() => finish?.());
    expect(element.scrollTop).toBe(600);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("keeps a subpixel reading step made between a height write and its settling pass", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, notifyLayout } = fixture;
    const element = makeScrollElement(800, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    element.setHeight(1_220);
    await act(() => notifyLayout(element, 20));
    expect(element.scrollTop).toBe(820);

    element.scrollTop -= 0.25;
    element.setHeight(1_240);
    await act(() => {
      notifyLayout(element, 20);
      notifyLayout(element);
    });
    expect(element.scrollTop).toBe(819.75);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("does not replay a shrinking text delta against an unchanged virtualized edge", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, requestRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(800, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    // The text frame has shrunk, but LegendList still exposes its old spacer.
    await act(() => element.notifyGrowth(element, -20));
    expect(element.scrollTop).toBe(800);
    expect(controlRef.current?.isFollowing()).toBe(true);

    // Its later layout commit clamps to the new native edge, then grows again.
    element.setHeight(1_180);
    element.scrollTop = 780;
    await act(() => requestRef.current?.());
    element.setHeight(1_220);
    await act(() => element.notifyGrowth(element, 40));
    expect(element.scrollTop).toBe(820);
    expect(controlRef.current?.isFollowing()).toBe(true);
  });

  it("keeps a restored reading position detached until an explicit end request", async () => {
    await using fixture = await setup();
    const {
      screen,
      Probe,
      controlRef,
      requestRef,
      scrollElements,
      makeScrollElement,
      MockResizeObserver,
    } = fixture;
    const element = makeScrollElement(700, 1_200, 400);
    scrollElements.push(element);
    const onFollowingChange = vi.fn();
    const update = async (endRequest = 0) =>
      await act(() =>
        screen.rerender(
          <Probe element={element} endRequest={endRequest} onFollowingChange={onFollowingChange} />,
        ),
      );
    await update();
    expect(controlRef.current?.isFollowing()).toBe(false);
    expect(onFollowingChange).not.toHaveBeenCalled();

    element.setHeight(1_240);
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(700);
    expect(controlRef.current?.isFollowing()).toBe(false);

    await update(1);
    expect(element.scrollTop).toBe(840);
    expect(onFollowingChange).toHaveBeenLastCalledWith(true);

    // Position caching can run before the scroll callback cancels ownership.
    element.scrollTop -= 0.25;
    expect(controlRef.current?.isFollowing()).toBe(false);
    await act(() => requestRef.current?.());
    expect(onFollowingChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps follow when the browser clamps a shrinking timeline to its new end", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, requestRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(800, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    element.setHeight(1_160);
    element.scrollTop = 760;
    expect(controlRef.current?.isFollowing()).toBe(true);
    await act(() => requestRef.current?.());

    element.setHeight(1_200);
    await act(() => requestRef.current?.());
    expect(element.scrollTop).toBe(800);
  });

  it("keeps follow after a chase frame sees the browser clamp a shrinking timeline", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, requestRef, scrollElements, makeScrollElement } = fixture;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    using _global1 = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    using _global2 = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const flushFrame = async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(0)));
    };
    const element = makeScrollElement(800, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    // Native clamping can land before ResizeObserver reports the smaller layout.
    element.setHeight(1_160);
    element.scrollTop = 760;
    await flushFrame();
    expect(controlRef.current?.isFollowing()).toBe(true);

    element.setHeight(1_200);
    await act(() => requestRef.current?.());
    expect(element.scrollTop).toBe(800);
    expect(controlRef.current?.isFollowing()).toBe(true);

    element.scrollTop -= 0.25;
    element.setHeight(1_240);
    await flushFrame();
    expect(element.scrollTop).toBe(799.75);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("pins delayed layout growth and stops scheduling frames once the edge settles", async () => {
    await using fixture = await setup();
    const { renderTimeline, scrollElements, makeScrollElement, MockResizeObserver } = fixture;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    using _global3 = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    using _global4 = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const flushFrame = async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(0)));
    };
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    // The virtualizer can commit its content height after the text frame's event.
    element.setHeight(2_040);
    await flushFrame();
    expect(element.scrollTop).toBe(1_640);
    element.setHeight(2_080);
    await flushFrame();
    expect(element.scrollTop).toBe(1_680);
    for (let index = 0; index < 3; index++) await flushFrame();
    expect(frames.size).toBe(0);

    // A later resize starts a bounded chase again, and navigation stops it.
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(frames.size).toBe(1);
    element.scrollTop -= 0.25;
    element.setHeight(2_120);
    await flushFrame();
    expect(element.scrollTop).toBe(1_679.75);
    expect(frames.size).toBe(0);
  });

  it("publishes character progress without restarting settled layout follow", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    using _global5 = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    using _global6 = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    const text = document.createTextNode("ABC");
    marker.append(text);
    element.firstElementChild?.append(marker);
    await renderTimeline(element);
    for (let index = 0; index < 3; index++) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(0)));
    }
    expect(frames.size).toBe(0);
    const readHeight = vi.spyOn(element, "scrollHeight", "get");
    const readViewport = vi.spyOn(element, "clientHeight", "get");

    for (let index = 0; index < text.length; index++) {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      await act(() => setSmoothTextEnd(marker, range));
    }

    expect(readHeight).not.toHaveBeenCalled();
    expect(readViewport).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(element.scrollTop).toBe(1_600);
    expect(controlRef.current?.isFollowing()).toBe(true);
  });

  it("reads the end once per pin and chase while preserving delayed growth", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, requestRef, scrollElements, makeScrollElement } = fixture;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    using _global7 = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    using _global8 = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    const readHeight = vi.spyOn(element, "scrollHeight", "get");
    const readViewport = vi.spyOn(element, "clientHeight", "get");

    element.setHeight(2_040);
    await act(() => requestRef.current?.());
    expect(element.scrollTop).toBe(1_640);
    expect(readHeight).toHaveBeenCalledTimes(1);
    expect(readViewport).toHaveBeenCalledTimes(1);
    readHeight.mockClear();
    readViewport.mockClear();

    element.setHeight(2_080);
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(0)));
    expect(element.scrollTop).toBe(1_680);
    expect(readHeight).toHaveBeenCalledTimes(1);
    expect(readViewport).toHaveBeenCalledTimes(1);
    expect(controlRef.current?.isFollowing()).toBe(true);
  });

  it("does not pull back a small then large scroll when layout runs before the scroll event", async () => {
    await using fixture = await setup();
    const {
      renderTimeline,
      controlRef,
      requestRef,
      scrollElements,
      makeScrollElement,
      MockResizeObserver,
    } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    element.firstElementChild?.append(marker);
    await renderTimeline(element);

    // No wheel/scroll callback has run yet: a frame can resize first.
    element.scrollTop = 1_599.75;
    element.setHeight(2_020);
    await act(() => element.notifyGrowth(marker));
    expect(element.scrollTop).toBe(1_599.75);

    element.scrollTop = 1_200;
    element.setHeight(2_100);
    await act(() => {
      element.notifyGrowth(marker);
      MockResizeObserver.instances.at(-1)?.trigger();
      requestRef.current?.();
    });
    expect(element.scrollTop).toBe(1_200);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("provides space for sequential sub-frame lines without waiting for a second layout event", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    using _global9 = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    using _global10 = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    element.firstElementChild?.append(marker);
    await renderTimeline(element);
    for (const height of [2_020, 2_040, 2_060]) {
      element.setHeight(height);
      await act(() =>
        marker.dispatchEvent(
          new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, {
            bubbles: true,
            detail: { delta: 20, synchronous: true },
          }),
        ),
      );
      expect(element.scrollTop).toBe(height - 400);
    }
    element.scrollTop -= 0.25;
    element.setHeight(2_080);
    await act(() =>
      marker.dispatchEvent(
        new CustomEvent(SMOOTH_TEXT_LAYOUT_EVENT, {
          bubbles: true,
          detail: { delta: 20, synchronous: true },
        }),
      ),
    );
    expect(element.scrollTop).toBe(1_659.75);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("does not start upward layout movement merely because a controller mounts above the end", async () => {
    await using fixture = await setup();
    const { renderTimeline, scrollElements, makeScrollElement, MockResizeObserver } = fixture;
    const element = makeScrollElement(700, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    expect(element.scrollTop).toBe(700);
    element.setHeight(1_240);
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(700);
  });

  it("honors an explicit end request even before a smooth text marker is mounted", async () => {
    await using fixture = await setup();
    const { renderTimeline, requestRef, scrollElements, makeScrollElement, MockResizeObserver } =
      fixture;
    const element = makeScrollElement(0, 1_200, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    await renderTimeline(element, true, "thread-a", 1);

    expect(element.scrollTop).toBe(800);
    expect(MockResizeObserver.instances.at(-1)?.observed.has(element.firstElementChild!)).toBe(
      true,
    );

    element.setHeight(1_240);
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(840);

    element.setHeight(1_280);
    await act(() => expect(requestRef.current?.()).toBe(true));
    expect(element.scrollTop).toBe(880);
  });

  it("pins text frame growth, then stops when the owner cancels follow", async () => {
    await using fixture = await setup();
    const {
      renderTimeline,
      controlRef,
      requestRef,
      scrollElements,
      makeScrollElement,
      MockResizeObserver,
    } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    marker.dataset.smoothTextEnd = "";
    element.firstElementChild?.append(marker);
    await renderTimeline(element);

    for (const height of [2_040, 2_080, 2_120]) {
      element.setHeight(height);
      await act(() => element.notifyGrowth(marker));
      expect(element.scrollTop).toBe(height - 400);
    }

    await act(() => controlRef.current?.cancel());
    element.scrollTop = 1_600;
    expect(element.scrollTop).toBe(1_600);
    expect(controlRef.current?.isFollowing()).toBe(false);

    element.setHeight(2_160);
    await act(() => {
      element.notifyGrowth(marker);
      MockResizeObserver.instances.at(-1)?.trigger();
      expect(requestRef.current?.()).toBe(false);
    });
    expect(element.scrollTop).toBe(1_600);
  });

  it.each([false, true])(
    "settles simultaneous body and footnote growth before paint while preserving reader navigation: %s",
    async (navigate) => {
      await using fixture = await setup();
      const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
      const element = makeScrollElement(1600, 2000, 400);
      scrollElements.push(element);
      const body = document.createElement("div");
      const footnote = document.createElement("div");
      body.style.height = footnote.style.height = "20px";
      element.firstElementChild!.append(body, footnote);
      Object.defineProperty(element, "scrollHeight", {
        get: () =>
          1960 + Number.parseFloat(body.style.height) + Number.parseFloat(footnote.style.height),
      });
      await renderTimeline(element);
      await act(() => {
        setSmoothTextFrameHeight(body, 40);
        setSmoothTextFrameHeight(footnote, 60);
      });
      if (navigate) element.scrollTop = 1300;
      await act(() => Promise.resolve());
      expect(element.scrollTop).toBe(navigate ? 1300 : 1660);
      expect(controlRef.current!.isFollowing()).toBe(!navigate);
    },
  );

  it("does not re-pin after a second upward navigation from the live edge", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, MockResizeObserver } =
      fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    element.firstElementChild?.append(marker);
    await renderTimeline(element);

    element.setHeight(2_040);
    await act(() => element.notifyGrowth(marker));
    expect(element.scrollTop).toBe(1_640);

    await act(() => controlRef.current?.cancel());
    element.scrollTop = 1_500;
    element.setHeight(2_080);
    await act(() => element.notifyGrowth(marker));
    expect(element.scrollTop).toBe(1_500);

    await renderTimeline(element, false);
    await renderTimeline(element, true, "thread-a", 1);
    expect(element.scrollTop).toBe(1_680);

    await act(() => controlRef.current?.cancel());
    element.scrollTop = 1_570;
    element.setHeight(2_120);
    await act(() => {
      element.notifyGrowth(marker);
      MockResizeObserver.instances.at(-1)?.trigger();
    });
    expect(element.scrollTop).toBe(1_570);
  });

  it("does not treat re-enabling after layout as an explicit end request", async () => {
    await using fixture = await setup();
    const {
      renderTimeline,
      controlRef,
      requestRef,
      scrollElements,
      makeScrollElement,
      MockResizeObserver,
    } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    await act(() => controlRef.current?.cancel());
    expect(controlRef.current?.isFollowing()).toBe(false);
    element.scrollTop = 700;
    element.setHeight(2_100);
    await act(() => {
      MockResizeObserver.instances.at(-1)?.trigger();
      expect(requestRef.current?.()).toBe(false);
    });
    expect(element.scrollTop).toBe(700);

    await renderTimeline(element, false);
    expect(controlRef.current).toBeNull();
    await renderTimeline(element);
    expect(element.scrollTop).toBe(700);
    await renderTimeline(element, true, "thread-a", 1);
    expect(element.scrollTop).toBe(1_700);
  });

  it("switches line expansion from fixed Thinking to fixed text before mutating the frame", async () => {
    await using fixture = await setup();
    const { renderTimeline, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const frame = document.createElement("div");
    frame.style.height = "20px";
    element.firstElementChild?.append(frame);
    Object.defineProperty(element, "scrollHeight", {
      get: () => 1_980 + Number.parseFloat(frame.style.height),
    });
    await renderTimeline(element);
    const thinkingBottom = () => element.scrollHeight - element.scrollTop;

    await act(() => setSmoothTextFrameHeight(frame, 40));
    expect(element.scrollTop).toBe(1_620);
    expect(thinkingBottom()).toBe(400);

    element.scrollTop -= 0.25;
    await act(() => setSmoothTextFrameHeight(frame, 60));
    expect(element.scrollTop).toBe(1_619.75);
    expect(thinkingBottom()).toBe(420.25);

    element.scrollTop -= 300;
    await act(() => setSmoothTextFrameHeight(frame, 80));
    expect(element.scrollTop).toBe(1_319.75);
    expect(thinkingBottom()).toBe(740.25);

    await renderTimeline(element, false);
    await renderTimeline(element, true, "thread-a", 1);
    await act(() => setSmoothTextFrameHeight(frame, 100));
    expect(thinkingBottom()).toBe(400);
  });

  it("cleans up the previous thread controller and handles an underflowing timeline", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, MockResizeObserver } =
      fixture;
    const element = makeScrollElement(0, 300, 400);
    scrollElements.push(element);
    await renderTimeline(element);
    const firstHandle = controlRef.current;
    const firstObserver = MockResizeObserver.instances.at(-1)!;
    expect(element.scrollTop).toBe(0);

    await renderTimeline(element, true, "thread-b");
    expect(firstHandle?.isFollowing()).toBe(false);
    expect(firstObserver.disconnected).toBe(true);
    element.setHeight(410);
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(10);

    await renderTimeline(element, false, "thread-b");
    expect(controlRef.current).toBeNull();
    element.setHeight(450);
    expect(element.scrollTop).toBe(10);
  });
});

describe("useSmoothScroll isAtEdge", () => {
  it("reports the viewport as at the edge while it sits on the end", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement, MockResizeObserver } =
      fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    expect(controlRef.current?.isAtEdge()).toBe(true);

    element.setHeight(2_040);
    await act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(controlRef.current?.isAtEdge()).toBe(true);
  });

  it("reports the viewport as away from the edge once the reader scrolls up", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    element.scrollTop = 1_200;
    expect(controlRef.current?.isAtEdge()).toBe(false);

    element.scrollTop = 0;
    expect(controlRef.current?.isAtEdge()).toBe(false);
  });

  it("reports the edge again after the reader scrolls back down past a cancel", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    await act(() => controlRef.current?.cancel());
    element.scrollTop = 1_200;
    expect(controlRef.current?.isFollowing()).toBe(false);
    expect(controlRef.current?.isAtEdge()).toBe(false);

    // The reader owns the viewport now: cancelled and lastPinnedTop describe
    // controller ownership, not where the viewport is. Reading the edge must
    // still report the real position.
    element.scrollTop = 1_600;
    expect(controlRef.current?.isFollowing()).toBe(false);
    expect(controlRef.current?.isAtEdge()).toBe(true);

    element.scrollTop = 0;
    expect(controlRef.current?.isAtEdge()).toBe(false);
  });

  it("leaves the edge on a sub-pixel upward step", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    element.scrollTop = 1_599.75;
    expect(controlRef.current?.isAtEdge()).toBe(false);
    expect(element.scrollTop).toBe(1_599.75);

    element.scrollTop = 1_600;
    expect(controlRef.current?.isAtEdge()).toBe(true);
  });

  it("treats content that underflows the viewport as being at the edge", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(0, 300, 400);
    scrollElements.push(element);
    await renderTimeline(element);

    expect(controlRef.current?.isAtEdge()).toBe(true);
  });

  it("publishes no handle while disabled so the caller falls back to the DOM", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    await renderTimeline(element, false);

    expect(controlRef.current).toBeNull();
    expect(element.scrollTop).toBe(1_600);
  });

  it("reads without moving the viewport or disturbing follow", async () => {
    await using fixture = await setup();
    const { renderTimeline, controlRef, scrollElements, makeScrollElement } = fixture;
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    marker.dataset.smoothTextEnd = "";
    element.firstElementChild?.append(marker);
    await renderTimeline(element);

    // Growth still pins to the new end with reads interleaved, and the reads
    // themselves never take ownership of the viewport.
    for (const height of [2_040, 2_080, 2_120]) {
      expect(controlRef.current?.isAtEdge()).toBe(true);
      element.setHeight(height);
      await act(() => element.notifyGrowth(marker));
      expect(element.scrollTop).toBe(height - 400);
      expect(controlRef.current?.isAtEdge()).toBe(true);
    }
    expect(controlRef.current?.isFollowing()).toBe(true);

    // A read from above the edge leaves the reader's offset untouched, so it
    // cannot re-pin or detach follow behind the caller's back.
    await act(() => controlRef.current?.cancel());
    element.scrollTop = 1_500;
    expect(controlRef.current?.isAtEdge()).toBe(false);
    element.setHeight(2_160);
    expect(controlRef.current?.isAtEdge()).toBe(false);
    expect(element.scrollTop).toBe(1_500);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });
});
