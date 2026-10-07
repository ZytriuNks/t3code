// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { OverlayScrollbar } from "./overlay-scrollbar";

let root: Root;
let container: HTMLDivElement;

/** A scrollable stand-in. clientHeight comes from the prototype spy in
 * beforeEach, so only the content height needs to vary per test.
 */
function createScrollable(scrollHeight: number) {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight });
  element.scrollTop = 0;
  document.body.append(element);
  return element;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // jsdom performs no layout, so every clientHeight is 0 and the component
  // would never measure a track. Report a fixed height for the lane instead;
  // ResizeObserver is stubbed out for the same reason.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OverlayScrollbar", () => {
  it("drags a horizontal overflow without changing the vertical offset", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const scrollable = createScrollable(1000);
    Object.defineProperty(scrollable, "scrollWidth", { value: 1000 });
    scrollable.style.overflowX = "auto";
    scrollable.scrollLeft = 100;
    scrollable.scrollTop = 80;
    act(() => root.render(<OverlayScrollbar scrollable={scrollable} orientation="horizontal" />));
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
    const thumb = lane.querySelector<HTMLElement>("div")!;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 12));
    vi.spyOn(thumb, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 0, 160, 6));
    thumb.setPointerCapture = () => {};
    thumb.releasePointerCapture = () => {};
    act(() =>
      thumb.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 50 }),
      ),
    );
    act(() => thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 130 })));
    expect(scrollable.scrollLeft).toBe(300);
    expect(scrollable.scrollTop).toBe(80);
    act(() => thumb.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })));
    act(() => thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 200 })));
    expect(scrollable.scrollLeft).toBe(300);
  });

  it("navigates horizontal overflow by keyboard and clamps to its edges", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const scrollable = createScrollable(1000);
    Object.defineProperty(scrollable, "scrollWidth", { value: 1000 });
    scrollable.style.overflowX = "auto";
    scrollable.scrollLeft = 590;
    scrollable.scrollTo = vi.fn();
    act(() => root.render(<OverlayScrollbar scrollable={scrollable} orientation="horizontal" />));
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']")!;
    act(() =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );
    expect(scrollable.scrollTo).toHaveBeenLastCalledWith({ left: 600, behavior: "instant" });
    act(() => lane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })));
    expect(scrollable.scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "instant" });
    act(() =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })),
    );
    expect(scrollable.scrollTo).toHaveBeenCalledTimes(2);
  });

  it.each(["auto", "hidden"])(
    "has no horizontal thumb when overflow is %s and cannot be scrolled",
    (overflow) => {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
      const scrollable = createScrollable(1000);
      Object.defineProperty(scrollable, "scrollWidth", { value: overflow === "auto" ? 400 : 1000 });
      scrollable.style.overflowX = overflow;
      act(() => root.render(<OverlayScrollbar scrollable={scrollable} orientation="horizontal" />));
      expect(container.querySelector("[role='scrollbar'] > div")).toBeNull();
    },
  );

  it("reveals while scrolling and restarts the idle delay on subsequent scrolls", () => {
    vi.useFakeTimers();
    const scrollable = createScrollable(1000);
    act(() => root.render(<OverlayScrollbar scrollable={scrollable} autoHide />));
    const thumb = () => container.querySelector<HTMLElement>("[role='scrollbar'] > div")!;
    expect(thumb().classList.contains("opacity-0")).toBe(true);
    act(() => scrollable.dispatchEvent(new Event("scroll")));
    expect(thumb().classList.contains("opacity-100")).toBe(true);
    act(() => vi.advanceTimersByTime(600));
    act(() => scrollable.dispatchEvent(new Event("scroll")));
    act(() => vi.advanceTimersByTime(600));
    expect(thumb().classList.contains("opacity-100")).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(thumb().classList.contains("opacity-0")).toBe(true);
  });

  it("steps the supplied viewport without requiring a host callback", () => {
    const scrollable = createScrollable(1000);
    scrollable.scrollBy = vi.fn();
    act(() => root.render(<OverlayScrollbar scrollable={scrollable} triangles />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Scroll down"]')!.click());
    expect(scrollable.scrollBy).toHaveBeenCalledWith({ top: 120, behavior: "smooth" });
  });

  it("releases idle timers when the scroll container is replaced", () => {
    vi.useFakeTimers();
    const first = createScrollable(1000);
    const second = createScrollable(2000);
    act(() => root.render(<OverlayScrollbar scrollable={first} autoHide />));
    act(() => first.dispatchEvent(new Event("scroll")));
    act(() => root.render(<OverlayScrollbar scrollable={second} autoHide />));
    act(() => first.dispatchEvent(new Event("scroll")));
    expect(
      container.querySelector("[role='scrollbar'] > div")!.classList.contains("opacity-0"),
    ).toBe(true);
    act(() => second.dispatchEvent(new Event("scroll")));
    expect(
      container.querySelector("[role='scrollbar'] > div")!.classList.contains("opacity-100"),
    ).toBe(true);
  });
  it("renders a thumb once the lane has been measured", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
    });
    // The lane must exist even before geometry resolves — it is what the
    // measuring effect reads its height from.
    const lane = container.querySelector("[role='scrollbar']");
    expect(lane).not.toBeNull();
    expect(lane?.getAttribute("aria-valuemax")).toBe("600");
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    expect(thumb).not.toBeNull();
  });

  it("positions the thumb proportionally to the scroll offset", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
    });
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    // Track 400, thumb 160 (40% of 400) leaves 240px of travel. Halfway down a
    // 600px scroll range puts the thumb at 120px.
    scrollable.scrollTop = 300;
    act(() => {
      scrollable.dispatchEvent(new Event("scroll"));
    });
    expect(thumb?.style.height).toBe("160px");
    expect(Number.parseFloat(thumb?.style.transform.replace("translateY(", "") ?? "0")).toBeCloseTo(
      120,
      0,
    );
  });

  it("renders nothing to grab when the content fits", () => {
    const scrollable = createScrollable(400);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
    });
    // Lane still mounts so it can be measured, but there is no thumb to drag.
    expect(container.querySelector(".rounded-\\[3px\\]")).toBeNull();
  });

  it("renders one up and one down triangle when asked", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} triangles />);
    });
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Scroll up", "Scroll down"]);
  });

  it("stays hit-testable while faded out so a hover can reach it", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} visible={false} />);
    });
    const lane = container.querySelector("[role='scrollbar']");
    // The lane must stay fully opaque and hit-testable. Fading the lane
    // multiplied its children's opacity down, so a host-controlled bar could
    // never be revealed by hovering it.
    expect(lane?.className).not.toContain("opacity-0");
    expect(lane?.className).not.toContain("pointer-events-none");
  });

  it("reveals the thumb on hover purely in CSS, with no React state", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} visible={false} />);
    });
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    expect(thumb?.className).toContain("opacity-0");
    // Hover is a `group-hover` rule rather than a state flip. Routing it
    // through state re-rendered on every pointer crossing and restarted the
    // opacity transition, which read as the bar jumping.
    expect(thumb?.className).toContain("group-hover:opacity-100");
  });

  it("never fades the lane itself, only its contents", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} visible={false} />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    const thumb = container.querySelector<HTMLElement>(".rounded-\\[3px\\]");
    // The regression: an opacity-0 lane multiplies its children's opacity
    // down, so a host-controlled bar could never be revealed by hovering it.
    expect(lane?.className).not.toContain("opacity-0");
    expect(thumb?.className).toContain("opacity-0");
  });

  it("stops dragging the list once the pointer is released", () => {
    const scrollable = createScrollable(10_000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
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

    act(() => {
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
    act(() => {
      thumb?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });

    const before = scrollable.scrollTop;
    act(() => {
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
    (reason) => {
      vi.useFakeTimers();
      const scrollable = createScrollable(1000);
      act(() => root.render(<OverlayScrollbar scrollable={scrollable} autoHide />));
      const thumb = container.querySelector<HTMLElement>("[role='scrollbar'] > div")!;
      thumb.setPointerCapture = () => {};
      thumb.releasePointerCapture = () => {};
      act(() =>
        thumb.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
        ),
      );
      act(() => vi.advanceTimersByTime(900));
      expect(thumb.classList.contains("opacity-100")).toBe(true);
      if (reason === "replace") {
        act(() => root.render(<OverlayScrollbar scrollable={createScrollable(2000)} autoHide />));
      } else {
        act(() => (reason === "blur" ? window : thumb).dispatchEvent(new Event(reason)));
      }
      scrollable.scrollTop = 123;
      act(() =>
        thumb.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 300 })),
      );
      expect(scrollable.scrollTop).toBe(123);
      expect(
        container.querySelector("[role='scrollbar'] > div")!.classList.contains("opacity-0"),
      ).toBe(true);
    },
  );

  it("coasts at a steady rate while a triangle is held", () => {
    vi.useFakeTimers();
    const scrollable = createScrollable(10_000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} triangles onStep={() => {}} />);
    });
    const down = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Scroll down",
    );
    act(() => {
      down?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    // Still within the grace period: a plain click has not started coasting.
    expect(scrollable.scrollTop).toBe(0);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollable.scrollTop).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it.each([
    { label: "Scroll up", initialOffset: 600, direction: -1 },
    { label: "Scroll down", initialOffset: 0, direction: 1 },
  ])(
    "starts holding $label at the boundary even with an earlier first frame",
    ({ label, initialOffset, direction }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(performance, "now").mockReturnValue(200);
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
      const advanceFrame = (time: number) => {
        const callbacks = [...frames.values()];
        frames.clear();
        act(() => callbacks.forEach((callback) => callback(time)));
      };
      const scrollable = createScrollable(1000);
      let offset = initialOffset;
      Object.defineProperty(scrollable, "scrollTop", {
        get: () => offset,
        set: (value: number) => {
          offset = Math.max(0, Math.min(value, 600));
        },
      });
      const onStep = vi.fn();
      act(() =>
        root.render(<OverlayScrollbar scrollable={scrollable} triangles onStep={onStep} />),
      );
      advanceFrame(100);
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      act(() => {
        button.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
        );
        vi.advanceTimersByTime(180);
      });
      // RAF timestamps describe the frame start, which can precede the timer callback.
      advanceFrame(199);
      advanceFrame(215);
      expect((offset - initialOffset) * direction).toBeGreaterThan(0);
      const beforeRelease = offset;
      act(() => {
        button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
        button.click();
      });
      advanceFrame(231);
      expect(offset).toBe(beforeRelease);
      expect(onStep).not.toHaveBeenCalled();
      vi.useRealTimers();
    },
  );

  it("cancels a pending hold when the scroll container changes", () => {
    vi.useFakeTimers();
    const previous = createScrollable(1000);
    const current = createScrollable(1000);
    act(() => root.render(<OverlayScrollbar scrollable={previous} triangles />));
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Scroll down"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    });
    act(() => root.render(<OverlayScrollbar scrollable={current} triangles />));
    act(() => vi.advanceTimersByTime(400));
    expect(previous.scrollTop).toBe(0);
    expect(current.scrollTop).toBe(0);
    vi.useRealTimers();
  });

  it("releases the host's pinned scroll before a hold moves away from the end", () => {
    vi.useFakeTimers();
    const scrollable = createScrollable(1000);
    let pinned = true;
    let offset = 600;
    Object.defineProperty(scrollable, "scrollTop", {
      get: () => offset,
      set: (value: number) => {
        if (!pinned) offset = Math.max(0, Math.min(value, 600));
      },
    });
    act(() =>
      root.render(
        <OverlayScrollbar
          scrollable={scrollable}
          triangles
          onScrollStart={() => {
            pinned = false;
          }}
        />,
      ),
    );
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Scroll up"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
      vi.advanceTimersByTime(300);
    });
    expect(offset).toBeLessThan(600);
    const beforeBlur = offset;
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => vi.advanceTimersByTime(300));
    expect(offset).toBe(beforeBlur);
  });

  it("narrows the thumb when a width is given", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} width="4px" />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.style.getPropertyValue("--app-scrollbar-thumb-width")).toBe("4px");
  });

  it("defaults the thumb width to the shared scrollbar token", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.style.getPropertyValue("--app-scrollbar-thumb-width")).toBe(
      "var(--app-scrollbar-width)",
    );
  });
});
