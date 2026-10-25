import { type ComponentProps } from "react";
import { act, fakeTimers, render as renderScreen, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  resources.use(fakeTimers());
  class TestHighlight extends Set<AbstractRange> {}
  let container: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let reducedMotion: boolean;
  let styles: HTMLStyleElement;
  const surfaceRules = `
  .chat-markdown [data-smooth-surface] { opacity: var(--t3-smooth-surface-opacity, 1); }
  .chat-markdown [data-smooth-inline-pending] { visibility: hidden; pointer-events: none; }
`;
  async function render(text: string, props: Partial<ComponentProps<typeof ChatMarkdown>> = {}) {
    await act(() =>
      screen.rerender(
        <ChatMarkdown
          cwd="C:/workspace"
          text={text}
          smoothStreaming
          isStreaming
          smoothTextFadeDurationMs={500}
          {...props}
        />,
      ),
    );
  }
  async function frame(at: number) {
    now = at;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
  }
  function surfaceFor(icon: Element) {
    const surface = icon.closest<HTMLElement>("[data-smooth-surface]");
    expect(
      surface,
      "the icon must share the hook-owned entry surface with its label",
    ).not.toBeNull();
    return surface!;
  }
  function opacity(surface: HTMLElement) {
    const computed = getComputedStyle(surface);
    // jsdom preserves var() expressions; the browser resolves the same shipped rule.
    return computed.opacity.startsWith("var(")
      ? Number(computed.getPropertyValue("--t3-smooth-surface-opacity") || 1)
      : Number(computed.opacity || 1);
  }
  async function begin(text: string) {
    await render(text, { claimInitialSmoothText: () => true });
  }
  async function enter(surface: HTMLElement) {
    const deadline = now + 80 + (2 * 20) / 0.17045454545454544 + 32;
    while (now < deadline) {
      await frame(now + 16);
      if (opacity(surface) > 0) return now;
    }
    throw new Error("The icon did not enter after its buffer and bounded space pulse");
  }

  stack.defer(() => {
    container.remove();
    styles.remove();
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    vi.restoreAllMocks();
  });

  frames = new Map();
  now = 0;
  reducedMotion = false;
  let id = 0;
  resources.use(stubGlobal("Highlight", TestHighlight));
  resources.use(stubGlobal("CSS", Object.create(CSS, { highlights: { value: new Map() } })));
  resources.use(
    stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    }),
  );
  resources.use(stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id)));
  resources.use(
    stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 200, 20),
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 200, 20)] as unknown as DOMRectList,
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(14, 0, 10, 20),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(14, 0, 10, 20)],
  });
  styles = document.createElement("style");
  styles.textContent = surfaceRules;
  document.head.append(styles);
  container = document.createElement("div");
  document.body.append(container);

  resources.use(
    stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    ),
  );
  // 夹具自行推进播放时钟；这里验证独立内容生命周期，不需要路由调度。
  const screen = stack.use(await renderScreen(null, { container: container, router: false }));
  const owned = stack.move();
  return {
    TestHighlight,
    container,
    frames,
    styles,
    surfaceRules,
    render,
    frame,
    surfaceFor,
    opacity,
    begin,
    enter,
    screen,
    get now() {
      return now;
    },
    set now(value: typeof now) {
      now = value;
    },
    get reducedMotion() {
      return reducedMotion;
    },
    set reducedMotion(value: typeof reducedMotion) {
      reducedMotion = value;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
describe("Markdown link icon entry timing", () => {
  it.each([
    ["plain", "[reference](https://timing-plain.com)"],
    ["formatted", "[**reference**](https://timing-rich.com)"],
    ["URL label", "<https://timing-url.com>"],
    ["brand", "[repository](https://github.com/example/repo)"],
    ["pending destination", "[unfinished"],
    ["file", "[source](./src/main.ts)"],
  ])("hides and fades the %s icon with its parent for 500ms", async (_kind, text) => {
    await using fixture = await setup();
    const { container, frame, surfaceFor, opacity, begin, enter } = fixture;
    await begin(text);
    const icon = container.querySelector("a [aria-hidden=true], button svg")!;
    expect(icon, container.innerHTML).not.toBeNull();
    const surface = surfaceFor(icon);
    expect(getComputedStyle(icon).visibility).toBe("hidden");
    expect(opacity(surface)).toBe(0);
    const enteredAt = await enter(surface);
    const initial = opacity(surface);
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(0.2);
    expect(getComputedStyle(icon).visibility).toBe("visible");
    await frame(enteredAt + 250);
    expect(opacity(surface)).toBeGreaterThan(initial);
    expect(opacity(surface)).toBeLessThan(1);
    await frame(enteredAt + 450);
    expect(opacity(surface)).toBeLessThan(1);
    await frame(enteredAt + 520);
    expect(opacity(surface)).toBe(1);
    expect(surface.hasAttribute("data-smooth-inline-pending")).toBe(false);
  });

  it.each(["load", "error"])(
    "keeps a delayed favicon %s inside its original fade",
    async (event) => {
      await using fixture = await setup();
      const { container, frame, surfaceFor, opacity, begin, enter } = fixture;
      await begin(`[reference](https://timing-${event}.com)`);
      const image = container.querySelector("a img")!;
      const surface = surfaceFor(image);
      await act(() => image.dispatchEvent(new Event(event)));
      expect(surfaceFor(container.querySelector("a svg, a img")!)).toBe(surface);
      expect(getComputedStyle(surface).visibility).toBe("hidden");
      expect(opacity(surface)).toBe(0);
      const enteredAt = await enter(surface);
      await frame(enteredAt + 250);
      expect(opacity(surface)).toBeGreaterThan(0);
      expect(opacity(surface)).toBeLessThan(1);
      await frame(enteredAt + 520);
      expect(opacity(surface)).toBe(1);
    },
  );

  it("does not restart or escape a fade when the favicon loads halfway through", async () => {
    await using fixture = await setup();
    const { container, frame, surfaceFor, opacity, begin, enter } = fixture;
    await begin("[reference](https://timing-midpoint.com)");
    const image = container.querySelector("a img")!;
    const surface = surfaceFor(image);
    const enteredAt = await enter(surface);
    await frame(enteredAt + 250);
    const midpoint = opacity(surface);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(surfaceFor(image)).toBe(surface);
    expect(opacity(surface)).toBe(midpoint);
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(1);
    await frame(enteredAt + 520);
    expect(opacity(surface)).toBe(1);
  });

  it("retains the entry surface when a pending reference resolves during its fade", async () => {
    await using fixture = await setup();
    const { container, render, frame, surfaceFor, opacity, begin, enter } = fixture;

    const source = "[reference][ref]\n\n";
    await begin(source);
    const anchor = container.querySelector("a")!;
    const surface = surfaceFor(anchor.querySelector("[aria-hidden=true]")!);
    const enteredAt = await enter(surface);
    await frame(enteredAt + 250);
    const midpoint = opacity(surface);
    await render(source + "[ref]: https://timing-resolved.com\n");
    await act(() => vi.advanceTimersByTimeAsync(120));
    expect(container.querySelector("a")).toBe(anchor);
    expect(anchor.href).toBe("https://timing-resolved.com/");
    const image = anchor.querySelector("img")!;
    expect(surfaceFor(image)).toBe(surface);
    expect(opacity(surface)).toBe(midpoint);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(opacity(surface)).toBe(midpoint);
    await frame(enteredAt + 520);
    expect(opacity(surface)).toBe(1);
  });

  it("keeps a settled link visible when a favicon finishes much later", async () => {
    await using fixture = await setup();
    const { container, frame, surfaceFor, opacity, begin, enter } = fixture;
    await begin("[reference](https://timing-late.com)");
    const image = container.querySelector("a img")!;
    const surface = surfaceFor(image);
    const enteredAt = await enter(surface);
    await frame(enteredAt + 520);
    await frame(5000);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(surface.contains(image)).toBe(true);
    expect(opacity(surface)).toBe(1);
    expect(image.closest("[data-smooth-inline-pending], [data-smooth-surface]")).toBeNull();
  });

  it.each(["reduced motion", "history", "disabled"])(
    "shows icons normally for %s",
    async (kind) => {
      await using fixture = await setup();
      const { container, render } = fixture;
      fixture.reducedMotion = kind === "reduced motion";
      const props =
        kind === "history"
          ? { isStreaming: false, smoothComplete: true }
          : kind === "disabled"
            ? { smoothStreaming: false }
            : {};
      await render("[reference](https://timing-static.com)", {
        claimInitialSmoothText: () => kind !== "history",
        ...props,
      });
      const icon = container.querySelector("a [aria-hidden=true]")!;
      expect(icon).not.toBeNull();
      expect(getComputedStyle(icon).visibility).toBe("visible");
      expect(icon.closest("[data-smooth-inline-pending], [data-smooth-surface]")).toBeNull();
      const image = container.querySelector("a img")!;
      await act(() => image.dispatchEvent(new Event("load")));
      expect(getComputedStyle(image).visibility).toBe("visible");
      expect(image.closest("[data-smooth-inline-pending], [data-smooth-surface]")).toBeNull();
    },
  );
});
