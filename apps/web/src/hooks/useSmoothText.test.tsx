// @vitest-environment jsdom
import { act, Fragment, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readSmoothTextEnd } from "../lib/smoothTextLayout";
import { useSmoothText } from "./useSmoothText";

const HIGHLIGHT_NAME = "t3-smooth-hidden";

class MockHighlight extends Set<Range> {}

class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  readonly observe = vi.fn<(target: Element) => void>();
  readonly unobserve = vi.fn<(target: Element) => void>();
  readonly disconnect = vi.fn<() => void>();
  readonly takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => []);
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  trigger(isIntersecting: boolean) {
    this.callback(
      [
        {
          isIntersecting,
          target: this.observe.mock.calls.at(-1)?.[0] ?? document.body,
        } as IntersectionObserverEntry,
      ],
      this,
    );
  }
}

type MockMediaQuery = {
  matches: boolean;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  setMatches: (matches: boolean) => void;
};

let root: Root | null = null;
let container: HTMLDivElement;
let highlights: Map<string, MockHighlight>;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let mediaQueries: Map<string, MockMediaQuery>;
let documentHidden: boolean;
let originalMatchMedia: PropertyDescriptor | undefined;
let originalRangeGetBoundingClientRect: PropertyDescriptor | undefined;
let renders: Map<string, number>;

function getMediaQuery(query: string) {
  let media = mediaQueries.get(query);
  if (!media) {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    media = {
      matches: false,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      setMatches(matches) {
        this.matches = matches;
        const event = new Event("change");
        for (const listener of listeners) {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      },
    };
    mediaQueries.set(query, media);
  }
  return media;
}

function Probe({
  id = "message",
  text,
  enabled = true,
  streaming = true,
  codeBlock = false,
  frame = false,
  markdownParagraph = false,
  onCopy,
  onSettled,
}: {
  id?: string;
  text: string;
  enabled?: boolean;
  streaming?: boolean;
  codeBlock?: boolean;
  frame?: boolean;
  markdownParagraph?: boolean;
  onCopy?: (text: string) => void;
  onSettled?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  renders.set(id, (renders.get(id) ?? 0) + 1);
  useSmoothText(ref, { enabled, streaming, onSettled });

  const content = (
    <div ref={ref} data-probe={id}>
      {markdownParagraph ? (
        text.split("\n").map((paragraph, index) => (
          <Fragment key={paragraph}>
            <p data-paragraph-index={index}>{paragraph}</p>
            {"\n"}
          </Fragment>
        ))
      ) : codeBlock ? (
        <div className="chat-markdown-codeblock">
          <div className="chat-markdown-codeblock-header">TypeScript</div>
          <button
            type="button"
            onClick={(event) =>
              onCopy?.(event.currentTarget.parentElement?.querySelector("code")?.textContent ?? "")
            }
          >
            Copy code
          </button>
          <pre>
            <code>{text}</code>
          </pre>
        </div>
      ) : (
        text
      )}
    </div>
  );
  return frame ? <div data-smooth-text-frame="">{content}</div> : content;
}

function hiddenHighlight() {
  return highlights.get(HIGHLIGHT_NAME);
}

function fadeRanges() {
  return [...highlights.entries()]
    .filter(([name]) => name.startsWith("t3-smooth-fade-"))
    .flatMap(([, highlight]) => [...highlight]);
}

function mockLineAwareRanges(lineHeight = 20) {
  const getBoundingClientRect = Range.prototype.getBoundingClientRect;
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    const root = this.startContainer.parentElement?.closest<HTMLElement>("[data-probe]");
    if (!root) return getBoundingClientRect.call(this);
    const endOffset = this.endContainer === this.startContainer ? this.endOffset : 0;
    const prefix = root.textContent?.slice(0, endOffset) ?? "";
    const line = (prefix.match(/\n/g)?.length ?? 0) + 1;
    return { bottom: line * lineHeight, height: this.toString().length > 0 ? 10 : 0 } as DOMRect;
  });
}

async function render(element: ReactNode) {
  await act(async () => {
    root?.render(element);
  });
  await flushMutations();
}

async function flushMutations() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushFrames(maxFrames = 120) {
  let now = performance.now();
  for (let index = 0; index < maxFrames; index += 1) {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) return;
    frames.delete(next[0]);
    now += 50;
    await act(async () => next[1](now));
    await flushMutations();
  }
  expect(frames.size).toBe(0);
}

