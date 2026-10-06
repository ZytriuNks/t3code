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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OverlayScrollbar", () => {
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

  it("flushes the bar against the right edge by default", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.className).toContain("right-0");
    expect(lane?.className).toContain("bottom-px");
    expect(lane?.style.getPropertyValue("--overlay-scrollbar-edge")).toBe("0px");
  });

  it("opens the bottom clearance for surfaces that need it", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} bottomGap="roomy" />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.className).toContain("bottom-2");
    expect(lane?.className).not.toContain("bottom-px");
  });

  it("pushes the bar into a content gutter when asked", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} thumbInset="gutter" />);
    });
    const lane = container.querySelector<HTMLElement>("[role='scrollbar']");
    expect(lane?.style.getPropertyValue("--overlay-scrollbar-edge")).toBe("0.25rem");
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