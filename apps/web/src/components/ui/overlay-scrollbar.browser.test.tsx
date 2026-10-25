import { act, render, fakeTimers, stubGlobal } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { OverlayScrollbar } from "./overlay-scrollbar";

async function setup() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400));
  stack.use(stubGlobal("ResizeObserver", undefined));
  const elements: HTMLElement[] = [];
  stack.defer(() => elements.forEach((element) => element.remove()));
  const container = document.createElement("div");
  // 几何边界由夹具交付；验证拖动、长按和取消，无路由入口。
  const screen = stack.use(await render(null, { container, router: false }));
  const createScrollable = (scrollHeight: number) => {
    const element = document.createElement("div");
    let offset = 0;
    let horizontalOffset = 0;
    Object.defineProperties(element, {
      scrollHeight: { value: scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => offset,
        set: (value: number) => {
          offset = value;
        },
      },
      scrollLeft: {
        configurable: true,
        get: () => horizontalOffset,
        set: (value: number) => {
          horizontalOffset = value;
        },
      },
    });
    document.body.append(element);
    elements.push(element);
    return element;
  };
  return Object.assign(stack.move(), { screen, container, createScrollable });
}

describe("OverlayScrollbar", () => {
  it("only deducts desktop resize clearance when a pane reaches the window edge", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    let paneRight = 1000;
    let notifyResize = () => {};
    const desktopStyle = document.createElement("style");
    desktopStyle.textContent =
      "[data-slot='overlay-scrollbar'] { --desktop-window-right-resize-inset: 2px; }";
    document.head.append(desktopStyle);
    env.use(vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280));
    env.use(
      vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(() => new DOMRect(0, 0, paneRight, 400)),
    );
    env.use(
      stubGlobal(
        "ResizeObserver",
        class {
          private targets = new Set<Element>();
          constructor(callback: (entries: ResizeObserverEntry[]) => void) {
            notifyResize = () =>
              callback(
                Array.from(this.targets, (target) => ({
                  target,
                  contentRect: target.getBoundingClientRect(),
                  borderBoxSize: [],
                  contentBoxSize: [],
                  devicePixelContentBoxSize: [],
                })),
              );
          }
          observe(target: Element) {
            this.targets.add(target);
          }
          unobserve(target: Element) {
            this.targets.delete(target);
          }
          disconnect() {
            this.targets.clear();
          }
        },
      ),
    );
    try {
      await act(() => screen.rerender(<OverlayScrollbar scrollable={scrollable} triangles />));
      const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
      expect(lane.style.getPropertyValue("--overlay-scrollbar-edge")).toBe("2px");
      // Closing the adjacent pane puts this bar beside the root's 2px padding.
      paneRight = 1278;
      await act(() => notifyResize());
      expect(lane.style.getPropertyValue("--overlay-scrollbar-edge")).toBe(
        "max(0px, calc(2px - var(--desktop-window-right-resize-inset)))",
      );
      // Reopening the pane restores the gap at the internal divider.
      paneRight = 1000;
      await act(() => notifyResize());
      expect(lane.style.getPropertyValue("--overlay-scrollbar-edge")).toBe("2px");
    } finally {
      desktopStyle.remove();
    }
  });

  it("continues a compact fade from its painted progress and takes longer to fade out", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(container, "animate", { configurable: true, value: animate });
    await act(() =>
      screen.rerender(<OverlayScrollbar scrollable={scrollable} autoHide thumbInset="gutter" />),
    );
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
    lane.dispatchEvent(new Event("pointerenter"));
    expect(animate).toHaveBeenLastCalledWith(
      [{ "--compact-scrollbar-reveal": 0 }, { "--compact-scrollbar-reveal": 1 }],
      { duration: 150, easing: "ease-out" },
    );
    // A partially painted frame must be retained when direction reverses.
    container.style.setProperty("--compact-scrollbar-reveal", "0.4");
    lane.dispatchEvent(new Event("pointerleave"));
    expect(cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenLastCalledWith(
      [{ "--compact-scrollbar-reveal": 0.4 }, { "--compact-scrollbar-reveal": 0 }],
      { duration: 300, easing: "ease-out" },
    );
    await screen.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(container.style.getPropertyValue("--compact-scrollbar-reveal")).toBe("");
  });

  it("shares compact scroll visibility without restarting its animation on each scroll", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(fakeTimers());
    const scrollable = env.createScrollable(1000);
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(container, "animate", { configurable: true, value: animate });
    await act(() =>
      screen.rerender(<OverlayScrollbar scrollable={scrollable} autoHide thumbInset="gutter" />),
    );
    await act(() => scrollable.dispatchEvent(new Event("scroll")));
    expect(animate).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTime(600));
    await act(() => scrollable.dispatchEvent(new Event("scroll")));
    await act(() => vi.advanceTimersByTime(600));
    expect(animate).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTime(100));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate).toHaveBeenLastCalledWith(
      [{ "--compact-scrollbar-reveal": 1 }, { "--compact-scrollbar-reveal": 0 }],
      { duration: 300, easing: "ease-out" },
    );
  });

  it("drags a horizontal overflow without changing the vertical offset", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400));
    const scrollable = env.createScrollable(1000);
    Object.defineProperty(scrollable, "scrollWidth", { value: 1000 });
    scrollable.style.overflowX = "auto";
    scrollable.scrollLeft = 100;
    scrollable.scrollTop = 80;
    await act(() =>
      screen.rerender(<OverlayScrollbar scrollable={scrollable} orientation="horizontal" />),
    );
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
    const thumb = lane.querySelector<HTMLElement>("div")!;
    env.use(vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 12)));
    env.use(vi.spyOn(thumb, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 0, 160, 6)));
    thumb.setPointerCapture = () => {};
    thumb.releasePointerCapture = () => {};
    await act(() =>
      thumb.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 50 }),
      ),
    );
    await act(() =>
      thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 130 })),
    );
    expect(scrollable.scrollLeft).toBe(300);
    expect(scrollable.scrollTop).toBe(80);
    await act(() => thumb.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })));
    await act(() =>
      thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 200 })),
    );
    expect(scrollable.scrollLeft).toBe(300);
  });

  it("reports each drag reversal before moving, even after the host resumes follow", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    scrollable.scrollTop = 300;
    const navigation: { direction: number; before: number }[] = [];
    await act(() =>
      screen.rerender(
        <OverlayScrollbar
          scrollable={scrollable}
          onScrollStart={(direction) => {
            navigation.push({ direction, before: scrollable.scrollTop });
          }}
        />,
      ),
    );
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
    const thumb = lane.querySelector<HTMLElement>("div")!;
    env.use(vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 12, 400)));
    env.use(vi.spyOn(thumb, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 120, 6, 160)));
    thumb.setPointerCapture = () => {};
    thumb.releasePointerCapture = () => {};
    await act(() =>
      thumb.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientY: 130,
        }),
      ),
    );
    for (const clientY of [90, 250, 170, 250]) {
      await act(() =>
        thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY })),
      );
    }
    expect(navigation).toEqual([
      { direction: -1, before: 300 },
      { direction: 1, before: 200 },
      { direction: -1, before: 600 },
      { direction: 1, before: 400 },
    ]);
    expect(scrollable.scrollTop).toBe(600);
    await act(() => thumb.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })));
  });

  it("navigates horizontal overflow by keyboard and clamps to its edges", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400));
    const scrollable = env.createScrollable(1000);
    Object.defineProperty(scrollable, "scrollWidth", { value: 1000 });
    scrollable.style.overflowX = "auto";
    scrollable.scrollLeft = 590;
    scrollable.scrollTo = vi.fn();
    await act(() =>
      screen.rerender(<OverlayScrollbar scrollable={scrollable} orientation="horizontal" />),
    );
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
    await act(() =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );
    expect(scrollable.scrollTo).toHaveBeenLastCalledWith({ left: 600, behavior: "instant" });
    await act(() =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })),
    );
    expect(scrollable.scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "instant" });
    await act(() =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })),
    );
    expect(scrollable.scrollTo).toHaveBeenCalledTimes(2);
  });

  it.each(["auto", "hidden"])(
    "has no horizontal thumb when overflow is %s and cannot be scrolled",
    async (overflow) => {
      await using env = await setup();
      const { screen, container } = env;
      env.use(vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400));
      const scrollable = env.createScrollable(1000);
      Object.defineProperty(scrollable, "scrollWidth", { value: overflow === "auto" ? 400 : 1000 });
      scrollable.style.overflowX = overflow;
      await act(() =>
        screen.rerender(<OverlayScrollbar scrollable={scrollable} orientation="horizontal" />),
      );
      expect(container.querySelector("[role='scrollbar'] > div")).toBeNull();
    },
  );

  it("reveals while scrolling and restarts the idle delay on subsequent scrolls", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(fakeTimers());
    const scrollable = env.createScrollable(1000);
    await act(() => screen.rerender(<OverlayScrollbar scrollable={scrollable} autoHide />));
    const thumb = () => container.querySelector<HTMLElement>("[role='scrollbar'] > div")!;
    expect(thumb().classList.contains("opacity-0")).toBe(true);
    await act(() => scrollable.dispatchEvent(new Event("scroll")));
    expect(thumb().classList.contains("opacity-100")).toBe(true);
    await act(() => vi.advanceTimersByTime(600));
    await act(() => scrollable.dispatchEvent(new Event("scroll")));
    await act(() => vi.advanceTimersByTime(600));
    expect(thumb().classList.contains("opacity-100")).toBe(true);
    await act(() => vi.advanceTimersByTime(100));
    expect(thumb().classList.contains("opacity-0")).toBe(true);
  });

  it("steps the supplied viewport without requiring a host callback", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    scrollable.scrollBy = vi.fn();
    await act(() => screen.rerender(<OverlayScrollbar scrollable={scrollable} triangles />));
    await act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Scroll down"]')!.click(),
    );
    expect(scrollable.scrollBy).toHaveBeenCalledWith({ top: 120, behavior: "smooth" });
  });

  it("releases idle timers when the scroll container is replaced", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(fakeTimers());
    const first = env.createScrollable(1000);
    const second = env.createScrollable(2000);
    await act(() => screen.rerender(<OverlayScrollbar scrollable={first} autoHide />));
    await act(() => first.dispatchEvent(new Event("scroll")));
    await act(() => screen.rerender(<OverlayScrollbar scrollable={second} autoHide />));
    await act(() => first.dispatchEvent(new Event("scroll")));
    expect(
      container.querySelector("[role='scrollbar'] > div")!.classList.contains("opacity-0"),
    ).toBe(true);
    await act(() => second.dispatchEvent(new Event("scroll")));
    expect(
      container.querySelector("[role='scrollbar'] > div")!.classList.contains("opacity-100"),
    ).toBe(true);
  });
  it("renders a thumb once the lane has been measured", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} />);
    });
    // The lane must exist even before geometry resolves — it is what the
    // measuring effect reads its height from.
    const lane = container.querySelector("[role='scrollbar']");
    expect(lane).not.toBeNull();
    expect(lane?.getAttribute("aria-valuemax")).toBe("600");
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    expect(thumb).not.toBeNull();
  });

  it("positions the thumb proportionally to the scroll offset", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} />);
    });
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    // Track 400, thumb 160 (40% of 400) leaves 240px of travel. Halfway down a
    // 600px scroll range puts the thumb at 120px.
    scrollable.scrollTop = 300;
    await act(() => {
      scrollable.dispatchEvent(new Event("scroll"));
    });
    expect(thumb?.style.height).toBe("160px");
    expect(Number.parseFloat(thumb?.style.transform.replace("translateY(", "") ?? "0")).toBeCloseTo(
      120,
      0,
    );
  });

  it("renders nothing to grab when the content fits", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(400);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} />);
    });
    // Lane still mounts so it can be measured, but there is no thumb to drag.
    expect(container.querySelector(".rounded-\\[3px\\]")).toBeNull();
  });

  it("renders one up and one down triangle when asked", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} triangles />);
    });
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Scroll up", "Scroll down"]);
  });

  it("stays hit-testable while faded out so a hover can reach it", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} visible={false} />);
    });
    const lane = container.querySelector("[role='scrollbar']");
    // The lane must stay fully opaque and hit-testable. Fading the lane
    // multiplied its children's opacity down, so a host-controlled bar could
    // never be revealed by hovering it.
    expect(lane?.className).not.toContain("opacity-0");
    expect(lane?.className).not.toContain("pointer-events-none");
  });

  it("reveals the thumb on hover purely in CSS, with no React state", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} visible={false} />);
    });
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    expect(thumb?.className).toContain("opacity-0");
    // Hover is a `group-hover` rule rather than a state flip. Routing it
    // through state re-rendered on every pointer crossing and restarted the
    // opacity transition, which read as the bar jumping.
    expect(thumb?.className).toContain("group-hover/overlay-scrollbar:opacity-100");
  });

  it("never fades the lane itself, only its contents", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} visible={false} />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    // The regression: an opacity-0 lane multiplies its children's opacity
    // down, so a host-controlled bar could never be revealed by hovering it.
    expect(lane?.className).not.toContain("opacity-0");
    expect(thumb?.className).toContain("opacity-0");
  });

  it("stops dragging the list once the pointer is released", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(10_000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} />);
    });
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    // jsdom has no pointer capture, so stand it in with a version that throws
    // the way a browser does once the pointer id is no longer active. If the
    // teardown let that exception escape, the pointermove handler would survive
    // and every later hover would drag the list to the cursor.
    const release = vi
      .fn(() => {
        throw new DOMException("no active pointer", "NotFoundError");
      })
      .mockName("releasePointerCapture");
    // jsdom implements neither capture method, so they are defined directly
    // rather than spied on.
    Object.defineProperty(thumb!, "setPointerCapture", { value: () => {}, configurable: true });
    Object.defineProperty(thumb!, "releasePointerCapture", {
      value: release,
      configurable: true,
    });

    await act(() => {
      scrollable.scrollTop = 240;
      thumb?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientY: 40,
        }),
      );
    });
    await act(() => {
      thumb?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });

    const before = scrollable.scrollTop;
    await act(() => {
      thumb?.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 200 }),
      );
    });
    // A leaked handler maps clientY 200 onto a very different offset. Starting
    // from a non-zero scrollTop keeps a coincidental match from hiding a leak.
    expect(scrollable.scrollTop).toBe(before);
    delete (thumb as unknown as Record<string, unknown>).releasePointerCapture;
  });

  it.each(["blur", "lostpointercapture", "replace"])(
    "keeps a grabbed compact thumb visible and stops dragging on %s",
    async (reason) => {
      await using env = await setup();
      const { screen, container } = env;
      env.use(fakeTimers());
      const scrollable = env.createScrollable(1000);
      await act(() => screen.rerender(<OverlayScrollbar scrollable={scrollable} autoHide />));
      const thumb = container.querySelector<HTMLElement>("[role='scrollbar'] > div")!;
      thumb.setPointerCapture = () => {};
      thumb.releasePointerCapture = () => {};
      await act(() =>
        thumb.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
        ),
      );
      await act(() => vi.advanceTimersByTime(900));
      expect(thumb.classList.contains("opacity-100")).toBe(true);
      if (reason === "replace") {
        await act(() =>
          screen.rerender(<OverlayScrollbar scrollable={env.createScrollable(2000)} autoHide />),
        );
      } else {
        await act(() => (reason === "blur" ? window : thumb).dispatchEvent(new Event(reason)));
      }
      scrollable.scrollTop = 123;
      await act(() =>
        thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 300 })),
      );
      expect(scrollable.scrollTop).toBe(123);
      expect(
        container.querySelector("[role='scrollbar'] > div")!.classList.contains("opacity-0"),
      ).toBe(true);
    },
  );

  it("coasts at a steady rate while a triangle is held", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(fakeTimers());
    const scrollable = env.createScrollable(10_000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} triangles onStep={() => {}} />);
    });
    const down = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Scroll down",
    );
    await act(() => {
      down?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    // Still within the grace period: a plain click has not started coasting.
    expect(scrollable.scrollTop).toBe(0);
    await act(() => {
      vi.advanceTimersByTime(200);
    });
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollable.scrollTop).toBeGreaterThan(0);
  });

  it.each([
    { label: "Scroll up", initialOffset: 600, direction: -1 },
    { label: "Scroll down", initialOffset: 0, direction: 1 },
  ])(
    "starts holding $label at the boundary even with an earlier first frame",
    async ({ label, initialOffset, direction }) => {
      await using env = await setup();
      const { screen, container } = env;
      env.use(fakeTimers());
      env.use(vi.spyOn(performance, "now").mockReturnValue(200));
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      env.use(
        vi
          .spyOn(globalThis, "requestAnimationFrame")
          .mockImplementation((callback: FrameRequestCallback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
          }),
      );
      env.use(
        vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id: number) => {
          frames.delete(id);
        }),
      );
      const advanceFrame = async (time: number) => {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(time)));
      };
      const scrollable = env.createScrollable(1000);
      let offset = initialOffset;
      Object.defineProperty(scrollable, "scrollTop", {
        get: () => offset,
        set: (value: number) => {
          offset = Math.max(0, Math.min(value, 600));
        },
      });
      const onStep = vi.fn();
      await act(() =>
        screen.rerender(<OverlayScrollbar scrollable={scrollable} triangles onStep={onStep} />),
      );
      await advanceFrame(100);
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      await act(() => {
        button.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
        );
        vi.advanceTimersByTime(180);
      });
      // RAF timestamps describe the frame start, which can precede the timer callback.
      await advanceFrame(199);
      await advanceFrame(215);
      expect((offset - initialOffset) * direction).toBeGreaterThan(0);
      const beforeRelease = offset;
      await act(() => {
        button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
        button.click();
      });
      await advanceFrame(231);
      expect(offset).toBe(beforeRelease);
      expect(onStep).not.toHaveBeenCalled();
    },
  );

  it("cancels a pending hold when the scroll container changes", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(fakeTimers());
    const previous = env.createScrollable(1000);
    const current = env.createScrollable(1000);
    await act(() => screen.rerender(<OverlayScrollbar scrollable={previous} triangles />));
    await act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Scroll down"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    });
    await act(() => screen.rerender(<OverlayScrollbar scrollable={current} triangles />));
    await act(() => vi.advanceTimersByTime(400));
    expect(previous.scrollTop).toBe(0);
    expect(current.scrollTop).toBe(0);
  });

  it("releases the host's pinned scroll before a hold moves away from the end", async () => {
    await using env = await setup();
    const { screen, container } = env;
    env.use(fakeTimers());
    const scrollable = env.createScrollable(1000);
    let pinned = true;
    let offset = 600;
    Object.defineProperty(scrollable, "scrollTop", {
      get: () => offset,
      set: (value: number) => {
        if (!pinned) offset = Math.max(0, Math.min(value, 600));
      },
    });
    await act(() =>
      screen.rerender(
        <OverlayScrollbar
          scrollable={scrollable}
          triangles
          onScrollStart={() => {
            pinned = false;
          }}
        />,
      ),
    );
    await act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Scroll up"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
      vi.advanceTimersByTime(300);
    });
    expect(offset).toBeLessThan(600);
    const beforeBlur = offset;
    await act(() => window.dispatchEvent(new Event("blur")));
    await act(() => vi.advanceTimersByTime(300));
    expect(offset).toBe(beforeBlur);
  });

  it("narrows the thumb when a width is given", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} width="4px" />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.style.getPropertyValue("--app-scrollbar-thumb-width")).toBe("4px");
  });

  it("defaults the thumb width to the shared scrollbar token", async () => {
    await using env = await setup();
    const { screen, container } = env;
    const scrollable = env.createScrollable(1000);
    await act(() => {
      screen.rerender(<OverlayScrollbar scrollable={scrollable} />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.style.getPropertyValue("--app-scrollbar-thumb-width")).toBe(
      "var(--app-scrollbar-width)",
    );
  });
});