function setDocumentHidden(hidden: boolean) {
  documentHidden = hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Highlight", MockHighlight);
  highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  frames = new Map();
  nextFrameId = 0;
  mediaQueries = new Map();
  renders = new Map();
  MockIntersectionObserver.instances = [];
  documentHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => documentHidden,
  });
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => getMediaQuery(query) as unknown as MediaQueryList),
  });
  originalRangeGetBoundingClientRect = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      const visibleText = this.toString().trim().length > 0;
      const inParagraph = Boolean(this.startContainer.parentElement?.closest("p"));
      const paragraphIndex = Number(
        this.startContainer.parentElement?.closest("p")?.getAttribute("data-paragraph-index") ?? 0,
      );
      return {
        bottom: inParagraph ? 30 + paragraphIndex * 30 + this.endOffset : this.endOffset,
        height: visibleText ? 10 : 0,
      } as DOMRect;
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container.remove();
  Reflect.deleteProperty(document, "hidden");
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  if (originalRangeGetBoundingClientRect) {
    Object.defineProperty(
      Range.prototype,
      "getBoundingClientRect",
      originalRangeGetBoundingClientRect,
    );
  } else {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSmoothText", () => {
  it("shows history immediately and masks appended text without React renders per frame", async () => {
    await render(<Probe text="Existing history." />);
    const message = container.querySelector<HTMLElement>("[data-probe='message']")!;
    expect(message.textContent).toBe("Existing history.");
    expect(hiddenHighlight()).toBeUndefined();

    await render(<Probe text="Existing history. Newly arriving text." />);
    const renderCount = renders.get("message");
    expect(message.textContent).toBe("Existing history. Newly arriving text.");
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(frames.size).toBeGreaterThan(0);

    await flushFrames();
    expect(renders.get("message")).toBe(renderCount);
    expect(message.textContent).toBe("Existing history. Newly arriving text.");
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().map((range) => range.toString())).toEqual([]);
  });

  it("fades only newly revealed ranges across successive appends", async () => {
    const history = "Existing history.";
    await render(<Probe text={history} />);
    expect(fadeRanges()).toHaveLength(0);

    await render(<Probe text={`${history} new`} />);
    const firstFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(firstFrame).toBeDefined();
    frames.delete(firstFrame![0]);
    await act(async () => firstFrame![1](performance.now() + 230));
    await flushMutations();
    const secondFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(secondFrame).toBeDefined();
    frames.delete(secondFrame![0]);
    await act(async () => secondFrame![1](performance.now() + 280));
    await flushMutations();
    const firstFadeRanges = fadeRanges();
    expect(firstFadeRanges.length).toBeGreaterThan(0);
    expect(firstFadeRanges.map((range) => range.toString()).join("")).not.toContain(history);

    await render(<Probe text={`${history} new words`} />);
    const afterAppendRanges = fadeRanges();
    expect(afterAppendRanges).toEqual(expect.arrayContaining(firstFadeRanges));
    expect(afterAppendRanges.map((range) => range.toString()).join("")).not.toContain(history);

    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("starts a new line's fade with its one-line reserve", async () => {
    mockLineAwareRanges();
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.probe === "message") {
        return { height: this.textContent?.includes("\n") ? 40 : 20 } as DOMRect;
      }
      if (this.dataset.smoothTextFrame !== undefined) {
        return { height: Number.parseFloat(this.style.height) || 20 } as DOMRect;
      }
      return getBoundingClientRect.call(this);
    });
    await render(<Probe text="A" frame />);
    const message = container.querySelector<HTMLElement>("[data-probe='message']")!;
    const frame = message.parentElement!;
    const layoutEvents = vi.fn();
    message.addEventListener("t3-smooth-text-layout", layoutEvents);

    await render(<Probe text={"A\nnew line"} frame />);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(fadeRanges().map((range) => range.toString())).toEqual([]);
    expect(frame.style.height).toBe("20px");

    let now = performance.now();
    let newLineFadeQueued = false;
    for (let index = 0; index < 12 && frame.style.height !== "40px"; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      now += 50;
      await act(async () => next![1](now));
      await flushMutations();
      newLineFadeQueued ||= fadeRanges().some((range) => range.toString() === "n");
    }

    expect(frame.style.height).toBe("40px");
    expect(layoutEvents.mock.calls.length).toBeGreaterThan(1);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(newLineFadeQueued).toBe(true);

    for (let index = 0; index < 12 && fadeRanges().length === 0; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      now += 50;
      await act(async () => next![1](now));
      await flushMutations();
    }
    expect(fadeRanges().length).toBeGreaterThan(0);
  });

  it("reserves one queued line at a time even when the provider appends several", async () => {
    mockLineAwareRanges();
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.probe === "message") {
        return { height: 20 + (this.textContent?.match(/\n/g)?.length ?? 0) * 20 } as DOMRect;
      }
      if (this.dataset.smoothTextFrame !== undefined) {
        return { height: Number.parseFloat(this.style.height) || 20 } as DOMRect;
      }
      return getBoundingClientRect.call(this);
    });
    await render(<Probe text="A" frame />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    await render(<Probe text={"A\nB\nC"} frame />);
    expect(frame.style.height).toBe("20px");

    let now = performance.now();
    let firstLineShown = false;
    for (let index = 0; index < 40; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      now += 50;
      await act(async () => next![1](now));
      await flushMutations();
      if (fadeRanges().some((range) => range.toString() === "B")) {
        firstLineShown = true;
        expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(20);
        expect(Number.parseFloat(frame.style.height)).toBeLessThan(60);
        break;
      }
      expect(Number.parseFloat(frame.style.height)).toBeLessThan(60);
    }
    expect(firstLineShown).toBe(true);
    await flushFrames();
    expect(frame.style.height).toBe("60px");
  });

  it("reports completion after the last painted grapheme, exactly once", async () => {
    const onSettled = vi.fn(() => readSmoothTextEnd(container)?.bottom);
    await render(<Probe text="A" onSettled={onSettled} />);
    await render(<Probe text="AB" streaming={false} onSettled={onSettled} />);
    expect(onSettled).not.toHaveBeenCalled();

    let now = performance.now();
    for (let index = 0; index < 20 && !onSettled.mock.calls.length; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      now += 50;
      await act(async () => next![1](now));
      await flushMutations();
    }
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled.mock.results[0]?.value).toBe(2);
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(hiddenHighlight()).toBeUndefined();
    await render(<Probe text="AB" streaming={false} onSettled={onSettled} />);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("reports completion without waiting for the fade or frame-height animation", async () => {
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.probe === "message") {
        return { height: this.textContent?.length === 1 ? 20 : 40 } as DOMRect;
      }
      if (this.dataset.smoothTextFrame !== undefined) {
        return { height: Number.parseFloat(this.style.height) || 20 } as DOMRect;
      }
      return getBoundingClientRect.call(this);
    });
    const onSettled = vi.fn(() => readSmoothTextEnd(container)?.bottom);
    await render(<Probe text="A" frame onSettled={onSettled} />);
    await render(<Probe text="AB" frame streaming={false} onSettled={onSettled} />);

    let now = performance.now();
    for (let index = 0; index < 20 && !onSettled.mock.calls.length; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      now += 50;
      await act(async () => next![1](now));
      await flushMutations();
    }

    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled.mock.results[0]?.value).toBe(2);
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(frames.size).toBeGreaterThan(0);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
  });

  it("keeps text nodes, selection, code headers, and copied code unchanged", async () => {
    const copied = vi.fn();
    const original = "const answer = 1;";
    await render(<Probe text={original} codeBlock onCopy={copied} />);
    const code = container.querySelector("code")!;
    const textNode = code.firstChild as Text;
    const nextText = `${original}\nconsole.log(answer);`;
    await render(<Probe text={nextText} codeBlock onCopy={copied} />);
    expect(code.firstChild).toBe(textNode);
    expect(code.textContent).toBe(nextText);

    const selectionRange = document.createRange();
    selectionRange.setStart(textNode, 0);
    selectionRange.setEnd(textNode, original.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(selectionRange);
    expect(selection.toString()).toBe(original);
    expect([...(hiddenHighlight() ?? [])].every((range) => range.startContainer === textNode)).toBe(
      true,
    );
    expect([...(hiddenHighlight() ?? [])].map((range) => range.toString()).join("")).not.toContain(
      "TypeScript",
    );
    expect([...(hiddenHighlight() ?? [])].map((range) => range.toString()).join("")).not.toContain(
      "Copy code",
    );

    await flushFrames();
    await act(async () => container.querySelector("button")!.click());
    expect(copied).toHaveBeenCalledWith(nextText);
    expect(code.textContent).toBe(nextText);
    expect(selection.toString()).toBe(original);
  });

  it("drains the terminal tail and disconnects its observers and animation frame", async () => {
    const disconnectMutations = vi.spyOn(MutationObserver.prototype, "disconnect");
    await render(<Probe text="A completed response." frame />);
    await render(<Probe text="A completed response. Final words." frame streaming={false} />);
    const observer = MockIntersectionObserver.instances.at(-1)!;
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(frames.size).toBeGreaterThan(0);

    await flushFrames();

    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(disconnectMutations).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-probe]")?.hasAttribute("data-smooth-output")).toBe(false);
    expect(container.querySelector("[data-smooth-text-frame]")).not.toBeNull();
  });

  it("publishes the visible text edge as it advances and retains the final reading edge", async () => {
    const history = "Existing history.";
    const completeText = `${history} Newly arriving text.`;
    await render(<Probe text={history} />);
    const historyMarker = container.querySelector<HTMLElement>("[data-probe='message']")!;
    expect(readSmoothTextEnd(container)).toMatchObject({
      element: historyMarker,
      bottom: history.length,
      hiddenTailHeight: 0,
    });

    await render(<Probe text={completeText} />);
    const firstPublished = readSmoothTextEnd(container)!;
    const firstPublishedEnd = firstPublished.bottom!;
    expect(firstPublishedEnd).toBe(history.length);
    expect(firstPublishedEnd).toBeLessThan(completeText.length);
    expect(firstPublished.hiddenTailHeight).toBeGreaterThan(0);

    let now = performance.now();
    for (let index = 0; index < 6; index += 1) {
      const nextFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(nextFrame).toBeDefined();
      frames.delete(nextFrame![0]);
      now += 50;
      await act(async () => nextFrame![1](now));
      await flushMutations();
    }
    const advanced = readSmoothTextEnd(container)!;
    const advancedEnd = advanced.bottom!;
    expect(advancedEnd).toBeGreaterThan(firstPublishedEnd!);
    expect(advancedEnd).toBeLessThan(completeText.length);
    expect(advanced.hiddenTailHeight).toBeLessThan(firstPublished.hiddenTailHeight);

    await render(<Probe text={completeText} streaming={false} />);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    expect(readSmoothTextEnd(container)).toMatchObject({
      element: historyMarker,
      bottom: completeText.length,
      hiddenTailHeight: 0,
    });
  });

  it("keeps a valid paragraph edge past a trailing newline as its hidden tail drains", async () => {
    const initialText = "Rendered paragraph";
    const completeText = `${initialText}\nwith a hidden tail`;
    await render(<Probe text={initialText} markdownParagraph />);

    const initialEnd = readSmoothTextEnd(container)!;
    expect(container.querySelector("p")?.textContent).toBe(initialText);
    expect(initialEnd).toMatchObject({
      element: container.querySelector<HTMLElement>("[data-probe='message']"),
      bottom: 30 + initialText.length,
      hiddenTailHeight: 0,
    });

    await render(<Probe text={completeText} markdownParagraph />);
    const streamingEnd = readSmoothTextEnd(container)!;
    expect(streamingEnd.bottom).toBe(initialEnd.bottom);
    expect(streamingEnd.bottom).toBeLessThan(30 + 30 + "with a hidden tail".length);
    expect(streamingEnd.hiddenTailHeight).toBeGreaterThan(0);

    let now = performance.now();
    for (let index = 0; index < 6; index += 1) {
      const nextFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(nextFrame).toBeDefined();
      frames.delete(nextFrame![0]);
      now += 50;
      await act(async () => nextFrame![1](now));
      await flushMutations();
    }
    expect(readSmoothTextEnd(container)!.hiddenTailHeight).toBeLessThan(
      streamingEnd.hiddenTailHeight,
    );

    await render(<Probe text={completeText} markdownParagraph streaming={false} />);
    await flushFrames();
    expect(readSmoothTextEnd(container)).toMatchObject({
      element: container.querySelector<HTMLElement>("[data-probe='message']"),
      bottom: 30 + 30 + "with a hidden tail".length,
      hiddenTailHeight: 0,
    });
  });

  it("clears the published text edge when disabled or unmounted", async () => {
    await render(<Probe text="Existing text." />);
    expect(readSmoothTextEnd(container)).toBeDefined();

    await render(<Probe text="Existing text." enabled={false} />);
    expect(readSmoothTextEnd(container)).toBeUndefined();
    expect(container.querySelector("[data-probe]")?.hasAttribute("data-smooth-text-end")).toBe(
      false,
    );

    await render(<Probe text="Existing text." />);
    expect(readSmoothTextEnd(container)).toBeDefined();
    if (root) await act(async () => root?.unmount());
    root = null;
    expect(readSmoothTextEnd(container)).toBeUndefined();
  });

  it("clears masks when disabled or unmounted and can smooth a later append", async () => {
    await render(<Probe text="Earlier text." />);
    await render(<Probe text="Earlier text. First append." />);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    const observer = MockIntersectionObserver.instances.at(-1)!;

    await render(<Probe text="Earlier text. First append." enabled={false} />);
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(observer.disconnect).toHaveBeenCalledOnce();

    await render(<Probe text="Earlier text. First append." />);
    expect(hiddenHighlight()).toBeUndefined();
    await render(<Probe text="Earlier text. First append. Next append." />);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);

    if (root) await act(async () => root?.unmount());
    root = null;
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
  });

  it.each(["reduced motion", "forced colors", "hidden document", "offscreen"] as const)(
    "clears masks for %s and smooths a new append after resume",
    async (reason) => {
      await render(<Probe text="Existing text." />);
      await render(<Probe text="Existing text. Appended text." />);
      expect(hiddenHighlight()?.size).toBeGreaterThan(0);

      if (reason === "reduced motion") {
        getMediaQuery("(prefers-reduced-motion: reduce)").setMatches(true);
      } else if (reason === "forced colors") {
        getMediaQuery("(forced-colors: active)").setMatches(true);
      } else if (reason === "hidden document") {
        setDocumentHidden(true);
      } else {
        MockIntersectionObserver.instances.at(-1)!.trigger(false);
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toHaveLength(0);
      expect(frames.size).toBe(0);

      if (reason === "reduced motion") {
        getMediaQuery("(prefers-reduced-motion: reduce)").setMatches(false);
      } else if (reason === "forced colors") {
        getMediaQuery("(forced-colors: active)").setMatches(false);
      } else if (reason === "hidden document") {
        setDocumentHidden(false);
      } else {
        MockIntersectionObserver.instances.at(-1)!.trigger(true);
      }
      expect(hiddenHighlight()).toBeUndefined();

      await render(<Probe text="Existing text. Appended text. Resumed output." />);
      expect(hiddenHighlight()?.size).toBeGreaterThan(0);
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it("recreates the shared highlight after an idle drain and isolates parallel messages", async () => {
    await render(
      <>
        <Probe key="first" id="first" text="First message." />
      </>,
    );
    await render(
      <>
        <Probe key="first" id="first" text="First message. Finished." streaming={false} />
      </>,
    );
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();

    await render(
      <>
        <Probe key="first" id="first" text="First message. Finished." streaming={false} />
        <Probe key="second" id="second" text="Second message." />
      </>,
    );
    await render(
      <>
        <Probe key="first" id="first" text="First message. Finished." />
        <Probe key="second" id="second" text="Second message." />
      </>,
    );
    await render(
      <>
        <Probe key="first" id="first" text="First message. Finished. New text." />
        <Probe key="second" id="second" text="Second message. New text." />
      </>,
    );
    expect(hiddenHighlight()?.size).toBe(2);

    await render(
      <>
        <Probe key="second" id="second" text="Second message. New text." />
      </>,
    );
    expect(hiddenHighlight()?.size).toBe(1);
    expect(
      [...(hiddenHighlight() ?? [])][0]?.startContainer.parentElement?.closest<HTMLElement>(
        "[data-probe]",
      )?.dataset.probe,
    ).toBe("second");

    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("shows text normally when CSS highlights are unavailable", async () => {
    vi.stubGlobal("CSS", {});
    await render(<Probe text="Existing text." />);
    await render(<Probe text="Existing text. Appended text." />);

    expect(container.querySelector<HTMLElement>("[data-probe]")?.textContent).toBe(
      "Existing text. Appended text.",
    );
    expect(container.querySelector("[data-probe]")?.hasAttribute("data-smooth-output")).toBe(false);
    expect(frames.size).toBe(0);
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });
});
