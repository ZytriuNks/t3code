// @vitest-environment jsdom
import { act, Fragment, StrictMode, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readSmoothTextEnd } from "../lib/smoothTextLayout";
import { SMOOTH_TEXT_FADE_ATTRIBUTE } from "../lib/smoothLineMotion";
import { useSmoothText } from "./useSmoothText";
import { remarkHoldIncompleteInline } from "../markdown-streaming";

const HIGHLIGHT_NAME = "t3-smooth-hidden";

class MockHighlight extends Set<AbstractRange> {}

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
let originalRangeGetClientRects: PropertyDescriptor | undefined;
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
  paused = false,
  streaming = true,
  complete = false,
  codeBlock = false,
  coloredText = false,
  richText,
  mode = "character",
  lineMode = "adaptive",
  codePending = false,
  frame = false,
  markdownParagraph = false,
  markdown = false,
  onCopy,
  onSettled,
  onPlaybackComplete,
  claimInitialText,
  initialBufferMs,
  fadeDurationMs,
  drainOnComplete,
  sourceText = text,
}: {
  id?: string;
  text: string;
  enabled?: boolean;
  paused?: boolean;
  streaming?: boolean;
  complete?: boolean;
  codeBlock?: boolean;
  coloredText?: boolean;
  richText?: ReactNode;
  mode?: "character" | "token" | "auto";
  lineMode?: "adaptive" | "parallel";
  codePending?: boolean;
  frame?: boolean;
  markdownParagraph?: boolean;
  markdown?: boolean;
  onCopy?: (text: string) => void;
  onSettled?: () => void;
  onPlaybackComplete?: () => void;
  claimInitialText?: () => boolean;
  initialBufferMs?: number;
  fadeDurationMs?: number;
  drainOnComplete?: boolean;
  sourceText?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  renders.set(id, (renders.get(id) ?? 0) + 1);
  useSmoothText(ref, {
    enabled,
    paused,
    mode,
    lineMode,
    streaming,
    complete,
    onSettled,
    onPlaybackComplete,
    claimInitialText,
    initialBufferMs,
    fadeDurationMs,
    drainOnComplete,
    sourceText,
  });

  const content = (
    <div ref={ref} data-probe={id}>
      {codePending ? (
        <div data-markdown-code-pending="">Loading code</div>
      ) : markdown ? (
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            ...(streaming && !complete ? [remarkHoldIncompleteInline] : []),
          ]}
        >
          {text}
        </ReactMarkdown>
      ) : richText ? (
        richText
      ) : coloredText ? (
        <span>{text}</span>
      ) : markdownParagraph ? (
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

function rangeText(source: AbstractRange) {
  const range = document.createRange();
  range.setStart(source.startContainer, source.startOffset);
  range.setEnd(source.endContainer, source.endOffset);
  return range.toString();
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

function mockWrappedRows(
  columns: number | (() => number) = 4,
  blocks = false,
  wordWrap = false,
  fixedWidth?: number,
) {
  const layouts = new WeakMap<
    HTMLElement,
    {
      text: string;
      columns: number;
      nodes: Array<{ node: Node; block: Element | null }>;
      glyphs: Array<DOMRect | undefined>;
      rects: DOMRect[];
    }
  >();
  const globalOffset = (root: HTMLElement, node: Node, offset: number) => {
    const prefix = document.createRange();
    prefix.setStart(root, 0);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  };
  const rects = (root: HTMLElement, start = 0, end = root.textContent?.length ?? 0) => {
    const rowColumns = typeof columns === "number" ? columns : columns();
    let row = 0;
    let column = 0;
    let previousBlock: Element | null = null;
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const identities: Array<{ node: Node; block: Element | null }> = [];
    const blockByOffset: Array<Element | null> = [];
    while (nodes.nextNode()) {
      const block = nodes.currentNode.parentElement?.closest("p, li, h1, h2, h3, tr, pre") ?? null;
      identities.push({ node: nodes.currentNode, block });
    }
    const text = root.textContent ?? "";
    const cached = layouts.get(root);
    if (
      cached &&
      cached.text === text &&
      cached.columns === rowColumns &&
      cached.nodes.length === identities.length &&
      identities.every(
        (entry, index) =>
          entry.node === cached.nodes[index]!.node && entry.block === cached.nodes[index]!.block,
      )
    ) {
      return start === 0 && end >= cached.glyphs.length
        ? cached.rects
        : cached.glyphs.slice(start, end).filter((rect): rect is DOMRect => rect !== undefined);
    }
    for (const entry of identities) {
      for (let index = 0; index < (entry.node.textContent?.length ?? 0); index++)
        blockByOffset.push(entry.block);
    }
    // Fake layout has the same invalidation rules as the fixture: text,
    // wrapping width and block membership. Reuse it between 240 Hz paints.
    const glyphs: Array<DOMRect | undefined> = [];
    for (const [index, glyph] of text.split("").entries()) {
      if (glyph === "\n") {
        if (!blocks || column > 0) row += 1;
        column = 0;
        continue;
      }
      if (blocks && /\S/u.test(glyph)) {
        const block = blockByOffset[index] ?? null;
        if (previousBlock && previousBlock !== block && column > 0) {
          row += 1;
          column = 0;
        }
        previousBlock = block;
      }
      if (wordWrap && /\S/u.test(glyph) && (index === 0 || /\s/u.test(text[index - 1]!))) {
        const wordLength = text.slice(index).match(/^\S+/u)?.[0].length ?? 0;
        if (wordLength <= rowColumns && column + wordLength > rowColumns) {
          row += 1;
          column = 0;
        }
      }
      if (column === rowColumns) {
        row += 1;
        column = 0;
      }
      {
        glyphs[index] = {
          x: column * 10,
          left: column * 10,
          right: (column + 1) * 10,
          width: 10,
          y: row * 20 + 4,
          top: row * 20 + 4,
          bottom: row * 20 + 16,
          height: 12,
        } as DOMRect;
      }
      column += 1;
    }
    const allRects = glyphs.filter((rect): rect is DOMRect => rect !== undefined);
    layouts.set(root, { text, columns: rowColumns, nodes: identities, glyphs, rects: allRects });
    return start === 0 && end >= glyphs.length
      ? allRects
      : glyphs.slice(start, end).filter((rect): rect is DOMRect => rect !== undefined);
  };
  const bounds = (fragments: DOMRect[]) => {
    if (fragments.length === 0) return { height: 0, bottom: 0, top: 0 } as DOMRect;
    const top = Math.min(...fragments.map((rect) => rect.top));
    const bottom = Math.max(...fragments.map((rect) => rect.bottom));
    const left = Math.min(...fragments.map((rect) => rect.left));
    const right = Math.max(...fragments.map((rect) => rect.right));
    return { top, bottom, left, right, width: right - left, height: bottom - top } as DOMRect;
  };
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    const root = this.startContainer.parentElement?.closest<HTMLElement>("[data-probe]");
    if (!root) return { height: 0, bottom: 0, top: 0 } as DOMRect;
    return bounds(
      rects(
        root,
        globalOffset(root, this.startContainer, this.startOffset),
        globalOffset(root, this.endContainer, this.endOffset),
      ),
    );
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const root = this.startContainer.parentElement?.closest<HTMLElement>("[data-probe]");
    return (root
      ? rects(
          root,
          globalOffset(root, this.startContainer, this.startOffset),
          globalOffset(root, this.endContainer, this.endOffset),
        )
      : []) as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const root = this.matches("[data-probe]")
      ? this
      : (this.querySelector<HTMLElement>("[data-probe]") ??
        this.closest<HTMLElement>("[data-probe]"));
    if (!root) return { height: 0, bottom: 0, top: 0 } as DOMRect;
    if (this.tagName === "CODE") return bounds(Array.from(this.getClientRects()));
    const naturalHeight = Math.ceil((rects(root).at(-1)?.bottom ?? 0) / 20) * 20;
    const explicitHeight = Number.parseFloat(this.style.height);
    const height =
      this.dataset.smoothTextFrame !== undefined && Number.isFinite(explicitHeight)
        ? explicitHeight
        : naturalHeight;
    return {
      height,
      bottom: height,
      top: 0,
      width: fixedWidth ?? (typeof columns === "number" ? columns : columns()) * 10,
    } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    const range = document.createRange();
    range.selectNodeContents(this);
    const fragments = Array.from(range.getClientRects());
    return (this.tagName === "CODE"
      ? fragments.map((rect) => {
          const top = Math.floor(rect.top / 20) * 20;
          return { ...rect, top, bottom: top + 20, height: 20 } as DOMRect;
        })
      : fragments) as unknown as DOMRectList;
  });
}

function mockMediaRows(mediaHeight: () => number) {
  const box = (top: number, height: number) =>
    ({ top, bottom: top + height, height, width: 100, left: 0, right: 100 }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.mediaObject !== undefined) return box(20, mediaHeight());
    const root = this.matches("[data-probe]")
      ? this
      : (this.querySelector<HTMLElement>("[data-probe]") ?? this.closest("[data-probe]"));
    if (!root) return box(0, 0);
    if (this.dataset.smoothTextFrame !== undefined)
      return box(0, Number.parseFloat(this.style.height) || 0);
    const hasObject = root.querySelector("[data-media-object]") !== null;
    const hasTail = root.querySelector("[data-media-tail]") !== null;
    return box(0, hasObject ? 20 + mediaHeight() + (hasTail ? 20 : 0) : 20);
  });
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    if (this.startContainer.nodeType === Node.ELEMENT_NODE) {
      const selected = this.startContainer.childNodes[this.startOffset];
      if (selected instanceof HTMLElement && selected.dataset.mediaObject !== undefined)
        return selected.getBoundingClientRect();
    }
    const parent = this.startContainer.parentElement;
    const top = parent?.closest("[data-media-tail]") ? 20 + mediaHeight() : 0;
    return box(top + 4, this.toString().trim() ? 12 : 0);
  });
}

function expectPaintedGlyphsToFit() {
  const message = container.querySelector<HTMLElement>("[data-probe]")!;
  const height = Number.parseFloat(message.parentElement!.style.height);
  const hidden = [...(hiddenHighlight() ?? [])];
  const nodes = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
  while (nodes.nextNode()) {
    const node = nodes.currentNode as Text;
    for (let offset = 0; offset < node.length; offset++) {
      if (!/\S/u.test(node.data[offset]!)) continue;
      if (
        hidden.some(
          (range) =>
            range.startContainer === node &&
            range.startOffset <= offset &&
            range.endOffset > offset,
        )
      )
        continue;
      const glyph = document.createRange();
      glyph.setStart(node, offset);
      glyph.setEnd(node, offset + 1);
      expect(glyph.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    }
  }
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
  originalRangeGetClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
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
  if (originalRangeGetClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeGetClientRects);
  } else {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
});

