import { act, render as renderScreen, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  class TestHighlight extends Set<AbstractRange> {}
  let page: HTMLDivElement;
  let now: number;
  let frames: Map<number, FrameRequestCallback>;
  const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

  stack.defer(() => {
    page.remove();
    vi.restoreAllMocks();
    if (originalBounds)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  now = 0;
  frames = new Map();
  let next = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  resources.use(
    stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++next, callback);
      return next;
    }),
  );
  resources.use(stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id)));
  resources.use(stubGlobal("Highlight", TestHighlight));
  resources.use(stubGlobal("CSS", Object.create(CSS, { highlights: { value: new Map() } })));
  resources.use(
    stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return this.toString().trim() ? new DOMRect(0, 4, 200, 12) : new DOMRect();
    },
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      const rect = this.getBoundingClientRect();
      return rect.height ? [rect] : [];
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const explicit = Number.parseFloat(this.style.height);
    return new DOMRect(
      0,
      0,
      300,
      this.hasAttribute("data-smooth-text-frame") && Number.isFinite(explicit)
        ? explicit
        : this.textContent
          ? 20
          : 0,
    );
  });
  page = document.createElement("div");
  document.body.append(page);

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
  const screen = stack.use(await renderScreen(null, { container: page, router: false }));
  const owned = stack.move();
  return {
    TestHighlight,
    page,
    frames,
    originalBounds,
    originalRects,
    screen,
    get now() {
      return now;
    },
    set now(value: typeof now) {
      now = value;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
describe("ChatMarkdown yield duration", () => {
  it.each([undefined, 80, 1000])(
    "opens real body space with the %s ms duration independently of glyph fade",
    async (duration) => {
      await using fixture = await setup();
      const { page, frames, screen } = fixture;
      await act(() =>
        screen.rerender(
          <ChatMarkdown
            text="BODY"
            cwd={undefined}
            isStreaming
            smoothStreaming
            smoothTextYieldDurationMs={duration}
            smoothTextFadeDurationMs={500}
            claimInitialSmoothText={() => true}
          />,
        ),
      );
      const frame = page.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const samples = new Map<number, number>();
      const milliseconds = duration ?? 200;
      for (fixture.now = 0; fixture.now <= milliseconds; fixture.now++) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(fixture.now)));
        samples.set(fixture.now, Number.parseFloat(frame.style.height));
      }
      expect(samples.get(milliseconds / 4)).toBeCloseTo(2.5832386, 5);
      expect(samples.get(milliseconds / 2)).toBeCloseTo(10, 7);
      expect(samples.get(milliseconds)).toBe(20);
      const fading = [...CSS.highlights.entries()].filter(
        ([name]) => name.startsWith("t3-smooth-fade") && CSS.highlights.get(name)!.size > 0,
      );
      expect(fading.length).toBeGreaterThan(0);
    },
  );
});
