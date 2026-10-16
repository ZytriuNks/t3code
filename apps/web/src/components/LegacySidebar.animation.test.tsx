// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mutationTargets = new Set<Element>();
const resizeTargets = new Set<Element>();
const intersectionTargets = new Set<Element>();

// Keep the real animation controller; only replace unavailable browser observer APIs.
function observer(targets: Set<Element>) {
  return class {
    private observed = new Set<Element>();
    observe(node: Element) {
      this.observed.add(node);
      targets.add(node);
    }
    unobserve(node: Element) {
      this.observed.delete(node);
      targets.delete(node);
    }
    disconnect() {
      this.observed.forEach((node) => targets.delete(node));
      this.observed.clear();
    }
  };
}

let root: Root | null;
let container: HTMLDivElement;
let reducedMotion: boolean;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.75);
  mutationTargets.clear();
  resizeTargets.clear();
  intersectionTargets.clear();
  reducedMotion = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MutationObserver", observer(mutationTargets));
  vi.stubGlobal("ResizeObserver", observer(resizeTargets));
  vi.stubGlobal("IntersectionObserver", observer(intersectionTargets));
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function unmountAndDrain() {
  await act(() => root!.unmount());
  root = null;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(mutationTargets.size).toBe(0);
  expect([...resizeTargets].filter((node) => node !== document.documentElement)).toEqual([]);
  expect(intersectionTargets.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

async function animatedList() {
  const { useLegacySidebarListAnimation } = await import("./LegacySidebar.animation");
  return function AnimatedList(props: { children?: ReactNode }) {
    const ref = useLegacySidebarListAnimation();
    return <div ref={ref}>{props.children}</div>;
  };
}

describe("legacy sidebar animation lifecycle", () => {
  it("cleans up nested lists across repeated collapse and expansion", async () => {
    const AnimatedList = await animatedList();
    function Section() {
      const [expanded, setExpanded] = useState(true);
      return (
        <>
          <button onClick={() => setExpanded((value) => !value)}>Toggle</button>
          <AnimatedList>
            {expanded ? (
              <AnimatedList>
                <AnimatedList />
              </AnimatedList>
            ) : null}
          </AnimatedList>
        </>
      );
    }
    await act(() => root!.render(<Section />));
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(mutationTargets.size).toBe(3);
      await act(() => container.querySelector("button")!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(mutationTargets.size).toBe(1);
      expect([...resizeTargets].every((node) => node.isConnected)).toBe(true);
      expect([...intersectionTargets].every((node) => node.isConnected)).toBe(true);
      await act(() => container.querySelector("button")!.click());
    }
    await unmountAndDrain();
  });

  it("does not recreate observers or polling when unmounted before initialization", async () => {
    const AnimatedList = await animatedList();
    await act(() =>
      root!.render(
        <AnimatedList>
          <li>Thread</li>
        </AnimatedList>,
      ),
    );
    expect(mutationTargets.size).toBe(1);
    await unmountAndDrain();
  });

  it("ignores a queued position check after unmount", async () => {
    const AnimatedList = await animatedList();
    await act(() => root!.render(<AnimatedList />));
    // Polling starts at 1500ms; the first interval queues its low-priority position check at 3500ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await unmountAndDrain();
  });

  it("retains exactly one controller during Strict Mode remounts and releases it on exit", async () => {
    const AnimatedList = await animatedList();
    await act(() =>
      root!.render(
        <StrictMode>
          <AnimatedList />
        </StrictMode>,
      ),
    );
    expect(mutationTargets.size).toBe(1);
    await unmountAndDrain();
  });

  it("does not start animation resources when reduced motion is requested", async () => {
    reducedMotion = true;
    const AnimatedList = await animatedList();
    await act(() => root!.render(<AnimatedList />));
    expect(mutationTargets.size).toBe(0);
    await unmountAndDrain();
  });
});