describe("useSmoothText", () => {
  it.each([0, 80, 420, 1000])(
    "honors a %s ms fade without delaying text completion",
    async (duration) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const settled = vi.fn();
      const finished = vi.fn();
      await render(
        <Probe
          text="A"
          fadeDurationMs={duration}
          onSettled={settled}
          onPlaybackComplete={finished}
        />,
      );
      now = 100;
      await render(
        <Probe
          text="AB"
          fadeDurationMs={duration}
          streaming={false}
          complete
          onSettled={settled}
          onPlaybackComplete={finished}
        />,
      );
      expect(settled).toHaveBeenCalledOnce();
      expect(hiddenHighlight()?.size ?? 0).toBe(0);
      if (duration === 0) expect(finished).toHaveBeenCalledOnce();
      else {
        expect(finished).not.toHaveBeenCalled();
        now += duration - 1;
        let callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect(fadeRanges().length).toBeGreaterThan(0);
        now += 2;
        callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect(finished).toHaveBeenCalledOnce();
        expect(fadeRanges()).toHaveLength(0);
      }
      expect(frames.size).toBe(0);
    },
  );

  it("keeps a collapsed item's FIFO without consuming its completed text or replaying its prefix", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const finish = vi.fn();
    await render(<Probe text="History" initialBufferMs={0} onPlaybackComplete={finish} />);
    await render(
      <Probe text="History new text" paused initialBufferMs={0} onPlaybackComplete={finish} />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" new text");
    now = 1_000;
    await render(
      <Probe
        text="History new text"
        paused
        streaming={false}
        initialBufferMs={0}
        onPlaybackComplete={finish}
      />,
    );
    expect(frames.size).toBe(0);
    expect(finish).not.toHaveBeenCalled();
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" new text");
    await render(
      <Probe
        text="History new text"
        streaming={false}
        initialBufferMs={0}
        onPlaybackComplete={finish}
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("History");
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("does not play a queued footnote until it becomes visible", async () => {
    const finish = vi.fn();
    await render(
      <Probe
        text="queued note"
        paused
        streaming={false}
        initialBufferMs={0}
        claimInitialText={() => true}
        onPlaybackComplete={finish}
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("queued note");
    expect(frames.size).toBe(0);
    expect(finish).not.toHaveBeenCalled();
    await render(
      <Probe
        text="queued note"
        streaming={false}
        initialBufferMs={0}
        claimInitialText={() => true}
        onPlaybackComplete={finish}
      />,
    );
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
    expect(finish).toHaveBeenCalledOnce();
  });
  it("reports playback complete after glyph fades finish without delaying the text-settled signal", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const settled = vi.fn();
    const finished = vi.fn();
    await render(<Probe text="A" onSettled={settled} onPlaybackComplete={finished} />);
    now = 100;
    await render(
      <Probe
        text="AB"
        streaming={false}
        complete
        onSettled={settled}
        onPlaybackComplete={finished}
      />,
    );
    expect(settled).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    expect(fadeRanges()).not.toHaveLength(0);
    for (now = 110; now <= 400; now += 10) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(finished).toHaveBeenCalledOnce();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("reveals an ordinary link label progressively with glyph fades and retains its destination", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const label = "链接正文逐字符渐入而且可以点击";
    await render(<Probe text="" richText={<p />} claimInitialText={() => true} />);
    await render(
      <Probe
        text={label}
        richText={
          <p>
            <a href="https://example.com">{label}</a>
          </p>
        }
        claimInitialText={() => true}
      />,
    );
    let intermediate = false;
    for (now = 200; now <= 1_200; now += 1_000 / 60) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (hidden.length > 0 && hidden.length < label.length) {
        intermediate = true;
        expect(fadeRanges().some((range) => range.startContainer.parentElement?.closest("a"))).toBe(
          true,
        );
      }
    }
    expect(intermediate).toBe(true);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps a task checkbox on the same FIFO as its still hidden label", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" markdown claimInitialText={() => true} />);
    await render(<Probe text="- [x] 任务正文" markdown claimInitialText={() => true} />);
    const checkbox = container.querySelector("input")!;
    expect(checkbox.hasAttribute("data-smooth-inline-pending")).toBe(true);
    for (now = 1_000; now <= 1_100; now += 10) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(checkbox.hasAttribute("data-smooth-inline-pending")).toBe(false);
    await flushFrames();
    expect(checkbox.hasAttribute("data-smooth-surface")).toBe(false);
  });

  it.each(
    [30, 60, 240].flatMap((hz) => [
      { hz, wrapped: false },
      { hz, wrapped: true },
    ]),
  )(
    "reveals only the opened image area while keeping its following row queued at $hz Hz (slot: $wrapped)",
    async ({ hz, wrapped }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockMediaRows(() => 180);
      await render(<Probe text="H" frame richText={<p>H</p>} />);
      await render(
        <Probe
          text="H image T"
          frame
          richText={
            <>
              <p>H</p>
              <p>
                {wrapped ? (
                  <span
                    data-media-object=""
                    data-smooth-media=""
                    data-markdown-copy="![fixture](fixture.png)"
                  >
                    <img alt="fixture" />
                  </span>
                ) : (
                  <img data-media-object="" alt="fixture" />
                )}
              </p>
              <p data-media-tail="">T</p>
            </>
          }
        />,
      );
      const image = container.querySelector<HTMLElement>("[data-media-object]")!;
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(image.hasAttribute("data-smooth-inline-pending")).toBe(true);
      expect(frame.style.height).toBe("20px");
      let partialImage = false;
      let fullyOpened = false;
      let imageStarted = false;
      for (now = 1_000 / hz; now <= 600 && frames.size; now += 1_000 / hz) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        if (imageStarted) expect(image.hasAttribute("data-smooth-inline-pending")).toBe(false);
        imageStarted ||= !image.hasAttribute("data-smooth-inline-pending");
        if (height < 199.5) {
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("T");
          if (!image.hasAttribute("data-smooth-inline-pending")) {
            partialImage = true;
            const clipped = Number(/inset\(0 0 ([\d.]+)px 0\)/u.exec(image.style.clipPath)?.[1]);
            expect(clipped).toBeGreaterThan(0);
            expect(180 - clipped).toBeLessThanOrEqual(height - 20 + 0.5);
            expect(
              Number(image.style.getPropertyValue("--t3-smooth-surface-opacity")),
            ).toBeGreaterThan(0);
          }
        } else if (!image.hasAttribute("data-smooth-inline-pending")) {
          if (!fullyOpened)
            expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("T");
          fullyOpened = true;
        }
      }
      expect(partialImage).toBe(true);
      expect(fullyOpened).toBe(true);
      await flushFrames();
      expect(image.hasAttribute("data-smooth-surface")).toBe(false);
      expect(image.style.clipPath).toBe("");
    },
  );

  it("opens the first image after the initial window without reserving invisible blank space", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => 180);
    await render(
      <Probe
        text="![fixture](fixture.png)"
        frame
        claimInitialText={() => true}
        richText={
          <p>
            <img data-media-object="" alt="fixture" />
          </p>
        }
      />,
    );
    const image = container.querySelector("img")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 800; now < 1_000; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(image.hasAttribute("data-smooth-inline-pending")).toBe(true);
      expect(Number.parseFloat(frame.style.height)).toBe(0);
    }
    expect(Number.parseFloat(frame.style.height)).toBe(0);
    now = 1_000;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(image.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect(Number.parseFloat(frame.style.height)).toBe(0);
    for (now = 1_016; now <= 1_080; now += 16) {
      const next = [...frames.values()];
      frames.clear();
      await act(() => next.forEach((callback) => callback(now)));
    }
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(200);
    expect(image.hasAttribute("data-smooth-inline-pending")).toBe(false);
    expect(image.style.clipPath).toMatch(/^inset/u);
    await flushFrames();
  });

  it.each([30, 60, 240])(
    "shortens large-image admission under queue pressure without exposing its tail at %s Hz",
    async (hz) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockMediaRows(() => 500);
      const tail = "Queued words ".repeat(60);
      await render(<Probe text="H" frame richText={<p>H</p>} />);
      await render(
        <Probe
          text={`H image ${tail}`}
          frame
          richText={
            <>
              <p>H</p>
              <img data-media-object="" alt="fixture" />
              <p data-media-tail="">{tail}</p>
            </>
          }
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const image = container.querySelector<HTMLImageElement>("img")!;
      let intermediate = false;
      for (now = 1000 / hz; now <= 320; now += 1000 / hz) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        if (height > 20 && height < 519.5) {
          intermediate = true;
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(tail);
          expect(image.style.clipPath).toMatch(/^inset/u);
        }
      }
      expect(intermediate).toBe(true);
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(520);
      expect(image.style.clipPath).toBe("");
      await flushFrames();
    },
  );

  it("animates a displayed image's loaded size even when no text arrives", async () => {
    let now = 0;
    let imageHeight = 40;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    await render(
      <Probe
        text="image"
        frame
        richText={
          <p>
            <img data-media-object="" alt="fixture" />
          </p>
        }
      />,
    );
    const image = container.querySelector("img")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(frame.style.height).toBe("60px");
    imageHeight = 180;
    await act(() => image.dispatchEvent(new Event("load")));
    expect(Number.parseFloat(frame.style.height)).toBe(60);
    expect(image.hasAttribute("data-smooth-inline-pending")).toBe(false);
    now = 80;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(60);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(200);
    await flushFrames();
    expect(Number.parseFloat(frame.style.height)).toBe(200);
  });

  it.each([120, 1_000])(
    "keeps a newly arrived large image on its painted clock after a %s ms frame stall",
    async (stallMs) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockMediaRows(() => 500);
      await render(<Probe text="H" frame richText={<p>H</p>} />);
      await flushFrames();
      now = 5_000;
      await render(
        <Probe
          text="H image T"
          frame
          richText={
            <>
              <p>H</p>
              <img data-media-object="" alt="fixture" />
              <p data-media-tail="">T</p>
            </>
          }
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const before = Number.parseFloat(frame.style.height);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 2);
      now += 16;
      const next = [...frames.values()];
      frames.clear();
      await act(() => next.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height) - before).toBeLessThan(10);
      const beforeStall = Number.parseFloat(frame.style.height);
      now += stallMs;
      const delayed = [...frames.values()];
      frames.clear();
      await act(() => delayed.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height) - beforeStall).toBeLessThan(20);
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each([80, 120])(
    "keeps image admission bounded during sustained %s ms frames",
    async (frameMs) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockMediaRows(() => 480);
      const tail = "Queued words ".repeat(60);
      await render(<Probe text="H" frame richText={<p>H</p>} />);
      await render(
        <Probe
          text={`H image ${tail}`}
          frame
          richText={
            <>
              <p>H</p>
              <img data-media-object="" alt="fixture" />
              <p data-media-tail="">{tail}</p>
            </>
          }
        />,
      );
      const image = container.querySelector<HTMLImageElement>("img")!;
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let intermediate = 0;
      for (now = 0; now <= 720; now += frameMs) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        if (height > 20 && height < 499.5) {
          intermediate++;
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(tail);
        }
      }
      expect(intermediate).toBeGreaterThanOrEqual(3);
      expect(image.style.clipPath).toBe("");
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(500);
      await flushFrames();
    },
  );

  it("retargets an image reflow smoothly when its loaded dimensions shrink again", async () => {
    let now = 0;
    let imageHeight = 40;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    await render(
      <Probe
        text="image"
        frame
        richText={
          <p>
            <img data-media-object="" alt="fixture" />
          </p>
        }
      />,
    );
    const image = container.querySelector("img")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    imageHeight = 400;
    await act(() => image.dispatchEvent(new Event("load")));
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    await step(150);
    const mid = Number.parseFloat(frame.style.height);
    expect(mid).toBeGreaterThan(100);
    imageHeight = 60;
    await act(() => image.dispatchEvent(new Event("load")));
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(mid);
    await step(230);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(mid);
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(80);
    await flushFrames();
    expect(Number.parseFloat(frame.style.height)).toBe(80);
  });

  it("keeps geometry observation until an image loading after completion has settled", async () => {
    let now = 0;
    let imageHeight = 40;
    let loaded = false;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    const content = (
      <p>
        <img data-media-object="" src="/late-image.png" alt="fixture" />
      </p>
    );
    await render(<Probe text="image" frame richText={content} />);
    const image = container.querySelector("img")!;
    vi.spyOn(image, "complete", "get").mockImplementation(() => loaded);
    const observer = MockIntersectionObserver.instances.at(-1)!;
    await render(<Probe text="image" frame richText={content} streaming={false} complete />);
    await flushFrames();
    expect(observer.disconnect).not.toHaveBeenCalled();
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const before = Number.parseFloat(frame.style.height);
    loaded = true;
    imageHeight = 400;
    await act(() => image.dispatchEvent(new Event("load")));
    expect(Number.parseFloat(frame.style.height)).toBe(before);
    await flushFrames();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(frame.style.height).toBe("");
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps an unloaded zero-height image queued after completion until geometry arrives", async () => {
    let now = 0;
    let imageHeight = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    await render(<Probe text="H" frame richText={<p>H</p>} />);
    await render(
      <Probe
        text="H image T"
        frame
        streaming={false}
        complete
        richText={
          <>
            <p>H</p>
            <img data-media-object="" src="/pending-image.png" alt="fixture" />
            <p data-media-tail="">T</p>
          </>
        }
      />,
    );
    const image = container.querySelector("img")!;
    const observer = MockIntersectionObserver.instances.at(-1)!;
    await flushFrames();
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("T");
    imageHeight = 300;
    vi.spyOn(image, "complete", "get").mockReturnValue(true);
    now = 2_000;
    await act(() => image.dispatchEvent(new Event("load")));
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("does not hold a completed text tail behind a tiny media metric correction", async () => {
    let now = 0;
    let imageHeight = 40;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    const content = (tail: string) => (
      <>
        <p>H</p>
        <img data-media-object="" alt="fixture" />
        <p data-media-tail="">{tail}</p>
      </>
    );
    await render(<Probe text="H image T" frame richText={content("T")} />);
    imageHeight = 60;
    await render(<Probe text="H image TX" frame richText={content("TX")} streaming={false} />);
    for (const at of [40, 80, 120]) {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps nested list rows in the same FIFO reservation sequence", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const list = (tail: boolean) => (
      <ul>
        <li>
          第一层
          <ul>
            <li>嵌套层</li>
          </ul>
        </li>
        {tail ? <li>后续内容</li> : null}
      </ul>
    );
    await render(
      <Probe text="第一层嵌套层" frame richText={list(false)} claimInitialText={() => true} />,
    );
    await render(
      <Probe
        text="第一层嵌套层后续内容"
        frame
        richText={list(true)}
        claimInitialText={() => true}
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 1_000; now <= 1_600 && frames.size > 0; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (hidden.includes("后续内容")) {
        expect(Number.parseFloat(frame.style.height)).toBeLessThan(80);
        break;
      }
    }
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([30, 60, 240])(
    "keeps an admitted row's unfinished glyphs readable when a later block rewrites at %s Hz",
    async (hz) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(20, true);
      const view = (rewrite: boolean, streaming = true) => (
        <Probe
          text={rewrite ? "changed" : "original"}
          frame
          streaming={streaming}
          claimInitialText={() => true}
          richText={
            <ul>
              <li>ABCDEFGHIJKLMNO</li>
              <li>第二行继续逐字显示内容。</li>
              <li>{rewrite ? "变化后的尾部" : "尚未显示的尾部"}</li>
            </ul>
          }
        />
      );
      await render(view(false));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let rewrote = false;
      for (let step = 0; step < hz * 5; step++) {
        now += 1_000 / hz;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        // Quintic motion starts with a subpixel rise; the rewrite must land
        // while that next reservation and the preceding row still overlap.
        if (!rewrote && hidden.includes("O") && Number.parseFloat(frame.style.height) > 20) {
          rewrote = true;
          await render(view(true, false));
        }
      }
      expect(rewrote).toBe(true);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it("preserves unchanged hidden ranges while appending to another Markdown block", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const view = (append: boolean) => (
      <Probe
        text={append ? "firstqueuednew" : "firstqueued"}
        claimInitialText={() => true}
        richText={
          <>
            <p>first</p>
            <p data-queued="">queued</p>
            {append ? <p>new</p> : null}
          </>
        }
      />
    );
    await render(view(false));
    const node = container.querySelector("[data-queued]")!.firstChild!;
    const queued = [...hiddenHighlight()!].find((range) => range.startContainer === node)!;
    expect(queued).toBeDefined();
    now = 20;
    await render(view(true));
    expect([...hiddenHighlight()!]).toContain(queued);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("does not translate a retained list item that also owns a newly inserted checkbox", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const elementBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches("input")) return { top: 4, bottom: 16, height: 12, width: 12 } as DOMRect;
      return elementBounds.call(this);
    });
    const view = (task: boolean) => (
      <Probe
        text={task ? "task" : "list"}
        frame
        richText={
          <>
            <ul>
              <li>
                {task ? <input type="checkbox" readOnly /> : null}
                {"已显示的列表正文"}
                <ul>
                  <li>已显示的嵌套行</li>
                </ul>
              </li>
            </ul>
            {"\n"}
          </>
        }
      />
    );
    await render(view(false));
    const label = container.querySelector("li")!.childNodes[0];
    await render(view(true));
    expect(container.querySelector("li")!.childNodes[1]).toBe(label);
    expect(container.querySelector<HTMLElement>("li")!.style.translate).toBe("");
    expect(container.querySelector<HTMLElement>("ul")!.style.translate).toBe("");
    expect(container.querySelector<HTMLElement>("[data-probe]")!.style.translate).toBe("");
    await flushFrames();
    expect(container.querySelector("input")!.hasAttribute("data-smooth-inline-pending")).toBe(
      false,
    );
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("reserves fenced code rows without adding glyph fades", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20);
    await render(
      <Probe text="第一行\n第二行\n第三行" frame codeBlock claimInitialText={() => true} />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 1_000; now <= 1_600 && frames.size > 0; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(
        fadeRanges().every((range) => range.startContainer.parentElement?.closest("pre") === null),
      ).toBe(true);
      if (Number.parseFloat(frame.style.height) >= 20) break;
    }
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(60);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("does not publish a loaded image's large natural height in one reflow", async () => {
    let now = 0;
    let imageHeight = 40;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    await render(<Probe text="H" frame richText={<p>H</p>} claimInitialText={() => true} />);
    await render(
      <Probe
        text="H image T"
        frame
        claimInitialText={() => true}
        richText={
          <>
            <p>H</p>
            <p>
              <img data-media-object="" alt="fixture" />
            </p>
            <p data-media-tail="">T</p>
          </>
        }
      />,
    );
    const image = container.querySelector("img")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const before = Number.parseFloat(frame.style.height);
    imageHeight = 180;
    await act(() => image.dispatchEvent(new Event("load")));
    const after = Number.parseFloat(frame.style.height);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThan(220);
    await flushFrames();
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(200);
  });

  it.each([30, 60, 240])(
    "keeps a completed tall image reservation visible across several frames at %s Hz",
    async (fps) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockMediaRows(() => 480);
      const content = (
        <>
          <p>H</p>
          <p>
            <img data-media-object="" alt="fixture" />
          </p>
          <p data-media-tail="">T</p>
        </>
      );
      await render(<Probe text="H" frame richText={<p>H</p>} />);
      await render(<Probe text="H image T" frame richText={content} streaming={false} complete />);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const heights: number[] = [];
      for (let index = 1; index <= fps; index++) {
        now = 1_000 + (index * 1_000) / fps;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height =
          Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height;
        heights.push(height);
        if (height < 500) {
          expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(true);
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("T");
        }
        if (height >= 500) break;
      }
      expect(heights.filter((height) => height > 20 && height < 500).length).toBeGreaterThanOrEqual(
        3,
      );
      expect(
        Math.max(...heights.slice(1).map((height, index) => height - heights[index]!)),
      ).toBeLessThan(100);
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each([30, 60, 240])(
    "splits a large completed provider fragment into bounded grapheme batches at %s Hz",
    async (fps) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      await render(<Probe text="History" mode="token" />);
      const tail = "👩‍💻字".repeat(200);
      await render(<Probe text={"History" + tail} mode="token" streaming={false} complete />);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(tail);
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      let previousCount = 400;
      let intermediate = 0;
      for (let index = 1; index <= fps; index++) {
        now = 1_000 + (index * 1_000) / fps;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        const count = [...segmenter.segment(hidden)].length;
        expect(previousCount - count).toBeLessThanOrEqual(128);
        expect(hidden === "" || hidden.startsWith("👩‍💻") || hidden.startsWith("字")).toBe(true);
        if (count > 0 && count < previousCount) intermediate++;
        previousCount = count;
        if (count === 0) break;
      }
      expect(intermediate).toBeGreaterThanOrEqual(3);
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("resumes line reservations after details content expands during output", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const content = (open: boolean, tail: boolean) => (
      <>
        <p>History</p>
        <div data-markdown-details="">
          <button data-smooth-atomic="">Details</button>
          {open ? (
            <div data-markdown-details-content="">
              {Array.from({ length: 10 }, (_, index) => (
                <p key={index}>展开行{index}逐字展示</p>
              ))}
            </div>
          ) : null}
        </div>
        {tail ? <p>最后继续正常逐行显示。</p> : null}
      </>
    );
    await render(<Probe text="HistoryDetails" frame richText={content(false, false)} />);
    await render(<Probe text="HistoryDetailsExpandedTail" frame richText={content(true, true)} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let intermediateFrames = 0;
    for (now = 1_000; now < 3_000; now += 1_000 / 30) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      const height = Number.parseFloat(frame.style.height);
      if (hidden.includes("最后") && height > 40 && height < 240) intermediateFrames++;
      expectPaintedGlyphsToFit();
    }
    expect(intermediateFrames).toBeGreaterThan(3);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("drains details inserted above an already visible suffix and keeps later output moving", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const content = (open: boolean, append = "") => (
      <>
        <p>History</p>
        <div data-markdown-details="">
          <button data-smooth-atomic="">Details</button>
          {open ? (
            <div data-markdown-details-content="">
              {Array.from({ length: 12 }, (_, index) => (
                <p key={index}>展开行{index}逐字展示</p>
              ))}
            </div>
          ) : null}
        </div>
        <p>已经可见的后续正文{append}</p>
      </>
    );
    await render(<Probe text="history details suffix" frame richText={content(false)} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const before = Number.parseFloat(frame.style.height);
    await render(<Probe text="history details expanded suffix" frame richText={content(true)} />);
    expect(Number.parseFloat(frame.style.height)).toBe(before);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
    now = 5_000;
    await render(
      <Probe
        text="history details expanded suffix next"
        frame
        richText={content(true, "之后继续输出。")}
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("之后继续输出。");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("reveals inserted details row by row before reserving the full height of retained footnotes", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const originalBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches("[data-footnotes]")) {
        const bounds = originalBounds.call(this);
        return { ...bounds, top: bounds.height - 20, bottom: bounds.height, height: 20 } as DOMRect;
      }
      return originalBounds.call(this);
    });
    const content = (expanded: boolean) => (
      <>
        <p>History</p>
        {expanded && (
          <div data-markdown-details-content="">
            {Array.from({ length: 12 }, (_, index) => (
              <p key={index}>新增展开行{index}逐字显示</p>
            ))}
          </div>
        )}
        <section data-footnotes="">
          <p>已显示脚注</p>
        </section>
      </>
    );
    await render(<Probe text="before" frame richText={content(false)} />);
    const footnote = container.querySelector("[data-footnotes]");
    await render(<Probe text="after" frame richText={content(true)} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let shownBeforeFullHeight = false;
    for (now = 0; now < 4_000; now += 1_000 / 60) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      const height = Number.parseFloat(frame.style.height);
      if (!hidden.includes("新增展开行0") && hidden.includes("新增展开行11") && height < 200)
        shownBeforeFullHeight = true;
      expect(container.querySelector("[data-footnotes]")).toBe(footnote);
      expect(hidden).not.toContain("已显示脚注");
    }
    expect(shownBeforeFullHeight).toBe(true);
    expect(hiddenHighlight()).toBeUndefined();
    expect((footnote as HTMLElement).style.translate).toBe("");
  });

  it("keeps a translated retained footer in local geometry while inserted rows stream above it", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    const elementBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    const translation = (node: Node) => {
      let offset = 0;
      for (let parent = node.parentElement; parent; parent = parent.parentElement)
        offset += Number.parseFloat(parent.style.translate.split(" ")[1] ?? "0") || 0;
      return offset;
    };
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const bounds = rangeBounds.call(this);
      const offset = translation(this.startContainer);
      return { ...bounds, top: bounds.top + offset, bottom: bounds.bottom + offset };
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches("[data-footnotes]")) {
        const range = document.createRange();
        range.selectNodeContents(this);
        const bounds = rangeBounds.call(range);
        const offset = Number.parseFloat(this.style.translate.split(" ")[1] ?? "0") || 0;
        const top = Math.floor(bounds.top / 20) * 20;
        const bottom = Math.ceil(bounds.bottom / 20) * 20;
        return { ...bounds, top: top + offset, bottom: bottom + offset, height: bottom - top };
      }
      return elementBounds.call(this);
    });
    const view = (rows: number, streaming = true) => (
      <Probe
        text={`revision-${rows}`}
        frame
        streaming={streaming}
        richText={
          <>
            <p>History</p>
            {Array.from({ length: rows }, (_, index) => (
              <p key={index}>插入正文第{index}行继续输出。</p>
            ))}
            <section data-footnotes="">
              <p>旧脚注一</p>
              <p>旧脚注二</p>
            </section>
          </>
        }
      />
    );
    await render(view(0));
    const footer = container.querySelector<HTMLElement>("[data-footnotes]")!;
    for (let step = 1; step <= 300; step++) {
      now = step * (1_000 / 60);
      if (step <= 120 && step % 6 === 0) await render(view(step / 6));
      if (step === 121) await render(view(20, false));
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      expect(
        Number.parseFloat(frame.style.height) || message.getBoundingClientRect().height,
      ).toBeLessThanOrEqual(message.getBoundingClientRect().height + 0.5);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("旧脚注");
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(footer.style.translate).toBe("");
  });

  it("measures an inserted FIFO line after a taller retained inline run without replaying that run", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const bounds = rangeBounds.call(this);
      if (this.startContainer.parentElement?.matches("strong"))
        return { ...bounds, top: 0, bottom: 24, height: 24 };
      return bounds;
    });
    const view = (inserted: string, streaming = true) => (
      <Probe
        text={`source ${inserted}`}
        frame
        streaming={streaming}
        richText={
          <p>
            <strong>History</strong>
            <span>{inserted}</span>
            <i>Retained tail</i>
          </p>
        }
      />
    );
    await render(view(""));
    const inserted = "new ".repeat(20);
    await render(view(inserted));
    await render(view(inserted, false));
    for (now = 16; now <= 2_000; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      expect(
        Number.parseFloat(frame.style.height) || message.getBoundingClientRect().height,
      ).toBeLessThanOrEqual(message.getBoundingClientRect().height + 0.5);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("History");
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("Retained tail");
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
  });

  it("opens the first FIFO line on time when a later closed panel is already retained", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    await render(
      <Probe
        text="opening closed panel"
        frame
        claimInitialText={() => true}
        richText={
          <>
            <p>First line</p>
            <div data-markdown-details-open="false">
              <div data-markdown-details-content="">
                <p>Hidden panel body</p>
              </div>
            </div>
          </>
        }
      />,
    );
    now = 1_000;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(fadeRanges().map(rangeText)).toContain("F");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("irst line");
    await flushFrames();
  });

  it("keeps the displayed edge on visible text when a closed details body is far above the viewport", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return { top: -1_000, bottom: -980, height: 20, width: 400 } as DOMRect;
    });
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return this.startContainer.parentElement?.closest("[data-markdown-details-content]")
        ? ({ top: 0, bottom: 0, height: 0 } as DOMRect)
        : ({ top: -996, bottom: -984, height: 12 } as DOMRect);
    });
    await render(<Probe text="before" frame richText={<p>Visible history</p>} />);
    await render(
      <Probe
        text="after"
        frame
        richText={
          <>
            <p>Visible history</p>
            <div data-markdown-details-open="false">
              <div data-markdown-details-content="">
                <p>Hidden body</p>
              </div>
            </div>
          </>
        }
      />,
    );
    const message = container.querySelector<HTMLElement>("[data-probe]")!;
    expect(readSmoothTextEnd(container)?.bottom).toBe(-984);
    for (now = 20; now <= 500; now += 20) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(message.parentElement!.style.height)).toBeLessThanOrEqual(20.5);
    }
  });

  it("skips a mounted closed details body and preserves it when the panel opens again", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const content = (open: boolean, tail: string) => (
      <>
        <p>History</p>
        <div data-markdown-details-open={open ? "true" : "false"}>
          <div data-markdown-details-content="">
            <p>{"折叠正文".repeat(20)}</p>
          </div>
        </div>
        <p>{tail}</p>
      </>
    );
    await render(<Probe text="History" frame richText={<p>History</p>} />);
    await render(<Probe text="History details Tail" frame richText={content(false, "Tail")} />);
    const body = container.querySelector("[data-markdown-details-content] p")!.firstChild;
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("折叠正文");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    await render(<Probe text="History details Tail" frame richText={content(true, "Tail")} />);
    expect(container.querySelector("[data-markdown-details-content] p")!.firstChild).toBe(body);
    expect(hiddenHighlight()).toBeUndefined();
    await render(
      <Probe text="History details Tail next" frame richText={content(true, "Tail next")} />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("折叠正文");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps superscript and subscript on their surrounding physical row", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const measure = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = measure.call(this);
      const script = this.startContainer.parentElement?.closest("sup, sub");
      if (!script) return rect;
      const shift = script.tagName === "SUP" ? -5 : 3;
      return {
        ...rect,
        top: rect.top + shift,
        bottom: rect.bottom + shift - 4,
        height: rect.height - 4,
      } as DOMRect;
    });
    await render(<Probe text="A" frame richText={<p style={{ lineHeight: "20px" }}>A</p>} />);
    await render(
      <Probe
        text="A123B456C"
        frame
        richText={
          <p style={{ lineHeight: "20px" }}>
            A
            <sup style={{ lineHeight: 0, fontSize: "10px", position: "relative", top: "-5px" }}>
              123
            </sup>
            B
            <sub style={{ lineHeight: 0, fontSize: "10px", position: "relative", top: "3px" }}>
              456
            </sub>
            C
          </p>
        }
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 1_000; now < 2_000; now += 1_000 / 60) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(20.5);
    }
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("fades a file button's frame, icon and complete label on one shared clock", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(
      <Probe
        text="file"
        claimInitialText={() => true}
        richText={
          <button data-smooth-atomic="">
            <svg aria-hidden="true" />
            <span>file.ts</span>
          </button>
        }
      />,
    );
    const surface = container.querySelector("button")!;
    expect(surface.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("file.ts");
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 1_000;
    await act(async () => next[1](now));
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges()).toHaveLength(0);
    expect(surface.hasAttribute("data-smooth-inline-pending")).toBe(false);
    const firstOpacity = Number(surface.style.getPropertyValue("--t3-smooth-surface-opacity"));
    expect(firstOpacity).toBeGreaterThan(0);
    expect(firstOpacity).toBeLessThan(0.2);
    const fade = frames.entries().next().value!;
    frames.delete(fade[0]);
    now = 1_090;
    await act(async () => fade[1](now));
    expect(Number(surface.style.getPropertyValue("--t3-smooth-surface-opacity"))).toBeGreaterThan(
      firstOpacity,
    );
    await flushFrames();
    expect(surface.hasAttribute("data-smooth-surface")).toBe(false);
  });

  it.each(["inline code", "file button"] as const)(
    "preserves the %s animation policy across work completion",
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const richText =
        kind === "inline code" ? (
          <code>example.ts</code>
        ) : (
          <button data-smooth-atomic="">
            <svg aria-hidden="true" />
            <span>example.ts</span>
          </button>
        );
      await render(<Probe text="example.ts" richText={richText} claimInitialText={() => true} />);
      const surface = container.querySelector<HTMLElement>(
        kind === "inline code" ? "code" : "button",
      )!;
      now = 1_000;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const firstOpacity = surface.style.getPropertyValue("--t3-smooth-surface-opacity");
      if (kind === "inline code") {
        expect(firstOpacity).toBe("");
        expect(fadeRanges()).toHaveLength(0);
      } else {
        expect(Number(firstOpacity)).toBeGreaterThan(0);
        expect(Number(firstOpacity)).toBeLessThan(1);
      }

      now = 1_004;
      await render(<Probe text="example.ts" richText={richText} streaming={false} complete />);
      expect(hiddenHighlight()).toBeUndefined();
      expect(surface.hasAttribute("data-smooth-inline-pending")).toBe(false);
      const completedOpacity = surface.style.getPropertyValue("--t3-smooth-surface-opacity");
      if (kind === "inline code") {
        expect(completedOpacity).toBe("");
        expect(fadeRanges()).toHaveLength(0);
      } else {
        expect(Number(completedOpacity)).toBeGreaterThan(Number(firstOpacity));
        expect(Number(completedOpacity)).toBeLessThan(1);
      }
      await flushFrames();
      expect(surface.hasAttribute("data-smooth-surface")).toBe(false);
      expect(surface.style.getPropertyValue("--t3-smooth-surface-opacity")).toBe("");
    },
  );

  it("preloads partial link labels and restores unfinished literals on completion", async () => {
    await render(<Probe text="History " markdown />);
    for (const suffix of ["[file", "[file]"]) {
      await render(<Probe text={`History ${suffix}`} markdown />);
      expect(container.textContent).toBe("History file");
      expect(container.querySelector("a")?.getAttribute("href")).toBe("");
    }
    await render(<Probe text="History [file](https://example.com" markdown />);
    expect(container.textContent).toBe("History file");
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("");
    await render(<Probe text="History [file](https://example.com)" markdown />);
    expect(container.textContent).toBe("History file");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.querySelector("a")).toBe(anchor);
    await render(<Probe text="History [unfinished" markdown streaming={false} complete />);
    expect(container.textContent).toBe("History [unfinished");
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("fades headings, emphasis and table text but never fades fenced code glyphs", async () => {
    const text =
      "# Heading\n\n**Bold** and *italic*.\n\n| Column |\n| --- |\n| Value |\n\n```txt\ncode body\n```";
    await render(<Probe text="" markdown claimInitialText={() => true} />);
    await render(<Probe text={text} markdown claimInitialText={() => true} />);
    const seen = new Set<string>();
    let now = performance.now() + 1_000;
    for (let index = 0; index < 300 && frames.size; index += 1) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      now += 25;
      await act(async () => next[1](now));
      for (const range of fadeRanges()) {
        expect(range.startContainer.parentElement?.closest("pre")).toBeNull();
        seen.add(range.startContainer.parentElement!.tagName);
      }
    }
    for (const tag of ["H1", "STRONG", "EM", "TH", "TD"]) expect(seen.has(tag)).toBe(true);
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("renders split Markdown increments with glyph fades except for inline code", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const source = "**粗体**\n\n`代码`\n\n| 标题 |\n| --- |\n| 内容 |";
    await render(<Probe text="" markdown claimInitialText={() => true} />);
    for (let end = 1; end <= source.length; end += 1) {
      now += 40;
      await render(<Probe text={source.slice(0, end)} markdown />);
      expect(container.textContent).not.toMatch(/[*`|]/u);
    }
    const seen = new Set<string>();
    for (let index = 0; index < 100 && frames.size; index += 1) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      now += 25;
      await act(async () => next[1](now));
      for (const range of fadeRanges()) {
        expect([...rangeText(range)]).toHaveLength(1);
        seen.add(range.startContainer.parentElement!.tagName);
      }
    }
    for (const tag of ["STRONG", "TH", "TD"]) expect(seen.has(tag)).toBe(true);
    expect(seen.has("CODE")).toBe(false);
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([
    [30, "code"],
    [60, "code"],
    [30, "link"],
    [60, "link"],
  ] as const)("keeps an unclosed long label's queue bounded at %s Hz: %s", async (fps, kind) => {
    const opening = kind === "code" ? "`" : "[";
    const closing = kind === "code" ? "`" : "](https://example.com)";
    const selector = kind === "code" ? "code" : "a";
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(24, true);
    await render(<Probe text="" frame markdown claimInitialText={() => true} />);
    let body = "";
    let nextArrival = 0;
    const backlogs: number[] = [];
    for (let index = 1; index <= fps * 6; index++) {
      const frameAt = (index * 1_000) / fps;
      while (nextArrival < frameAt) {
        now = nextArrival;
        nextArrival += 40;
        body += "path";
        await render(<Probe text={opening + body} frame markdown />);
      }
      now = frameAt;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (now >= 4_000)
        backlogs.push([...(hiddenHighlight() ?? [])].map(rangeText).join("").length);
    }
    expect(container.querySelector(selector)?.textContent).toBe(body);
    expect(Math.max(...backlogs)).toBeLessThan(64);
    const before = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
    const surface = container.querySelector(selector);
    await render(<Probe text={opening + body + closing} frame markdown />);
    expect(container.querySelector(selector)).toBe(surface);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("").length).toBeLessThanOrEqual(
      before,
    );
    await render(
      <Probe text={opening + body + closing} frame markdown streaming={false} complete />,
    );
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("preserves provider batches when deferred text commits several source arrivals together", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" sourceText="" mode="token" claimInitialText={() => true} />);
    await render(<Probe text="" sourceText="Hello" mode="token" />);
    now = 100;
    await render(<Probe text="" sourceText="Hello world" mode="token" />);
    now = 200;
    await render(<Probe text="Hello world" sourceText="Hello world" mode="token" />);
    now = 1_000;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" world");
    expect(fadeRanges().map(rangeText)).toContain("Hello");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("releases one received text batch at a time in token mode", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" mode="token" claimInitialText={() => true} />);
    await render(<Probe text="Hello" mode="token" />);
    now = 100;
    await render(<Probe text="Hello world" mode="token" />);
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 1_000;
    await act(async () => next[1](now));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" world");
    expect(fadeRanges().map(rangeText).join("")).toBe("Hello");
    await render(<Probe text="Hello world" mode="character" />);
    const afterSwitch = frames.entries().next().value!;
    frames.delete(afterSwitch[0]);
    now = 1_018;
    await act(async () => afterSwitch[1](now));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("world");
  });

  it("keeps queued glyphs masked and fading glyphs on their clock when a timeline row moves", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" />);
    await render(<Probe text="HistoryABCDE" />);
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 16;
    await act(async () => next[1](now));
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BCDE");

    // Virtualized rows can move without changing their Markdown subtree.
    container.remove();
    document.body.append(container);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BCDE");
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);

    const afterMove = frames.entries().next().value!;
    frames.delete(afterMove[0]);
    now = 40;
    await act(async () => afterMove[1](now));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CDE");
    expect(fadeRanges().map(rangeText).sort()).toEqual(["A", "B"]);
    expect(readSmoothTextEnd(container)?.hiddenTailHeight).toBe(3);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps displayed paragraphs visible when a final footnote definition reparses earlier text", async () => {
    const text = "Reference[^note].\n\nAlready visible body.\n\nAnother visible paragraph.";
    await render(<Probe text={text} markdown />);
    const paragraphs = [...container.querySelectorAll("p")];
    expect(hiddenHighlight()).toBeUndefined();

    await render(
      <Probe text={`${text}\n\n[^note]: New footnote content.`} markdown streaming={false} />,
    );
    expect(container.querySelectorAll("p")[1]).toBe(paragraphs[1]);
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden).not.toContain("Already visible body.");
    expect(hidden).not.toContain("Another visible paragraph.");
    expect(hidden).toContain("New footnote content.");
  });

  it("preserves the visible part of a paragraph while its queued tail survives a footnote rewrite", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const text = "Reference[^note].\n\nVisible text and a still queued paragraph tail.";
    await render(<Probe text="" markdown claimInitialText={() => true} />);
    await render(<Probe text={text} markdown claimInitialText={() => true} />);
    for (now = 1_000; now <= 1_800; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      if (![...(hiddenHighlight() ?? [])].map(rangeText).join("").includes("Visible text")) break;
    }
    const before = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(before).toContain("paragraph tail.");
    expect(before).not.toContain("Visible text");
    const paragraph = container.querySelectorAll("p")[1]!;
    const paragraphTail = [...(hiddenHighlight() ?? [])]
      .filter((range) => range.startContainer.parentElement?.closest("p") === paragraph)
      .map(rangeText)
      .join("");

    await render(<Probe text={`${text}\n\n[^note]: New note.`} markdown />);
    const after = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    // The reference's text changes from literal syntax to its formatted number;
    // the independently playing paragraph retains its own visible prefix.
    expect(after).toContain(paragraphTail);
    expect(after).not.toContain("Visible text");
    expect(after).toContain("New note.");
  });

  it("keeps an inline code surface hidden until its first character is revealed", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" markdown claimInitialText={() => true} />);
    await render(<Probe text="A `示例文本` B" markdown claimInitialText={() => true} />);
    const code = container.querySelector("code")!;
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    for (now = 1_000; now <= 1_015; now += 15) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    }
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 1_040;
    await act(async () => next[1](now));
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(false);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("例文本");
    expect(fadeRanges().map(rangeText).join("")).not.toContain("示");
    expect(code.style.getPropertyValue("--t3-smooth-surface-opacity")).toBe("");
    expect(code.textContent).toBe("示例文本");
  });

  it("grows a wrapped inline code frame with its visible characters and restores it on completion", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const rect = (x: number, y: number, width: number, height: number) =>
      new DOMRect(x, y, width, height);
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      const count = this.toString().length;
      return [
        rect(104, 202, Math.min(2, count) * 10, 16),
        ...(count > 2 ? [rect(104, 222, (count - 2) * 10, 16)] : []),
      ] as unknown as DOMRectList;
    });
    await render(<Probe text="`示例文本`" markdown claimInitialText={() => true} />);
    const code = container.querySelector("code")!;
    code.style.paddingRight = "4px";
    vi.spyOn(code, "getBoundingClientRect").mockReturnValue(rect(100, 200, 28, 40));
    vi.spyOn(code, "getClientRects").mockReturnValue([
      rect(100, 200, 28, 20),
      rect(100, 220, 28, 20),
    ] as unknown as DOMRectList);
    const step = async (time: number) => {
      now = time;
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
    };
    await step(1_000);
    expect(code.style.clipPath).toBe('path("M0,0H18V20H0Z")');
    await step(1_025);
    expect(code.style.clipPath).toBe('path("M0,0H28V20H0Z")');
    await step(1_050);
    expect(code.style.clipPath).toBe('path("M0,0H28V20H0Z M0,20H18V40H0Z")');
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("本");
    expect(code.textContent).toBe("示例文本");
    await step(1_051);
    expect(code.style.clipPath).toBe('path("M0,0H28V20H0Z M0,20H18V40H0Z")');
    await render(<Probe text="`示例文本`" markdown streaming={false} complete />);
    expect(code.style.clipPath).toBe("");
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([
    "complete",
    "disabled",
    "hidden",
    "reduced motion",
    "forced colors",
    "unmounted",
  ] as const)("restores pending inline code surfaces when %s", async (reason) => {
    mockWrappedRows(64);
    await render(<Probe text="`pending code`" frame markdown claimInitialText={() => true} />);
    const code = container.querySelector("code")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(true);
    if (reason === "complete") {
      await render(<Probe text="`pending code`" frame markdown streaming={false} complete />);
    } else if (reason === "disabled") {
      await render(<Probe text="`pending code`" frame markdown enabled={false} />);
    } else if (reason === "hidden") {
      setDocumentHidden(true);
    } else if (reason === "reduced motion") {
      getMediaQuery("(prefers-reduced-motion: reduce)").setMatches(true);
    } else if (reason === "forced colors") {
      getMediaQuery("(forced-colors: active)").setMatches(true);
    } else {
      await act(async () => root?.unmount());
      root = null;
    }
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(false);
    expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
  });

  it("shows the final character in the completion commit without waiting for the first window", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    mockWrappedRows(40);
    const onSettled = vi.fn();
    await render(<Probe text="Final answer" frame claimInitialText={() => true} />);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);

    await render(
      <Probe
        text="Final answer."
        frame
        streaming={false}
        complete
        claimInitialText={() => true}
        onSettled={onSettled}
      />,
    );
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).not.toHaveBeenCalled();
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("aligns an opening line on completion while preserving its character fades", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockLineAwareRanges();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height:
          this.dataset.smoothTextFrame !== undefined
            ? Number.parseFloat(this.style.height) || 20
            : 40,
      } as DOMRect;
    });
    await render(<Probe text="A" frame />);
    await render(<Probe text={"A\nBCDE"} frame />);
    for (now = 16; now <= 64; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
    }
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(fadeRanges().length).toBeGreaterThan(0);

    await render(<Probe text={"A\nBCDE"} frame streaming={false} complete />);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(container.querySelector<HTMLElement>("[data-smooth-text-frame]")?.style.height).toBe(
      "40px",
    );
    expect(readSmoothTextEnd(container)?.hiddenTailHeight).toBe(0);
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).not.toHaveBeenCalled();
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
    expect(container.querySelector<HTMLElement>("[data-smooth-text-frame]")?.style.height).toBe("");
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("keeps each glyph's fade clock when a provider update replaces its text node", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" />);
    await render(<Probe text="HistoryA" />);
    let next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 16;
    await act(async () => next[1](now));
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect(highlights.get("t3-smooth-fade-1")?.size).toBe(1);
    const message = container.querySelector("[data-probe]")!;
    expect(message.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);

    now = 30;
    await render(<Probe text="HistoryABC" coloredText />);
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect(fadeRanges()[0]?.startContainer).toBe(container.querySelector("span")?.firstChild);
    expect(message.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
    expect(container.querySelector("span")?.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
    next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 34;
    await act(async () => next[1](now));
    expect([...(highlights.get("t3-smooth-fade-2") ?? [])].map(rangeText)).toContain("A");
    expect(fadeRanges().map(rangeText).join("")).not.toContain("History");
  });

  it("releases a new line only after its complete glyphs fit the reserved height", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockLineAwareRanges();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height:
          this.dataset.smoothTextFrame !== undefined
            ? Number.parseFloat(this.style.height) || 20
            : this.textContent?.includes("\n")
              ? 40
              : 20,
      } as DOMRect;
    });
    await render(<Probe text="Intro" frame />);
    await render(<Probe text={"Intro\nABCDE"} frame />);
    const frameElement = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let firstAt: number | null = null;
    let secondAt: number | null = null;
    for (now = 16; now <= 320; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (!hidden.includes("A")) firstAt ??= now;
      if (!hidden.includes("B")) {
        secondAt = now;
        expect(Number.parseFloat(frameElement.style.height)).toBe(40);
        break;
      }
    }
    expect(firstAt).not.toBeNull();
    expect(secondAt).not.toBeNull();
    expect(secondAt! - firstAt!).toBeLessThan(150);
  });

  it("never rewinds a line when a provider commit paints after the next RAF timestamp", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(10);
    await render(<Probe text="Intro" frame />);
    now = 20;
    await render(<Probe text={"Intro" + "字".repeat(45)} frame />);
    const frameElement = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const step = async (timestamp: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(timestamp)));
    };
    for (let at = 40; at <= 120; at += 20) {
      now = at;
      await step(at);
    }
    const before = Number.parseFloat(frameElement.style.height);
    now = 145;
    await render(<Probe text={"Intro" + "字".repeat(46)} frame />);
    const committed = Number.parseFloat(frameElement.style.height);
    expect(committed).toBeGreaterThan(before);
    // RAF timestamps describe the start of a frame, before its queued commits.
    await step(140);
    expect(Number.parseFloat(frameElement.style.height)).toBeGreaterThanOrEqual(committed);
  });

  it("keeps fast row displacement moving while its admitted glyphs approach the handoff", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(30);
    await render(<Probe text="H" frame />);
    let text = "H";
    let arrival = 0;
    const frameElement = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let previousHeight = 20;
    let plateau = 0;
    let maxPlateau = 0;
    for (let timestamp = 4; timestamp <= 2500; timestamp += 4) {
      while (arrival * 25 <= timestamp) {
        now = arrival++ * 25;
        text += "字".repeat(10);
        await render(<Probe text={text} frame />);
      }
      now = timestamp;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frameElement.style.height);
      expect(height).toBeGreaterThanOrEqual(previousHeight);
      if (timestamp >= 1500 && height === previousHeight) {
        plateau += 4;
        maxPlateau = Math.max(maxPlateau, plateau);
      } else plateau = 0;
      previousHeight = height;
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      const visible = text.length - hidden.length;
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      const glyph = document.createRange();
      glyph.setStart(message.firstChild!, visible - 1);
      glyph.setEnd(message.firstChild!, visible);
      expect(glyph.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    }
    expect(maxPlateau).toBeLessThanOrEqual(12);
  });

  it("plays a footnote queue inside the pinned activity row without a new first window or self-blocking", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(4);
    const view = (text: string) => (
      <main>
        <div style={{ position: "sticky" }}>
          <div data-testid="timeline-live-activity-layer">
            <details open data-stream-footnotes="">
              <summary>Footnotes</summary>
              <Probe text={text} frame initialBufferMs={0} claimInitialText={() => true} />
            </details>
          </div>
        </div>
      </main>
    );
    await render(view(""));
    await render(view("ABCDEFGHIJKL"));
    const shell = container.querySelector("details")!;
    expect(MockIntersectionObserver.instances.at(-1)!.observe).toHaveBeenCalledWith(shell);
    MockIntersectionObserver.instances.at(-1)!.trigger(true);
    for (let index = 1; index <= 18; index++) {
      now = index * (1_000 / 30);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
    expect(now).toBeLessThan(1_000);
    await flushFrames();
  });

  it.each(["adaptive", "parallel"] as const)(
    "keeps a %s line masked until virtualized end-follow provides its actual viewport space",
    async (lineMode) => {
      let now = 0;
      let activityTop = 20;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(4);
      const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.dataset.testid === "timeline-live-activity-layer")
          return { top: activityTop, height: 20, bottom: activityTop + 20 } as DOMRect;
        return rect.call(this);
      });
      const content = (text: string) => (
        <main>
          <Probe text={text} frame lineMode={lineMode} />
          <div style={{ position: "sticky" }}>
            <div data-testid="timeline-live-activity-layer" />
          </div>
        </main>
      );
      await render(content("H"));
      await render(content("HABCDE"));
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      for (let at = 16; at <= 320; at += 16) await step(at);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("DE");
      expect(fadeRanges().map(rangeText).join("")).not.toContain("D");
      activityTop = 40;
      await step(336);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("D");
      expect(fadeRanges().map(rangeText)).toContain("D");
      await flushFrames();
    },
  );

  it("retries a ready row's virtual measurement instead of waiting on the next source commit", async () => {
    let now = 0;
    let activityTop = 20;
    let synchronousCommits = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(4);
    const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.testid === "timeline-live-activity-layer"
        ? ({ top: activityTop, height: 20, bottom: activityTop + 20 } as DOMRect)
        : bounds.call(this);
    });
    const view = (text: string) => (
      <main>
        <Probe text={text} frame />
        <div style={{ position: "sticky" }}>
          <div data-testid="timeline-live-activity-layer" />
        </div>
      </main>
    );
    await render(view("H"));
    const publish = (event: Event) => {
      if (!(event as CustomEvent).detail?.synchronous) return;
      synchronousCommits++;
      activityTop = Number.parseFloat((event.target as HTMLElement).style.height);
    };
    container.addEventListener("t3-smooth-text-layout", publish);
    try {
      await render(view("HABCDE"));
      for (now = 16; now <= 640 && hiddenHighlight(); now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(synchronousCommits).toBeGreaterThan(0);
      expect(hiddenHighlight()).toBeUndefined();
      expect(now).toBeLessThanOrEqual(640);
    } finally {
      container.removeEventListener("t3-smooth-text-layout", publish);
    }
    await flushFrames();
  });

  it("reveals image pixels in the same frame that end-follow makes their space", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => 300);
    const view = (image: boolean) => (
      <main style={{ overflowY: "auto" }} data-smooth-scroll-following="">
        <Probe
          text={image ? "history image" : "history"}
          frame
          richText={
            <>
              <p>H</p>
              {image && <img data-media-object="" alt="fixture" />}
            </>
          }
        />
        <div style={{ position: "sticky" }}>
          <div data-testid="timeline-live-activity-layer" />
        </div>
      </main>
    );
    await render(view(false));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const activity = container.querySelector<HTMLElement>(
      '[data-testid="timeline-live-activity-layer"]',
    )!;
    activity.getBoundingClientRect = () =>
      ({ top: Number.parseFloat(frame.style.height), height: 20 }) as DOMRect;
    await render(view(true));
    const image = container.querySelector<HTMLElement>("img")!;
    let partialFrames = 0;
    for (now = 16; now <= 280; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height);
      if (height <= 21 || height >= 319) continue;
      partialFrames++;
      expect(image.hasAttribute("data-smooth-inline-pending")).toBe(false);
      const clipped = Number(/inset\(0 0 ([\d.]+)px 0\)/u.exec(image.style.clipPath)?.[1]);
      expect(300 - clipped).toBeCloseTo(height - 20, 4);
    }
    expect(partialFrames).toBeGreaterThan(3);
    await flushFrames();
  });

  it("admits a media frame when pinned end-follow rounds its edge by a fraction of a pixel", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => 300.3);
    const view = (image: boolean, streaming = true) => (
      <main>
        <Probe
          text={image ? "history image" : "history"}
          frame
          streaming={streaming}
          richText={
            <>
              <p>H</p>
              {image && <img data-media-object="" alt="fixture" />}
            </>
          }
        />
        <div style={{ position: "sticky" }}>
          <div data-testid="timeline-live-activity-layer" />
        </div>
      </main>
    );
    await render(view(false));
    const activity = container.querySelector<HTMLElement>(
      '[data-testid="timeline-live-activity-layer"]',
    )!;
    activity.getBoundingClientRect = () => {
      const height = Number.parseFloat(
        container.querySelector<HTMLElement>("[data-smooth-text-frame]")!.style.height,
      );
      const top = Math.floor(height * 64) / 64;
      return { top, bottom: top + 20, height: 20 } as DOMRect;
    };
    await render(view(true));
    await render(view(true, false));
    for (now = 16; now <= 2_000; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    const image = container.querySelector<HTMLElement>("img")!;
    expect(image.style.getPropertyValue("--t3-smooth-surface-opacity")).toBe("");
    expect(image.style.clipPath).toBe("");
    expect(container.querySelector("[data-smooth-revealing]")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("measures newly reached rows against the moving root while end-follow scrolls", async () => {
    let now = 0;
    let rootTop = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(4);
    const originalRange = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    const originalElement = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = originalRange.call(this);
      return { ...rect, top: rect.top + rootTop, bottom: rect.bottom + rootTop };
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalElement.call(this);
      return { ...rect, top: rootTop, bottom: rootTop + rect.height };
    });
    await render(<Probe text="H" frame />);
    const text = "HABCDEFGHIJKLMNOPQRSTUVW";
    await render(<Probe text={text} frame />);
    for (now = 16; now <= 1_000 && frames.size; now += 16) {
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      const frame = message.parentElement!;
      rootTop = -Number.parseFloat(frame.style.height);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      expect(text.endsWith(hidden)).toBe(true);
      const visible = text.length - hidden.length;
      const glyph = document.createRange();
      glyph.setStart(message.firstChild!, visible - 1);
      glyph.setEnd(message.firstChild!, visible);
      expect(glyph.getBoundingClientRect().bottom - rootTop).toBeLessThanOrEqual(
        Number.parseFloat(frame.style.height) + 0.5,
      );
    }
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([
    { commitCost: 0, maxCommits: 32 },
    { commitCost: 5, maxCommits: 3 },
    { commitCost: 12, maxCommits: 1 },
  ])(
    "admits sequential subframe rows within budget, commit cost: $commitCost ms",
    async ({ commitCost, maxCommits }) => {
      let now = 0;
      let layoutCost = 0;
      let activityTop = 20;
      vi.spyOn(performance, "now").mockImplementation(() => now + layoutCost);
      mockWrappedRows(4);
      const originalBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.dataset.testid === "timeline-live-activity-layer")
          return { top: activityTop, height: 20, bottom: activityTop + 20 } as DOMRect;
        return originalBounds.call(this);
      });
      const text = "H" + "字".repeat(80);
      const content = (source: string, streaming = true) => (
        <main>
          <Probe text={source} frame streaming={streaming} />
          <div style={{ position: "sticky" }}>
            <div data-testid="timeline-live-activity-layer" />
          </div>
        </main>
      );
      await render(content("H"));
      await render(content(text));
      await render(content(text, false));
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await step(1_000);
      await step(1_034);
      const hiddenBefore = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      expect(hiddenBefore).toBeGreaterThan(4);
      const commits: number[] = [];
      const commitSpace = (event: Event) => {
        if (!(event as CustomEvent<{ synchronous?: boolean }>).detail?.synchronous) return;
        activityTop = Number.parseFloat((event.target as HTMLElement).style.height);
        commits.push(activityTop);
        layoutCost += commitCost;
      };
      container.addEventListener("t3-smooth-text-layout", commitSpace);
      try {
        await step(1_068);
        const hiddenAfter = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        expect(hiddenBefore - hiddenAfter).toBeGreaterThan(maxCommits === 1 ? 0 : 4);
        expect(commits.length).toBeGreaterThan(maxCommits === 1 ? 0 : 1);
        expect(commits.length).toBeLessThanOrEqual(maxCommits);
        for (let index = 1; index < commits.length; index++) {
          expect(commits[index]! - commits[index - 1]!).toBeGreaterThan(0);
          expect(commits[index]! - commits[index - 1]!).toBeLessThanOrEqual(20);
        }
        const visible = text.length - hiddenAfter;
        expect(Math.ceil(visible / 4) * 20).toBeLessThanOrEqual(activityTop);
      } finally {
        container.removeEventListener("t3-smooth-text-layout", commitSpace);
      }
    },
  );

  it("opens one short line at a time before releasing that line's first character", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockLineAwareRanges();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height:
          this.dataset.smoothTextFrame !== undefined
            ? Number.parseFloat(this.style.height) || 20
            : 20 + (this.textContent?.match(/\n/g)?.length ?? 0) * 20,
      } as DOMRect;
    });
    await render(<Probe text="A" frame />);
    await render(<Probe text={"A\nB\nC"} frame />);
    const frameElement = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let firstAt: number | null = null;
    let followingAt: number | null = null;
    for (now = 16; now <= 800; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (!hidden.includes("B")) firstAt ??= now;
      if (Number.parseFloat(frameElement.style.height) < 40) expect(hidden).toContain("B");
      if (Number.parseFloat(frameElement.style.height) < 60) expect(hidden).toContain("C");
      if (!hidden.includes("C")) {
        followingAt = now;
        expect(Number.parseFloat(frameElement.style.height)).toBe(60);
        break;
      }
    }
    expect(firstAt).not.toBeNull();
    expect(followingAt).not.toBeNull();
    expect(followingAt! - firstAt!).toBeLessThanOrEqual(256);
  });

  it("eases a live partial wrapped row instead of interpreting its first increment as a complete row", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(40);
    await render(<Probe text={"甲".repeat(40)} frame />);
    await render(<Probe text={"甲".repeat(40) + "乙丙丁戊"} frame />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const heights: number[] = [];
    for (let index = 1; index <= 8; index++) {
      now = index * 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      heights.push(Number.parseFloat(frame.style.height));
    }
    expect(heights.at(-1)).toBeGreaterThan(20);
    expect(heights.at(-1)).toBeLessThan(40);
    expect(heights.slice(1).filter((height, index) => height > heights[index]!)).toHaveLength(7);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("乙");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each(["ABCDEFGHIJKL", "ABCD\nEFGH\nIJKL"])(
    "admits only one complete physical row for an initial burst: %s",
    async (text) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows();
      await render(<Probe text={text} frame claimInitialText={() => true} />);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 999;
      await act(async () => next[1](now));
      expect(frame.style.height).toBe("0px");
      expect(fadeRanges()).toHaveLength(0);

      const first = frames.entries().next().value!;
      frames.delete(first[0]);
      now = 1_000;
      await act(async () => first[1](now));
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      expect(fadeRanges().map(rangeText)).toEqual(["A"]);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("EFGH");

      let previousHeight = 20;
      for (now = 1_016; now <= 1_800 && frames.size > 0; now += 16) {
        const scheduled = frames.entries().next().value!;
        frames.delete(scheduled[0]);
        await act(async () => scheduled[1](now));
        const height = Number.parseFloat(frame.style.height);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(height - previousHeight).toBeLessThanOrEqual(20);
        if (height < 36) expect(hidden).toContain("E");
        if (height < 56) expect(hidden).toContain("I");
        previousHeight = height;
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.style.height).toBe("60px");
    },
  );

  it.each(["plain", "quote", "code"] as const)(
    "keeps a trailing-newline %s burst inside sequential physical rows",
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(64);
      const claimInitialText = () => true;
      const content = (text: string) =>
        kind === "quote" ? (
          <blockquote>{text}</blockquote>
        ) : kind === "code" ? (
          <pre>{text}</pre>
        ) : undefined;
      await render(
        <Probe text="" richText={content("")} frame claimInitialText={claimInitialText} />,
      );
      await render(
        <Probe
          text={"A\nB\nC\nD\n"}
          richText={content("A\nB\nC\nD\n")}
          frame
          claimInitialText={claimInitialText}
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 999;
      await act(async () => next[1](now));
      expect(frame.style.height).toBe("0px");
      expect(fadeRanges()).toHaveLength(0);
      next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 1_000;
      await act(async () => next[1](now));
      expectPaintedGlyphsToFit();
      expect(frame.style.height).toBe("20px");
      expect(fadeRanges().map(rangeText)).toEqual(kind === "code" ? [] : ["A"]);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("B\nC\nD");
      for (now = 1_016; now <= 1_600 && frames.size > 0; now += 16) {
        const scheduled = frames.entries().next().value!;
        frames.delete(scheduled[0]);
        await act(async () => scheduled[1](now));
        expectPaintedGlyphsToFit();
        const height = Number.parseFloat(frame.style.height);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        if (hidden.includes("B")) expect(height).toBeLessThanOrEqual(40);
        if (hidden.includes("C")) expect(height).toBeLessThanOrEqual(60);
        if (hidden.includes("D")) expect(height).toBeLessThanOrEqual(80);
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.style.height).toBe("80px");
    },
  );

  it.each(["token", "atomic"] as const)(
    "admits a wrapped %s label one physical row at a time",
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows();
      const mode = kind === "token" ? "token" : "character";
      await render(<Probe text="H" frame mode={mode} />);
      await render(
        <Probe
          text="HABCDEFGH"
          frame
          mode={mode}
          richText={
            kind === "atomic" ? (
              <>
                H<button data-smooth-atomic="">ABCDEFGH</button>
              </>
            ) : undefined
          }
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      if (kind === "atomic") {
        const surface = container.querySelector<HTMLElement>("button")!;
        vi.spyOn(surface, "getClientRects").mockImplementation(
          () =>
            [
              {
                top: 0,
                bottom: 60,
                left: 0,
                right: 40,
                width: 40,
                height: 60,
              },
            ] as unknown as DOMRectList,
        );
      }
      let firstAt: number | null = null;
      for (now = 16; now <= 320 && frames.size > 0; now += 16) {
        const next = frames.entries().next().value!;
        frames.delete(next[0]);
        await act(async () => next[1](now));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        if (hidden.includes("A")) continue;
        firstAt = now;
        expectPaintedGlyphsToFit();
        if (kind === "atomic") {
          expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
          expect(hidden).toContain("D");
          const surface = container.querySelector<HTMLElement>("button")!;
          expect(surface.hasAttribute("data-smooth-inline-pending")).toBe(false);
          const opacity = surface.style.getPropertyValue("--t3-smooth-surface-opacity");
          expect(opacity ? Number.parseFloat(opacity) : 1).toBeGreaterThan(0);
          expect(surface.style.clipPath).not.toBe("");
        } else {
          expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
          expect(hidden).toContain("D");
        }
        break;
      }
      expect(firstAt).not.toBeNull();
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("drains a received token batch spanning physical rows before work completion", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows();
    await render(<Probe text="H" frame mode="token" />);
    await render(<Probe text="HABCDEFGH" frame mode="token" />);
    for (now = 16; now <= 1_600 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(container.querySelector<HTMLElement>("[data-smooth-text-frame]")?.style.height).toBe(
      "60px",
    );
  });

  it("makes room for reflowed history before releasing the next arriving glyph", async () => {
    let now = 0;
    let columns = 4;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(() => columns);
    await render(<Probe text="ABCDEFGH" frame />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(frame.style.height).toBe("40px");
    columns = 2;
    await render(<Probe text="ABCDEFGHI" frame />);
    for (now = 16; now <= 1_600 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      expect(fadeRanges().map(rangeText).join("")).not.toMatch(/[A-H]/u);
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.style.height).toBe("100px");
  });

  it("keeps newly released glyphs inside the frame when wrapping changes during playback", async () => {
    let now = 0;
    let columns = 4;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(() => columns);
    await render(<Probe text="H" frame />);
    await render(<Probe text="HABCDEFGH" frame />);
    for (now = 16; now <= 128; now += 16) {
      const first = frames.entries().next().value!;
      frames.delete(first[0]);
      await act(async () => first[1](now));
      if (fadeRanges().some((range) => rangeText(range) === "A")) break;
    }
    expect(fadeRanges().map(rangeText)).toContain("A");
    columns = 2;
    window.dispatchEvent(new Event("resize"));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now += 16; now <= 640 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      const height = Number.parseFloat(frame.style.height);
      for (const range of fadeRanges()) {
        const measurement = document.createRange();
        measurement.setStart(range.startContainer, range.startOffset);
        measurement.setEnd(range.endContainer, range.endOffset);
        expect(measurement.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
      }
    }
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("opens a new paragraph without checking every historical node for visible text", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const history = Array.from({ length: 100 }, (_, index) => <p key={index}>History</p>);
    const view = (tail: string) => (
      <Probe
        text={"History".repeat(100) + tail}
        frame
        richText={
          <>
            {history}
            {tail ? <p data-new-paragraph>{tail}</p> : null}
          </>
        }
      />
    );
    await render(view(""));
    await render(view("A BCDEFGHIJKLMNOPQRSTUVWXYZ"));
    const paragraph = container.querySelector<HTMLElement>("[data-new-paragraph]")!;
    const contains = vi.spyOn(paragraph, "contains");
    for (now = 16; now <= 1_600; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (paragraph.hasAttribute("data-smooth-line-enter")) break;
    }
    expect(paragraph.hasAttribute("data-smooth-line-enter")).toBe(true);
    expect(contains.mock.calls.length).toBeLessThan(16);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("does not walk back through a long paragraph before rejecting a repeated entrance", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const history = Array.from({ length: 100 }, (_, index) => <span key={index}>H</span>);
    const view = (tail: string) => (
      <Probe
        text={"H".repeat(100) + tail}
        frame
        richText={
          <p>
            {history}
            <span>{tail}</span>
          </p>
        }
      />
    );
    await render(view(""));
    await render(view("\nA BCDEFGHIJKLMNOPQRSTUVWXYZ"));
    const paragraph = container.querySelector<HTMLElement>("p")!;
    const contains = vi.spyOn(paragraph, "contains");
    for (now = 16; now <= 640 && frames.size > 0; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(paragraph.hasAttribute("data-smooth-line-enter")).toBe(false);
    }
    expect(contains.mock.calls.length).toBeLessThan(16);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each(["transform", "translate"])(
    "does not reserve space again for its own %s entrance during provider refreshes",
    async (property) => {
      let now = 0;
      let displacement = 2;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(64, true);
      const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        const rect = rangeBounds.call(this);
        const enter = this.startContainer.parentElement?.closest("[data-smooth-line-enter]");
        return enter?.closest('[data-probe="translated"]')
          ? { ...rect, top: rect.top + displacement, bottom: rect.bottom + displacement }
          : rect;
      });
      const style = window.getComputedStyle.bind(window);
      vi.stubGlobal("getComputedStyle", (element: Element) => {
        const result = style(element);
        return new Proxy(result, {
          get(target, key) {
            if (
              key === property &&
              element.matches('[data-probe="translated"] [data-smooth-line-enter]')
            )
              return property === "translate"
                ? `0px ${displacement}px`
                : `matrix(1, 0, 0, 1, 0, ${displacement})`;
            return Reflect.get(target, key);
          },
        });
      });
      const view = (tail: string) => (
        <>
          {["control", "translated"].map((id) => (
            <Probe
              key={id}
              id={id}
              text={"H" + tail}
              frame
              richText={
                <>
                  <p>H</p>
                  {tail ? (
                    <p>
                      <a href="https://example.com">
                        <span>{tail}</span>
                      </a>
                    </p>
                  ) : null}
                </>
              }
            />
          ))}
        </>
      );
      await render(view(""));
      await render(view("A BCDEFGHIJKLMNOPQRSTUVWXYZ"));
      for (now = 16; now <= 1_600; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        if (container.querySelector('[data-probe="translated"] [data-smooth-line-enter]')) break;
      }
      expect(
        container.querySelector('[data-probe="translated"] [data-smooth-line-enter]'),
      ).not.toBeNull();
      await render(view("A BCDEFGHIJKLMNOPQRSTUVWXYZ more"));
      for (let index = 0; index < 8; index++) {
        now += 16;
        displacement = 2 * (1 - (index + 1) / 8);
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const heights = ["control", "translated"].map((id) =>
          Number.parseFloat(
            container.querySelector<HTMLElement>(`[data-probe="${id}"]`)!.parentElement!.style
              .height,
          ),
        );
        expect(heights[1]).toBeCloseTo(heights[0]!, 5);
      }
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("keeps an unchanged mixed-font row's displacement clock through provider refreshes", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const originalRangeBounds = vi
      .mocked(Range.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = originalRangeBounds.call(this);
      return this.endContainer.parentElement?.closest("code") && this.toString()
        ? { ...rect, bottom: rect.bottom + 2, height: rect.height + 2 }
        : rect;
    });
    await render(
      <>
        <Probe id="control" text="H" frame richText={<p>H</p>} />
        <Probe id="refreshed" text="H" frame richText={<p>H</p>} />
      </>,
    );
    const content = (
      <>
        <p>H</p>
        <p>
          A<code>BCDE</code>
        </p>
      </>
    );
    const probes = (source = "HABCDE") => (
      <>
        <Probe id="control" text="HABCDE" frame richText={content} />
        <Probe id="refreshed" text="HABCDE" sourceText={source} frame richText={content} />
      </>
    );
    await render(probes());
    const frameFor = (id: string) =>
      container.querySelector<HTMLElement>(`[data-probe="${id}"]`)!.parentElement!;
    for (now = 16; now <= 32; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(now)));
    }
    expect(Number.parseFloat(frameFor("control").style.height)).toBeGreaterThan(20);
    expect(Number.parseFloat(frameFor("control").style.height)).toBeLessThan(36);
    now = 32;
    await render(probes("HABCDE "));
    now = 48;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => callbacks.forEach((callback) => callback(now)));
    expect(Number.parseFloat(frameFor("refreshed").style.height)).toBeCloseTo(
      Number.parseFloat(frameFor("control").style.height),
      5,
    );
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each(["resize observer", "window resize"] as const)(
    "fits already visible glyphs before the next frame after a %s reflow",
    async (trigger) => {
      let now = 0;
      let columns = 20;
      let notifyResize: ResizeObserverCallback | undefined;
      const observe = vi.fn();
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            notifyResize = callback;
          }
          observe = observe;
          disconnect = disconnect;
        },
      );
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(() => columns);
      await render(<Probe text="H" frame />);
      await render(<Probe text="HABCDEFGHIJKLMNOPQRSTUVWXY" frame />);
      for (now = 16; now <= 112; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(async () => callbacks.forEach((callback) => callback(now)));
      }
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      const frame = message.parentElement!;
      expect(observe).toHaveBeenCalledWith(message);
      expect(frame.style.height).toBe("20px");
      expect(fadeRanges().length).toBeGreaterThanOrEqual(4);
      const hiddenBefore = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      const fadesBefore = fadeRanges();
      const rendersBefore = renders.get("message");
      columns = 2;
      await act(async () => {
        if (trigger === "resize observer") notifyResize?.([], {} as ResizeObserver);
        else window.dispatchEvent(new Event("resize"));
      });
      expectPaintedGlyphsToFit();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hiddenBefore);
      expect(fadeRanges()).toEqual(fadesBefore);
      expect(renders.get("message")).toBe(rendersBefore);
      const fittedHeight = frame.style.height;
      await act(async () => notifyResize?.([], {} as ResizeObserver));
      expect(frame.style.height).toBe(fittedHeight);
      expect(fadeRanges()).toEqual(fadesBefore);
      await act(async () => root?.unmount());
      root = null;
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(["resize observer", "window resize"] as const)(
    "fits a reflowed visible prefix while its unchanged last row is reserving after %s",
    async (trigger) => {
      let now = 0;
      let columns = 4;
      let notifyResize: ResizeObserverCallback | undefined;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            notifyResize = callback;
          }
          observe() {}
          disconnect() {}
        },
      );
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(() => columns);
      await render(<Probe text="ABCD" frame />);
      await render(<Probe text="ABCDEF" frame />);
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      const frame = message.parentElement!;
      for (now = 2; now <= 128; now += 2) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(async () => callbacks.forEach((callback) => callback(now)));
        if (Number.parseFloat(frame.style.height) > 20) break;
      }
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(20);
      expect(Number.parseFloat(frame.style.height)).toBeLessThan(36);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("EF");
      columns = 3;
      await act(async () => {
        if (trigger === "resize observer") notifyResize?.([], {} as ResizeObserver);
        else window.dispatchEvent(new Event("resize"));
      });
      expectPaintedGlyphsToFit();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("EF");
      expect(fadeRanges()).toHaveLength(0);
      for (now += 4; now <= 600 && frames.size > 0; now += 4) {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => pending.forEach((callback) => callback(now)));
        expectPaintedGlyphsToFit();
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.style.height).toBe("40px");
    },
  );

  it.each(["initial", "appended", "incremental append", "completion snapshot"] as const)(
    "reveals a final heading from %s whose glyphs extend below its natural line box",
    async (arrival) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const message = this.matches("[data-probe]")
          ? this
          : this.querySelector<HTMLElement>("[data-probe]");
        const natural = message
          ? (message.querySelector("p") ? 20 : 0) + (message.querySelector("h1") ? 26 : 0)
          : 0;
        const explicit = Number.parseFloat(this.style.height);
        const height =
          this.hasAttribute("data-smooth-text-frame") && Number.isFinite(explicit)
            ? explicit
            : natural;
        return { top: 0, bottom: height, height, width: 640 } as DOMRect;
      });
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        if (!this.toString().trim()) return { top: 0, bottom: 0, height: 0 } as DOMRect;
        const heading = this.endContainer.parentElement?.closest("h1");
        const message = this.endContainer.parentElement?.closest("[data-probe]");
        const top = heading ? (message?.querySelector("p") ? 18 : -2) : 4;
        const height = heading ? 29 : 12;
        return { top, bottom: top + height, height, width: 10 } as DOMRect;
      });
      const appended = arrival === "appended" || arrival === "incremental append";
      const source = `${appended ? "History\n\n" : ""}# 标题单行边界`;
      await render(
        <Probe
          text={appended ? "History" : ""}
          frame
          markdown
          claimInitialText={() => !appended}
        />,
      );
      if (arrival === "incremental append") {
        await render(
          <Probe
            text="History\n\n# 标"
            frame
            richText={
              <>
                <p>History</p>
                <h1>标</h1>
              </>
            }
          />,
        );
        expect(container.querySelector("h1")?.textContent).toBe("标");
        const reservingFrame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        for (now = 2; now <= 1_600; now += 2) {
          const callbacks = [...frames.values()];
          frames.clear();
          await act(async () => callbacks.forEach((callback) => callback(now)));
          if (Number.parseFloat(reservingFrame.style.height) > 20) break;
        }
        expect(Number.parseFloat(reservingFrame.style.height)).toBeGreaterThan(20);
        expect(Number.parseFloat(reservingFrame.style.height)).toBeLessThan(47);
      }
      await render(
        <Probe
          text={source}
          frame
          markdown={arrival !== "incremental append"}
          richText={
            arrival === "incremental append" ? (
              <>
                <p>History</p>
                <h1>标题单行边界</h1>
              </>
            ) : undefined
          }
          streaming={arrival !== "completion snapshot"}
          complete={arrival === "completion snapshot"}
          claimInitialText={() => !appended}
        />,
      );
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      const frame = message.parentElement!;
      if (arrival === "completion snapshot") {
        expect(hiddenHighlight()).toBeUndefined();
        expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
        expect(frame.style.height).toBe("26px");
        expect(fadeRanges()).toHaveLength(6);
      }
      let headingStarted = false;
      for (now += 16; now <= 2_400 && frames.size > 0; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(async () => callbacks.forEach((callback) => callback(now)));
        const headingFades = fadeRanges().filter((range) =>
          range.startContainer.parentElement?.closest("h1"),
        );
        if (headingFades.length > 0) {
          headingStarted = true;
          if (arrival === "initial")
            expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
        }
        if (frame.hasAttribute("data-smooth-text-clipping")) expectPaintedGlyphsToFit();
      }
      expect(headingStarted).toBe(true);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
      expect(frame.style.height).toBe(
        arrival === "completion snapshot" ? "" : `${appended ? 46 : 26}px`,
      );
      await render(
        <Probe
          text={source}
          frame
          markdown
          streaming={false}
          complete
          claimInitialText={() => !appended}
        />,
      );
      // Switching the custom incremental fixture back to Markdown inserts a
      // separator node. Its new FIFO must still obtain space on completion.
      for (let index = 0; index < 6 && hiddenHighlight(); index++) {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
      await flushFrames();
      expect(frame.style.height).toBe("");
    },
  );

  it("keeps future rows clipped and removes the clip once the last row has space while its glyphs remain masked", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64);
    await render(<Probe text="H" frame />);
    await render(
      <Probe text={"H\nABCDEFGHIJKLMNOPQRST\n一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"} frame />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let sawFutureRowClipped = false;
    let sawAdmittedSuffixMasked = false;
    for (now = 4; now <= 1_000 && frames.size > 0; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (hidden.includes("一") && Number.parseFloat(frame.style.height) < 58) {
        expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(true);
        sawFutureRowClipped = true;
      }
      if (!frame.hasAttribute("data-smooth-text-clipping") && hidden.includes("癸")) {
        expect(Number.parseFloat(frame.style.height)).toBe(60);
        sawAdmittedSuffixMasked = true;
      }
    }
    expect(sawFutureRowClipped).toBe(true);
    expect(sawAdmittedSuffixMasked).toBe(true);
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
  });

  it.each(["最后一行尚未显示完毕", "单行末尾".repeat(10)])(
    "finishes admitted final glyphs in the completion commit while trailing space keeps moving: %s",
    async (tail) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(64, true);
      const content = (
        <>
          <p>H</p>
          <ul>
            <li>{tail}</li>
          </ul>
        </>
      );
      await render(<Probe text="H" frame richText={<p>H</p>} />);
      await render(<Probe text={"H" + tail} frame richText={content} />);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      for (now = 4; now < 1_000; now += 4) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        if (height >= 38 && height < 40 && hiddenHighlight()) break;
      }
      expect(now).toBeLessThan(1_000);
      expect(hiddenHighlight()).toBeDefined();
      const before = Number.parseFloat(frame.style.height);
      await render(<Probe text={"H" + tail} frame richText={content} streaming={false} complete />);
      expect(hiddenHighlight()).toBeUndefined();
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before);
      expectPaintedGlyphsToFit();
      await flushFrames();
      expect(frame.style.height).toBe("");
    },
  );

  it("finishes a final same-row insertion before retained footnotes in the activity completion commit", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const content = (tail: string) => (
      <>
        <p>正文{tail}</p>
        <ul>
          <li>已经显示的第一条脚注</li>
          <li>已经显示的第二条脚注</li>
        </ul>
      </>
    );
    await render(<Probe text="正文" frame richText={<p>正文</p>} />);
    await render(<Probe text="正文脚注" frame richText={content("")} />);
    await flushFrames();
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const before = frame.style.height;
    now = 1000;
    await render(
      <Probe
        text="正文收尾脚注"
        frame
        richText={content("这一行最后补齐的内容。")}
        streaming={false}
        complete
      />,
    );
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.style.height).toBe(before);
    expectPaintedGlyphsToFit();
    expect(fadeRanges().length).toBeGreaterThan(0);
    await flushFrames();
  });

  it("reserves a table's bottom border with its final row before exposing still masked cells", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const originalBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalBounds.call(this);
      const message = this.matches("[data-probe]")
        ? this
        : this.querySelector<HTMLElement>("[data-probe]");
      if (!message?.querySelector("table")) return rect;
      if (
        this.hasAttribute("data-smooth-text-frame") &&
        Number.isFinite(Number.parseFloat(this.style.height))
      )
        return rect;
      return { ...rect, height: rect.height + 8, bottom: rect.bottom + 8 };
    });
    await render(<Probe text="H" frame richText={<p>H</p>} />);
    await render(
      <Probe
        text="HABCDEFGHIJKLMNOPQRST一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"
        frame
        streaming={false}
        richText={
          <>
            <p>H</p>
            <table>
              <tbody>
                <tr>
                  <td>ABCDEFGHIJKLMNOPQRST</td>
                </tr>
                <tr>
                  <td>一二三四五六七八九十甲乙丙丁戊己庚辛壬癸</td>
                </tr>
              </tbody>
            </table>
          </>
        }
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let sawBorderAndPendingCell = false;
    for (now = 4; now <= 1_000 && frames.size > 0; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (!frame.hasAttribute("data-smooth-text-clipping") && hidden.includes("癸")) {
        expect(Number.parseFloat(frame.style.height)).toBe(68);
        sawBorderAndPendingCell = true;
      }
    }
    expect(sawBorderAndPendingCell).toBe(true);
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("does not reserve a live table's empty tail rows and toolbar while its last received row drains", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const originalBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalBounds.call(this);
      if (this.hasAttribute("data-smooth-text-frame") && this.style.height) return rect;
      const message = this.matches("[data-probe]") ? this : this.querySelector("[data-probe]");
      return message?.querySelector("table")
        ? { ...rect, height: rect.height + 60, bottom: rect.bottom + 60 }
        : rect;
    });
    const initial = (
      <>
        <p>H</p>
        <table>
          <tbody>
            <tr>
              <td>ABCDEFGHIJ</td>
            </tr>
            <tr>
              <td />
            </tr>
            <tr>
              <td />
            </tr>
          </tbody>
        </table>
      </>
    );
    await render(
      <Probe text="HABCDEFGHIJ" frame richText={initial} claimInitialText={() => true} />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 16; now <= 1_800 && frames.size > 0; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(40);
      expectPaintedGlyphsToFit();
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.style.height).toBe("40px");
    await render(<Probe text="HABCDEFGHIJ" frame richText={initial} streaming={false} />);
    await flushFrames();
    expect(frame.style.height).toBe("");
    expect(frame.getBoundingClientRect().height).toBe(100);
  });

  it("keeps the pending row's deadline when earlier layout keeps moving its glyphs", async () => {
    let now = 0;
    let shift = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = rangeBounds.call(this);
      const delta = this.startContainer.parentElement?.closest("td") ? shift : 0;
      return { ...rect, top: rect.top + delta, bottom: rect.bottom + delta };
    });
    const elementBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = elementBounds.call(this);
      return this.hasAttribute("data-probe")
        ? { ...rect, bottom: rect.bottom + shift, height: rect.height + shift }
        : rect;
    });
    const view = (tail: string) => (
      <Probe
        text={"H" + tail}
        frame
        initialBufferMs={0}
        richText={
          <>
            <p>H</p>
            <table>
              <tbody>
                <tr>
                  <td>{tail}</td>
                </tr>
              </tbody>
            </table>
          </>
        }
      />
    );
    await render(view(""));
    await render(view("ABCDEFGHIJKLMNOP"));
    for (now = 16; now <= 320; now += 16) {
      if (now >= 32) {
        shift += 6;
        await act(() => window.dispatchEvent(new Event("resize")));
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("A");
    await flushFrames();
  });

  it("animates the first row of a footnote without a second initial buffer", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    await render(<Probe text="Footnote" frame initialBufferMs={0} claimInitialText={() => true} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const heights: number[] = [];
    for (now = 0; now <= 300; now += 8) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      heights.push(Number.parseFloat(frame.style.height));
    }
    expect(heights.some((height) => height > 0 && height < 20)).toBe(true);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps a newly selected completed footnote out of the main answer's fast drain", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    await render(
      <Probe
        text={"Footnote content ".repeat(5)}
        frame
        streaming={false}
        initialBufferMs={0}
        drainOnComplete={false}
        claimInitialText={() => true}
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const heights: number[] = [];
    for (now = 0; now <= 160; now += 8) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      heights.push(Number.parseFloat(frame.style.height));
    }
    expect(heights.filter((height) => height > 0.5 && height < 19.5).length).toBeGreaterThan(4);
    expect(hiddenHighlight()).toBeDefined();
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each(["none", "image", "checkbox", "toolbar"])(
    "bounds repeated table reflow with a %s object",
    async (object) => {
      let now = 0;
      let shift = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(64, true);
      const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        const rect = rangeBounds.call(this);
        return { ...rect, top: rect.top + shift, bottom: rect.bottom + shift };
      });
      const elementBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const rect = elementBounds.call(this);
        return this.hasAttribute("data-probe")
          ? { ...rect, bottom: rect.bottom + shift, height: rect.height + shift }
          : rect;
      });
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          richText={
            <>
              {object === "image" && <img alt="history" />}
              {object === "checkbox" && <input type="checkbox" readOnly checked />}
              <table>
                <tbody>
                  <tr>
                    <td>{text}</td>
                  </tr>
                </tbody>
              </table>
              {object === "toolbar" && (
                <div data-smooth-atomic="">
                  <button>Copy</button>
                </div>
              )}
            </>
          }
        />
      );
      await render(view("H"));
      shift = 10;
      await act(() => window.dispatchEvent(new Event("resize")));
      await render(view("HABCDEFGHIJKLMNOP"));
      for (now = 16; now <= 208; now += 16) {
        if (now % 32 === 0) {
          shift += 2;
          await act(() => window.dispatchEvent(new Event("resize")));
        }
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("A");
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("keeps glyphs visible after a font metric reflow at unchanged content width", async () => {
    let now = 0;
    let columns = 20;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(() => columns, false, false, 200);
    await render(<Probe text="H" frame />);
    await render(<Probe text="HABCDEFGHIJKLMN" frame />);
    const message = container.querySelector<HTMLElement>("[data-probe]")!;
    const frame = message.parentElement!;
    let released = "";
    let fadeForA: AbstractRange | undefined;
    for (now = 16; now <= 160 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      fadeForA = fadeRanges().find((range) => rangeText(range) === "A");
      if (!fadeForA) continue;
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      released = [...message.textContent!].filter((glyph) => !hidden.includes(glyph)).join("");
      if (released.length < 4) continue;
      break;
    }
    expect(fadeForA).toBeDefined();
    expect(released.length).toBeGreaterThanOrEqual(4);
    expect(frame.style.height).toBe("20px");
    expect(message.getBoundingClientRect().width).toBe(200);
    const rendersBeforeReflow = renders.get("message");
    columns = 3;
    expect(message.getBoundingClientRect().width).toBe(200);
    for (now += 16; now <= 640 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      expectPaintedGlyphsToFit();
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      for (const glyph of released) expect(hidden).not.toContain(glyph);
      const fadingA = fadeRanges().find((range) => rangeText(range) === "A");
      if (fadingA) expect(fadingA).toBe(fadeForA);
    }
    expect(renders.get("message")).toBe(rendersBeforeReflow);
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.style.height).toBe("100px");
  });

  it("drains a wrapped atomic file label before work completion", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows();
    await render(<Probe text="H" frame />);
    await render(
      <Probe
        text="HABCDEFGH"
        frame
        richText={
          <>
            H<button data-smooth-atomic="">ABCDEFGH</button>
          </>
        }
      />,
    );
    for (now = 16; now <= 1_600 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(container.querySelector("button")?.hasAttribute("data-smooth-inline-pending")).toBe(
      false,
    );
  });

  it("plays a reserved row's motion with character fades without duplicating or recoloring text", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows();
    await render(<Probe text="H" frame coloredText />);
    const span = container.querySelector("span")!;
    const textNode = span.firstChild!;
    span.style.color = "rgb(90, 140, 180)";
    await render(<Probe text={"H\nABCDE"} frame coloredText />);
    const selection = window.getSelection()!;
    const selected = document.createRange();
    selected.setStart(textNode, 0);
    selected.setEnd(textNode, 1);
    selection.addRange(selected);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const bucketFor = (glyph: string) =>
      [...highlights.entries()]
        .filter(([name]) => name.startsWith("t3-smooth-fade-"))
        .find(([, highlight]) => [...highlight].some((range) => rangeText(range) === glyph))?.[0];
    let firstAt: number | null = null;
    let firstFade: AbstractRange | undefined;
    for (now = 16; now <= 320 && frames.size > 0; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(now)));
      const bucket = bucketFor("A");
      if (!bucket) continue;
      firstAt = now;
      firstFade = fadeRanges().find((range) => rangeText(range) === "A");
      expect(firstFade).toBeDefined();
      expect(fadeRanges().filter((range) => rangeText(range) === "A")).toHaveLength(1);
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(36);
      expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(40);
      expect(span.style.getPropertyValue("--t3-smooth-foreground")).toBe("rgb(90, 140, 180)");
      break;
    }
    expect(firstAt).not.toBeNull();
    for (now = firstAt! + 16; now <= firstAt! + 128; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(now)));
    }
    const settledMotion = bucketFor("A");
    expect(settledMotion).toBeDefined();
    expect(fadeRanges()).toContain(firstFade);
    expect(span.style.color).toBe("rgb(90, 140, 180)");
    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(span.firstChild).toBe(textNode);
    expect(selection.toString()).toBe("H");
    expect(span.textContent).toBe("H\nABCDE");
    await flushFrames();
    expect(span.style.getPropertyValue("--t3-smooth-foreground")).toBe("");
    selection.removeAllRanges();
  });

  it("prepares actual Markdown blocks while cached and admits formatted glyphs by physical row", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(4, true);
    await render(
      <Probe text={"## ABCD\n\nEF `GHIJ"} frame markdown claimInitialText={() => true} />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("ABCD");
    const code = container.querySelector("code")!;
    expect(code.textContent).toBe("GHIJ");
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    const source = "## ABCD\n\nEF `GHIJ`\n\n| K | L |\n|---|---|\n| M | N |";
    now = 200;
    await render(<Probe text={source} frame markdown claimInitialText={() => true} />);
    expect(container.querySelector("code")).toBe(code);
    expect(code.textContent).toBe("GHIJ");
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/[|`#]/u);
    expect(fadeRanges()).toHaveLength(0);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(frame.style.height).toBe("0px");

    let firstAt: number | null = null;
    for (now = 992; now <= 2_400 && frames.size > 0; now += 16) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](now));
      const height = Number.parseFloat(frame.style.height);
      for (const range of fadeRanges()) {
        expect(rangeText(range)).toHaveLength(1);
        const measurement = document.createRange();
        measurement.setStart(range.startContainer, range.startOffset);
        measurement.setEnd(range.endContainer, range.endOffset);
        expect(measurement.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
      }
      if (fadeRanges().some((range) => rangeText(range) === "A")) firstAt ??= now;
    }
    expect(firstAt).toBe(1_008);
    expect(hiddenHighlight()).toBeUndefined();
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(false);
    expect(code.style.clipPath).toBe("");
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it.each([false, true])(
    "keeps a sustained high-rate stream of one-character rows from accumulating a growing tail, with initial window: %s",
    async (bufferInitial) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(64);
      let text = "H";
      const claimInitialText = () => bufferInitial;
      await render(<Probe text={text} frame claimInitialText={claimInitialText} />);
      const warmup = bufferInitial ? 1_000 : 0;
      const streamEnd = warmup + 1_200;
      const backlog: Array<{ at: number; characters: number }> = [];
      for (now = 1; now <= streamEnd; now++) {
        if (now % 10 === 0) {
          text += "\nX";
          await render(<Probe text={text} frame claimInitialText={claimInitialText} />);
        }
        if (now % 16 !== 0 || frames.size === 0) continue;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(async () => callbacks.forEach((callback) => callback(now)));
        backlog.push({
          at: now,
          characters: [...(hiddenHighlight() ?? [])].map(rangeText).join("").replace(/\s/gu, "")
            .length,
        });
      }
      const early = backlog.filter(
        (sample) => sample.at >= warmup + 400 && sample.at < warmup + 800,
      );
      const late = backlog.filter((sample) => sample.at >= warmup + 800);
      expect(
        Math.max(...late.map((sample) => sample.characters)),
        JSON.stringify(backlog.filter((sample) => sample.at % 160 === 0)),
      ).toBeLessThanOrEqual(40);
      expect(backlog.at(-1)!.characters).toBeLessThanOrEqual(
        Math.max(...early.map((sample) => sample.characters)) + 4,
      );
      for (now = streamEnd + 16; now <= streamEnd + 500 && frames.size > 0; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(async () => callbacks.forEach((callback) => callback(now)));
      }
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each([1, 3, 5])(
    "keeps a row's first glyph advancing while increments arrive every %s ms",
    async (arrivalInterval) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(64);
      await render(<Probe text="H" frame />);
      let text = "H\nA";
      await render(<Probe text={text} frame />);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let reservationAt: number | null = null;
      for (now = 16; now <= 128; now += 16) {
        const next = frames.entries().next().value!;
        frames.delete(next[0]);
        await act(async () => next[1](now));
        if (Number.parseFloat(frame.style.height) > 20) {
          reservationAt = now;
          break;
        }
      }
      expect(reservationAt).not.toBeNull();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("A");
      text += "\n";
      let firstGlyphAt: number | null = null;
      for (now = reservationAt! + 1; now <= reservationAt! + 240; now++) {
        if ((now - reservationAt!) % arrivalInterval === 0) {
          text += "Z";
          await render(<Probe text={text} frame />);
        }
        if (now % 16 !== 0 || frames.size === 0) continue;
        const next = frames.entries().next().value!;
        frames.delete(next[0]);
        await act(async () => next[1](now));
        if (![...(hiddenHighlight() ?? [])].map(rangeText).join("").includes("A"))
          firstGlyphAt ??= now;
      }
      expect(firstGlyphAt).not.toBeNull();
      expect(firstGlyphAt! - reservationAt!).toBeLessThanOrEqual(112);
    },
  );

  it.each([false, true])(
    "keeps a visible tail word inside its frame when an append moves it onto a new row, with inline code: %s",
    async (inlineCode) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(8, inlineCode, true);
      const source = (word: string) => (inlineCode ? `H \`${word}\`` : `H ${word}`);
      await render(<Probe text={source("abcdef")} frame markdown={inlineCode} />);
      expectPaintedGlyphsToFit();
      await render(<Probe text={source("abcdefg")} frame markdown={inlineCode} />);
      expectPaintedGlyphsToFit();
      for (now = 16; now <= 320 && frames.size > 0; now += 16) {
        const next = frames.entries().next().value!;
        frames.delete(next[0]);
        await act(async () => next[1](now));
        expectPaintedGlyphsToFit();
      }
      expect(hiddenHighlight()).toBeUndefined();
      if (inlineCode) {
        expect(container.querySelector("code")?.textContent).toBe("abcdefg");
        expect(container.querySelector("code")?.style.clipPath).toBe("");
      }
    },
  );

  it("waits for terminal code to render before draining and reporting completion", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.probe === "message") return { height: 60 } as DOMRect;
      if (this.dataset.smoothTextFrame !== undefined) {
        return { height: Number.parseFloat(this.style.height) || 0 } as DOMRect;
      }
      return getBoundingClientRect.call(this);
    });
    const onSettled = vi.fn();
    const claimInitialText = () => true;
    await render(
      <Probe
        text="AB"
        sourceText={"```js\nAB\n```"}
        codePending
        frame
        streaming={false}
        claimInitialText={claimInitialText}
        onSettled={onSettled}
      />,
    );
    expect(onSettled).not.toHaveBeenCalled();
    const observer = MockIntersectionObserver.instances.at(-1)!;
    expect(observer.disconnect).not.toHaveBeenCalled();
    await flushFrames();
    expect(frames.size).toBe(0);
    expect(container.querySelector<HTMLElement>("[data-smooth-text-frame]")?.style.height).toBe(
      "0px",
    );
    now = 800;
    await render(
      <Probe
        text="AB"
        sourceText={"```js\nAB\n```"}
        codeBlock
        frame
        streaming={false}
        claimInitialText={claimInitialText}
        onSettled={onSettled}
      />,
    );
    for (const [time, hidden] of [
      [999, "AB"],
      [1_000, "B"],
    ] as const) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => callbacks.forEach((callback) => callback(time)));
      expect(
        [...(hiddenHighlight() ?? [])].map(rangeText).join(""),
        container.querySelector<HTMLElement>("[data-smooth-text-frame]")?.style.height,
      ).toBe(hidden);
    }
    await flushFrames();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("starts the window with unpainted source tokens, before Markdown has visible text", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" sourceText="```js" claimInitialText={() => true} />);
    now = 800;
    await render(<Probe text="A" sourceText={"```js\nA"} claimInitialText={() => true} />);
    for (const [time, hidden] of [
      [999, "A"],
      [1_000, ""],
    ] as const) {
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](time));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
    }
  });

  it("does not reopen a restored source's window while its code is still unpainted", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" sourceText="```js" claimInitialText={() => false} />);
    now = 800;
    await render(<Probe text="A" sourceText={"```js\nA"} claimInitialText={() => false} />);
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    await act(async () => next[1](821));
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([true, false])(
    "buffers a new message's first mounted text even when streaming is %s",
    async (streaming) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      const onSettled = vi.fn();
      await render(
        <Probe
          text="中文🙂"
          streaming={streaming}
          claimInitialText={() => true}
          onSettled={onSettled}
        />,
      );
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("中文🙂");
      expect(onSettled).not.toHaveBeenCalled();
      for (const [now, hidden] of [
        [999, "中文🙂"],
        [1_000, "文🙂"],
        [1_010, "文🙂"],
        [1_025, "🙂"],
        [1_050, ""],
      ] as const) {
        const next = frames.entries().next().value!;
        frames.delete(next[0]);
        await act(async () => next[1](now));
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
      }
      expect(onSettled.mock.calls).toHaveLength(streaming ? 0 : 1);
    },
  );

  it.each([true, false])(
    "keeps the initial buffer through StrictMode when streaming is %s",
    async (streaming) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      let claimed = false;
      const claimInitialText = () => {
        const isNew = !claimed;
        claimed = true;
        return isNew;
      };
      await render(
        <StrictMode>
          <Probe text="ABC" streaming={streaming} claimInitialText={claimInitialText} />
        </StrictMode>,
      );
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABC");
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      await act(async () => next[1](999));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABC");
    },
  );

  it("keeps a received message visible when virtualization mounts it again", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const seen = new Set<string>();
    const claimInitialText = () => {
      const isNew = !seen.has("message");
      seen.add("message");
      return isNew;
    };
    await render(<Probe text="ABC" claimInitialText={claimInitialText} />);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    await render(null);
    await render(<Probe text="ABC" claimInitialText={claimInitialText} />);
    expect(hiddenHighlight()).toBeUndefined();
    await render(<Probe text="ABCD" claimInitialText={claimInitialText} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("D");
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    await act(async () => next[1](21));
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps a new multi-line burst out of layout until its characters start playing", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    mockLineAwareRanges();
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.probe === "message") return { height: 60 } as DOMRect;
      if (this.dataset.smoothTextFrame !== undefined) {
        return { height: Number.parseFloat(this.style.height) || 0 } as DOMRect;
      }
      return getBoundingClientRect.call(this);
    });
    await render(<Probe text={"A\nB\nC"} frame claimInitialText={() => true} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(frame.style.height).toBe("0px");
    const first = frames.entries().next().value!;
    frames.delete(first[0]);
    await act(async () => first[1](999));
    expect(frame.style.height).toBe("0px");
    expect(fadeRanges()).toHaveLength(0);
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    await act(async () => next[1](1_000));
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("B\nC");
    await flushFrames();
    expect(frame.style.height).toBe("60px");
  });

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
    expect(fadeRanges().map(rangeText)).toEqual([]);
  });

  it("fades only newly revealed ranges across successive appends", async () => {
    const history = "Existing history.";
    await render(<Probe text={history} />);
    expect(fadeRanges()).toHaveLength(0);

    await render(<Probe text={`${history} new`} />);
    const firstFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(firstFrame).toBeDefined();
    frames.delete(firstFrame![0]);
    await act(async () => firstFrame![1](performance.now() + 1_030));
    await flushMutations();
    const secondFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(secondFrame).toBeDefined();
    frames.delete(secondFrame![0]);
    await act(async () => secondFrame![1](performance.now() + 1_080));
    await flushMutations();
    const firstFadeRanges = fadeRanges();
    expect(firstFadeRanges.length).toBeGreaterThan(0);
    expect(firstFadeRanges.map(rangeText).join("")).not.toContain(history);

    await render(<Probe text={`${history} new words`} />);
    const afterAppendRanges = fadeRanges();
    expect(afterAppendRanges).toEqual(expect.arrayContaining(firstFadeRanges));
    expect(afterAppendRanges.map(rangeText).join("")).not.toContain(history);

    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
  });

  it.each([false, true])(
    "keeps the glyph's computed color until every fade on its parent ends, with an existing property: %s",
    async (hasExistingProperty) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      await render(<Probe text="History" coloredText />);
      const code = container.querySelector("span")!;
      const property = "--t3-smooth-foreground";
      code.style.color = "rgb(90, 140, 180)";
      if (hasExistingProperty) code.style.setProperty(property, "rgb(8, 9, 10)", "important");
      const previousValue = code.style.getPropertyValue(property);
      const previousPriority = code.style.getPropertyPriority(property);
      const foreground = getComputedStyle(code).color;
      expect(foreground).toBe("rgb(90, 140, 180)");
      await render(<Probe text="HistoryAB" coloredText />);

      for (const frameTime of [16, 48]) {
        const next = frames.entries().next().value!;
        frames.delete(next[0]);
        now = frameTime;
        await act(async () => next[1](now));
      }
      expect(fadeRanges().map(rangeText)).toEqual(expect.arrayContaining(["A", "B"]));
      expect(code.style.getPropertyValue(property)).toBe(foreground);

      let next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 204;
      await act(async () => next[1](now));
      expect(fadeRanges().map(rangeText)).toEqual(["B"]);
      expect(code.style.getPropertyValue(property)).toBe(foreground);

      next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 236;
      await act(async () => next[1](now));
      expect(fadeRanges()).toHaveLength(0);
      expect(code.style.getPropertyValue(property)).toBe(previousValue);
      expect(code.style.getPropertyPriority(property)).toBe(previousPriority);
      expect(getComputedStyle(code).color).toBe(foreground);
      expect(frames.size).toBe(0);
    },
  );

  it.each(["class", "style", "data-theme-id"] as const)(
    "caches an active parent's inherited color across appends and refreshes it for a root %s theme change",
    async (attribute) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const documentRoot = document.documentElement;
      const originalAttribute = documentRoot.getAttribute(attribute);
      const themeAttribute = (value: string) =>
        attribute === "class"
          ? `smooth-test-${value}`
          : attribute === "style"
            ? `--smooth-test-theme: ${value};`
            : `smooth-test-${value}`;
      const selector = (value: string) =>
        attribute === "class"
          ? `html.smooth-test-${value}`
          : `html[${attribute}="${themeAttribute(value)}"]`;
      const themeStyles = document.createElement("style");
      themeStyles.textContent = `${selector("one")} [data-probe]{color:rgb(90,140,180)}${selector("two")} [data-probe]{color:rgb(220,130,40)}`;
      document.head.append(themeStyles);
      documentRoot.setAttribute(attribute, themeAttribute("one"));
      try {
        await render(<Probe text="History" coloredText />);
        const span = container.querySelector("span")!;
        const property = "--t3-smooth-foreground";
        span.style.setProperty(property, "rgb(8, 9, 10)", "important");
        expect(getComputedStyle(span).color).toBe("rgb(90, 140, 180)");
        await render(<Probe text="HistoryAB" coloredText />);
        const first = frames.entries().next().value!;
        frames.delete(first[0]);
        now = 16;
        await act(async () => first[1](now));
        expect(span.style.getPropertyValue(property)).toBe("rgb(90, 140, 180)");
        expect(fadeRanges().map(rangeText)).toContain("A");
        const computedStyles = vi.spyOn(globalThis, "getComputedStyle");
        for (const tail of ["ABC", "ABCD", "ABCDE"]) {
          now += 4;
          await render(<Probe text={`History${tail}`} coloredText />);
          expect(span.style.getPropertyValue(property)).toBe("rgb(90, 140, 180)");
        }
        expect(computedStyles.mock.calls.filter(([element]) => element === span)).toHaveLength(0);
        const activeBeforeTheme = fadeRanges();
        documentRoot.setAttribute(attribute, themeAttribute("two"));
        await flushMutations();
        expect(getComputedStyle(span).color).toBe("rgb(220, 130, 40)");
        expect(span.style.getPropertyValue(property)).toBe("rgb(220, 130, 40)");
        expect(fadeRanges()).toEqual(activeBeforeTheme);
        expect(span.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
        await flushFrames();
        expect(span.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
        expect(span.style.getPropertyValue(property)).toBe("rgb(8, 9, 10)");
        expect(span.style.getPropertyPriority(property)).toBe("important");
        expect(getComputedStyle(span).color).toBe("rgb(220, 130, 40)");
      } finally {
        await render(null);
        themeStyles.remove();
        if (originalAttribute === null) documentRoot.removeAttribute(attribute);
        else documentRoot.setAttribute(attribute, originalAttribute);
      }
    },
  );

  it.each([
    "complete",
    "reduced motion",
    "forced colors",
    "hidden document",
    "offscreen",
    "disabled",
    "unmounted",
  ] as const)("restores the original color property and priority when %s", async (reason) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" coloredText />);
    const code = container.querySelector("span")!;
    const property = "--t3-smooth-foreground";
    code.style.color = "rgb(90, 140, 180)";
    code.style.setProperty(property, "rgb(8, 9, 10)", "important");
    const originalValue = code.style.getPropertyValue(property);
    await render(<Probe text="HistoryABCDE" coloredText />);
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 16;
    await act(async () => next[1](now));
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect(code.style.getPropertyValue(property)).toBe(getComputedStyle(code).color);
    expect(code.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);

    if (reason === "complete") {
      await render(<Probe text="HistoryABCDE" coloredText streaming={false} complete />);
      expect(fadeRanges().length).toBeGreaterThan(0);
      await flushFrames();
    } else if (reason === "reduced motion") {
      getMediaQuery("(prefers-reduced-motion: reduce)").setMatches(true);
    } else if (reason === "forced colors") {
      getMediaQuery("(forced-colors: active)").setMatches(true);
    } else if (reason === "hidden document") {
      setDocumentHidden(true);
    } else if (reason === "offscreen") {
      MockIntersectionObserver.instances.at(-1)!.trigger(false);
    } else if (reason === "disabled") {
      await render(<Probe text="HistoryABCDE" coloredText enabled={false} />);
    } else {
      await act(async () => root?.unmount());
      root = null;
    }
    expect(fadeRanges()).toHaveLength(0);
    expect(code.style.getPropertyValue(property)).toBe(originalValue);
    expect(code.style.getPropertyPriority(property)).toBe("important");
    expect(code.style.color).toBe("rgb(90, 140, 180)");
    expect(code.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("restores an existing fade marker and foreground property after the last active glyph", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" coloredText />);
    const span = container.querySelector("span")!;
    span.setAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE, "previous-owner");
    span.style.setProperty("--t3-smooth-foreground", "rgb(8, 9, 10)", "important");
    span.style.color = "rgb(90, 140, 180)";
    await render(<Probe text="HistoryA" coloredText />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));

    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect(span.getAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe("previous-owner");
    expect(span.style.getPropertyValue("--t3-smooth-foreground")).toBe("rgb(90, 140, 180)");
    await flushFrames();
    expect(span.getAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe("previous-owner");
    expect(span.style.getPropertyValue("--t3-smooth-foreground")).toBe("rgb(8, 9, 10)");
    expect(span.style.getPropertyPriority("--t3-smooth-foreground")).toBe("important");
  });

  it("transfers a retained Text node's active fade marker and color to its new parent", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" coloredText />);
    const previousParent = container.querySelector("span")!;
    previousParent.style.color = "rgb(90, 140, 180)";
    await render(<Probe text="HistoryABCDE" coloredText />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const active = fadeRanges()[0]!;
    const textNode = previousParent.firstChild!;
    expect(previousParent.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
    const nextParent = document.createElement("strong");
    nextParent.style.color = "rgb(220, 130, 40)";
    previousParent.append(nextParent);
    nextParent.append(textNode);
    now = 20;
    await flushMutations();

    expect(fadeRanges().some((range) => range === active)).toBe(true);
    expect(active.startContainer.parentElement).toBe(nextParent);
    expect(previousParent.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
    expect(previousParent.style.getPropertyValue("--t3-smooth-foreground")).toBe("");
    expect(nextParent.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
    expect(nextParent.style.getPropertyValue("--t3-smooth-foreground")).toBe("rgb(220, 130, 40)");
    await flushFrames();
    expect(nextParent.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
    expect(nextParent.style.getPropertyValue("--t3-smooth-foreground")).toBe("");
  });

  it("keeps a nested parent's fade marker and own color after its ancestor's last fade ends", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const content = (tail = false) => (
      <span style={{ color: "rgb(90, 140, 180)" }}>
        History{tail ? "A" : ""}
        <strong style={{ color: "rgb(220, 130, 40)" }}>{tail ? "B" : ""}</strong>
      </span>
    );
    await render(<Probe text="History" richText={content()} />);
    await render(<Probe text="HistoryAB" richText={content(true)} />);
    for (const time of [16, 48]) {
      now = time;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    const ancestor = container.querySelector("span")!;
    const child = container.querySelector("strong")!;
    expect(ancestor.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
    expect(child.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
    expect(child.style.getPropertyValue("--t3-smooth-foreground")).toBe("rgb(220, 130, 40)");

    now = 200;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(fadeRanges().map(rangeText)).toEqual(["B"]);
    expect(ancestor.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
    expect(child.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(true);
    expect(child.style.getPropertyValue("--t3-smooth-foreground")).toBe("rgb(220, 130, 40)");
    await flushFrames();
    expect(child.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
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
    frame.addEventListener("t3-smooth-text-layout", layoutEvents);

    await render(<Probe text={"A\nnew line"} frame />);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(fadeRanges().map(rangeText)).toEqual([]);
    expect(frame.style.height).toBe("20px");

    let now = performance.now();
    let newLineFadeQueued = false;
    for (let index = 0; index < 32 && frame.style.height !== "40px"; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      now += 50;
      await act(async () => next![1](now));
      await flushMutations();
      newLineFadeQueued ||= fadeRanges().some((range) => rangeText(range) === "n");
    }

    expect(frame.style.height).toBe("40px");
    expect(layoutEvents.mock.calls.length).toBeGreaterThan(1);
    for (let index = 0; index < 8 && !newLineFadeQueued; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) break;
      frames.delete(next[0]);
      now += 16;
      await act(async () => next[1](now));
      newLineFadeQueued ||= fadeRanges().some((range) => rangeText(range) === "n");
    }
    expect(newLineFadeQueued).toBe(true);
    // Height can settle after the FIFO has drained; it never gates its cadence.
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
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
      const callbacks = [...frames.values()];
      expect(callbacks.length).toBeGreaterThan(0);
      frames.clear();
      now += 16;
      await act(async () => callbacks.forEach((callback) => callback(now)));
      await flushMutations();
      if (fadeRanges().some((range) => rangeText(range) === "B")) {
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
    expect(Number.parseFloat(frame.style.height)).toBe(40);
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
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("TypeScript");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("Copy code");

    await flushFrames();
    await act(async () => container.querySelector("button")!.click());
    expect(copied).toHaveBeenCalledWith(nextText);
    expect(code.textContent).toBe(nextText);
    expect(selection.toString()).toBe(original);
  });

  it("drains the terminal tail and disconnects its observers and animation frame", async () => {
    const observeMutations = vi.spyOn(MutationObserver.prototype, "observe");
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
    expect(disconnectMutations).toHaveBeenCalled();
    for (const mutationObserver of new Set(observeMutations.mock.contexts))
      expect(disconnectMutations.mock.contexts).toContain(mutationObserver);
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
    for (let index = 0; index < 2; index += 1) {
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

  it("does not rescan long Markdown for code-pending status on each playback frame", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const text = "持续播放正文".repeat(60);
    await render(<Probe text="" frame claimInitialText={() => true} />);
    await render(<Probe text={text} frame richText={<p>{text}</p>} />);
    const message = container.querySelector<HTMLElement>("[data-probe]")!;
    const query = vi.spyOn(message, "querySelector");
    for (let index = 0; index < 12; index++) {
      now = 1_050 + index * (1_000 / 60);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(query.mock.calls.some(([selector]) => selector === "[data-markdown-code-pending]")).toBe(
      false,
    );
    expect(fadeRanges().length).toBeGreaterThan(0);
    await flushFrames();
  });

  it("tracks an attribute-only code loading state and completes after it clears", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const finished = vi.fn();
    const text = "尚待绘制的代码正文";
    const content = (
      <pre>
        <code>{text}</code>
      </pre>
    );
    await render(<Probe text="" claimInitialText={() => true} onPlaybackComplete={finished} />);
    await render(<Probe text={text} richText={content} onPlaybackComplete={finished} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(text);
    const pre = container.querySelector("pre")!;
    await act(() => pre.setAttribute("data-markdown-code-pending", ""));
    await flushMutations();
    expect([...(hiddenHighlight() ?? [])].map(rangeText)).toEqual([]);
    await render(
      <Probe
        text={text}
        richText={content}
        streaming={false}
        complete
        onPlaybackComplete={finished}
      />,
    );
    expect(finished).not.toHaveBeenCalled();
    now = 100;
    await act(() => pre.removeAttribute("data-markdown-code-pending"));
    await flushMutations();
    await flushFrames();
    expect(finished).toHaveBeenCalledOnce();
    expect(container.querySelector("code")!.textContent).toBe(text);
  });

  it("ignores decorative icon swaps and loads while the pending text keeps playing", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(20, true);
    const text = "输出正文".repeat(60);
    await render(<Probe text="" frame claimInitialText={() => true} />);
    await render(
      <Probe
        text={text}
        frame
        richText={
          <p>
            <a href="https://example.com">
              <span aria-hidden="true">
                <img alt="" />
              </span>
              {text}
            </a>
          </p>
        }
      />,
    );
    now = 1_050;
    let callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    await flushMutations();
    const before = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
    expect(before).toBeGreaterThan(0);
    const icon = container.querySelector('[aria-hidden="true"]')!;
    const image = icon.querySelector("img")!;
    const scan = vi.spyOn(document, "createTreeWalker");
    await act(() => {
      image.dispatchEvent(new Event("load"));
      image.dispatchEvent(new Event("error"));
      icon.replaceChildren(document.createElement("svg"));
    });
    await flushMutations();
    expect(scan).not.toHaveBeenCalled();
    // A favicon load also updates opacity classes inside its excluded shell.
    await act(() => icon.firstElementChild!.classList.add("opacity-100"));
    await flushMutations();
    expect(scan.mock.calls.length).toBe(0);
    for (let index = 0; index < 5; index++) {
      now += 1_000 / 60;
      callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden.length).toBeLessThan(before);
    expect(text.endsWith(hidden)).toBe(true);
    expectPaintedGlyphsToFit();
    await flushFrames();
  });

  it("does not replay a painted footnote when its navigation backlinks are updated", async () => {
    const content = (repeated: boolean) => (
      <p>
        已显示的脚注正文
        <a href="#ref-one" data-footnote-backref="">
          {repeated ? "↩1" : "↩"}
        </a>
        {repeated && (
          <a href="#ref-two" data-footnote-backref="">
            ↩2
          </a>
        )}
      </p>
    );
    await render(<Probe text="已显示的脚注正文" richText={content(false)} />);
    expect(hiddenHighlight()).toBeUndefined();
    await render(<Probe text="已显示的脚注正文" richText={content(true)} />);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges()).toEqual([]);
    expect(container.querySelectorAll("[data-footnote-backref]")).toHaveLength(2);
  });

  it("retains painted code when a preceding reference resolves while its tokens are replaced", async () => {
    const code = "const value = 1;\nconsole.log(value);";
    const content = (resolved: boolean, appended = "") => (
      <>
        <p>{resolved ? <a href="#note">1</a> : "[^note]"}</p>
        <pre>
          <code
            dangerouslySetInnerHTML={{
              __html: resolved ? `<span>${code}${appended}</span>` : code,
            }}
          />
        </pre>
      </>
    );
    await render(<Probe text={`[^note]${code}`} richText={content(false)} />);
    const pre = container.querySelector("pre");
    const appended = "\nnewCode();";
    await render(<Probe text={`1${code}${appended}`} richText={content(true, appended)} />);
    expect(container.querySelector("pre")).toBe(pre);
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden).not.toContain(code);
    expect(hidden).toContain(appended);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps painted punctuation when a late footnote marker splits its text node", async () => {
    await render(<Probe text="正文。" richText={<p>正文。</p>} />);
    await render(
      <Probe
        text="正文1。"
        richText={
          <p>
            正文<a href="#note">1</a>。
          </p>
        }
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("1");
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps unread code masked through token replacement and a preceding reference rewrite", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const code = "const first = 1;\nconst second = 2;\nconst third = 3;";
    const view = (resolved: boolean, source = code) => (
      <Probe
        text={`${resolved ? "1" : "[^note]"}${source}`}
        initialBufferMs={0}
        richText={
          <>
            <p>{resolved ? <a href="#note">1</a> : "[^note]"}</p>
            <pre>
              <code
                dangerouslySetInnerHTML={{
                  __html: resolved ? `<span>${source}</span>` : source,
                }}
              />
            </pre>
          </>
        }
      />
    );
    await render(view(false, ""));
    await render(view(false));
    const hiddenCode = () =>
      [...(hiddenHighlight() ?? [])]
        .filter((range) => range.startContainer.parentElement?.closest("pre"))
        .map(rangeText)
        .join("");
    for (let step = 0; step < 30 && hiddenCode().length === code.length; step++) {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    const before = hiddenCode();
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(code.length);
    await render(view(true, `${code}\nnewCode();`));
    expect(hiddenCode()).toBe(`${before}\nnewCode();`);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("publishes the FIFO edge without scanning a preloaded Markdown suffix each frame", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const history = <p>History</p>;
    await render(<Probe text="History" richText={history} />);
    await render(
      <Probe
        text={"History" + "AB".repeat(600)}
        richText={
          <>
            {history}
            {Array.from({ length: 600 }, (_, index) => (
              <span key={index}>AB</span>
            ))}
          </>
        }
      />,
    );
    const tail = container.querySelector("span:last-child")!.firstChild as Text;
    const readTailLength = vi.spyOn(tail, "length", "get");

    for (let index = 0; index < 4; index++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => pending.forEach((callback) => callback(now)));
      await flushMutations();
    }

    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(readSmoothTextEnd(container)?.bottom).toBeGreaterThan(0);
    expect([...(hiddenHighlight() ?? [])].some((entry) => entry.startContainer === tail)).toBe(
      true,
    );
    expect(readTailLength).not.toHaveBeenCalled();
  });

  it("leaves distant hidden Markdown ranges untouched as the FIFO prefix fades", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const history = <p>History</p>;
    await render(<Probe text="History" richText={history} />);
    await render(
      <Probe
        text={"History" + "AB".repeat(600)}
        richText={
          <>
            {history}
            {Array.from({ length: 600 }, (_, index) => (
              <span key={index}>AB</span>
            ))}
          </>
        }
      />,
    );
    const tail = container.querySelector("span:last-child")!.firstChild as Text;
    const tailMask = [...hiddenHighlight()!].find((range) => range.startContainer === tail)!;
    const readTailEndpoint = vi.spyOn(tailMask, "endOffset", "get");

    for (let index = 0; index < 4; index++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => pending.forEach((callback) => callback(now)));
      await flushMutations();
    }

    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(hiddenHighlight()?.has(tailMask)).toBe(true);
    expect(readTailEndpoint).not.toHaveBeenCalled();
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
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
    for (let index = 0; index < 26; index += 1) {
      const nextFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!nextFrame) break;
      frames.delete(nextFrame[0]);
      now += 50;
      await act(async () => nextFrame[1](now));
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

  it("keeps up with 120 characters per second on a 60 Hz display with separate glyph fades", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" claimInitialText={() => true} sourceText="" />);
    let text = "";
    let maxAdvance = 0;
    let previousVisible = 0;
    for (let frame = 0; frame <= 480; frame++) {
      now = (frame * 1_000) / 60;
      if (frame % 6 === 0) {
        text += "abcdefghijkL";
        await render(<Probe text={text} sourceText={text} />);
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      const visible = text.length - hidden;
      maxAdvance = Math.max(maxAdvance, visible - previousVisible);
      previousVisible = visible;
      if (now < 1_000) expect(visible).toBe(0);
      for (const range of fadeRanges()) expect(rangeText(range)).toHaveLength(1);
    }
    expect(maxAdvance).toBeGreaterThan(1);
    expect(text.length - previousVisible).toBeLessThan(24);
    // Each glyph gets its own age, rather than fading a provider batch together.
    expect(
      [...highlights].filter(
        ([name, ranges]) => name.startsWith("t3-smooth-fade-") && ranges.size > 0,
      ).length,
    ).toBeGreaterThan(1);
  });

  it.each([false, true])(
    "plays explicit lines in FIFO order with a soft line transition, frame: %s",
    async (frame) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(20);
      const text = "ABCDEFGHIJ\n一二三四五六七八九十";
      await render(<Probe text={text} frame={frame} claimInitialText={() => true} />);
      const advance = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await advance(999);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(text);
      await advance(1_000);
      expect(fadeRanges().map(rangeText)).toEqual(["A"]);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(text.slice(1));
      let precedingLastAt: number | null = null;
      let followingFirstAt: number | null = null;
      for (now = 1_008; now <= 1_500; now += 8) {
        await advance(now);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(text.endsWith(hidden)).toBe(true);
        const fading = fadeRanges().map(rangeText);
        for (const glyph of fading) expect(glyph).toHaveLength(1);
        if (fading.includes("J")) precedingLastAt ??= now;
        if (!fading.includes("一")) continue;
        followingFirstAt = now;
        expect(hidden).not.toMatch(/[A-J]/u);
        expect("二三四五六七八九十".endsWith(hidden)).toBe(true);
        expect(fading).toContain("J");
        break;
      }
      expect(precedingLastAt).not.toBeNull();
      expect(followingFirstAt).not.toBeNull();
      expect(followingFirstAt! - precedingLastAt!).toBeLessThan(180);
      await flushFrames();
    },
  );

  it("preserves the FIFO prefix and active glyph clocks through character/token mode changes", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const firstBatch = "A".repeat(90);
    const text = firstBatch + "A".repeat(90) + "\nB";
    await render(<Probe text="" claimInitialText={() => true} />);
    await render(<Probe text={firstBatch} />);
    now = 100;
    await render(<Probe text={text} />);
    now = 1_000;
    let callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const initialFades = fadeRanges();
    expect(initialFades.map(rangeText)).toEqual(["A"]);
    const hiddenBefore = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hiddenBefore).toBe("A".repeat(179) + "\nB");
    await render(<Probe text={text} mode="token" />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hiddenBefore);
    expect(fadeRanges()).toEqual(initialFades);
    callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hiddenBefore);
    now = 1_013;
    callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const hiddenAfterToken = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(text.endsWith(hiddenAfterToken)).toBe(true);
    expect(hiddenAfterToken.length).toBeLessThan(hiddenBefore.length);
    expect(hiddenBefore.length - hiddenAfterToken.length).toBeLessThanOrEqual(32);
    for (const range of initialFades) expect(fadeRanges()).toContain(range);
    expect(fadeRanges().map(rangeText)).not.toContain("B");
    now = 1_014;
    await render(<Probe text={text} mode="character" />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hiddenAfterToken);
    for (const range of initialFades) expect(fadeRanges()).toContain(range);
    now = 1_015;
    await render(<Probe text={text} mode="character" streaming={false} complete />);
    for (now = 1_023; now <= 1_143 && hiddenHighlight(); now += 8) {
      callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(hiddenHighlight()).toBeUndefined();
    for (const range of initialFades) expect(fadeRanges()).toContain(range);
    expect(fadeRanges().filter((range) => rangeText(range) === "B")).toHaveLength(1);
    await flushFrames();
    expect(highlights.size).toBe(0);
  });

  it("keeps automatic wrapping on the preceding character's clock", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return { bottom: this.endOffset > 5 ? 40 : 20, height: 10 } as DOMRect;
    });
    await render(<Probe text="ABCDEFGHIJ" claimInitialText={() => true} />);
    now = 1_000;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BCDEFGHIJ");
    await flushFrames();
  });

  it("publishes the FIFO reading edge and reaches a later line after its preceding text", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockLineAwareRanges();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height:
          this.dataset.smoothTextFrame !== undefined
            ? Number.parseFloat(this.style.height) || 0
            : 40,
      } as DOMRect;
    });
    await render(<Probe text={"A".repeat(180) + "\nB"} frame claimInitialText={() => true} />);
    let precedingSamples = 0;
    let reachedLaterLine = false;
    for (let index = 0; index <= 150; index++) {
      now = 1_000 + index * (1_000 / 60);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const bottom = readSmoothTextEnd(container)?.bottom;
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      if (bottom === 40) reachedLaterLine = true;
      if (hidden.includes("A")) {
        precedingSamples++;
        expect(bottom).toBe(20);
        expect(hidden).toContain("B");
      }
      expect(bottom).toBe(reachedLaterLine ? 40 : 20);
    }
    expect(precedingSamples).toBeGreaterThan(10);
    expect(reachedLaterLine).toBe(true);
    await flushFrames();
  });

  it.each(["hard break", "formatted break", "paragraph", "list", "table"] as const)(
    "plays a Markdown %s's next line after its preceding text on the same character clock",
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const text = {
        "hard break": "ABCDEFGHIJ  \n一二三四五六七八九十",
        "formatted break": "**ABCDEFGHIJ**\n**一二三四五六七八九十**",
        paragraph: "ABCDEFGHIJ\n\n一二三四五六七八九十",
        list: "- ABCDEFGHIJ\n- 一二三四五六七八九十",
        table:
          "| ABCDEFGHIJ | KLMNOPQRST |\n| --- | --- |\n| 一二三四五六七八九十 | 甲乙丙丁戊己庚辛壬癸 |",
      }[kind];
      await render(<Probe text={text} markdown claimInitialText={() => true} />);
      let nextLineStarted = false;
      let precedingTextStarted = false;
      for (now = 1_000; now <= 2_000; now += 8) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const fading = fadeRanges().map(rangeText);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        if (fading.includes("A")) precedingTextStarted = true;
        for (const glyph of fading) expect(glyph).toHaveLength(1);
        if (!fading.includes("一")) {
          expect(hidden).toContain("一二三四五六七八九十");
          continue;
        }
        nextLineStarted = true;
        expect(precedingTextStarted).toBe(true);
        expect(hidden).not.toMatch(kind === "table" ? /[A-T]/u : /[A-J]/u);
        expect(hidden).toContain("二三四五六七八九十");
        if (kind === "table") expect(hidden).toContain("甲乙丙丁戊己庚辛壬癸");
        break;
      }
      expect(nextLineStarted).toBe(true);
      await flushFrames();
    },
  );

  it("clips inline code to its FIFO prefix while a later line remains queued", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        return [
          {
            left: 0,
            right: this.toString().length * 10,
            top: 0,
            bottom: 20,
            width: 10,
            height: 20,
          },
        ];
      },
    });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      { left: 0, right: 100, top: 0, bottom: 20 } as DOMRect,
    ] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
    } as DOMRect);
    await render(
      <Probe text={"`ABCDEFGHIJ`\n一二三四五六七八九十"} markdown claimInitialText={() => true} />,
    );
    now = 1_000;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(fadeRanges()).toHaveLength(0);
    expect(container.querySelector("code")?.style.clipPath).toContain("H10");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(
      "一二三四五六七八九十",
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("BCDEFGHIJ");
    await flushFrames();
  });

  it("keeps up with short lines without waiting for each height animation to settle", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockLineAwareRanges();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height:
          this.dataset.smoothTextFrame !== undefined
            ? Number.parseFloat(this.style.height) || 0
            : 20 + (this.textContent?.match(/\n/g)?.length ?? 0) * 20,
      } as DOMRect;
    });
    await render(<Probe text="" frame claimInitialText={() => true} />);
    let text = "";
    for (let frame = 0; frame <= 480; frame++) {
      now = (frame * 1_000) / 60;
      if (frame % 6 === 0) {
        text += "一二三四五\n六七八九十\n";
        await render(<Probe text={text} frame />);
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      for (const range of fadeRanges()) expect(rangeText(range)).toHaveLength(1);
      if (now < 1_000) expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(text);
    }
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden.length).toBeLessThan(40);
    const visible = text.slice(0, text.length - hidden.length);
    const visibleHeight = (visible.match(/\n/g)?.length ?? 0) * 20;
    const height = Number.parseFloat(
      container.querySelector<HTMLElement>("[data-smooth-text-frame]")!.style.height,
    );
    expect(height).toBeGreaterThanOrEqual(visibleHeight - 20);
  });

  it.each([
    { fps: 30, mode: "token" as const },
    { fps: 60, mode: "token" as const },
    { fps: 120, mode: "token" as const },
    { fps: 240, mode: "token" as const },
    { fps: 30, mode: "auto" as const },
    { fps: 60, mode: "auto" as const },
    { fps: 120, mode: "auto" as const },
    { fps: 240, mode: "auto" as const },
  ])(
    "keeps $mode backlog bounded with more input batches than $fps Hz frames",
    async ({ fps, mode }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      await render(<Probe text="" mode={mode} claimInitialText={() => true} />);
      let text = "";
      let usedBatchFades = false;
      const backlog: Array<{ at: number; size: number }> = [];
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      for (let index = 1; index <= fps * 6; index++) {
        const frameAt = (index * 1_000) / fps;
        const batches = 240 / fps;
        for (let batch = 0; batch < batches; batch++) {
          now = ((index - 1) * 1_000) / fps + (batch * 1_000) / 240;
          text += "字流动";
          await render(<Probe text={text} mode={mode} />);
        }
        await step(frameAt);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        if (frameAt < 1_000) expect(hidden).toBe(text.length);
        if (frameAt >= 3_000) backlog.push({ at: frameAt, size: hidden });
        if (
          fadeRanges().some((range) =>
            range.startContainer === range.endContainer
              ? range.endOffset - range.startOffset > 1
              : rangeText(range).length > 1,
          )
        )
          usedBatchFades = true;
      }
      expect(usedBatchFades).toBe(mode === "token" || fps <= 60);
      const early = backlog.filter((sample) => sample.at < 4_000);
      const late = backlog.filter((sample) => sample.at >= 5_000);
      const mean = (samples: typeof backlog) =>
        samples.reduce((sum, sample) => sum + sample.size, 0) / samples.length;
      expect(mean(late)).toBeLessThan(100);
      expect(mean(late)).toBeLessThanOrEqual(mean(early) + 8);
      for (let index = 1; index <= fps; index++) await step(6_000 + (index * 1_000) / fps);
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toHaveLength(0);
      // Returning to character mode must work during draining, without another
      // source update to reset the switch clock or restart the first window.
      now = 7_000;
      text += "下一段文字";
      await render(<Probe text={text} mode={mode} />);
      await step(7_000 + 1_000 / fps);
      const fading = fadeRanges().map(rangeText);
      expect(fading.length).toBeGreaterThan(0);
      if (mode === "auto") expect(fading.every((glyph) => glyph.length === 1)).toBe(true);
      else expect(fading).toContain("下一段文字");
    },
  );

  it.each([
    { fps: 30, mode: "token" as const },
    { fps: 60, mode: "token" as const },
    { fps: 240, mode: "token" as const },
    { fps: 30, mode: "auto" as const },
    { fps: 60, mode: "auto" as const },
    { fps: 240, mode: "auto" as const },
  ])(
    "keeps short $mode fragments balanced at 1600 characters/s and $fps Hz",
    async ({ fps, mode }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      await render(<Probe text="" mode={mode} claimInitialText={() => true} />);
      let text = "";
      let batch = 0;
      let previousVisible = 0;
      const late: number[] = [];
      for (let index = 1; index <= fps * 6; index++) {
        const at = (index * 1_000) / fps;
        while ((batch * 1_000) / 800 < at) {
          now = (batch++ * 1_000) / 800;
          text += "字流";
          await render(<Probe text={text} mode={mode} />);
        }
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(text.endsWith(hidden)).toBe(true);
        const visible = text.length - hidden.length;
        expect(visible - previousVisible).toBeLessThanOrEqual(128);
        previousVisible = visible;
        if (at >= 5_000) late.push(hidden.length);
      }
      // Check the live queue before completion can accelerate or flush its tail.
      expect(late.reduce((sum, count) => sum + count, 0) / late.length).toBeLessThan(128);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("").length).toBeLessThan(128);
      await render(<Probe text={text} mode={mode} streaming={false} complete />);
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("retains token fades through a short empty queue while incoming output remains fast", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" mode="auto" claimInitialText={() => true} />);
    let text = "";
    const step = async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    for (let index = 1; index <= 90; index++) {
      for (let batch = 0; batch < 5; batch++) {
        now = ((index - 1) * 1_000) / 30 + (batch * 1_000) / 150;
        text += "字流动速";
        await render(<Probe text={text} mode="auto" />);
      }
      now = (index * 1_000) / 30;
      await step();
    }
    for (let index = 0; index < 8; index++) {
      now += 1_000 / 30;
      await step();
    }
    expect(hiddenHighlight()).toBeUndefined();
    text += "甲乙丙丁";
    await render(<Probe text={text} mode="auto" />);
    now += 1_000 / 30;
    await step();
    expect(fadeRanges().map(rangeText)).toContain("甲乙丙丁");
    await flushFrames();
  });

  it("yields costly token work between frames while preserving the unread FIFO", async () => {
    let now = 0;
    let workMs = 0;
    let measure = false;
    vi.spyOn(performance, "now").mockImplementation(() => now + workMs);
    const NativeStaticRange = StaticRange;
    vi.stubGlobal(
      "StaticRange",
      class extends NativeStaticRange {
        constructor(init: StaticRangeInit) {
          super(init);
          if (measure) workMs += 4;
        }
      },
    );
    const text = "字流".repeat(256);
    await render(<Probe text="" mode="token" initialBufferMs={0} claimInitialText={() => true} />);
    await render(<Probe text={text} mode="token" initialBufferMs={0} />);
    measure = true;
    const pending: number[] = [];
    for (let index = 1; index <= 60 && frames.size > 0; index++) {
      now = (index * 1_000) / 30;
      workMs = 0;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      expect(text.endsWith(hidden)).toBe(true);
      pending.push(hidden.length);
    }
    expect(pending[0]).toBeGreaterThan(text.length - 128);
    expect(pending[0]).toBeLessThan(text.length);
    expect(pending.at(-1)).toBe(0);
  });

  it("keeps an empty Markdown toolbar on the fast text clock rather than the media clock", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMediaRows(() => 24);
    const view = (text: string, toolbar = false) => (
      <Probe
        text={text + (toolbar ? "tail".repeat(20) : "")}
        frame
        mode="auto"
        initialBufferMs={0}
        claimInitialText={() => true}
        richText={
          <>
            <p>{text}</p>
            {toolbar ? (
              <>
                <div data-smooth-atomic="" data-media-object="">
                  <button>
                    <svg />
                  </button>
                </div>
                <p data-media-tail="">{"tail".repeat(20)}</p>
              </>
            ) : null}
          </>
        }
      />
    );
    await render(view(""));
    const step = async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    let text = "";
    for (let index = 1; index <= 60; index++) {
      now = (index * 1_000) / 30;
      text += "字".repeat(20);
      await render(view(text));
      await step();
    }
    await render(view(text, true));
    for (let index = 0; index < 5; index++) {
      now += 1_000 / 30;
      await step();
    }
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden.length).toBeLessThan(80);
    const toolbar = container.querySelector<HTMLElement>("[data-media-object]")!;
    expect(toolbar.hasAttribute("data-smooth-inline-pending")).toBe(false);
    await flushFrames();
  });

  it("recovers from irregular frames and repeated main-thread stalls without replaying an unbounded batch", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" mode="auto" claimInitialText={() => true} />);
    const intervals = [4.17, 16.67, 33.33, 16.67, 50, 120, 16.67, 33.33];
    let text = "";
    let arrival = 0;
    let at = 0;
    let previousVisible = 0;
    const late: number[] = [];
    for (let index = 0; at < 6_000; index++) {
      at += intervals[index % intervals.length]!;
      while (arrival <= at) {
        now = arrival;
        arrival += 10;
        text += "字流动甲乙丙";
        await render(<Probe text={text} mode="auto" />);
      }
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const pending = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      const visible = text.length - pending;
      expect(visible - previousVisible).toBeLessThanOrEqual(128);
      previousVisible = visible;
      if (at > 4_000) late.push(pending);
    }
    expect(late.reduce((sum, count) => sum + count, 0) / late.length).toBeLessThan(128);
    await render(<Probe text={text} mode="auto" streaming={false} />);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
  });

  it("keeps ordinary source output in character mode while catching up on a 30Hz page", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" mode="auto" claimInitialText={() => true} />);
    let text = "";
    let previousBatch = -1;
    let played = false;
    for (let index = 0; index < 180; index++) {
      now = (index * 1_000) / 30;
      const batch = Math.floor(now / 100);
      if (batch !== previousBatch) {
        previousBatch = batch;
        text += "字".repeat(20);
        await render(<Probe text={text} mode="auto" />);
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const fading = fadeRanges().map(rangeText);
      if (fading.length) played = true;
      expect(fading.every((glyph) => glyph.length === 1)).toBe(true);
    }
    expect(played).toBe(true);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("").length).toBeLessThan(30);
    await flushFrames();
  });

  it.each([
    { fps: 30, lineMode: "adaptive" as const },
    { fps: 240, lineMode: "adaptive" as const },
    { fps: 30, lineMode: "parallel" as const },
    { fps: 240, lineMode: "parallel" as const },
  ])(
    "keeps fast physical lines bounded and inside their frame with $lineMode at $fps Hz",
    async ({ fps, lineMode }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(20);
      await render(
        <Probe text="" frame mode="auto" lineMode={lineMode} claimInitialText={() => true} />,
      );
      let text = "";
      let batch = 0;
      const late: number[] = [];
      for (let index = 1; index <= fps * 6; index++) {
        const at = (index * 1_000) / fps;
        while ((batch * 1_000) / 120 < at) {
          now = (batch++ * 1_000) / 120;
          text += "流动字符甲乙\n";
          await render(<Probe text={text} frame mode="auto" lineMode={lineMode} />);
        }
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(text.endsWith(hidden)).toBe(true);
        let visibleEnd = text.length - hidden.length;
        while (visibleEnd > 0 && /\s/u.test(text[visibleEnd - 1]!)) visibleEnd--;
        if (visibleEnd > 0) {
          const message = container.querySelector<HTMLElement>("[data-probe]")!;
          const glyph = document.createRange();
          glyph.setStart(message.firstChild!, visibleEnd - 1);
          glyph.setEnd(message.firstChild!, visibleEnd);
          expect(glyph.getBoundingClientRect().bottom).toBeLessThanOrEqual(
            Number.parseFloat(message.parentElement!.style.height) + 0.5,
          );
        }
        if (now >= 5_000) late.push(hidden.length);
      }
      expect(late.reduce((sum, count) => sum + count, 0) / late.length).toBeLessThan(100);
      await render(
        <Probe text={text} frame mode="auto" lineMode={lineMode} streaming={false} complete />,
      );
      // Completion may contain several short rows. They must obtain their
      // space within the drain window instead of being exposed in its commit.
      expectPaintedGlyphsToFit();
      for (let index = 0; index < Math.ceil(fps / 10) && hiddenHighlight(); index++) {
        now += 1_000 / fps;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        if (frame.style.height) expectPaintedGlyphsToFit();
      }
      expect(hiddenHighlight()).toBeUndefined();
      await flushFrames();
      expect(frames.size).toBe(0);
    },
  );

  it("drains short dense Markdown through sequential pinned reservations at 30 Hz", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const source =
      Array.from(
        { length: 10 },
        (_, index) =>
          `## 阶段 ${index + 1}\n\n正文**格式内容**与 \`code-${index}\`，继续稳定输出。\n\n` +
          `| 项目 | 状态 |\n|---|---|\n| 检查${index} | 已完成 |\n| 渐入 | 正常 |\n\n` +
          "- 每行单独让位\n- 保持工具记录\n\n",
      ).join("") + "末尾段落继续逐字符输出。".repeat(12);
    const view = (text: string, streaming = true) => (
      <main>
        <Probe
          text={text}
          frame
          markdown
          mode="auto"
          streaming={streaming}
          claimInitialText={() => true}
        />
        <div style={{ position: "sticky" }}>
          <div data-testid="timeline-live-activity-layer" />
        </div>
      </main>
    );
    await render(view(""));
    const activity = container.querySelector<HTMLElement>(
      '[data-testid="timeline-live-activity-layer"]',
    )!;
    activity.getBoundingClientRect = () => {
      const height = container
        .querySelector<HTMLElement>("[data-smooth-text-frame]")!
        .getBoundingClientRect().height;
      return { top: height, bottom: height, height: 0 } as DOMRect;
    };
    const lastArrivalAt = (Math.ceil(source.length / 30) - 1) * 30;
    let arrival = 0;
    for (let frame = 1; (frame * 1_000) / 30 < lastArrivalAt + 220; frame++) {
      const at = (frame * 1_000) / 30;
      while (arrival * 30 <= Math.min(at, lastArrivalAt)) {
        now = arrival * 30;
        const end = Math.min(source.length, ++arrival * 30);
        await render(view(source.slice(0, end), end < source.length));
      }
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const edge = readSmoothTextEnd(container);
      if (edge?.bottom !== null && edge?.bottom !== undefined)
        expect(edge.bottom).toBeLessThanOrEqual(activity.getBoundingClientRect().top);
    }
    expect([...(hiddenHighlight() ?? [])].map(rangeText)).toEqual([]);
    expect(readSmoothTextEnd(container)?.hiddenTailHeight).toBe(0);
    await flushFrames();
  });

  it("drains dense Markdown before work ends with a 30 Hz display", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(64, true);
    const source =
      ("**动态正文**与`行内代码`，".repeat(14) + "\n\n").repeat(12) +
      "\n|甲|乙|\n|---|---|\n" +
      Array.from({ length: 12 }, (_, index) => `|${index}行内容|第二列文本|`).join("\n") +
      "\n\n末尾逐字衔接。";
    await render(<Probe text="" frame markdown mode="auto" claimInitialText={() => true} />);
    const lastArrivalAt = (Math.ceil(source.length / 30) - 1) * 30;
    let arrival = 0;
    for (let frame = 1; (frame * 1_000) / 30 < lastArrivalAt + 220; frame++) {
      const at = (frame * 1_000) / 30;
      while (arrival * 30 <= Math.min(at, lastArrivalAt)) {
        now = arrival * 30;
        const end = Math.min(source.length, ++arrival * 30);
        await render(
          <Probe
            text={source.slice(0, end)}
            frame
            markdown
            mode="auto"
            streaming={end < source.length}
          />,
        );
      }
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(container.querySelector("[data-probe]")!.textContent).toContain("末尾逐字衔接。");
  });

  it("keeps individual character fades when work ends with a queued tail", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" coloredText />);
    await render(<Probe text="HistoryABCDE" coloredText />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const existingRange = fadeRanges()[0]!;
    const existingBucket = [...highlights].find(([, ranges]) => ranges.has(existingRange))?.[0];
    now = 20;
    await render(<Probe text="HistoryABCDEFGH" coloredText streaming={false} complete />);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().map(rangeText)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect([...(highlights.get(existingBucket!) ?? [])].map(rangeText)).toContain("A");
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).not.toHaveBeenCalled();
    now = 28;
    const fadeCallbacks = [...frames.values()];
    frames.clear();
    await act(() => fadeCallbacks.forEach((callback) => callback(now)));
    expect(
      [...highlights].filter(([name, ranges]) => name.startsWith("t3-smooth-fade-") && ranges.size)
        .length,
    ).toBeGreaterThan(1);
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a completed token snapshot's fade together without restarting a previous batch", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" mode="token" />);
    await render(<Probe text="HistoryABCDE" mode="token" />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(fadeRanges().map(rangeText)).toEqual(["ABCDE"]);
    now = 20;
    await render(<Probe text="HistoryABCDEFGH" mode="token" streaming={false} complete />);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().map(rangeText)).toEqual(["ABCDE", "FGH"]);
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("plays a literal emphasis pair's arriving tail before the work completion commit", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const history = "History\n\n";
    const literalPair = "说明：**包含中文标点。**";
    const tail = "后续正文继续逐字显示".repeat(8);
    await render(<Probe text={history} markdown />);
    expect(container.textContent).toBe("History");
    let suffix = "";
    let previousVisible = 0;
    let animatedFrames = 0;
    for (let frame = 0; frame <= 156; frame++) {
      now = (frame * 1_000) / 60;
      if (frame % 6 === 0) {
        suffix = literalPair + tail.slice(0, (frame / 6 + 1) * 3);
        await render(<Probe text={history + suffix} markdown />);
        // CommonMark leaves this pair literal; its following text must still
        // enter the playback queue while the turn is running.
        expect(container.querySelector("p:last-child")?.textContent).toBe(suffix);
        expect(container.querySelector("strong")).toBeNull();
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      const visible = suffix.length - hidden;
      expect(visible - previousVisible).toBeLessThan(6);
      previousVisible = visible;
      const fading = fadeRanges();
      for (const range of fading) expect(rangeText(range)).toHaveLength(1);
      if (fading.length > 0 && frame > 60) animatedFrames++;
    }
    expect(animatedFrames).toBeGreaterThan(60);
    const queuedAtCompletion = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
    expect(queuedAtCompletion).toBeLessThan(9);
    const previousDomLength = container.textContent!.length;
    const finalSuffix = suffix + "末尾字";
    now += 7;
    await render(<Probe text={history + finalSuffix} markdown streaming={false} complete />);
    expect(container.querySelector("p:last-child")?.textContent).toBe(finalSuffix);
    expect(container.textContent!.length - previousDomLength).toBe(3);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().length).toBeGreaterThan(0);
    for (const range of fadeRanges()) expect(rangeText(range)).toHaveLength(1);
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("plays a 53-character completed snapshot before work ends 187 ms later", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const text = "字".repeat(120);
    await render(<Probe text={text} claimInitialText={() => true} />);
    const advanceFrame = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    for (let frame = 0; frame <= 180; frame++) await advanceFrame((frame * 1_000) / 60);
    expect(hiddenHighlight()).toBeUndefined();

    const finalText = text + "末".repeat(53);
    await render(<Probe text={finalText} streaming={false} />);
    let previousHidden = 53;
    let intermediateFrames = 0;
    for (let frame = 1; frame <= 10; frame++) {
      await advanceFrame(3_000 + (frame * 1_000) / 60);
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      if (hidden > 0 && hidden < 53) intermediateFrames++;
      expect(previousHidden - hidden).toBeLessThan(16);
      for (const range of fadeRanges()) expect(rangeText(range)).toHaveLength(1);
      previousHidden = hidden;
    }
    expect(intermediateFrames).toBeGreaterThan(1);
    expect(previousHidden).toBe(0);
    expect(fadeRanges().length).toBeGreaterThan(0);

    now = 3_187;
    await render(<Probe text={finalText} streaming={false} complete />);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(container.textContent).toBe(finalText);
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("keeps the completion deadline when only two slow display frames arrive", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" />);
    await render(<Probe text="HistoryA" />);
    now = 16;
    const initialCallbacks = [...frames.values()];
    frames.clear();
    await act(() => initialCallbacks.forEach((callback) => callback(now)));
    now = 1_000;
    await render(<Probe text={"HistoryA" + "尾".repeat(53)} streaming={false} />);
    const visible: number[] = [];
    for (const at of [1_080, 1_160]) {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      visible.push(53 - [...(hiddenHighlight() ?? [])].map(rangeText).join("").length);
    }
    expect(visible[0]).toBeGreaterThan(12);
    expect(visible[0]).toBeLessThan(53);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().length).toBeGreaterThan(0);
  });

  it.each([30, 60, 240])(
    "drains a short final structural tail within 100ms at %s Hz before activity teardown",
    async (fps) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(24, true);
      await render(<Probe text="History" frame richText={<p>History</p>} />);
      const tail = "一段正文接着显示结束".repeat(4);
      await render(
        <Probe
          text={"History" + tail}
          frame
          streaming={false}
          richText={
            <>
              <p>History</p>
              <ul>
                <li>{tail}</li>
              </ul>
            </>
          }
        />,
      );
      for (let index = 1; index <= Math.ceil(fps / 10); index++) {
        now = (index * 1000) / fps;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expectPaintedGlyphsToFit();
      }
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each([30, 60, 240].flatMap((fps) => [false, true].map((complete) => ({ fps, complete }))))(
    "keeps short plain-text completion rows behind their space at $fps Hz (complete=$complete)",
    async ({ fps, complete }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockWrappedRows(40);
      await render(<Probe text="History" frame />);
      const text = "History\nA\nB\nC\nD\nE\nF";
      await render(<Probe text={text} frame streaming={false} complete={complete} />);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("A\nB\nC\nD\nE\nF");
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      const heights = new Set<number>();
      for (let index = 1; index <= fps && frames.size; index++) {
        now = (index * 1_000) / fps;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        if (frame.style.height) {
          expectPaintedGlyphsToFit();
          heights.add(Number.parseFloat(frame.style.height));
        } else expect(hiddenHighlight()).toBeUndefined();
      }
      expect(heights.size).toBeGreaterThan(3);
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("keeps a long completion tail in the FIFO instead of revealing it in the close commit", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const history = "History";
    const tail = "尾".repeat(160);
    await render(<Probe text={history} frame />);
    await render(<Probe text={history + tail} frame streaming={false} complete />);
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden.length).toBeGreaterThan(128);
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(at)));
    };
    now = 1_016;
    await step(now);
    const after = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(after.length).toBeLessThan(hidden.length);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([false, true])(
    "drains an already mounted tail without an append, framed: %s",
    async (framed) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      if (framed) mockWrappedRows(32, true);
      await render(<Probe text="History" frame={framed} />);
      const text = "History" + "尾".repeat(120);
      await render(<Probe text={text} frame={framed} />);
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await step(1_000);
      expect(hiddenHighlight()?.size).toBeGreaterThan(0);
      await render(<Probe text={text} frame={framed} streaming={false} />);
      let intermediate = 0;
      for (let index = 1; index <= 10; index++) {
        await step(1_000 + index * 17);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        if (hidden > 0 && hidden < 120) intermediate++;
      }
      expect(intermediate).toBeGreaterThan(1);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
      expect(fadeRanges().length).toBeGreaterThan(0);
    },
  );

  it("preserves character playback and fades across a transient offscreen layout during fast output", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" claimInitialText={() => true} />);
    await render(<Probe text={"字".repeat(200)} />);
    const observer = MockIntersectionObserver.instances.at(-1)!;
    observer.trigger(false);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toHaveLength(200);
    expect(frames.size).toBe(0);
    now = 200;
    await render(<Probe text={"字".repeat(400)} />);
    observer.trigger(true);
    now = 1_000;
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    await act(async () => next[1](now));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toHaveLength(399);
    expect(fadeRanges().map(rangeText).join("")).toBe("字");
    await flushFrames(500);
  });

  it.each(["reduced motion", "forced colors", "hidden document"] as const)(
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

  it("advances masks and character fades without replacing their registered highlight objects", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const register = highlights.set.bind(highlights);
    let redundantRegistrations = 0;
    vi.spyOn(highlights, "set").mockImplementation((name, highlight) => {
      if (highlights.get(name) === highlight) redundantRegistrations++;
      return register(name, highlight);
    });
    await render(<Probe text="History" />);
    await render(<Probe text={"History" + "字".repeat(80)} />);
    const initialHidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
    for (let frame = 1; frame <= 6; frame++) {
      now = (frame * 1_000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      for (const range of fadeRanges()) expect(rangeText(range)).toHaveLength(1);
    }
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("").length).toBeLessThan(
      initialHidden,
    );
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(redundantRegistrations).toBe(0);
    await flushFrames();
    expect(highlights.size).toBe(0);
  });

  it("measures appended text before clearing the previous glyph fades", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(24);
    await render(<Probe text="History" frame />);
    await render(<Probe text="HistoryABCDE" frame />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const active = fadeRanges()[0]!;
    expect(rangeText(active)).toBe("A");
    const probe = container.querySelector<HTMLElement>("[data-probe]")!;
    const bounds = probe.getBoundingClientRect();
    let firstGeometryReadRetainedFade: boolean | undefined;
    vi.spyOn(probe, "getBoundingClientRect").mockImplementation(() => {
      firstGeometryReadRetainedFade ??= fadeRanges().includes(active);
      return bounds;
    });
    now = 20;
    await render(<Probe text="HistoryABCDEFGH" frame />);
    expect(firstGeometryReadRetainedFade).toBe(true);
    expect(fadeRanges().map(rangeText)).toContain("A");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("H");
    await flushFrames();
    expect(highlights.size).toBe(0);
  });

  it.each(["retained text append", "source-only append"] as const)(
    "keeps active glyph ranges registered through a %s without rebuilding them",
    async (revision) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      await render(<Probe text="History" />);
      await render(<Probe text="HistoryABCDE" />);
      now = 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const active = fadeRanges().find((range) => rangeText(range) === "A")!;
      expect(active).toBeDefined();
      const textNode = container.querySelector("[data-probe]")!.firstChild;
      const deleteRange = vi.spyOn(MockHighlight.prototype, "delete");

      now = 20;
      await render(
        <Probe
          text={revision === "retained text append" ? "HistoryABCDEFGH" : "HistoryABCDE"}
          sourceText="HistoryABCDEFGH"
        />,
      );

      expect(container.querySelector("[data-probe]")!.firstChild).toBe(textNode);
      expect(fadeRanges().some((range) => range === active)).toBe(true);
      expect(deleteRange.mock.calls.some(([range]) => range === active)).toBe(false);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("E");
      await flushFrames();
      expect(highlights.size).toBe(0);
    },
  );

  it("keeps a pending row's painted height stable between frames when later text arrives", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(12, true);
    const middle = "第二段仍在逐行让位和逐字显示".repeat(8);
    const view = (tail: string) => (
      <Probe
        text={`H${middle}${tail}`}
        frame
        initialBufferMs={0}
        richText={
          <>
            <p>H</p>
            <p>{middle}</p>
            <p>{tail}</p>
          </>
        }
      />
    );
    await render(<Probe text="H" frame initialBufferMs={0} richText={<p>H</p>} />);
    await render(view("tail"));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let checked = false;
    for (now = 16; now < 500; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (Number.parseFloat(frame.style.height) <= 20) continue;
      const height = frame.style.height;
      now += 4;
      await render(view("tail with another packet"));
      expect(frame.style.height).toBe(height);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(
        "tail with another packet",
      );
      checked = true;
      break;
    }
    expect(checked).toBe(true);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("does not reclassify unchanged historical paragraphs for every source append", async () => {
    const history = Array.from({ length: 100 }, (_, index) => <p key={index}>History {index}</p>);
    const view = (text: string) => (
      <Probe
        text={text}
        paused
        richText={
          <>
            {history}
            <p>{text}</p>
          </>
        }
      />
    );
    await render(view("tail"));
    const first = container.querySelector("p")!;
    const classify = vi.spyOn(first, "closest");
    for (let index = 1; index <= 20; index++) await render(view("tail" + " new".repeat(index)));
    expect(classify).not.toHaveBeenCalled();
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" new".repeat(20));
  });

  it.each([
    "aria-hidden",
    "class",
    "role",
    "data-smooth-footnotes-inline",
    "data-footnote-backref",
  ])(
    "refreshes cached text ownership when %s changes without replacing a node",
    async (attribute) => {
      await render(
        <Probe
          text="ABCDE"
          paused
          claimInitialText={() => true}
          richText={
            <p>
              <span>ABCDE</span>
            </p>
          }
        />,
      );
      const span = container.querySelector("span")!;
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABCDE");
      await act(() =>
        span.setAttribute(
          attribute,
          attribute === "class" ? "sr-only" : attribute === "role" ? "toolbar" : "true",
        ),
      );
      await flushMutations();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
      await act(() => span.removeAttribute(attribute));
      await flushMutations();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABCDE");
    },
  );

  it("reclassifies a surviving text node when it moves into an inline code surface", async () => {
    await render(
      <Probe
        text="ABCDE"
        paused
        claimInitialText={() => true}
        richText={
          <p>
            <span>ABCDE</span>
          </p>
        }
      />,
    );
    const span = container.querySelector("span")!;
    const code = document.createElement("code");
    await act(() => {
      span.before(code);
      code.append(span);
    });
    await flushMutations();
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABCDE");
    // Restore React's authored ownership before the fixture unmounts.
    await act(() => {
      code.before(span);
      code.remove();
    });
    await flushMutations();
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(false);
  });

  it("records source-only arrivals without rescanning deferred Markdown or rebuilding its masks", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="" claimInitialText={() => true} />);
    await render(<Probe text="ABCDE" sourceText="ABCDE" />);
    const scan = vi.spyOn(document, "createTreeWalker");
    const removeMask = vi.spyOn(MockHighlight.prototype, "delete");
    const masked = [...(hiddenHighlight() ?? [])];

    for (now = 100; now <= 500; now += 100) {
      await render(<Probe text="ABCDE" sourceText={"ABCDE".repeat(now / 100 + 1)} />);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(masked.every((range) => hiddenHighlight()?.has(range))).toBe(true);
    expect(removeMask).not.toHaveBeenCalled();

    await render(<Probe text="ABCDE" streaming={false} complete />);
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("keeps buffered inline frames free of repeated hidden-state attribute writes", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const content = (
      <p>
        <code>ABCDE</code> and <code>FGHIJ</code>
      </p>
    );
    await render(<Probe text="ABCDE and FGHIJ" richText={content} claimInitialText={() => true} />);
    const records: MutationRecord[] = [];
    const watcher = new MutationObserver((batch) => records.push(...batch));
    for (const surface of container.querySelectorAll("code"))
      watcher.observe(surface, { attributes: true });
    try {
      for (now = 16; now <= 64; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(records).toHaveLength(0);
      expect(container.querySelectorAll("[data-smooth-inline-pending]")).toHaveLength(2);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABCDE and FGHIJ");
    } finally {
      watcher.disconnect();
    }
  });

  it("reuses an inline frame's clipping geometry between character deadlines", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(4);
    await render(<Probe text="`ABCDEFGHIJKLM`" markdown claimInitialText={() => true} />);
    now = 1_000;
    let callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const code = container.querySelector("code")!;
    expect(code.style.clipPath).not.toBe("");
    const clipBefore = code.style.clipPath;
    const opacityBefore = code.style.getPropertyValue("--t3-smooth-surface-opacity");
    const readBounds = vi.fn(code.getBoundingClientRect.bind(code));
    const readFragments = vi.fn(code.getClientRects.bind(code));
    Object.defineProperty(code, "getBoundingClientRect", { configurable: true, value: readBounds });
    Object.defineProperty(code, "getClientRects", { configurable: true, value: readFragments });
    const writeClip = vi.spyOn(code.style, "clipPath", "set");

    now = 1_001;
    callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));

    expect(code.style.clipPath).toBe(clipBefore);
    expect(code.style.getPropertyValue("--t3-smooth-surface-opacity")).toBe(opacityBefore);
    expect(opacityBefore).toBe("");
    expect(readBounds).not.toHaveBeenCalled();
    expect(readFragments).not.toHaveBeenCalled();
    expect(writeClip).not.toHaveBeenCalled();
    await flushFrames();
    expect(code.style.clipPath).toBe("");
  });

  it.each(["inline code", "file button"] as const)(
    "does not rewrite a settled %s surface during unrelated character animation",
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const content = (tail = "") => (
        <>
          {kind === "inline code" ? (
            <code>History</code>
          ) : (
            <button type="button" data-smooth-atomic="">
              History
            </button>
          )}
          {tail}
        </>
      );
      await render(<Probe text="History" richText={content()} />);
      await render(<Probe text="HistoryABCDEFGHIJKLM" richText={content("ABCDEFGHIJKLM")} />);
      const surface = container.querySelector<HTMLElement>(
        kind === "inline code" ? "code" : "button",
      )!;
      const removeStyle = vi.spyOn(surface.style, "removeProperty");
      const readStyle = vi.spyOn(surface.style, "getPropertyValue");
      const readBounds = vi.spyOn(surface, "getBoundingClientRect");
      const readFragments = vi.spyOn(surface, "getClientRects");
      now = 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));

      expect(fadeRanges().length).toBeGreaterThan(0);
      expect(surface.hasAttribute("data-smooth-surface")).toBe(false);
      expect(removeStyle).not.toHaveBeenCalled();
      expect(readStyle).not.toHaveBeenCalled();
      expect(readBounds).not.toHaveBeenCalled();
      expect(readFragments).not.toHaveBeenCalled();
      await flushFrames();
      expect(highlights.size).toBe(0);
    },
  );

  it("reads a batch of new glyph colors before writing their highlight color bindings", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await render(<Probe text="History" />);
    const text = Array.from({ length: 80 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index),
    ).join("");
    await render(
      <Probe
        text={`History${text}`}
        richText={
          <>
            History
            {[...text].map((glyph) => (
              <span key={glyph}>{glyph}</span>
            ))}
          </>
        }
      />,
    );
    now = 16;
    let callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const operations: Array<"read" | "write"> = [];
    const computedStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudoElement) => {
      if (element.matches("[data-probe] span")) operations.push("read");
      return computedStyle(element, pseudoElement);
    });
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      property: string,
      value: string | null,
      priority?: string,
    ) {
      if (property === "--t3-smooth-foreground") operations.push("write");
      return setProperty.call(this, property, value, priority);
    });

    now = 32;
    callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));

    expect(operations.filter((operation) => operation === "read").length).toBeGreaterThan(1);
    const firstWrite = operations.indexOf("write");
    expect(firstWrite).toBeGreaterThan(0);
    expect(operations.slice(firstWrite)).not.toContain("read");
    await flushFrames();
  });

  it("measures newly revealed inline frames without fading their text or background", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(12, true);
    await render(
      <Probe
        text="ABCDE一二三四五"
        richText={
          <>
            <p>
              <code>ABCDE</code>
            </p>
            <p>
              <code>一二三四五</code>
            </p>
          </>
        }
        claimInitialText={() => true}
      />,
    );
    const operations: Array<"read" | "write"> = [];
    for (const code of container.querySelectorAll("code")) {
      const bounds = code.getBoundingClientRect.bind(code);
      Object.defineProperty(code, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          operations.push("read");
          return bounds();
        },
      });
    }
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      property: string,
      value: string | null,
      priority?: string,
    ) {
      if (property === "--t3-smooth-surface-opacity") operations.push("write");
      return setProperty.call(this, property, value, priority);
    });

    let reachedSecond = false;
    for (now = 1_000; now <= 1_200; now += 8) {
      operations.length = 0;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (container.querySelectorAll("code")[1]!.hasAttribute("data-smooth-inline-pending"))
        continue;
      reachedSecond = true;
      break;
    }
    expect(reachedSecond).toBe(true);
    expect(fadeRanges()).toHaveLength(0);
    expect(operations.filter((operation) => operation === "read")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "write")).toHaveLength(0);
    await flushFrames();
  });

  it("settles a same-row suffix without waiting for a zero-height reservation", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockWrappedRows(4);
    const onSettled = vi.fn();
    await render(<Probe text="H" frame onSettled={onSettled} />);
    await render(<Probe text="HABCDE" frame onSettled={onSettled} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 16; now <= 240; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height);
      if (height > 20 && height < 40) break;
    }
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
    now += 1;
    await render(<Probe text="HABCDEFG" frame streaming={false} onSettled={onSettled} />);

    for (now += 16; now <= 480; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (!hiddenHighlight()) break;
    }

    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.style.height).toBe("40px");
    expect(onSettled).toHaveBeenCalledOnce();
    expect(fadeRanges().length).toBeGreaterThan(0);
    await flushFrames();
    expect(highlights.size).toBe(0);
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
