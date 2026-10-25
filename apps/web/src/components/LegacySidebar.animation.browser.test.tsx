import { StrictMode, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, fakeTimers } from "../../test/render";

async function setup({ reducedMotion = false } = {}) {
  await using stack = new AsyncDisposableStack();
  const mutationTargets = new Set<Element>();
  const resizeTargets = new Set<Element>();
  const intersectionTargets = new Set<Element>();
  const mutations = new Map<MutationObserver, Set<Element>>();
  const resizes = new Map<ResizeObserver, Set<Element>>();
  const intersections = new Map<IntersectionObserver, Set<Element>>();
  stack.use(
    vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (
      this: MutationObserver,
      node,
    ) {
      if (!(node instanceof Element)) return;
      const nodes = mutations.get(this) ?? new Set<Element>();
      mutations.set(this, nodes);
      nodes.add(node);
      mutationTargets.add(node);
    }),
  );
  stack.use(
    vi.spyOn(MutationObserver.prototype, "disconnect").mockImplementation(function (
      this: MutationObserver,
    ) {
      mutations.get(this)?.forEach((node) => mutationTargets.delete(node));
      mutations.delete(this);
    }),
  );
  stack.use(
    vi.spyOn(ResizeObserver.prototype, "observe").mockImplementation(function (
      this: ResizeObserver,
      node,
    ) {
      const nodes = resizes.get(this) ?? new Set<Element>();
      resizes.set(this, nodes);
      nodes.add(node);
      resizeTargets.add(node);
    }),
  );
  stack.use(
    vi.spyOn(ResizeObserver.prototype, "unobserve").mockImplementation(function (
      this: ResizeObserver,
      node,
    ) {
      resizes.get(this)?.delete(node);
      resizeTargets.delete(node);
    }),
  );
  stack.use(
    vi.spyOn(ResizeObserver.prototype, "disconnect").mockImplementation(function (
      this: ResizeObserver,
    ) {
      resizes.get(this)?.forEach((node) => resizeTargets.delete(node));
      resizes.delete(this);
    }),
  );
  stack.use(
    vi.spyOn(IntersectionObserver.prototype, "observe").mockImplementation(function (
      this: IntersectionObserver,
      node,
    ) {
      const nodes = intersections.get(this) ?? new Set<Element>();
      intersections.set(this, nodes);
      nodes.add(node);
      intersectionTargets.add(node);
    }),
  );
  stack.use(
    vi.spyOn(IntersectionObserver.prototype, "unobserve").mockImplementation(function (
      this: IntersectionObserver,
      node,
    ) {
      intersections.get(this)?.delete(node);
      intersectionTargets.delete(node);
    }),
  );
  stack.use(
    vi.spyOn(IntersectionObserver.prototype, "disconnect").mockImplementation(function (
      this: IntersectionObserver,
    ) {
      intersections.get(this)?.forEach((node) => intersectionTargets.delete(node));
      intersections.delete(this);
    }),
  );
  stack.use(vi.spyOn(Math, "random").mockReturnValue(0.75));
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  stack.use(vi.spyOn(media, "matches", "get").mockReturnValue(reducedMotion));
  stack.use(vi.spyOn(globalThis, "matchMedia").mockReturnValue(media));
  // 动画资源的生命周期不依赖路由。
  const screen = stack.use(await render(null, { router: false }));
  stack.use(fakeTimers());
  const { useLegacySidebarListAnimation } = await import("./LegacySidebar.animation");
  function AnimatedList(props: { children?: ReactNode }) {
    const ref = useLegacySidebarListAnimation();
    return <div ref={ref}>{props.children}</div>;
  }
  const unmountAndDrain = async () => {
    await screen.unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(mutationTargets.size).toBe(0);
    expect([...resizeTargets].filter((node) => node !== document.documentElement)).toEqual([]);
    expect(intersectionTargets.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  };
  return Object.assign(stack.move(), {
    screen,
    AnimatedList,
    mutationTargets,
    resizeTargets,
    intersectionTargets,
    unmountAndDrain,
  });
}

describe("legacy sidebar animation lifecycle", () => {
  it("cleans up nested lists across repeated collapse and expansion", async () => {
    await using fixture = await setup();
    const { AnimatedList, screen } = fixture;
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
    await act(() => screen.rerender(<Section />));
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(fixture.mutationTargets.size).toBe(3);
      await act(() => screen.container.querySelector("button")!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(fixture.mutationTargets.size).toBe(1);
      expect([...fixture.resizeTargets].every((node) => node.isConnected)).toBe(true);
      expect([...fixture.intersectionTargets].every((node) => node.isConnected)).toBe(true);
      await act(() => screen.container.querySelector("button")!.click());
    }
    await fixture.unmountAndDrain();
  });

  it("does not recreate observers or polling when unmounted before initialization", async () => {
    await using fixture = await setup();
    const { AnimatedList, screen } = fixture;
    await act(() =>
      screen.rerender(
        <AnimatedList>
          <li>Thread</li>
        </AnimatedList>,
      ),
    );
    expect(fixture.mutationTargets.size).toBe(1);
    await fixture.unmountAndDrain();
  });

  it("ignores a queued position check after unmount", async () => {
    await using fixture = await setup();
    const { AnimatedList, screen } = fixture;
    await act(() => screen.rerender(<AnimatedList />));
    // Polling starts at 1500ms; the first interval queues its low-priority position check at 3500ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await fixture.unmountAndDrain();
  });

  it("retains exactly one controller during Strict Mode remounts and releases it on exit", async () => {
    await using fixture = await setup();
    const { AnimatedList, screen } = fixture;
    await act(() =>
      screen.rerender(
        <StrictMode>
          <AnimatedList />
        </StrictMode>,
      ),
    );
    expect(fixture.mutationTargets.size).toBe(1);
    await fixture.unmountAndDrain();
  });

  it("does not start animation resources when reduced motion is requested", async () => {
    await using fixture = await setup({ reducedMotion: true });
    const { AnimatedList, screen } = fixture;
    await act(() => screen.rerender(<AnimatedList />));
    expect(fixture.mutationTargets.size).toBe(0);
    await fixture.unmountAndDrain();
  });
});
