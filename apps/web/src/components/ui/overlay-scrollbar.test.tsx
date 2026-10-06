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

  it("reports the hovered state through the lane's opacity", () => {
    const scrollable = createScrollable(1000);
    act(() => {
      root.render(<OverlayScrollbar scrollable={scrollable} />);
    });
    const lane = container.querySelector("[role='scrollbar']");
    expect(lane?.className).toContain("opacity-100");
  });
});