import { act, fakeTimers, render as renderScreen, stubGlobal } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import {
  StreamingMarkdownFootnoteItem,
  StreamingMarkdownFootnotes,
} from "./StreamingMarkdownFootnotes";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  class TestHighlight extends Set<AbstractRange> {}
  let page: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let reduced: boolean;
  const headingHeight = 53.5;
  const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const bounds = (height: number, top = 100) => new DOMRect(0, top, 300, height);
  async function step(ms = 16) {
    now += ms;
    await act(async () => {
      vi.advanceTimersByTime(ms);
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(now);
    });
  }
  async function render({
    blocked = false,
    streaming = true,
    complete = false,
    resumed = false,
    historical = false,
    second = false,
    target = page,
    yieldDurationMs,
  }: {
    blocked?: boolean;
    streaming?: boolean;
    complete?: boolean;
    resumed?: boolean;
    historical?: boolean;
    second?: boolean;
    target?: HTMLDivElement;
    yieldDurationMs?: number | undefined;
  } = {}) {
    await act(() =>
      screen.rerender(
        <StreamingMarkdownFootnotes
          host={target}
          inlineHost={target}
          detached={streaming}
          streaming={streaming}
          smooth
          autoCollapse
          mode="character"
          lineMode="adaptive"
          fadeDurationMs={200}
          yieldDurationMs={yieldDurationMs}
          playbackResume={
            resumed
              ? { key: "heading-resume", baselineText: "Earlier body.", synchronized: true }
              : undefined
          }
          items={[
            { id: "note", text: "Footnote body", complete, blocked, synchronized: historical },
            ...(second ? [{ id: "next-note", text: "Next footnote", complete: false }] : []),
          ]}
        >
          <ol>
            <StreamingMarkdownFootnoteItem id="note">
              <p>Footnote body</p>
            </StreamingMarkdownFootnoteItem>
            {second ? (
              <StreamingMarkdownFootnoteItem id="next-note">
                Next footnote
              </StreamingMarkdownFootnoteItem>
            ) : null}
          </ol>
        </StreamingMarkdownFootnotes>,
      ),
    );
  }
  function occupied(target = page) {
    const widget = target.querySelector<HTMLElement>(".streaming-markdown-footnotes");
    if (!widget || widget.hidden) return 0;
    const heading = target.querySelector<HTMLElement>("[data-smooth-footnote-heading]");
    const body = target.querySelector<HTMLElement>("li > [data-smooth-text-frame]");
    const explicit = Number.parseFloat(heading?.style.height ?? "");
    return (
      (Number.isFinite(explicit) ? explicit : headingHeight) +
      (body?.closest("[hidden]") ? 0 : Number.parseFloat(body?.style.height ?? "") || 0)
    );
  }
  function deferPanelClose() {
    const panel = page.querySelector<HTMLElement>("[data-slot=collapsible-panel]")!;
    const toggle = page.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!;
    panel.style.transitionDuration = "0.2s";
    panel.style.animationName = "none";
    panel.style.animationDuration = "0s";
    Object.defineProperty(panel, "scrollHeight", {
      configurable: true,
      get: () =>
        [...panel.querySelectorAll<HTMLLIElement>("li")].some((item) => !item.hidden) ? 40 : 0,
    });
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const finished = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    let animations: { finished: Promise<void> }[] = [{ finished }];
    let finishReplacement!: () => void;
    const dispatchCancel = () => {
      const event = new Event("transitioncancel", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "height" });
      panel.dispatchEvent(event);
    };
    let registered = false;
    let registerAt = now + 48;
    Object.defineProperty(panel, "getAnimations", {
      configurable: true,
      value: () => {
        if (!panel.hasAttribute("data-ending-style") || now < registerAt) return [];
        registered = true;
        return animations;
      },
    });
    return {
      panel,
      toggle,
      finish: resolve,
      cancel: () => {
        animations = [];
        reject(new DOMException("The transition was canceled", "AbortError"));
        dispatchCancel();
      },
      cancelWithReplacement: () => {
        animations = [
          {
            finished: new Promise<void>((done) => {
              finishReplacement = done;
            }),
          },
        ];
        reject(new DOMException("The transition was canceled", "AbortError"));
        dispatchCancel();
      },
      finishReplacement: () => finishReplacement(),
      registered: () => registered,
      delayRegistration: () => {
        registerAt = now + 48;
      },
    };
  }

  stack.defer(() => {
    page.remove();
    vi.restoreAllMocks();
    if (originalBounds)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  resources.use(fakeTimers());
  frames = new Map();
  now = 0;
  reduced = false;
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
    stubGlobal("matchMedia", (query: string) => ({
      matches: reduced && query.includes("reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  page = document.createElement("div");
  document.body.append(page);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.isConnected || this.closest("[hidden]")) return bounds(0, 0);
    const explicit = Number.parseFloat(this.style.height);
    if (this.hasAttribute("data-smooth-text-frame") && Number.isFinite(explicit))
      return bounds(explicit);
    return this.closest("li") ? bounds(40, 100 + headingHeight) : bounds(headingHeight);
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      if (
        !this.startContainer.isConnected ||
        this.startContainer.parentElement?.closest("[hidden]") ||
        !this.toString().trim()
      )
        return bounds(0, 0);
      return this.startContainer.parentElement?.closest("li")
        ? bounds(14, 100 + headingHeight + 3)
        : bounds(18, 125);
    },
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      const rect = this.getBoundingClientRect();
      return rect.height > 0 ? [rect] : [];
    },
  });

  // 夹具自行推进播放时钟；这里验证独立内容生命周期，不需要路由调度。
  const screen = stack.use(await renderScreen(null, { container: page, router: false }));
  const owned = stack.move();
  return {
    TestHighlight,
    page,
    frames,
    headingHeight,
    originalBounds,
    originalRects,
    bounds,
    step,
    render,
    occupied,
    deferPanelClose,
    screen,
    get now() {
      return now;
    },
    set now(value: typeof now) {
      now = value;
    },
    get reduced() {
      return reduced;
    },
    set reduced(value: typeof reduced) {
      reduced = value;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
it.each([undefined, 80, 1000])(
  "opens heading and body using the shared %s ms yield duration",
  async (yieldDurationMs) => {
    await using fixture = await setup();
    const { page, headingHeight, step, render, occupied } = fixture;
    await render({ yieldDurationMs });
    const duration = yieldDurationMs ?? 200;
    const heights = new Map<number, number>();
    for (let elapsed = 0; elapsed <= duration + 8; elapsed += 2) {
      await step(2);
      heights.set(elapsed + 2, occupied());
    }
    // The first RAF creates the heading's reservation at t=2ms.
    expect(heights.get(duration / 2 + 2)).toBeCloseTo(headingHeight / 2, 5);
    expect(heights.get(duration + 2)).toBeGreaterThanOrEqual(headingHeight);
    const panel = page.querySelector<HTMLElement>('[data-slot="collapsible-panel"]')!;
    expect(panel.style.transitionDuration).toBe(`${duration}ms`);
    expect(panel.style.transitionTimingFunction).toBe("cubic-bezier(0.42, 0, 0.58, 1)");
  },
);
it.each([80, 1000])(
  "opens footnote body space in %s ms after its heading has completed",
  async (yieldDurationMs) => {
    await using fixture = await setup();
    const { page, step, render } = fixture;
    await render({ yieldDurationMs });
    const samples = new Map<number, number>();
    let startedAt: number | null = null;
    for (let elapsed = 0; elapsed <= yieldDurationMs * 2 + 200; elapsed += 2) {
      await step(2);
      const frame = page.querySelector<HTMLElement>("li > [data-smooth-text-frame]")!;
      const height = Number.parseFloat(frame.style.height) || 0;
      samples.set(fixture.now, height);
      if (height > 0.000001) startedAt ??= fixture.now - 2;
    }
    expect(startedAt).not.toBeNull();
    expect(startedAt).toBeGreaterThanOrEqual(yieldDurationMs);
    expect(samples.get(startedAt! + yieldDurationMs / 2)).toBeCloseTo(20, 5);
    expect(samples.get(startedAt! + yieldDurationMs)).toBe(40);
  },
);
it("gives the entire first heading space before exposing the footnote body", async () => {
  await using fixture = await setup();
  const { page, headingHeight, step, render, occupied } = fixture;
  await render();
  expect(occupied()).toBe(0);
  let intermediate = 0;
  let previous = 0;
  let largestHeadingStep = 0;
  for (let index = 0; index < 160; index++) {
    await step();
    const height = occupied();
    if (previous < headingHeight)
      largestHeadingStep = Math.max(largestHeadingStep, height - previous);
    if (height > 0 && height < headingHeight) intermediate++;
    if (!page.querySelector<HTMLLIElement>("li")!.hidden)
      expect(height).toBeGreaterThanOrEqual(headingHeight);
    previous = height;
  }
  expect(intermediate).toBeGreaterThan(4);
  expect(largestHeadingStep).toBeLessThan(headingHeight / 4);
  expect(page.querySelector<HTMLLIElement>("li")!.hidden).toBe(false);
});
it("occupies no heading space while an earlier reference blocks admission", async () => {
  await using fixture = await setup();
  const { headingHeight, step, render, occupied } = fixture;
  await render({ blocked: true });
  for (let index = 0; index < 80; index++) await step();
  expect(occupied()).toBe(0);
  await render();
  expect(occupied()).toBe(0);
  for (let index = 0; index < 160; index++) await step();
  expect(occupied()).toBeGreaterThanOrEqual(headingHeight);
});
it("reserves a new heading after synchronized body history only when its handoff is ready", async () => {
  await using fixture = await setup();
  const { page, headingHeight, step, render, occupied } = fixture;
  await render({ blocked: true, resumed: true });
  for (let index = 0; index < 80; index++) await step();
  expect(occupied()).toBe(0);
  await render({ resumed: true });
  expect(occupied()).toBe(0);
  const heights: number[] = [];
  for (let index = 0; index < 160; index++) {
    await step();
    heights.push(occupied());
    if (!page.querySelector<HTMLLIElement>("li")!.hidden)
      expect(occupied()).toBeGreaterThanOrEqual(headingHeight);
  }
  expect(heights.filter((height) => height > 0 && height < headingHeight).length).toBeGreaterThan(
    4,
  );
  expect(
    Math.max(
      ...heights.map((height, index) =>
        (heights[index - 1] ?? 0) < headingHeight ? height - (heights[index - 1] ?? 0) : 0,
      ),
    ),
  ).toBeLessThan(headingHeight / 4);
  expect(page.querySelector<HTMLLIElement>("li")!.hidden).toBe(false);
});
it("starts a delayed portal's heading from zero when its host connects", async () => {
  await using fixture = await setup();
  const { headingHeight, step, render, occupied } = fixture;
  const target = document.createElement("div");
  try {
    await render({ target });
    const widget = target.querySelector("[data-stream-footnotes]");
    const heading = target.querySelector("[data-smooth-footnote-heading]");
    for (let index = 0; index < 20; index++) await step();
    expect(occupied(target)).toBe(0);
    document.body.append(target);
    const heights = [occupied(target)];
    for (let index = 0; index < 160; index++) {
      await step();
      heights.push(occupied(target));
    }
    expect(heights[0]).toBe(0);
    expect(heights.filter((height) => height > 0 && height < headingHeight).length).toBeGreaterThan(
      4,
    );
    expect(target.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(target.querySelector("[data-smooth-footnote-heading]")).toBe(heading);
    expect(target.querySelector<HTMLLIElement>("li")!.hidden).toBe(false);
  } finally {
    target.remove();
  }
});
it("keeps an existing historical heading immediate and does not replay it on a later commit", async () => {
  await using fixture = await setup();
  const { page, headingHeight, step, render, occupied } = fixture;
  await render({ resumed: true, historical: true, complete: true });
  expect(occupied()).toBe(headingHeight);
  const heading = page.querySelector("[data-smooth-footnote-heading]");
  for (let index = 0; index < 80; index++) await step();
  await render({ resumed: true, historical: true });
  expect(page.querySelector("[data-smooth-footnote-heading]")).toBe(heading);
  expect(occupied()).toBe(headingHeight);
});
it.each(["history", "reduced"])("does not delay %s headings", async (mode) => {
  await using fixture = await setup();
  const { headingHeight, render, occupied } = fixture;
  fixture.reduced = mode === "reduced";
  await render({ streaming: mode !== "history" });
  expect(occupied()).toBeGreaterThanOrEqual(headingHeight);
});
it("does not animate a new heading after synchronized body history with reduced motion", async () => {
  await using fixture = await setup();
  const { headingHeight, step, render, occupied } = fixture;
  fixture.reduced = true;
  await render({ resumed: true });
  expect(occupied()).toBeGreaterThanOrEqual(headingHeight);
  const height = occupied();
  for (let index = 0; index < 40; index++) {
    await step();
    expect(occupied()).toBe(height);
  }
});
it("does not leave panel padding visible after the group closes", async () => {
  await using fixture = await setup();
  const { page, step, render } = fixture;
  await render({ complete: true });
  for (let index = 0; index < 220; index++) await step();
  expect(
    page.querySelector("[data-stream-footnotes]")?.getAttribute("data-markdown-details-open"),
  ).toBe("false");
  expect(page.querySelector<HTMLElement>("[data-slot=collapsible-panel]")?.hidden).toBe(true);
});
it.each(["manual", "automatic"])(
  "keeps outgoing content until Base UI finishes a delayed %s close",
  async (source) => {
    await using fixture = await setup();
    const { page, step, render, deferPanelClose } = fixture;
    await render();
    for (let index = 0; index < 160; index++) await step();
    const item = page.querySelector<HTMLLIElement>("li")!;
    const close = deferPanelClose();
    if (source === "manual") await act(() => close.toggle.click());
    else {
      await render({ complete: true });
      // 真正完成后立即收起；不额外推进旧阅读等待。
      close.delayRegistration();
    }
    for (let index = 0; index < 8; index++) {
      await step();
      expect(close.panel.hidden).toBe(false);
      expect(item.hidden).toBe(false);
      expect(item.querySelector("p")?.textContent).toBe("Footnote body");
    }
    expect(close.registered()).toBe(true);
    await act(async () => close.finish());
    expect(close.panel.hidden).toBe(true);
    expect(item.hidden).toBe(true);
  },
);
it("keeps a newly queued note hidden until the outgoing delayed close finishes", async () => {
  await using fixture = await setup();
  const { page, step, render, deferPanelClose } = fixture;
  await render();
  for (let index = 0; index < 160; index++) await step();
  const first = page.querySelector<HTMLLIElement>("li")!;
  const close = deferPanelClose();
  await act(() => close.toggle.click());
  await render({ second: true });
  const second = page.querySelectorAll<HTMLLIElement>("li")[1]!;
  for (let index = 0; index < 8; index++) {
    await step();
    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(true);
    expect(close.panel.hidden).toBe(false);
  }
  await act(async () => close.finish());
  expect(first.hidden).toBe(true);
  expect(second.hidden).toBe(false);
  expect(page.querySelectorAll("li")[0]).toBe(first);
  expect(page.querySelectorAll("li")[1]).toBe(second);
});
it("ignores completion of a close interrupted by an immediate manual reopen", async () => {
  await using fixture = await setup();
  const { page, step, render, deferPanelClose } = fixture;
  await render();
  for (let index = 0; index < 160; index++) await step();
  const item = page.querySelector<HTMLLIElement>("li")!;
  const close = deferPanelClose();
  await act(() => close.toggle.click());
  await step();
  await act(() => close.toggle.click());
  await act(async () => close.finish());
  for (let index = 0; index < 10; index++) {
    await step();
    expect(close.panel.hidden).toBe(false);
    expect(item.hidden).toBe(false);
  }
  expect(page.querySelector("li")).toBe(item);
});
it.each(["manual", "automatic"])(
  "finishes a canceled %s close with no replacement so the next queued note can play",
  async (source) => {
    await using fixture = await setup();
    const { page, step, render, deferPanelClose } = fixture;
    await render();
    for (let index = 0; index < 160; index++) await step();
    const first = page.querySelector<HTMLLIElement>("li")!;
    const close = deferPanelClose();
    if (source === "manual") await act(() => close.toggle.click());
    else {
      await render({ complete: true });
      close.delayRegistration();
    }
    for (let index = 0; index < 8 && !close.registered(); index++) await step();
    expect(close.registered()).toBe(true);
    expect(first.hidden).toBe(false);

    await render({ second: true });
    close.cancel();
    for (let index = 0; index < 20; index++) await step();

    const second = page.querySelectorAll<HTMLLIElement>("li")[1]!;
    expect(close.panel.hidden).toBe(false);
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    expect(
      page
        .querySelector("[data-markdown-details-open]")
        ?.getAttribute("data-markdown-details-open"),
    ).toBe("true");
  },
);
it.each([0, 1, 2, 8])(
  "retains canceled-close completion when a note arrives after %s animation frames",
  async (arrivalFrames) => {
    await using fixture = await setup();
    const { page, step, render, deferPanelClose } = fixture;
    await render();
    for (let index = 0; index < 160; index++) await step();
    const first = page.querySelector<HTMLLIElement>("li")!;
    const close = deferPanelClose();
    await act(() => close.toggle.click());
    for (let index = 0; index < 8 && !close.registered(); index++) await step();
    expect(close.registered()).toBe(true);
    expect(first.hidden).toBe(false);

    await act(async () => close.cancel());
    for (let index = 0; index < arrivalFrames; index++) await step();
    await render({ second: true });
    for (let index = 0; index < 20; index++) await step();

    const second = page.querySelectorAll<HTMLLIElement>("li")[1]!;
    expect(page.querySelector("li")).toBe(first);
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    expect(
      page
        .querySelector("[data-markdown-details-open]")
        ?.getAttribute("data-markdown-details-open"),
    ).toBe("true");
  },
);
it("keeps a canceled close pending while a replacement animation is active", async () => {
  await using fixture = await setup();
  const { page, step, render, deferPanelClose } = fixture;
  await render();
  for (let index = 0; index < 160; index++) await step();
  const item = page.querySelector<HTMLLIElement>("li")!;
  const close = deferPanelClose();
  await act(() => close.toggle.click());
  for (let index = 0; index < 8 && !close.registered(); index++) await step();
  expect(close.registered()).toBe(true);

  close.cancelWithReplacement();
  // A replacement/reversing animation is still present when the cancel fallback runs.
  for (let index = 0; index < 8; index++) await step();
  expect(close.panel.hidden).toBe(false);
  expect(item.hidden).toBe(false);
  expect(
    page.querySelector("[data-markdown-details-open]")?.getAttribute("data-markdown-details-open"),
  ).toBe("false");

  await act(() => close.finishReplacement());
  expect(close.panel.hidden).toBe(true);
  expect(item.hidden).toBe(true);
});
it("does not let an old cancellation fallback finish a later close generation", async () => {
  await using fixture = await setup();
  const { page, step, render, deferPanelClose } = fixture;
  await render();
  for (let index = 0; index < 160; index++) await step();
  const item = page.querySelector<HTMLLIElement>("li")!;
  const firstClose = deferPanelClose();
  await act(() => firstClose.toggle.click());
  for (let index = 0; index < 8 && !firstClose.registered(); index++) await step();
  firstClose.cancel();
  await step();

  await act(() => firstClose.toggle.click());
  const nextClose = deferPanelClose();
  await act(() => nextClose.toggle.click());
  for (let index = 0; index < 8 && !nextClose.registered(); index++) await step();
  expect(nextClose.registered()).toBe(true);
  await step();
  expect(
    page.querySelector("[data-markdown-details-open]")?.getAttribute("data-markdown-details-open"),
  ).toBe("false");
  expect(firstClose.panel.hidden).toBe(false);
  expect(item.hidden).toBe(false);

  await act(() => nextClose.finish());
  expect(firstClose.panel.hidden).toBe(true);
  expect(item.hidden).toBe(true);
});
it("closes without waiting for an animation when reduced motion is active", async () => {
  await using fixture = await setup();
  const { page, step, render } = fixture;
  await render();
  for (let index = 0; index < 160; index++) await step();
  fixture.reduced = true;
  const panel = page.querySelector<HTMLElement>("[data-slot=collapsible-panel]")!;
  const toggle = page.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!;
  await act(() => toggle.click());
  for (let index = 0; index < 8; index++) await step();
  expect(panel.hidden).toBe(true);
  expect(page.querySelector<HTMLLIElement>("li")!.hidden).toBe(true);
});
