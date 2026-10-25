import { Fragment, StrictMode, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { act, fakeTimers, render as renderScreen, stubGlobal } from "../../test/render";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  publishSmoothTextLayoutCommit,
  readSmoothTextEnd,
  registerSmoothTextLayoutScope,
  setSmoothTextFrameHeight,
} from "../lib/smoothTextLayout";
import { createTimelineLayout } from "../components/chat/timelineLayout";
import * as layoutModule from "../lib/smoothTextLayout";
import { smoothTextPlaybackStore } from "../lib/smoothTextPlayback";
import type { SmoothTextResumeInput } from "../lib/smoothTextPlayback";
import { SMOOTH_TEXT_FADE_ATTRIBUTE } from "../lib/smoothLineMotion";
import * as motionModule from "../lib/smoothLineMotion";
// A 20px rest-to-rest Bezier has its maximum speed at half of the default 200ms.
const DEFAULT_LINE_BEZIER_PEAK_VELOCITY = 20 / (200 * 0.58);
import * as cadenceModule from "../lib/smoothLineCadence";
import { SMOOTH_TEXT_BUFFER_MS } from "../lib/smoothText";
import * as smoothTextModule from "../lib/smoothText";
import * as decorationModule from "../lib/smoothTextDecorations";
import type { SmoothTextCandidate } from "../lib/smoothTextCommit";
import { measureSmoothTextBlock } from "../lib/smoothTextCommit";
import { useSmoothText } from "./useSmoothText";
import { remarkHoldIncompleteInline } from "../markdown-streaming";
import { StreamingMarkdownFootnotes } from "../components/chat/StreamingMarkdownFootnotes";

const FIXTURE_EPOCH = 1_800_000_000_000;
const HIGHLIGHT_NAME = "t3-smooth-hidden";

const originals = vi.hoisted(
  () =>
    ({}) as {
      layoutModule: typeof import("../lib/smoothTextLayout");
      motionModule: typeof import("../lib/smoothLineMotion");
      cadenceModule: typeof import("../lib/smoothLineCadence");
      smoothTextModule: typeof import("../lib/smoothText");
      decorationModule: typeof import("../lib/smoothTextDecorations");
    },
);
vi.mock("../lib/smoothTextLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/smoothTextLayout")>();
  originals.layoutModule = actual;
  return { ...actual, afterSmoothTextLayoutCommit: vi.fn(actual.afterSmoothTextLayoutCommit) };
});
vi.mock("../lib/smoothLineMotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/smoothLineMotion")>();
  originals.motionModule = actual;
  return {
    ...actual,
    createSmoothLinePulse: vi.fn(actual.createSmoothLinePulse),
    smoothLineCurveProgress: vi.fn(actual.smoothLineCurveProgress),
  };
});
vi.mock("../lib/smoothLineCadence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/smoothLineCadence")>();
  originals.cadenceModule = actual;
  return { ...actual, createSmoothLineCadence: vi.fn(actual.createSmoothLineCadence) };
});
vi.mock("../lib/smoothText", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/smoothText")>();
  originals.smoothTextModule = actual;
  return { ...actual, createSmoothTextLines: vi.fn(actual.createSmoothTextLines) };
});
vi.mock("../lib/smoothTextDecorations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/smoothTextDecorations")>();
  originals.decorationModule = actual;
  return { ...actual, createSmoothTextDecorations: vi.fn(actual.createSmoothTextDecorations) };
});

vi.mock("../lib/smoothTextPlayback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/smoothTextPlayback")>();
  return {
    ...actual,
    smoothTextPlaybackStore: actual.createSmoothTextPlaybackStore(() => FIXTURE_EPOCH),
  };
});

function resizeEntries(container: HTMLElement): ResizeObserverEntry[] {
  return [container, ...container.querySelectorAll("*")].map(
    (target) =>
      ({
        target,
        contentRect: target.getBoundingClientRect(),
      }) as ResizeObserverEntry,
  );
}

async function setup() {
  await using stack = new AsyncDisposableStack();
  let clock = vi.spyOn(performance, "now").mockReturnValue(0);
  stack.use(vi.spyOn(Date, "now").mockReturnValue(FIXTURE_EPOCH));
  const restoreMocks = () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    clock = vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_EPOCH);
  };
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

  const container = document.createElement("div");
  let highlights: Map<string, MockHighlight>;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let mediaQueries: Map<string, MockMediaQuery>;
  let documentHidden: boolean;
  let originalMatchMedia: PropertyDescriptor | undefined;
  let originalRangeGetBoundingClientRect: PropertyDescriptor | undefined;
  let originalRangeGetClientRects: PropertyDescriptor | undefined;
  let renders: Map<string, number>;
  const FixtureMutationObserver = MutationObserver;
  const fixtureLayoutObservers = new Set<MutationObserver>();

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
    yieldDurationMs,
    drainOnComplete,
    retainOnComplete,
    resume,
    sourceText = text,
    arrivalSourceText,
    candidate,
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
    yieldDurationMs?: number | undefined;
    drainOnComplete?: boolean;
    retainOnComplete?: boolean;
    resume?: SmoothTextResumeInput;
    sourceText?: string;
    arrivalSourceText?: string;
    candidate?: SmoothTextCandidate;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    renders.set(id, (renders.get(id) ?? 0) + 1);
    useSmoothText(ref, {
      enabled,
      candidate,
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
      yieldDurationMs,
      drainOnComplete,
      retainOnComplete,
      resume,
      sourceText,
      arrivalSourceText,
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
                onCopy?.(
                  event.currentTarget.parentElement?.querySelector("code")?.textContent ?? "",
                )
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
    const region = highlights.get(HIGHLIGHT_NAME);
    return region?.size ? region : undefined;
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
    lineHeight = 20,
  ) {
    const layouts = new WeakMap<
      HTMLElement,
      {
        text: string;
        columns: number;
        offsets: Map<Node, number>;
        glyphs: Array<DOMRect | undefined>;
        rects: DOMRect[];
      }
    >();
    const changes = new WeakMap<HTMLElement, { observer: MutationObserver; dirty: boolean }>();
    const globalOffset = (root: HTMLElement, node: Node, offset: number) => {
      rects(root);
      const start = layouts.get(root)?.offsets.get(node);
      if (node.nodeType === Node.TEXT_NODE && start !== undefined) return start + offset;
      const prefix = document.createRange();
      prefix.setStart(root, 0);
      prefix.setEnd(node, offset);
      return prefix.toString().length;
    };
    const rects = (root: HTMLElement, start = 0, end?: number): DOMRect[] => {
      const rowColumns = typeof columns === "number" ? columns : columns();
      let change = changes.get(root);
      if (!change) {
        const state = {
          dirty: true,
          observer: new FixtureMutationObserver(() => {
            state.dirty = true;
          }),
        };
        state.observer.observe(root, { childList: true, characterData: true, subtree: true });
        fixtureLayoutObservers.add(state.observer);
        changes.set(root, state);
        change = state;
      }
      if (change.observer.takeRecords().length > 0) change.dirty = true;
      const cached = layouts.get(root);
      if (cached && !change.dirty && cached.columns === rowColumns)
        return start === 0 && (end === undefined || end >= cached.glyphs.length)
          ? cached.rects
          : cached.glyphs.slice(start, end).filter((rect): rect is DOMRect => rect !== undefined);
      let row = 0;
      let column = 0;
      let previousBlock: Element | null = null;
      const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const identities: Array<{ node: Node; block: Element | null }> = [];
      const blockByOffset: Array<Element | null> = [];
      while (nodes.nextNode()) {
        const block =
          nodes.currentNode.parentElement?.closest("p, li, h1, h2, h3, tr, pre") ?? null;
        identities.push({ node: nodes.currentNode, block });
      }
      const text = root.textContent ?? "";
      const offsets = new Map<Node, number>();
      let position = 0;
      for (const entry of identities) {
        offsets.set(entry.node, position);
        position += entry.node.textContent?.length ?? 0;
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
            y: row * lineHeight + lineHeight * 0.2,
            top: row * lineHeight + lineHeight * 0.2,
            bottom: row * lineHeight + lineHeight * 0.8,
            height: lineHeight * 0.6,
          } as DOMRect;
        }
        column += 1;
      }
      const allRects = glyphs.filter((rect): rect is DOMRect => rect !== undefined);
      layouts.set(root, { text, columns: rowColumns, offsets, glyphs, rects: allRects });
      change.dirty = false;
      return start === 0 && (end === undefined || end >= glyphs.length)
        ? allRects
        : glyphs.slice(start, end).filter((rect): rect is DOMRect => rect !== undefined);
    };
    const bounds = (fragments: DOMRect[]) => {
      if (fragments.length === 0) return { height: 0, bottom: 0, top: 0 } as DOMRect;
      const top = Math.min(...fragments.map((rect) => rect.top));
      const bottom = Math.max(...fragments.map((rect) => rect.bottom));
      const left = Math.min(...fragments.map((rect) => rect.left));
      const right = Math.max(...fragments.map((rect) => rect.right));
      return new DOMRect(left, top, right - left, bottom - top).toJSON() as DOMRect;
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
      const naturalHeight = Math.ceil((rects(root).at(-1)?.bottom ?? 0) / lineHeight) * lineHeight;
      const explicitHeight = Number.parseFloat(this.style.height);
      const height =
        this.dataset.smoothTextFrame !== undefined && Number.isFinite(explicitHeight)
          ? explicitHeight
          : naturalHeight;
      return new DOMRect(
        0,
        0,
        fixedWidth ?? (typeof columns === "number" ? columns : columns()) * 10,
        height,
      ).toJSON() as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
      this: HTMLElement,
    ) {
      const range = document.createRange();
      range.selectNodeContents(this);
      const fragments = Array.from(range.getClientRects());
      return (this.tagName === "CODE"
        ? fragments.map((rect) => {
            const top = Math.floor(rect.top / lineHeight) * lineHeight;
            return { ...rect, top, bottom: top + lineHeight, height: lineHeight } as DOMRect;
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

  function mockHorizontalRuleFlow(margin = 16) {
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
      const style = originalGetComputedStyle(element, pseudoElement);
      if (!(element instanceof HTMLElement) || element.tagName !== "HR") return style;
      return new Proxy(style, {
        get(target, property) {
          if (property === "marginTop" || property === "marginBottom") return `${margin}px`;
          return Reflect.get(target, property, target);
        },
      });
    });

    const rect = (top: number, height: number): DOMRect =>
      ({ top, bottom: top + height, height, left: 0, right: 300, width: 300 }) as DOMRect;
    const measure = (root: HTMLElement) => {
      const elementRects = new WeakMap<HTMLElement, DOMRect>();
      const textTops = new WeakMap<Text, number>();
      let cursor = 0;
      let previousMarginBottom = 0;
      for (const child of root.children) {
        const isRule = child.tagName === "HR";
        const marginTop = isRule ? margin : 0;
        const top = cursor + Math.max(previousMarginBottom, marginTop);
        if (isRule) {
          elementRects.set(child as HTMLElement, rect(top, 1));
          cursor = top + 1;
          previousMarginBottom = margin;
          continue;
        }

        const block = child as HTMLElement;
        elementRects.set(block, rect(top, 20));
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) textTops.set(walker.currentNode as Text, top);
        cursor = top + 20;
        previousMarginBottom = 0;
      }
      return { elementRects, textTops, height: cursor + previousMarginBottom };
    };
    const findRoot = (element: HTMLElement) =>
      element.matches("[data-probe]")
        ? element
        : (element.closest<HTMLElement>("[data-probe]") ??
          element.querySelector<HTMLElement>("[data-probe]"));

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const root = findRoot(this);
      if (!root) return rect(0, 0);
      const layout = measure(root);
      if (this.tagName === "HR") return layout.elementRects.get(this) ?? rect(0, 0);
      if (this.dataset.smoothTextFrame !== undefined) {
        const explicitHeight = Number.parseFloat(this.style.height);
        return rect(0, Number.isFinite(explicitHeight) ? explicitHeight : layout.height);
      }
      if (this === root) return rect(0, layout.height);
      return layout.elementRects.get(this) ?? rect(0, 0);
    });
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const node =
        this.startContainer.nodeType === Node.TEXT_NODE ? (this.startContainer as Text) : null;
      const root = node?.parentElement?.closest<HTMLElement>("[data-probe]");
      if (!node || !root) return rect(0, 0);
      const top = (measure(root).textTops.get(node) ?? 0) + 4;
      return rect(top, this.toString().trim() ? 12 : 0);
    });
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      const bounds = this.getBoundingClientRect();
      return (bounds.height > 0 ? [bounds] : []) as unknown as DOMRectList;
    });
  }

  function horizontalRuleFrameState(at: number, frame: HTMLElement, rules: HTMLElement[]) {
    return {
      at: Number(at.toFixed(2)),
      height: Number.parseFloat(frame.style.height) || 0,
      rules: rules.map((rule) => {
        const opacity = rule.style.getPropertyValue("--t3-smooth-surface-opacity");
        return {
          pending: rule.hasAttribute("data-smooth-inline-pending"),
          opacity: opacity ? Number.parseFloat(opacity) : 1,
          visible:
            !rule.hasAttribute("data-smooth-inline-pending") &&
            (!opacity || Number.parseFloat(opacity) > 0),
        };
      }),
      hidden: [...(hiddenHighlight() ?? [])].map(rangeText).join(""),
    };
  }

  // 单 Text 流的确定性几何；每次 source 更新只建立一次行索引，避免长流夹具反复扫描前缀。
  function mockStreamRows(columns: number) {
    let indexedText = "";
    let rowAt: number[] = [];
    let height = 0;
    const index = () => {
      const text = container.querySelector("[data-probe]")?.textContent ?? "";
      if (text === indexedText) return;
      indexedText = text;
      rowAt = [];
      let row = 0;
      let column = 0;
      for (let offset = 0; offset < text.length; offset++) {
        rowAt[offset] = row;
        if (text[offset] === "\n") {
          row++;
          column = 0;
        } else if (++column === columns) {
          row++;
          column = 0;
        }
      }
      rowAt[text.length] = row;
      height = Math.max(1, row + (column > 0 ? 1 : 0)) * 20;
    };
    const box = (top: number, bottom: number) =>
      ({ top, bottom, height: bottom - top, left: 0, right: 400, width: 400 }) as DOMRect;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      index();
      const start = this.startContainer.nodeType === Node.TEXT_NODE ? this.startOffset : 0;
      const end =
        this.endContainer.nodeType === Node.TEXT_NODE ? this.endOffset : indexedText.length;
      const top = (rowAt[start] ?? 0) * 20;
      return box(top, end > start ? ((rowAt[end - 1] ?? 0) + 1) * 20 : top);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      index();
      const explicit = Number.parseFloat(this.style.height);
      return box(
        0,
        this.hasAttribute("data-smooth-text-frame") && Number.isFinite(explicit)
          ? explicit
          : height,
      );
    });
  }

  function expectPaintedGlyphsToFit() {
    const message = container.querySelector<HTMLElement>("[data-probe]")!;
    const explicitHeight = Number.parseFloat(message.parentElement!.style.height);
    const height = Number.isFinite(explicitHeight)
      ? explicitHeight
      : message.parentElement!.getBoundingClientRect().height;
    const hidden = [...(hiddenHighlight() ?? [])];
    const nodes = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    const glyph = document.createRange();
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
        glyph.setStart(node, offset);
        glyph.setEnd(node, offset + 1);
        expect(glyph.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
      }
    }
  }

  async function render(element: ReactNode) {
    await act(async () => {
      await screen.rerender(element);
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
    let now = clock();
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

  // Bound real travel at the basic peak, plus two admission paints per row.
  // Tests keep sampling visibility throughout this window instead of clearing
  // the FIFO merely because the old 80ms completion timer expired.
  function remainingSpaceMs(fps = 60) {
    const message = container.querySelector<HTMLElement>("[data-probe]")!;
    const height = Number.parseFloat(message.parentElement!.style.height) || 0;
    const distance = Math.max(0, message.getBoundingClientRect().height - height);
    return (
      (2 * distance) / DEFAULT_LINE_BEZIER_PEAK_VELOCITY +
      ((Math.ceil(distance / 20) + 1) * 2 * 1000) / fps +
      80
    );
  }

  function setDocumentHidden(hidden: boolean) {
    documentHidden = hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  stack.use(stubGlobal("Highlight", MockHighlight));
  highlights = new Map();
  stack.use(stubGlobal("CSS", Object.create(CSS, { highlights: { value: highlights } })));
  stack.use(stubGlobal("IntersectionObserver", MockIntersectionObserver));
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
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number) => {
    frames.delete(id);
  };
  stack.use(stubGlobal("requestAnimationFrame", requestFrame));
  stack.use(stubGlobal("cancelAnimationFrame", cancelFrame));

  stack.defer(() => {
    for (const observer of fixtureLayoutObservers) observer.disconnect();
    fixtureLayoutObservers.clear();
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
    vi.restoreAllMocks();
    vi.resetAllMocks();
    if (originalRangeGetClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeGetClientRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  // 夹具主动推进动画帧，且不使用导航；路由的帧调度不属于本 hook 的回归范围。
  let screen = stack.use(await renderScreen(null, { container, router: false }));
  const unmount = () => screen.unmount();
  const remount = async () => {
    // 复用同一 DOM 容器以保留恢复测试的布局条件。
    screen = owned.use(await renderScreen(null, { container, router: false }));
  };
  const renderCommit = (element: ReactNode) => {
    void screen.rerender(element);
  };
  const owned = stack.move();
  return {
    MockHighlight,
    MockIntersectionObserver,
    container,
    highlights,
    frames,
    mediaQueries,
    renders,
    fixtureLayoutObservers,
    getMediaQuery,
    Probe,
    hiddenHighlight,
    rangeText,
    fadeRanges,
    mockLineAwareRanges,
    mockWrappedRows,
    mockMediaRows,
    mockHorizontalRuleFlow,
    horizontalRuleFrameState,
    mockStreamRows,
    expectPaintedGlyphsToFit,
    render,
    flushMutations,
    flushFrames,
    remainingSpaceMs,
    setDocumentHidden,
    unmount,
    remount,
    renderCommit,
    get clock() {
      return clock;
    },
    restoreMocks,
    requestFrame,
    cancelFrame,
    get nextFrameId() {
      return nextFrameId;
    },
    use: <T extends Disposable>(resource: T) => owned.use(resource),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("useSmoothText", () => {
  describe("parallel line paint permission", () => {
    it.each(["thinking", "meta", "scoped-footnote"])(
      "refreshes a %s boundary without measuring an unused body origin",
      async (kind) => {
        await using fixture = await setup();
        const { container, Probe, mockWrappedRows, render } = fixture;
        mockWrappedRows(4);
        await render(
          <main data-markdown-footnote-scope={kind === "scoped-footnote" ? "current" : undefined}>
            <Probe text="甲乙" frame />
            <div
              data-boundary=""
              data-timeline-status-height={kind === "thinking" ? "fixture:thinking" : undefined}
              data-timeline-tail-anchor={kind === "meta" ? "meta" : undefined}
              className={
                kind === "scoped-footnote" ? "streaming-markdown-footnotes-heading" : undefined
              }
            />
          </main>,
        );
        const main = container.querySelector("main")!;
        const frame = main.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const body = main.querySelector<HTMLElement>("[data-probe]")!;
        const read = vi.fn(body.getBoundingClientRect.bind(body));
        body.getBoundingClientRect = read;
        let edge = 60;
        main.querySelector<HTMLElement>("[data-boundary]")!.getBoundingClientRect = () =>
          new DOMRect(0, edge, 100, 20);
        main.dispatchEvent(new Event("t3-smooth-text-layout-commit"));
        expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("59px");
        edge = 40;
        main.dispatchEvent(new Event("scroll"));
        expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("39px");
        expect(read).not.toHaveBeenCalled();
      },
    );

    it.each(["detached-meta", "older-footnote"])(
      "requires the body origin to distinguish a preceding %s boundary",
      async (kind) => {
        await using fixture = await setup();
        const { container, Probe, mockWrappedRows, render } = fixture;
        mockWrappedRows(4);
        await render(
          <main>
            <div
              data-old-boundary=""
              data-timeline-tail-anchor={kind === "detached-meta" ? "meta" : undefined}
              className={
                kind === "older-footnote" ? "streaming-markdown-footnotes-heading" : undefined
              }
            />
            <div data-stream-footnotes={kind === "detached-meta" ? "" : undefined}>
              <Probe text="甲乙" frame />
            </div>
            <div data-timeline-status-height="fixture:thinking" />
          </main>,
        );
        const main = container.querySelector("main")!;
        const body = main.querySelector<HTMLElement>("[data-probe]")!;
        const frame = main.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const read = vi.fn(() => new DOMRect(0, 50, 100, 20));
        body.getBoundingClientRect = read;
        frame.getBoundingClientRect = () => new DOMRect(0, 50, 100, 20);
        let oldTop = 0;
        main.querySelector<HTMLElement>("[data-old-boundary]")!.getBoundingClientRect = () =>
          new DOMRect(0, oldTop, 100, 20);
        main.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
          () => new DOMRect(0, 100, 100, 20);
        main.dispatchEvent(new Event("t3-smooth-text-layout-commit"));
        expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("49px");
        expect(read).toHaveBeenCalledOnce();
        read.mockClear();
        oldTop = 70;
        main.dispatchEvent(new Event("scroll"));
        expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("19px");
        expect(read).toHaveBeenCalledOnce();
      },
    );

    it("reads candidate width once per tick and remeasures after a real width change", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      let columns = 4;
      mockWrappedRows(() => columns);
      const commit = vi.fn();
      const measure = vi.fn(() => (columns === 4 ? 60 : 100));
      const candidate = { measure, commit };
      await render(<Probe text="甲乙" frame />);
      await render(<Probe text="甲乙" frame candidate={candidate} />);
      const body = container.querySelector<HTMLElement>("[data-probe]")!;
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const read = vi.fn(body.getBoundingClientRect.bind(body));
      body.getBoundingClientRect = read;
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await step(16);
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(20);
      expect(Number.parseFloat(frame.style.height)).toBeLessThan(60);
      expect(commit).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledOnce();
      columns = 8;
      await step(32);
      expect(measure).toHaveBeenCalledTimes(2);
      expect(commit).not.toHaveBeenCalled();
      for (let index = 1; index <= 40 && !commit.mock.calls.length; index++)
        await step(32 + index * 16);
      expect(frame.style.height).toBe("100px");
      expect(commit).toHaveBeenCalledOnce();
    });

    it.each([60, 40])(
      "holds a replacement at %spx until its own owner receipt and completion",
      async (target) => {
        await using fixture = await setup();
        const { container, frames, mockWrappedRows, render } = fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(20);
        const permits: Array<{ callback: () => void; cancelled: boolean }> = [];
        const unregister = registerSmoothTextLayoutScope(container, {
          frame(callback) {
            const id = fixture.requestFrame(callback);
            return () => fixture.cancelFrame(id);
          },
          afterCommit(_element, callback) {
            const permit = { callback, cancelled: false };
            permits.push(permit);
            return () => {
              permit.cancelled = true;
            };
          },
        });
        const complete = vi.fn();
        function Replacement({ stage }: { stage: "A" | "B" | "C" }) {
          const [released, setReleased] = useState("A");
          const ref = useRef<HTMLDivElement>(null);
          const request = {
            measure: () => (stage === "B" ? 60 : target),
            commit: () => setReleased(stage),
          };
          useSmoothText(ref, {
            enabled: true,
            sourceText: "HistoryXYZ",
            streaming: stage !== "C",
            complete: stage === "C",
            candidate: stage !== "A" && released !== stage ? request : undefined,
            yieldDurationMs: 150,
            fadeDurationMs: 0,
            onPlaybackComplete: complete,
          });
          return (
            <div data-smooth-text-frame="">
              <div data-probe="message" ref={ref}>
                {released === "C" ? "HistoryXYZ" : released === "B" ? "HistoryB" : "History"}
              </div>
            </div>
          );
        }
        const step = async () => {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        };
        try {
          await render(<Replacement stage="A" />);
          await render(<Replacement stage="B" />);
          for (let i = 0; i < 80 && !permits.length; i++) await step();
          const b = permits[0]!;
          expect(b).toBeDefined();
          const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
          expect(frame.style.height).toBe("60px");
          await render(<Replacement stage="C" />);
          expect(frame.style.height).toBe("60px");
          expect(container.querySelector("[data-probe]")?.textContent).toBe("History");
          expect(complete).not.toHaveBeenCalled();
          await act(() => b.callback());
          expect(b.cancelled).toBe(true);
          expect(container.querySelector("[data-probe]")?.textContent).toBe("History");
          const c = permits.find((permit) => permit !== b && !permit.cancelled)!;
          expect(c).toBeDefined();
          for (let i = 0; i < 10; i++) await step();
          expect(complete).not.toHaveBeenCalled();
          await act(() => c.callback());
          for (let i = 0; i < 80 && !complete.mock.calls.length; i++) await step();
          expect(container.querySelector("[data-probe]")?.textContent).toBe("HistoryXYZ");
          expect(complete).toHaveBeenCalledOnce();
        } finally {
          unregister();
        }
      },
    );

    it.each(["t3-smooth-text-layout-commit", "scroll", "resize"])(
      "bounds repeated boundary reads and refreshes on synchronous %s",
      async (event) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const view = (tail: boolean) => (
          <main>
            <Probe text={tail ? "甲乙丙丁戊" : "甲乙丙丁"} frame initialBufferMs={0} />
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view(false));
        const boundary = container.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        let edge = 19;
        const read = vi.fn(() => new DOMRect(0, edge, 100, 20));
        boundary.getBoundingClientRect = read;
        await render(view(true));
        for (let index = 0; index < 50; index++) {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        }
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        expect(frame.style.height).toBe("40px");
        read.mockClear();
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        // One read phase before the synchronous layout barrier, one after it.
        expect(read.mock.calls.length).toBeLessThanOrEqual(2);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("戊");
        const main = container.querySelector("main")!;
        let changed = false;
        read.mockClear();
        using _heightRead = vi.spyOn(frame.style, "height", "get").mockImplementation(() => {
          // Enter the external handler after this tick has cached the old edge,
          // before an unchanged height write can invalidate it incidentally.
          if (!changed && read.mock.calls.length > 0) {
            changed = true;
            edge = 50;
            (event === "resize" ? window : main).dispatchEvent(new Event(event));
            expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("49px");
          }
          return frame.style.getPropertyValue("height");
        });
        now += 16;
        const next = [...frames.values()];
        frames.clear();
        await act(() => next.forEach((callback) => callback(now)));
        expect(changed).toBe(true);
        expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("49px");
      },
    );

    it.each([201, 350, 680])(
      "drains framed text at sustained %s ms deliveries while bounding each reveal batch",
      async (interval) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const done = vi.fn();
        const settled = vi.fn();
        const text = "甲乙丙丁".repeat(12);
        const view = (value: string, streaming: boolean) => (
          <main>
            <Probe
              text={value}
              frame
              initialBufferMs={0}
              yieldDurationMs={300}
              streaming={streaming}
              onSettled={settled}
              onPlaybackComplete={done}
            />
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view("", true));
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        container.querySelector<HTMLElement>(
          "[data-timeline-status-height]",
        )!.getBoundingClientRect = () =>
          new DOMRect(0, frame.getBoundingClientRect().height + 5, 100, 20);
        await render(view(text, true));
        await render(view(text, false));
        let visible = text.length - [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        expect(visible).toBeLessThan(text.length);
        const trace: Array<{ at: number; height: string; hidden: number }> = [];
        for (let index = 0; index < 60 && frames.size; index++) {
          now += interval;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
          const next = text.length - [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
          expect(next).toBeGreaterThanOrEqual(visible);
          expect(next - visible).toBeLessThanOrEqual(32);
          visible = next;
          trace.push({ at: now, height: frame.style.height, hidden: text.length - visible });
          if (visible > 0) {
            const glyph = document.createRange();
            glyph.setStart(container.querySelector("[data-probe]")!.firstChild!, visible - 1);
            glyph.setEnd(container.querySelector("[data-probe]")!.firstChild!, visible);
            expect(glyph.getBoundingClientRect().bottom).toBeLessThanOrEqual(
              frame.getBoundingClientRect().height + 4.5,
            );
          }
        }
        expect(hiddenHighlight(), JSON.stringify(trace.slice(-5))).toBeUndefined();
        expect(done).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
      },
    );
    it.each([201, 350, 680])(
      "delivers candidate space after sustained %s ms frames without replaying one stall",
      async (interval) => {
        await using fixture = await setup();
        const { container, frames, Probe, mockWrappedRows, render } = fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const commit = vi.fn();
        const candidate = { measure: () => 60, commit };
        await render(<Probe text="甲乙" frame yieldDurationMs={300} />);
        await render(<Probe text="甲乙" frame yieldDurationMs={300} candidate={candidate} />);
        const step = async (elapsed: number) => {
          now += elapsed;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        };
        await step(10_000);
        expect(commit).not.toHaveBeenCalled();
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        expect(Number.parseFloat(frame.style.height)).toBeLessThan(25);
        for (let index = 0; index < 6 && !commit.mock.calls.length; index++) await step(interval);
        expect(commit).toHaveBeenCalledOnce();
        expect(frame.style.height).toBe("60px");
        await step(interval);
        expect(commit).toHaveBeenCalledOnce();
      },
    );
    it.each([1, 4, 8])(
      "keeps %s producers' boundary observers through unrelated DOM changes",
      async (count) => {
        await using fixture = await setup();
        const { container, Probe, mockWrappedRows, render } = fixture;
        mockWrappedRows(4);
        const observe = vi.fn();
        const unobserve = vi.fn();
        const disconnect = vi.fn();
        fixture.use(
          stubGlobal(
            "ResizeObserver",
            class {
              observe = observe;
              unobserve = unobserve;
              disconnect = disconnect;
            },
          ),
        );
        await render(
          <main>
            {Array.from({ length: count }, (_, index) => (
              <Probe key={index} id={String(index)} text="甲乙" frame markdownParagraph />
            ))}
            <div data-timeline-status-height="fixture:thinking" />
            <div data-unrelated="">
              <span />
            </div>
          </main>,
        );
        const main = container.querySelector("main")!;
        const query = vi.spyOn(main, "querySelectorAll");
        const boundary = container.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        boundary.getBoundingClientRect = () => new DOMRect(0, 80, 100, 20);
        observe.mockClear();
        unobserve.mockClear();
        disconnect.mockClear();
        await act(async () => {
          const producer = main.querySelector<HTMLElement>("[data-probe]")!;
          const candidate = document.createElement("p");
          candidate.textContent = "甲乙丙";
          measureSmoothTextBlock(producer, producer.querySelector("p")!, candidate, []);
          main.querySelector("[data-unrelated]")!.append(document.createElement("span"));
          await Promise.resolve();
        });
        expect(query).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(unobserve).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
        const heading = document.createElement("div");
        heading.className = "streaming-markdown-footnotes-heading";
        heading.getBoundingClientRect = () => new DOMRect(0, 40, 100, 20);
        await act(async () => {
          main.append(heading);
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(count);
        expect(observe.mock.calls.map(([target]) => target)).toEqual([heading]);
        expect(disconnect).not.toHaveBeenCalled();
        for (const frame of main.querySelectorAll<HTMLElement>("[data-smooth-text-frame]"))
          expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("39px");
        await act(async () => {
          heading.remove();
          await Promise.resolve();
        });
        expect(unobserve.mock.calls.map(([target]) => target)).toEqual([heading]);
        for (const frame of main.querySelectorAll<HTMLElement>("[data-smooth-text-frame]"))
          expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("79px");
      },
    );

    it("does not rewrite an unchanged paint boundary on layout publication", async () => {
      await using fixture = await setup();
      const { container, Probe, mockWrappedRows, render } = fixture;
      mockWrappedRows(4);
      await render(
        <main>
          <Probe text="甲乙" frame />
          <div data-timeline-status-height="fixture:thinking" />
        </main>,
      );
      const main = container.querySelector("main")!;
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const boundary = container.querySelector<HTMLElement>("[data-timeline-status-height]")!;
      boundary.getBoundingClientRect = () => new DOMRect(0, 80, 100, 20);
      main.dispatchEvent(new Event("scroll"));
      const write = vi.spyOn(frame.style, "setProperty");
      const watcher = new MutationObserver(() => {});
      watcher.observe(frame, { attributes: true });
      try {
        main.dispatchEvent(new Event("t3-smooth-text-layout-commit"));
        expect(write).not.toHaveBeenCalled();
        expect(watcher.takeRecords()).toHaveLength(0);
        boundary.getBoundingClientRect = () => new DOMRect(0, 50, 100, 20);
        main.dispatchEvent(new Event("t3-smooth-text-layout-commit"));
        expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("49px");
      } finally {
        watcher.disconnect();
      }
    });

    it("does not measure paint boundaries for static history refreshes", async () => {
      await using fixture = await setup();
      const { container, Probe, mockWrappedRows, render } = fixture;
      mockWrappedRows(4);
      const source = "History tail";
      await render(
        <main>
          <Probe
            text={source}
            frame
            sourceText={source}
            resume={{
              key: "static-boundary-history",
              baselineText: source,
              mountText: source,
              synchronized: true,
            }}
          />
          <div data-timeline-status-height="fixture:thinking" />
        </main>,
      );
      const main = container.querySelector("main")!;
      const frame = main.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const boundary = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
      const read = vi.fn(() => new DOMRect(0, 80, 100, 20));
      boundary.getBoundingClientRect = read;
      frame.style.setProperty("--t3-smooth-paint-height", "12px");
      frame.setAttribute("data-smooth-text-boundary", "");

      main.dispatchEvent(new Event("t3-smooth-text-layout-commit"));
      main.dispatchEvent(new Event("scroll"));

      expect(read).not.toHaveBeenCalled();
      expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("");
      expect(frame.hasAttribute("data-smooth-text-boundary")).toBe(false);
    });

    it("reads every producer's committed boundary before publishing any clip writes", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      mockWrappedRows(4);
      await render(
        <main>
          {["body", "note"].map((id) => (
            <Probe
              key={id}
              id={id}
              text="甲乙"
              frame
              mode="auto"
              fadeDurationMs={500}
              yieldDurationMs={200}
            />
          ))}
          <div data-timeline-status-height="fixture:thinking" />
        </main>,
      );
      const main = container.querySelector("main")!;
      const boundary = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
      const order: string[] = [];
      boundary.getBoundingClientRect = () => {
        order.push("read");
        return new DOMRect(0, 80, 100, 20);
      };
      for (const frame of main.querySelectorAll<HTMLElement>("[data-smooth-text-frame]")) {
        const original = frame.style.setProperty.bind(frame.style);
        vi.spyOn(frame.style, "setProperty").mockImplementation((...args) => {
          order.push("write");
          original(...args);
        });
      }
      const layout = createTimelineLayout(main, {
        list: () => null,
        control: () => null,
        requestCommit: () => {},
        synchronous: (write) => write(),
      });
      try {
        layout.request();
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(16)));
        expect(order.filter((entry) => entry === "read")).toHaveLength(1);
        expect(order.slice(0, 1)).toEqual(["read"]);
        expect(order.slice(1).every((entry) => entry === "write")).toBe(true);
        for (const frame of main.querySelectorAll<HTMLElement>("[data-smooth-text-frame]"))
          expect(frame.style.getPropertyValue("--t3-smooth-paint-height")).toBe("79px");

        order.length = 0;
        publishSmoothTextLayoutCommit(main);
        expect(order.filter((entry) => entry === "read")).toHaveLength(1);
      } finally {
        layout.dispose();
      }
    });

    it.each(
      (["adaptive", "parallel"] as const).flatMap((lineMode) =>
        [false, true].map((eof) => ({ lineMode, eof })),
      ),
    )(
      "waits for a real Timeline publication before admitting a $lineMode row (EOF=$eof)",
      async ({ lineMode, eof }) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const view = (text: string, complete = false) => (
          <main>
            <div data-timeline-row-id="body">
              <Probe
                text={text}
                frame
                lineMode={lineMode}
                initialBufferMs={0}
                complete={complete}
                streaming={!complete}
              />
            </div>
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view("甲乙丙丁"));
        const main = container.querySelector("main")!;
        const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        const sizes = new Map([["body", 20]]);
        let committedHeight = 20;
        let requestedGeneration = 0;
        let synchronousPublications = 0;
        status.getBoundingClientRect = () => new DOMRect(0, committedHeight, 100, 20);
        const layout = createTimelineLayout(main, {
          list: () => ({
            getState: () => ({ sizes }),
            setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
          }),
          control: () => null,
          requestCommit: (generation) => {
            requestedGeneration = generation;
          },
          synchronous: (write) => {
            synchronousPublications++;
            write();
          },
        });
        const step = async () => {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        };
        try {
          await render(view("甲乙丙丁戊"));
          for (let index = 0; index < 20; index++) {
            if (requestedGeneration > 0) break;
            await step();
          }
          expect(requestedGeneration).toBeGreaterThan(0);
          expect(synchronousPublications).toBe(0);
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("戊");

          for (let index = 0; index < 3; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("戊");
          expect(synchronousPublications).toBe(0);
          if (eof) {
            await render(view("甲乙丙丁戊", true));
            expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("戊");
          }

          committedHeight = sizes.get("body")!;
          await act(() => layout.complete(requestedGeneration));
          for (let index = 0; index < 20; index++) {
            await step();
            if (![...(hiddenHighlight() ?? [])].map(rangeText).join("").includes("戊")) break;
          }
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
          expect(committedHeight).toBeGreaterThanOrEqual(40);
          expect(synchronousPublications).toBe(0);
        } finally {
          layout.dispose();
        }
      },
    );

    it.each([false, true])(
      "admits a delayed %s row while another producer keeps its Timeline row changing",
      async (eof) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const onPlaybackComplete = vi.fn();
        const view = (text: string, complete = false) => (
          <main>
            <div data-timeline-row-id="body">
              <Probe
                text={text}
                frame
                initialBufferMs={0}
                complete={complete}
                streaming={!complete}
                onPlaybackComplete={onPlaybackComplete}
              />
              <div data-other-producer="" />
            </div>
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view("甲乙丙丁"));
        const main = container.querySelector("main")!;
        const row = main.querySelector<HTMLElement>("[data-timeline-row-id]")!;
        const frame = row.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const other = row.querySelector<HTMLElement>("[data-other-producer]")!;
        const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        row.getBoundingClientRect = () =>
          new DOMRect(
            0,
            0,
            100,
            frame.getBoundingClientRect().height + (Number.parseFloat(other.style.height) || 0),
          );
        const sizes = new Map([["body", 20]]);
        let committedHeight = 20;
        const publications: Array<{ generation: number; height: number; complete(): void }> = [];
        let nextCommit = 0;
        const synchronous = vi.fn((write: () => void) => write());
        status.getBoundingClientRect = () => new DOMRect(0, committedHeight, 100, 20);
        const layout = createTimelineLayout(main, {
          list: () => ({
            getState: () => ({ sizes }),
            setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
          }),
          control: () => null,
          requestCommit: (generation) => {
            publications.push({
              generation,
              height: sizes.get("body")!,
              complete: layout.capture(generation),
            });
          },
          synchronous,
        });
        try {
          await render(view("甲乙丙丁戊", eof));
          for (let index = 1; index <= 64; index++) {
            now += 16;
            setSmoothTextFrameHeight(other, index);
            const callbacks = [...frames.values()];
            frames.clear();
            await act(() => callbacks.forEach((callback) => callback(now)));
            if (publications.length - nextCommit > 2) {
              const publication = publications[nextCommit++]!;
              committedHeight = publication.height;
              await act(publication.complete);
            }
          }
          expect(nextCommit).toBeGreaterThan(10);
          expect(committedHeight).toBeGreaterThanOrEqual(40);
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
          if (eof) expect(onPlaybackComplete).toHaveBeenCalledOnce();
          expect(synchronous).not.toHaveBeenCalled();
        } finally {
          layout.dispose();
        }
      },
    );

    it("does not use a moved boundary to admit glyphs beyond an older committed row size", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <main>
          <div data-timeline-row-id="body">
            <Probe text={text} frame initialBufferMs={0} />
          </div>
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view("甲乙丙丁"));
      const main = container.querySelector("main")!;
      const row = main.querySelector<HTMLElement>("[data-timeline-row-id]")!;
      const frame = row.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      row.getBoundingClientRect = () => frame.getBoundingClientRect();
      const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
      const sizes = new Map([["body", 20]]);
      const publications: Array<{ generation: number; height: number }> = [];
      let boundaryTop = 20;
      status.getBoundingClientRect = () => new DOMRect(0, boundaryTop, 100, 20);
      const layout = createTimelineLayout(main, {
        list: () => ({
          getState: () => ({ sizes }),
          setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
        }),
        control: () => null,
        requestCommit: (generation) => {
          publications.push({ generation, height: sizes.get("body")! });
        },
        synchronous: (write) => write(),
      });
      const step = async () => {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      try {
        await render(view("甲乙丙丁戊"));
        for (let index = 0; index < 20 && publications.length === 0; index++) await step();
        const first = publications[0]!;
        expect(first.height).toBeLessThan(40);
        boundaryTop = 100;
        await act(() => layout.complete(first.generation));
        await step();
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("戊");

        for (let index = 0; index < 20; index++) {
          await step();
          const latest = publications.at(-1)!;
          if (latest.height >= 40) await act(() => layout.complete(latest.generation));
          if (![...(hiddenHighlight() ?? [])].map(rangeText).join("").includes("戊")) break;
        }
        expect(publications.at(-1)!.height).toBeGreaterThanOrEqual(40);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
      } finally {
        layout.dispose();
      }
    });

    it.each([
      { eof: false, shortTail: false },
      { eof: true, shortTail: false },
      { eof: true, shortTail: true },
    ])(
      "revokes cached glyph space after a real shrinking commit with future growth queued (EOF=$eof, short tail=$shortTail)",
      async ({ eof, shortTail }) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const view = (text: string, complete = false) => (
          <main>
            <div data-timeline-row-id="body">
              <Probe
                text={text}
                frame
                initialBufferMs={0}
                complete={complete}
                streaming={!complete}
              />
              <div data-other-producer="" />
            </div>
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        const baseline = shortTail ? "甲乙丙丁戊己庚辛壬癸子丑" : "甲乙丙丁";
        const admitted = `${baseline}${shortTail ? "寅" : "戊"}`;
        const next = shortTail ? `${admitted}卯` : "甲乙丙丁戊己庚辛壬癸子丑寅";
        const last = next.at(-1)!;
        await render(view(baseline));
        const main = container.querySelector("main")!;
        const row = main.querySelector<HTMLElement>("[data-timeline-row-id]")!;
        const other = row.querySelector<HTMLElement>("[data-other-producer]")!;
        const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        let rowHeight = 100;
        let boundaryTop = 20;
        row.getBoundingClientRect = () => new DOMRect(0, 0, 100, rowHeight);
        status.getBoundingClientRect = () => new DOMRect(0, boundaryTop, 100, 20);
        const sizes = new Map([["body", 20]]);
        const publications: Array<{ generation: number; height: number }> = [];
        const synchronous = vi.fn((write: () => void) => write());
        const layout = createTimelineLayout(main, {
          list: () => ({
            getState: () => ({ sizes }),
            setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
          }),
          control: () => null,
          requestCommit: (generation) =>
            publications.push({ generation, height: sizes.get("body")! }),
          synchronous,
        });
        const step = async () => {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        };
        try {
          await render(view(admitted));
          for (let index = 0; index < 20 && publications.length === 0; index++) await step();
          const first = publications.at(-1)!;
          expect(first.height).toBe(100);
          boundaryTop = 200;
          await act(() => layout.complete(first.generation));
          for (let index = 0; index < 40; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain(
            admitted.at(-1)!,
          );

          rowHeight = 20;
          setSmoothTextFrameHeight(other, 0);
          await step();
          const shrink = publications.at(-1)!;
          expect(shrink.height).toBe(20);
          await act(() => layout.complete(shrink.generation));

          rowHeight = 100;
          setSmoothTextFrameHeight(other, 80);
          await step();
          expect(publications.at(-1)!.height).toBe(100);
          await render(view(next, eof));
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(last);
          for (let index = 0; index < 64; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(last);
          await act(() => layout.complete(publications.at(-1)!.generation));
          for (let index = 0; index < 64; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain(last);
          expect(synchronous).not.toHaveBeenCalled();
        } finally {
          layout.dispose();
        }
      },
    );

    it.each([
      { eof: false, shortTail: false },
      { eof: true, shortTail: false },
      { eof: true, shortTail: true },
    ])(
      "caps cached footer glyph space after independent CSS shrink (EOF=$eof, short tail=$shortTail)",
      async ({ eof, shortTail }) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const view = (text: string, complete = false) => (
          <main>
            <div data-footer style={{ height: 100 }}>
              <Probe
                text={text}
                frame
                initialBufferMs={0}
                complete={complete}
                streaming={!complete}
              />
              <div data-other-producer />
            </div>
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        const baseline = shortTail ? "甲乙丙丁戊己庚辛壬癸子丑" : "甲乙丙丁";
        const admitted = `${baseline}${shortTail ? "寅" : "戊"}`;
        const next = shortTail ? `${admitted}卯` : "甲乙丙丁戊己庚辛壬癸子丑寅";
        await render(view(baseline));
        const main = container.querySelector("main")!;
        const footer = main.querySelector<HTMLElement>("[data-footer]")!;
        const other = footer.querySelector<HTMLElement>("[data-other-producer]")!;
        const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        let boundaryTop = 20;
        footer.getBoundingClientRect = () =>
          new DOMRect(0, 0, 100, Number.parseFloat(footer.style.height));
        status.getBoundingClientRect = () => new DOMRect(0, boundaryTop, 100, 20);
        const requests: number[] = [];
        const layout = createTimelineLayout(main, {
          list: () => null,
          footer: () => footer,
          control: () => null,
          requestCommit: (generation) => requests.push(generation),
          synchronous: (write) => write(),
        });
        const step = async () => {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        };
        try {
          await render(view(admitted));
          for (let index = 0; index < 20 && requests.length === 0; index++) await step();
          expect(requests.length).toBeGreaterThan(0);
          boundaryTop = 200;
          await act(() => layout.complete(requests.at(-1)!));
          for (let index = 0; index < 40; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain(
            admitted.at(-1)!,
          );

          // This CSS box has no virtual spacer preserving its old 100px.
          // No height event or React receipt accompanies the shrink to 20px.
          footer.style.height = "20px";
          await render(view(next, eof));
          const last = next.at(-1)!;
          for (let index = 0; index < 64; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(last);

          footer.style.height = "100px";
          setSmoothTextFrameHeight(other, 80);
          await step();
          await act(() => layout.complete(requests.at(-1)!));
          for (let index = 0; index < 64; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain(last);
        } finally {
          layout.dispose();
        }
      },
    );

    it("repays a permit wait during continued auto output with 500ms fades", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockStreamRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockStreamRows(40);
      let blocked = false;
      const source = Array.from({ length: 1600 }, (_, index) =>
        String.fromCharCode(65 + (index % 26)),
      ).join("");
      const view = (length: number) => (
        <main>
          <div data-timeline-row-id="body">
            <Probe
              text={source.slice(0, length)}
              frame
              mode="auto"
              lineMode="adaptive"
              fadeDurationMs={500}
              yieldDurationMs={200}
              initialBufferMs={0}
            />
          </div>
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view(0));
      const main = container.querySelector("main")!;
      const frame = main.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const boundary = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
      boundary.getBoundingClientRect = () =>
        new DOMRect(0, blocked ? 200 : (Number.parseFloat(frame.style.height) || 0) + 20, 400, 20);
      let debtAfterWait = 0;
      let debtWhileStreaming = 0;
      let visible = 0;
      for (now = 10; now <= 4000; now += 10) {
        blocked = now >= 1000 && now < 1400;
        const received = Math.floor(now / 100) * 40;
        if (now % 100 === 0) await render(view(received));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        const pending = hidden.length;
        const nextVisible = received - pending;
        expect(hidden).toBe(source.slice(nextVisible, received));
        expect(nextVisible - visible).toBeLessThanOrEqual(128);
        // The measured boundary also covers the interval with a fixed permit.
        expect(Math.ceil(nextVisible / 40) * 20).toBeLessThanOrEqual(
          boundary.getBoundingClientRect().top + 0.5,
        );
        visible = nextVisible;
        if (now === 1500) debtAfterWait = pending;
        if (now === 3900) debtWhileStreaming = pending;
      }
      expect(debtAfterWait).toBeGreaterThan(80);
      expect(debtWhileStreaming).toBeLessThan(debtAfterWait / 2);
    });
    it.each([
      { hz: 30, duration: 100, row: 20, gap: 28, kind: "wrap", fade: 200 },
      { hz: 60, duration: 200, row: 20, gap: 28, kind: "paragraph", fade: 200 },
      { hz: 240, duration: 300, row: 36, gap: 44, kind: "heading", fade: 200 },
      { hz: 60, duration: 200, row: 20, gap: 28, kind: "list", fade: 0 },
      { hz: 30, duration: 100, row: 20, gap: 5, kind: "wrap", fade: 200 },
      { hz: 60, duration: 200, row: 20, gap: 5, kind: "paragraph", fade: 200 },
      { hz: 240, duration: 300, row: 36, gap: 5, kind: "heading", fade: 200 },
    ])(
      "uses the first safe paint at $hz Hz, $duration ms, $kind, gap=$gap, fade=$fade",
      async ({ hz, duration, row, gap, kind, fade }) => {
        await using fixture = await setup();
        const {
          container,
          highlights,
          frames,
          Probe,
          hiddenHighlight,
          rangeText,
          fadeRanges,
          mockWrappedRows,
          render,
        } = fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4, kind !== "wrap", false, undefined, row);
        const view = (tail: boolean, streaming = true, complete = false) => (
          <main style={{ overflowY: "auto" }} data-smooth-scroll-following="">
            <Probe
              text={tail ? "甲乙丙丁戊" : "甲乙丙丁"}
              frame
              initialBufferMs={0}
              yieldDurationMs={duration}
              fadeDurationMs={fade}
              streaming={streaming}
              complete={complete}
              richText={
                kind === "wrap" ? undefined : kind === "heading" ? (
                  <>
                    <h2 style={{ lineHeight: `${row}px` }}>甲乙丙丁</h2>
                    {tail && <h2 style={{ lineHeight: `${row}px` }}>戊</h2>}
                  </>
                ) : kind === "list" ? (
                  <ul>
                    <li>
                      甲乙丙丁
                      {tail && (
                        <ul>
                          <li>戊</li>
                        </ul>
                      )}
                    </li>
                  </ul>
                ) : (
                  <>
                    <p>甲乙丙丁</p>
                    {tail && <p>戊</p>}
                  </>
                )
              }
            />
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view(false));
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const thinking = container.querySelector<HTMLElement>("[data-timeline-status-height]")!;
        thinking.getBoundingClientRect = () =>
          new DOMRect(0, (Number.parseFloat(frame.style.height) || row) + gap, 100, 20);
        await render(view(true));
        const requiredBottom = row * 1.8 + (kind === "wrap" ? 0 : 2);
        let permitted = false;
        for (let index = 1; index <= hz * 2; index++) {
          now = (index * 1000) / hz;
          const before = Number.parseFloat(frame.style.height);
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
          const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
          if (!hidden.includes("戊")) {
            expect(before, "fade must start before the full space curve finishes").toBeLessThan(
              row * 2 - 0.1,
            );
            expect(thinking.getBoundingClientRect().top - 1).toBeGreaterThanOrEqual(requiredBottom);
            if (fade)
              expect(
                [...(highlights.get("t3-smooth-fade-1") ?? [])].some((range) =>
                  rangeText(range).includes("戊"),
                ),
              ).toBe(true);
            permitted = true;
            break;
          }
          if (gap > row)
            throw new Error("an existing safe gap must allow the first delivered frame");
          expect(
            thinking.getBoundingClientRect().top - 1,
            "do not miss the first safe delivered frame",
          ).toBeLessThan(requiredBottom);
          expect(fadeRanges().some((range) => rangeText(range).includes("戊"))).toBe(false);
        }
        expect(permitted).toBe(true);
        expect(
          container.querySelector("p[data-smooth-line-enter] p, li[data-smooth-line-enter] li"),
        ).toBeNull();
        for (const block of container.querySelectorAll("p, li, h2"))
          if (block.textContent?.includes("甲"))
            expect(block.hasAttribute("data-smooth-line-enter")).toBe(false);
        expect(fadeRanges().some((range) => /[甲乙丙丁]/u.test(rangeText(range)))).toBe(false);
        await render(view(true, false, true));
        for (let index = 0; index < hz * 2 && frames.size; index++) {
          now += 1000 / hz;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        }
        expect(hiddenHighlight()).toBeUndefined();
        expect(frames.size).toBe(0);
        expect(frame.getBoundingClientRect().height).toBe(row * 2);
      },
    );

    it.each([true, false])(
      "clips to the actual footnote separator with autoCollapse=%s",
      async (autoCollapse) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4);
        const view = (text: string) => (
          <main>
            <Probe text={text} frame initialBufferMs={0} />
            <StreamingMarkdownFootnotes
              host={null}
              detached={false}
              streaming={false}
              smooth={false}
              mode="character"
              lineMode="adaptive"
              autoCollapse={autoCollapse}
              items={[{ id: "note", text: "note", complete: true }]}
            >
              <ol>
                <li id="note">note</li>
              </ol>
            </StreamingMarkdownFootnotes>
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view("甲乙丙丁"));
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const separator = container.querySelector<HTMLElement>(
          ".streaming-markdown-footnotes-heading",
        )!;
        let edge = 60;
        separator.getBoundingClientRect = () => new DOMRect(0, edge, 100, 20);
        container.querySelector<HTMLElement>(
          "[data-timeline-status-height]",
        )!.getBoundingClientRect = () => new DOMRect(0, 100, 100, 20);
        await render(view("甲乙丙丁戊"));
        now = 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
        expect(
          Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height")) +
            frame.getBoundingClientRect().top,
        ).toBe(59);
        edge = 30;
        await act(() =>
          container.querySelector("main")!.dispatchEvent(new Event("scroll", { bubbles: false })),
        );
        expect(
          Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height")) +
            frame.getBoundingClientRect().top,
        ).toBe(29);
        edge = 75;
        await act(() => window.dispatchEvent(new Event("resize")));
        expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(
          74,
        );
        edge = -5;
        await act(() => container.querySelector("main")!.dispatchEvent(new Event("scroll")));
        expect(frame.hasAttribute("data-smooth-text-boundary")).toBe(true);
        expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(0);
      },
    );

    it("waits for the actual copy-control boundary and clips an already admitted line", async () => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <main>
          <Probe text={text} frame initialBufferMs={0} />
          <div data-timeline-tail-anchor="meta">Copy</div>
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view("甲乙丙丁"));
      let edge = 30;
      const controls = container.querySelector<HTMLElement>('[data-timeline-tail-anchor="meta"]')!;
      controls.getBoundingClientRect = () => new DOMRect(0, edge, 100, 28);
      container.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
        () => new DOMRect(0, 100, 100, 20);
      await render(view("甲乙丙丁戊"));
      now = 16;
      let callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("戊");
      expect(fadeRanges().some((range) => rangeText(range).includes("戊"))).toBe(false);
      edge = 60;
      now = 32;
      callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      edge = 30;
      await act(() => container.querySelector("main")!.dispatchEvent(new Event("scroll")));
      expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(29);
      await act(async () => {
        controls.removeAttribute("data-timeline-tail-anchor");
        await Promise.resolve();
      });
      expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(99);
      await act(async () => {
        controls.setAttribute("data-timeline-tail-anchor", "meta");
        await Promise.resolve();
      });
      expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(29);
    });

    it("does not let preceding message controls bound detached footnote playback", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <main>
          <div data-timeline-tail-anchor="meta">Copy</div>
          <div data-stream-footnotes="">
            <Probe text={text} frame initialBufferMs={0} />
          </div>
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view("甲乙丙丁"));
      container.querySelector<HTMLElement>(
        '[data-timeline-tail-anchor="meta"]',
      )!.getBoundingClientRect = () => new DOMRect(0, -40, 100, 28);
      container.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
        () => new DOMRect(0, 100, 100, 20);
      await render(view("甲乙丙丁戊"));
      now = 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
      expect(
        Number.parseFloat(
          container
            .querySelector<HTMLElement>("[data-smooth-text-frame]")!
            .style.getPropertyValue("--t3-smooth-paint-height"),
        ),
      ).toBe(99);
    });

    it("admits a same-row suffix from its glyph bounds rather than its taller layout box", async () => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <main>
          <Probe text={text} frame initialBufferMs={0} />
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view("甲"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      container.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
        () => new DOMRect(0, 19, 100, 20);
      await render(view("甲乙"));
      now = 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(hiddenHighlight()).toBeUndefined();
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(18);
      expect(fadeRanges().map(rangeText)).toContain("乙");
    });

    it.each([false, true])(
      "keeps early painted glyphs separate from layout height during source appends (blocks=%s)",
      async (blocks) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
          fixture;
        let now = 0;
        fixture.clock.mockImplementation(() => now);
        mockWrappedRows(4, blocks);
        const view = (text: string) => (
          <main>
            <Probe
              text={text}
              frame
              initialBufferMs={0}
              richText={
                blocks ? (
                  <>
                    <p>{text.slice(0, 4)}</p>
                    {text.length > 4 && <p>{text.slice(4)}</p>}
                  </>
                ) : undefined
              }
            />
            <div data-timeline-status-height="fixture:thinking" />
          </main>
        );
        await render(view("甲乙丙丁"));
        container.querySelector<HTMLElement>(
          "[data-timeline-status-height]",
        )!.getBoundingClientRect = () => new DOMRect(0, 80, 100, 20);
        await render(view("甲乙丙丁戊"));
        now = 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const height = Number.parseFloat(frame.style.height);
        expect(height).toBeLessThan(30);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
        await render(view("甲乙丙丁戊己"));
        expect(Number.parseFloat(frame.style.height)).toBeCloseTo(height, 5);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("戊");
        now = 32;
        const following = [...frames.values()];
        frames.clear();
        await act(() => following.forEach((callback) => callback(now)));
        expect(Number.parseFloat(frame.style.height)).toBeLessThan(30);
        // The sparse fixture keeps its original 100ms glyph cadence. Space
        // must not delay that deadline until the 200ms reservation ends.
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("己");
        while (now < 128) {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        }
        expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("己");
      },
    );

    it("refreshes an idle producer's clip when another producer publishes the timeline", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <main>
          <Probe text={text} frame initialBufferMs={0} />
          <div data-footer="" />
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view("甲乙丙丁"));
      let edge = 80;
      container.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
        () => new DOMRect(0, edge, 100, 20);
      let publication = 0;
      const layout = createTimelineLayout(container.querySelector("main")!, {
        list: () => null,
        control: () => null,
        requestCommit: (generation) => {
          publication = generation;
        },
        synchronous: (write) => write(),
      });
      const step = async () => {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        await act(() => layout.complete(publication));
      };
      try {
        await render(view("甲乙丙丁戊"));
        for (let index = 0; index < 200 && frames.size; index++) await step();
        expect(frames.size).toBe(0);
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(
          79,
        );
        edge = 30;
        setSmoothTextFrameHeight(container.querySelector<HTMLElement>("[data-footer]")!, 12);
        await step();
        expect(Number.parseFloat(frame.style.getPropertyValue("--t3-smooth-paint-height"))).toBe(
          29,
        );
      } finally {
        layout.dispose();
      }
    });
  });

  it("delivers scoped playback frames through the layout scope and cancels on unmount", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, render, unmount } = fixture;
    let nextScopedFrame = 0;
    const scopedFrames = new Map<number, FrameRequestCallback>();
    const cancelScopedFrame = vi.fn((id: number) => scopedFrames.delete(id));
    const scope = {
      frame: vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextScopedFrame;
        scopedFrames.set(id, callback);
        return () => cancelScopedFrame(id);
      }),
      afterCommit: vi.fn(() => () => {}),
    };
    const unregister = registerSmoothTextLayoutScope(container, scope);

    await render(<Probe text="" />);
    await render(<Probe text="Scoped playback stays queued between delivered frames." />);

    expect(scope.frame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    const scheduledFrame = scopedFrames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(scheduledFrame).toBeDefined();
    const [id, callback] = scheduledFrame!;
    scopedFrames.delete(id);
    await act(() => callback(123));

    expect(scope.frame).toHaveBeenCalledTimes(2);
    expect(scopedFrames.size).toBe(1);
    const pendingFrameId = scopedFrames.keys().next().value as number;
    await unmount();

    expect(cancelScopedFrame).toHaveBeenCalledWith(pendingFrameId);
    expect(scopedFrames.size).toBe(0);
    expect(frames.size).toBe(0);
    unregister();
  });

  describe("checkpoint playback", () => {
    it.each([false, true])(
      "plays an actual checkpoint tail without a new delta (strict=%s)",
      async (strict) => {
        await using fixture = await setup();
        const { Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
        const source = "History tail";
        const resume = {
          key: `start-checkpoint-${strict}`,
          baselineText: source,
          mountText: source,
          synchronized: true,
        };
        smoothTextPlaybackStore.set(resume.key, {
          visibleText: "History",
          sourceText: source,
          intervalMs: 10,
          recordedAt: FIXTURE_EPOCH,
        });
        const done = vi.fn();
        const view = (streaming: boolean) => {
          const probe = (
            <Probe
              text={source}
              resume={resume}
              onPlaybackComplete={done}
              streaming={streaming}
              complete={!streaming}
            />
          );
          return strict ? <StrictMode>{probe}</StrictMode> : probe;
        };
        await render(view(true));
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" tail");
        await render(view(true));
        await flushFrames();
        expect(done).not.toHaveBeenCalled();
        await render(view(false));
        await flushFrames();
        expect(hiddenHighlight()).toBeUndefined();
        expect(done).toHaveBeenCalledOnce();
      },
    );
    it("finishes the final fade after all glyphs are admitted", async () => {
      await using fixture = await setup();
      const { Probe, hiddenHighlight, fadeRanges, render, flushFrames } = fixture;
      const done = vi.fn();
      await render(<Probe text="A" />);
      await render(
        <Probe
          text="AB"
          streaming={false}
          complete
          onPlaybackComplete={done}
          fadeDurationMs={200}
        />,
      );
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges().length).toBeGreaterThan(0);
      expect(done).not.toHaveBeenCalled();
      await flushFrames();
      expect(done).toHaveBeenCalledOnce();
    });

    it("preserves a 500ms auto fade across EOF without restarting or clearing it", async () => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockStreamRows,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockStreamRows(40);
      const done = vi.fn();
      const view = (text: string, eof = false) => (
        <main>
          <Probe
            text={text}
            frame
            mode="auto"
            lineMode="adaptive"
            fadeDurationMs={500}
            yieldDurationMs={200}
            initialBufferMs={0}
            streaming={!eof}
            complete={eof}
            onPlaybackComplete={done}
          />
        </main>
      );
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await render(view("History"));
      now = 100;
      await render(view("HistoryA"));
      await step(116);
      const existing = fadeRanges().find((range) => rangeText(range) === "A");
      expect(existing).toBeDefined();
      now = 120;
      await render(view("HistoryAB", true));
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toContain(existing);
      expect(fadeRanges().map(rangeText)).toContain("B");
      expect(done).not.toHaveBeenCalled();
      await step(370);
      // Hidden/revealing can already be zero while the 500ms glyph fade is active.
      expect(container.querySelector("[data-smooth-revealing]")).toBeNull();
      expect(fadeRanges().length).toBeGreaterThan(0);
      expect(done).not.toHaveBeenCalled();
      await step(621);
      expect(fadeRanges()).toHaveLength(0);
      expect(done).toHaveBeenCalledOnce();
    });
    it.each(["history", "forceShow", "reduced-motion", "complete-checkpoint"])(
      "keeps %s static",
      async (kind) => {
        await using fixture = await setup();
        const { getMediaQuery, Probe, hiddenHighlight, fadeRanges, render, flushFrames } = fixture;
        const source = "History tail";
        const resume = {
          key: `start-static-${kind}`,
          baselineText: source,
          mountText: source,
          synchronized: true,
          forceShow: kind === "forceShow",
        };
        if (kind === "complete-checkpoint" || kind === "forceShow")
          smoothTextPlaybackStore.set(resume.key, {
            visibleText: kind === "complete-checkpoint" ? source : "History",
            sourceText: source,
            intervalMs: 10,
            recordedAt: FIXTURE_EPOCH,
          });
        if (kind === "reduced-motion")
          getMediaQuery("(prefers-reduced-motion: reduce)").setMatches(true);
        await render(
          <Probe
            text={source}
            {...(kind === "history" || kind === "reduced-motion" ? {} : { resume })}
            {...(kind === "reduced-motion" ? { claimInitialText: () => true } : {})}
          />,
        );
        await flushFrames();
        expect(hiddenHighlight()).toBeUndefined();
        expect(fadeRanges()).toHaveLength(0);
      },
    );
    it("waits for a paused queued item to become active", async () => {
      await using fixture = await setup();
      const { Probe, hiddenHighlight, render, flushFrames } = fixture;
      const view = (paused: boolean) => (
        <Probe
          text="queued note"
          paused={paused}
          streaming={false}
          claimInitialText={() => true}
          initialBufferMs={0}
        />
      );
      await render(view(true));
      expect(hiddenHighlight()).toBeDefined();
      await render(view(false));
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    });
  });

  it("keeps a retained segment's EOF drain behind its real boundary and owns the next segment", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(4);
    const done = vi.fn();
    const view = (text: string, eof: boolean) => (
      <main>
        <Probe
          text={text}
          frame
          streaming={false}
          complete={eof}
          drainOnComplete={eof}
          retainOnComplete
          initialBufferMs={0}
          onPlaybackComplete={done}
        />
        <div data-timeline-status-height="segment:thinking" />
      </main>
    );
    await render(view("AAAA", false));
    let edge = 20;
    container.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
      () => new DOMRect(0, edge, 100, 20);
    const source = "AAAA" + "B".repeat(40);
    await render(view(source, false));
    done.mockClear();
    await render(view(source, true));
    const step = async () => {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    for (let index = 0; index < 32; index++) await step();
    expect(hiddenHighlight()).toBeDefined();
    expect(done).not.toHaveBeenCalled();
    edge = 1000;
    container
      .querySelector("main")!
      .dispatchEvent(new Event("t3-smooth-text-layout-commit", { bubbles: true }));
    for (let index = 0; index < 500 && frames.size; index++) await step();
    expect(hiddenHighlight()).toBeUndefined();
    expect(done).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    await render(view(source + "CCCC", true));
    expect(done).toHaveBeenCalledOnce();
    for (let index = 0; index < 500 && frames.size; index++) await step();
    expect(hiddenHighlight()).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("continues a small verified backlog after the playback observer remounts", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames, unmount, remount } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    const resume: SmoothTextResumeInput = {
      key: "environment/thread/run/item/body",
      baselineText: "A",
      synchronized: true,
    };
    const source = "ABCDEFGHIJKLM";
    await render(<Probe text="A" resume={resume} />);
    await render(<Probe text={source} resume={resume} />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(hiddenHighlight()).toBeDefined();
    const hiddenBeforeDetach = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hiddenBeforeDetach.length).toBeGreaterThan(0);
    expect(hiddenBeforeDetach.length).toBeLessThan(source.length - 1);

    await unmount();
    await remount();
    expect(smoothTextPlaybackStore.get(resume.key)?.visibleText).toBeTruthy();
    await render(<Probe text={source} resume={resume} />);
    const hiddenAfterAttach = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hiddenAfterAttach).toBe(hiddenBeforeDetach);

    now += 16;
    const resumedFrames = [...frames.values()];
    frames.clear();
    await act(() => resumedFrames.forEach((callback) => callback(now)));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("").length).toBeLessThan(
      hiddenAfterAttach.length,
    );
    await flushFrames();
  });

  it("shows a large synchronized backlog immediately and smooths the next live delta", async () => {
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    const resume: SmoothTextResumeInput = {
      key: "environment/thread/run/large/body",
      baselineText: "A",
      synchronized: true,
      forceShow: true,
    };
    const source = `A${"b".repeat(100)}`;
    await render(<Probe text={source} resume={resume} />);
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
    expect(fadeRanges()).toHaveLength(0);
    expect(container.querySelector<HTMLElement>("[data-smooth-text-frame]")).toBeNull();

    await render(<Probe text={`${source} live`} resume={{ ...resume, forceShow: false }} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(" live");
  });

  it("keeps only marker-after text in the first synchronized commit in the playback queue", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume: SmoothTextResumeInput = {
      key: "environment/thread/run/marker/item/body",
      baselineText: "Synchronized history",
      mountText: "Synchronized history",
      synchronized: true,
    };
    await render(<Probe text="Synchronized history live" resume={resume} />);

    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" live");
  });

  it("shows a completed background snapshot without a mask or fade", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, fadeRanges, render } = fixture;
    const resume: SmoothTextResumeInput = {
      key: "environment/thread/run/completed/item/body",
      baselineText: "A",
      synchronized: true,
    };
    await render(<Probe text={`A${"b".repeat(80)}`} resume={resume} complete />);

    expect(hiddenHighlight()?.size ?? 0).toBe(0);
    expect(fadeRanges()).toHaveLength(0);
    expect(frames.size).toBe(0);
  });

  it.each([0, 80, 420, 1000])(
    "honors a %s ms fade without delaying text completion",
    async (duration) => {
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, fadeRanges, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
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
  it("does not reclaim a played prefix when its source closes while paused", async () => {
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } =
      fixture;
    const view = (paused: boolean, streaming: boolean, text = "AB") => (
      <Probe
        text={text}
        paused={paused}
        streaming={streaming}
        initialBufferMs={0}
        fadeDurationMs={0}
        drainOnComplete={false}
        claimInitialText={() => true}
      />
    );
    await render(view(false, true));
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
    const node = container.querySelector("[data-probe]")!.firstChild;
    await render(view(true, true));
    await render(view(true, false));
    expect(container.querySelector("[data-smooth-output]")).toBeNull();
    await render(view(false, false));
    expect(container.querySelector("[data-probe]")!.firstChild).toBe(node);
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
    expect(fadeRanges()).toHaveLength(0);
    await render(view(false, false, "AB new tail"));
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden).toContain("new tail");
    expect(hidden).not.toContain("AB");
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
  });

  it("still buffers deferred glyphs when the fixed source closes while its DOM is empty", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    const view = (text: string, streaming: boolean, paused: boolean) => (
      <Probe
        text={text}
        sourceText="New text"
        streaming={streaming}
        paused={paused}
        initialBufferMs={0}
        fadeDurationMs={0}
        drainOnComplete={false}
        claimInitialText={() => true}
      />
    );
    await render(view("", true, true));
    await render(view("", false, true));
    await render(view("New text", false, false));
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("New text");
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
  });

  it("reports playback complete after glyph fades finish without delaying the text-settled signal", async () => {
    await using fixture = await setup();
    const { frames, Probe, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it.each(["- 任务正文", "1. 任务正文", "- [x] 任务正文"])(
    "fades the list prefix with its first row without replaying an appended tail: %s",
    async (source) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      const view = (text: string) => (
        <Probe text={text} markdown frame initialBufferMs={0} claimInitialText={() => true} />
      );
      await render(view(source));
      const item = container.querySelector("li")!;
      const opacity = () =>
        Number(item.style.getPropertyValue("--t3-smooth-marker-opacity") || "1");
      expect(opacity()).toBe(0);
      let intermediate = false;
      for (now = 16; now <= 700; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        intermediate ||= opacity() > 0 && opacity() < 1;
      }
      expect(intermediate).toBe(true);
      await flushFrames();
      expect(opacity()).toBe(1);
      await render(view(source + "，继续追加正文"));
      expect(container.querySelector("li")).toBe(item);
      expect(opacity()).toBe(1);
      await flushFrames();
      expect(item.hasAttribute("data-smooth-list-marker")).toBe(false);
    },
  );

  it("keeps a task checkbox on the same FIFO as its still hidden label", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockMediaRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
            const clipped = Number(
              /inset\(0px 0px ([\d.]+)px(?: 0px)?\)/u.exec(image.style.clipPath)?.[1],
            );
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
    await using fixture = await setup();
    const { container, frames, Probe, mockMediaRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockMediaRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, mockMediaRows, render, flushFrames } = fixture;
    let now = 0;
    let imageHeight = 40;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockMediaRows, render, flushFrames } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockMediaRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, mockMediaRows, render, flushFrames } = fixture;
    let now = 0;
    let imageHeight = 40;
    fixture.clock.mockImplementation(() => now);
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

  /**
   * Streams "H", then an image and a following text row arriving at 25
   * glyphs per second. Returns when the image box completed, when the first
   * following glyph appeared, and the longest pause between following glyphs.
   */
  async function streamTextAfterImage(
    fixture: Awaited<ReturnType<typeof setup>>,
    {
      loadAt,
      loadedHeight = 180,
    }: {
      loadAt?: number;
      loadedHeight?: number;
    },
  ) {
    const { container, frames, Probe, hiddenHighlight, rangeText, mockMediaRows, render } = fixture;
    let now = 0;
    let imageHeight = loadAt === undefined ? loadedHeight : 100;
    fixture.clock.mockImplementation(() => now);
    mockMediaRows(() => imageHeight);
    const tail = "T".repeat(30);
    const view = (shown: number) => (
      <Probe
        text={shown > 0 ? `H image ${tail.slice(0, shown)}` : "H image"}
        frame
        claimInitialText={() => true}
        richText={
          <>
            <p>H</p>
            <p>
              <img data-media-object="" alt="fixture" />
            </p>
            {shown > 0 ? <p data-media-tail="">{tail.slice(0, shown)}</p> : null}
          </>
        }
      />
    );
    await render(<Probe text="H" frame claimInitialText={() => true} richText={<p>H</p>} />);
    const step = async () => {
      now += 1_000 / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    // 90 frames at 60 Hz: past the first window, with "H" fully shown.
    for (let index = 0; index < 90; index++) await step();
    const imageAt = now;
    await render(view(0));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let arrived = 0;
    let loaded = false;
    let boxDoneAt: number | null = null;
    let firstTailAt: number | null = null;
    let previousVisible = 0;
    let lastRevealAt = 0;
    let longestTailGap = 0;
    for (let index = 0; index < 180; index++) {
      const elapsed = now - imageAt;
      const due = Math.min(tail.length, Math.floor(elapsed / 40));
      if (due > arrived) {
        arrived = due;
        await render(view(arrived));
      }
      if (loadAt !== undefined && !loaded && elapsed >= loadAt) {
        loaded = true;
        imageHeight = loadedHeight;
        await act(() => container.querySelector("img")!.dispatchEvent(new Event("load")));
      }
      await step();
      if (boxDoneAt === null && Number.parseFloat(frame.style.height) >= 20 + imageHeight - 0.5)
        boxDoneAt = now - imageAt;
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      const visible = arrived - (hidden.match(/T/gu)?.length ?? 0);
      if (visible > previousVisible) {
        if (previousVisible === 0) firstTailAt = now - imageAt;
        else if (arrived < tail.length)
          longestTailGap = Math.max(longestTailGap, now - lastRevealAt);
        lastRevealAt = now;
        previousVisible = visible;
      }
    }
    expect(hiddenHighlight()).toBeUndefined();
    return { boxDoneAt: boxDoneAt!, firstTailAt: firstTailAt!, longestTailGap };
  }

  it("opens the row after an image within the image's own space curve", async () => {
    await using fixture = await setup();

    // A media box has no glyphs to play while it opens. Waiting for it to
    // complete before opening the following row paused the text after every
    // image by a whole row's space curve.
    const { boxDoneAt, firstTailAt } = await streamTextAfterImage(fixture, {});
    expect(firstTailAt - boxDoneAt).toBeLessThanOrEqual((1_000 / 60) * 4 + 0.001);
  });

  it.each([
    ["grows while the following text plays", 900, 180],
    ["shrinks while the following text plays", 900, 40],
    ["grows while the following row opens", 170, 180],
  ] as const)(
    "keeps the following text playing when a loaded image %s",
    async (_label, loadAt, loadedHeight) => {
      await using fixture = await setup();

      const { firstTailAt, longestTailGap } = await streamTextAfterImage(fixture, {
        loadAt,
        loadedHeight,
      });
      expect(firstTailAt).toBeLessThanOrEqual(250);
      // 25 glyphs per second arrive one every 40ms: about three 60 Hz frames.
      expect(longestTailGap).toBeLessThanOrEqual((1_000 / 60) * 5 + 0.001);
    },
  );

  it("keeps geometry observation until an image loading after completion has settled", async () => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      Probe,
      hiddenHighlight,
      mockMediaRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    let imageHeight = 40;
    let loaded = false;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      Probe,
      hiddenHighlight,
      rangeText,
      mockMediaRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    let imageHeight = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, mockMediaRows, render } = fixture;
    let now = 0;
    let imageHeight = 40;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it("keeps a row's opening space when a rewrite changes that row's tail", async () => {
    await using fixture = await setup();
    const {
      container,
      highlights,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      unmount,
      remount,
    } = fixture;
    // Markdown can rewrite the end of the row whose space is opening, e.g. when
    // a delimiter resolves. The row must keep its curve instead of restarting
    // it on every such commit. The control receives the same fragments as a
    // following paragraph, a plain append, so both runs measure one source rate.
    const firstGlyphShownAt = async (rewriteOpeningRow: boolean) => {
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const first = "A".repeat(12);
      let second = `${"B".repeat(12)}x`;
      let third = "";
      const view = () => (
        <Probe
          id={rewriteOpeningRow ? "rewriting" : "appending"}
          text={`${first}\n${second}${third ? `\n${third}` : ""}`}
          frame
          markdownParagraph
          claimInitialText={() => true}
        />
      );
      await render(view());
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const shown = "B".repeat(12);
      for (let step = 0; step < 240; step++) {
        now += 1_000 / 60;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        if (!hidden.includes(shown)) return now;
        if (Number.parseFloat(frame.style.height) > 20 && step % 3 === 0) {
          if (rewriteOpeningRow) second = `${second.slice(0, -1)}Cx`;
          else third += "C";
          await render(view());
        }
      }
      return Number.POSITIVE_INFINITY;
    };
    const appending = await firstGlyphShownAt(false);
    await unmount();
    frames.clear();
    highlights.clear();
    await remount();
    fixture.restoreMocks();
    const rewriting = await firstGlyphShownAt(true);
    expect(appending).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(rewriting - appending).toBeLessThan(1_000 / 20);
  });

  it.each([false, true])(
    "bounds an isolated row's glyph wait by its real space pulse (cleared source: %s)",
    async (clearedSource) => {
      await using fixture = await setup();
      const {
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      if (clearedSource) {
        for (const source of ["", "x", "xy", ""]) {
          await render(
            <Probe
              text=""
              sourceText={source}
              frame
              markdownParagraph
              claimInitialText={() => true}
            />,
          );
        }
      }
      const rows = Array.from({ length: 4 }, (_, row) => String.fromCharCode(65 + row).repeat(30));
      await render(
        <Probe text={rows.join("\n")} frame markdownParagraph claimInitialText={() => true} />,
      );
      // Later rows wait for their own bounded space pulse, then keep their
      // glyph clocks instead of exposing an entire row in one paint.
      let previousVisible = 0;
      let longestPause = 0;
      let largestFrameReveal = 0;
      let pauseStartedAt: number | null = null;
      for (let step = 0; step < 600 && frames.size > 0; step++) {
        now += 1_000 / 60;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect(fadeRanges().every((range) => rangeText(range).length === 1)).toBe(true);
        expectPaintedGlyphsToFit();
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").replace(/\s/gu, "");
        const visible = rows.join("").length - hidden.length;
        if (visible > 0 && hidden.length > 0 && visible === previousVisible) pauseStartedAt ??= now;
        else if (pauseStartedAt !== null) {
          longestPause = Math.max(longestPause, now - pauseStartedAt);
          pauseStartedAt = null;
        }
        if (previousVisible > 0)
          largestFrameReveal = Math.max(largestFrameReveal, visible - previousVisible);
        previousVisible = visible;
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(longestPause).toBeLessThan((2 * 20) / DEFAULT_LINE_BEZIER_PEAK_VELOCITY);
      // The pool may run at twice this one-second batch's source pace, then
      // repay a real layout wait at twice that glyph pace. The longer fixed-peak
      // pulse must still respect that allowance rather than release a row.
      const maximumGlyphsPerSecond = rows.join("").length * 2 * 2;
      expect(largestFrameReveal).toBeLessThanOrEqual(Math.ceil(maximumGlyphsPerSecond / 60));
    },
  );

  it.each([30, 60, 240])(
    "keeps an admitted row's unfinished glyphs readable when a later block rewrites at %s Hz",
    async (hz) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it("keeps checkbox list rows on the same continuous space curve as plain list rows", async () => {
    await using fixture = await setup();
    const { container, highlights, frames, Probe, hiddenHighlight, render, unmount, remount } =
      fixture;
    const rowHeight = 22.75;
    const glyphBottom = 20;
    const checkboxHeight = 13;
    const modelText = (count: number, task: boolean) =>
      Array.from({ length: count }, (_, index) => `${task ? "\uFFFC" : ""}${index + 1}`).join("");
    const run = async (task: boolean) => {
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        const owner =
          this.startContainer.nodeType === Node.TEXT_NODE
            ? this.startContainer.parentElement
            : (this.startContainer as Element).closest?.("li");
        const row = [...container.querySelectorAll("li")].findIndex(
          (li) => li === owner?.closest("li"),
        );
        const top = Math.max(0, row) * rowHeight;
        return {
          left: 0,
          right: 100,
          width: 100,
          top: top + 1,
          bottom: top + glyphBottom,
          height: glyphBottom - 1,
        } as DOMRect;
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const row = [...container.querySelectorAll("li")].findIndex(
          (li) => li === this.closest("li"),
        );
        const top = Math.max(0, row) * rowHeight;
        if (this.matches("[data-probe]")) {
          const height = this.querySelectorAll("li").length * rowHeight;
          return { left: 0, right: 100, width: 100, top: 0, bottom: height, height } as DOMRect;
        }
        if (this.matches("[data-smooth-text-frame]")) {
          const height = Number.parseFloat(this.style.height) || 0;
          return { left: 0, right: 100, width: 100, top: 0, bottom: height, height } as DOMRect;
        }
        if (this.matches("input[type=checkbox]")) {
          const checkboxTop = top + 4.95;
          return {
            left: 0,
            right: checkboxHeight,
            width: checkboxHeight,
            top: checkboxTop,
            bottom: checkboxTop + checkboxHeight,
            height: checkboxHeight,
          } as DOMRect;
        }
        const height = this.matches("li")
          ? rowHeight
          : rowHeight * this.querySelectorAll("li").length;
        return { left: 0, right: 100, width: 100, top, bottom: top + height, height } as DOMRect;
      });

      const view = (count: number) => (
        <Probe
          text={modelText(count, task)}
          sourceText={modelText(count, task)}
          frame
          initialBufferMs={0}
          claimInitialText={() => true}
          richText={
            <ul style={{ lineHeight: `${rowHeight}px` }}>
              {Array.from({ length: count }, (_, index) => (
                <li key={index} style={{ lineHeight: `${rowHeight}px` }}>
                  {task ? <input type="checkbox" readOnly /> : null}
                  <span>{index + 1}</span>
                </li>
              ))}
            </ul>
          }
        />
      );
      await render(view(0));
      for (let count = 1; count <= 3; count++) {
        now += 100;
        await render(view(count));
      }
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const completeAt: number[] = [];
      for (let step = 0; step < 90 && frames.size > 0; step++) {
        now += 1_000 / 60;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height) || 0;
        while (completeAt.length < 3 && height >= (completeAt.length + 1) * rowHeight - 0.5)
          completeAt.push(now);
      }
      expect(hiddenHighlight()).toBeUndefined();
      return completeAt;
    };

    const plainRows = await run(false);
    await unmount();
    await remount();
    frames.clear();
    highlights.clear();
    fixture.restoreMocks();
    const taskRows = await run(true);

    expect(plainRows).toHaveLength(3);
    expect(taskRows).toHaveLength(3);
    for (let index = 1; index < 3; index++)
      expect(taskRows[index]! - taskRows[index - 1]!).toBeLessThanOrEqual(
        plainRows[index]! - plainRows[index - 1]! + 1_000 / 60,
      );
  });

  it("reserves fenced code rows without adding glyph fades", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      fadeRanges,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it("does not advance code space between paints when an append does not reflow visible glyphs", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40);
    const view = (text: string) => (
      <Probe
        text={text}
        frame
        initialBufferMs={0}
        claimInitialText={() => true}
        richText={
          <pre>
            <code>{text}</code>
          </pre>
        }
      />
    );
    await render(view("abcdefghijkl"));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let before = 0;
    let movingAndVisible = false;
    for (now = 0; now < 500; now += 7) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      before = Number.parseFloat(frame.style.height);
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      if (hidden > 0 && hidden < 12 && before < 19.9) {
        movingAndVisible = true;
        break;
      }
    }
    expect(movingAndVisible).toBe(true);
    now += 3;
    await render(view("abcdefghijklm"));
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 6);
    await flushFrames();
    expect(Number.parseFloat(frame.style.height)).toBe(20);
  });

  it("starts a new code row on its wake frame instead of backdating through the idle source gap", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40);
    const view = (text: string) => (
      <Probe
        text={text}
        frame
        initialBufferMs={0}
        richText={
          <pre>
            <code>{text}</code>
          </pre>
        }
      />
    );
    const first = "H".repeat(40);
    const second = `${first}\n${"A".repeat(40)}`;
    await render(view(first));
    now = 80;
    await render(view(second));
    for (; now < 2_000 && frames.size > 0; now += 7) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(frames.size).toBe(0);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const before = Number.parseFloat(frame.style.height);
    now += 80;
    await render(view(`${second}\n${"B".repeat(40)}`));
    now += 7;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(Number.parseFloat(frame.style.height) - before).toBeLessThan(0.5);
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    await flushFrames();
    expect(Number.parseFloat(frame.style.height)).toBe(60);
  });

  it.each([300, 1200])(
    "keeps queued code space moving through a multi-frame glyph wait at %s chars per second",
    async (charsPerSecond) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, false, false, undefined, 40);
      const chunkSize = Math.round(charsPerSecond / 12.5);
      const source = Array.from({ length: 80 }, () => "x".repeat(39) + "\n").join("");
      const view = (sourceLength: number) => {
        const text = source.slice(0, sourceLength);
        return (
          <Probe
            text={text}
            sourceText={source.slice(0, sourceLength)}
            frame
            initialBufferMs={0}
            claimInitialText={() => true}
            richText={
              <pre>
                <code>{text}</code>
              </pre>
            }
          />
        );
      };
      const frameHeight = () =>
        Number.parseFloat(
          container.querySelector<HTMLElement>("[data-smooth-text-frame]")!.style.height,
        ) || 0;
      await render(view(0));

      let maxStep = 0;
      let renderedSourceLength = 0;
      let previousHeight = frameHeight();
      const totalDuration = 800;
      let frameIndex = 0;
      for (now = 4.1; now <= totalDuration; frameIndex += 1) {
        now += frameIndex === 96 ? 20.8 : 4.1;
        const nextLength = Math.min(source.length, Math.floor(now / 80) * chunkSize);
        if (nextLength !== renderedSourceLength) {
          await render(view(nextLength));
          renderedSourceLength = nextLength;
        }
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = frameHeight();
        if (previousHeight >= 40 && height - previousHeight > maxStep) {
          maxStep = height - previousHeight;
        }
        previousHeight = height;
      }

      const sourceLengthAtEnd = Math.min(source.length, Math.floor(totalDuration / 80) * chunkSize);
      const hiddenLengthAtEnd = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      const visibleLengthAtEnd = sourceLengthAtEnd - hiddenLengthAtEnd;
      // A moving Hermite continuation may accelerate above its mean source speed.
      expect(maxStep).toBeLessThan(40 / 4);
      expect(visibleLengthAtEnd / (totalDuration / 1_000)).toBeGreaterThan(charsPerSecond * 0.4);

      // Let the actual queued source drain, then send another chunk after a
      // real idle gap. The new space must start from rest instead of inheriting
      // velocity from the previous burst.
      for (let step = 0; step < 2_000 && frames.size > 0; step += 1) {
        now += 4.1;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(hiddenHighlight()).toBeUndefined();
      const beforeIdleChunk = frameHeight();
      now += 120;
      const nextSourceLength = Math.min(source.length, sourceLengthAtEnd + chunkSize);
      await render(view(nextSourceLength));
      now += 4.1;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(frameHeight() - beforeIdleChunk).toBeLessThan(8);
      expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    },
  );

  it("keeps queued code handoffs moving after delayed Timeline publications", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40, false, false, undefined, 40);
    const frameStep = 1_000 / 240;
    const baseline = "x".repeat(39) + "\n";
    const source = Array.from({ length: 24 }, () => "x".repeat(39) + "\n").join("");
    const chunkSize = 96;
    const view = (text: string) => (
      <main>
        <div data-timeline-row-id="body">
          <Probe
            text={text}
            sourceText={text}
            frame
            initialBufferMs={0}
            claimInitialText={() => true}
            richText={
              <pre>
                <code>{text}</code>
              </pre>
            }
          />
        </div>
        <div data-timeline-status-height="fixture:thinking" />
      </main>
    );
    await render(view(baseline));
    const main = container.querySelector("main")!;
    const row = main.querySelector<HTMLElement>("[data-timeline-row-id]")!;
    const frame = row.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
    const sizes = new Map([["body", 20]]);
    let committedHeight = 20;
    const publications: Array<{
      generation: number;
      requestedAt: number;
      height: number;
      complete(): void;
    }> = [];
    let layout!: ReturnType<typeof createTimelineLayout>;
    status.getBoundingClientRect = () => new DOMRect(0, committedHeight, 100, 20);
    layout = createTimelineLayout(main, {
      list: () => ({
        getState: () => ({ sizes }),
        setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
      }),
      control: () => null,
      requestCommit: (generation) => {
        publications.push({
          generation,
          requestedAt: now,
          height: sizes.get("body")!,
          complete: layout.capture(generation),
        });
      },
      synchronous: (write) => write(),
    });

    let sourceLength = 0;
    let completedPublications = 0;
    let delayedPublications = 0;
    let queuedFrames = 0;
    let growthSamples = 0;
    let lastGrowthAt: number | null = null;
    let maxGrowthGap = 0;
    let maxGrowthGapStart: number | null = null;
    let maxGrowthGapEnd: number | null = null;
    let previousHeight = Number.parseFloat(frame.style.height) || 20;
    let previousHidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
    const endAt = 900;
    try {
      for (now = frameStep; now <= endAt; now += frameStep) {
        const nextLength = Math.min(source.length, Math.floor(now / 80) * chunkSize);
        if (nextLength !== sourceLength) {
          await render(view(baseline + source.slice(0, nextLength)));
          sourceLength = nextLength;
        }

        while (
          publications[completedPublications] &&
          now - publications[completedPublications]!.requestedAt >= frameStep * 3
        ) {
          const publication = publications[completedPublications++]!;
          committedHeight = publication.height;
          delayedPublications += 1;
          await act(publication.complete);
        }

        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height) || 0;
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        // Measure handoff gaps only while the next row is already queued and
        // the owner has published enough space; real publication waits remain.
        if (hidden >= 80 && committedHeight >= height + 40) {
          queuedFrames += 1;
          if (height > previousHeight + 0.05) {
            growthSamples += 1;
            if (lastGrowthAt !== null && now - lastGrowthAt > maxGrowthGap) {
              maxGrowthGap = now - lastGrowthAt;
              maxGrowthGapStart = lastGrowthAt;
              maxGrowthGapEnd = now;
            }
            lastGrowthAt = now;
          }
        } else {
          // A supply or owner-space gap starts a new measurement interval.
          lastGrowthAt = null;
        }
        // A code row remains masked until its measured space has a real owner
        // publication, even while later source rows are already queued.
        if (hidden < previousHidden) {
          expect(completedPublications).toBeGreaterThan(0);
          const visible = baseline.length + sourceLength - hidden;
          expect(Math.ceil(visible / 40) * 40).toBeLessThanOrEqual(committedHeight + 0.5);
        }
        previousHidden = hidden;
        previousHeight = height;
      }

      expect(delayedPublications).toBeGreaterThan(0);
      expect(queuedFrames).toBeGreaterThan(20);
      expect(growthSamples).toBeGreaterThan(20);
      expect(
        maxGrowthGap,
        `growth gap=${maxGrowthGap} (${maxGrowthGapStart}..${maxGrowthGapEnd}); delayed publications=${delayedPublications}`,
      ).toBeLessThanOrEqual(frameStep * 2 + 0.001);
    } finally {
      layout.dispose();
    }
  });

  it("keeps alternating long and short code lines moving through delayed Timeline commits", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(80, true, false, undefined, 19.25);
    const frameStep = 1_000 / 240;
    const baseline = "b".repeat(96) + "\n";
    const source = [
      Array.from({ length: 24 }, () => "s".repeat(9)).join("\n") + "\n",
      Array.from(
        { length: 8 },
        () => ["L".repeat(62), "s".repeat(9), "m".repeat(22), "W".repeat(96)].join("\n") + "\n",
      ).join(""),
    ].join("");
    const chunkSize = 10;
    const sourceInterval = (chunkSize / 300) * 1_000;
    const view = (text: string) => (
      <main>
        <div data-timeline-row-id="body">
          <Probe
            text={text}
            sourceText={text}
            frame
            mode="auto"
            initialBufferMs={0}
            claimInitialText={() => true}
            richText={
              <pre>
                <code>{text}</code>
              </pre>
            }
          />
        </div>
        <div data-timeline-status-height="fixture:thinking" />
      </main>
    );
    await render(view(baseline));
    const main = container.querySelector("main")!;
    const row = main.querySelector<HTMLElement>("[data-timeline-row-id]")!;
    const frame = row.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const code = row.querySelector<HTMLElement>("code")!;
    const codeText = code.firstChild as Text;
    const status = main.querySelector<HTMLElement>("[data-timeline-status-height]")!;
    const sizes = new Map([["body", 20]]);
    let committedHeight = 20;
    const publications: Array<{
      generation: number;
      requestedAt: number;
      height: number;
      complete(): void;
    }> = [];
    let layout!: ReturnType<typeof createTimelineLayout>;
    status.getBoundingClientRect = () => new DOMRect(0, committedHeight, 100, 20);
    layout = createTimelineLayout(main, {
      list: () => ({
        getState: () => ({ sizes }),
        setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
      }),
      control: () => null,
      requestCommit: (generation) => {
        publications.push({
          generation,
          requestedAt: now,
          height: sizes.get("body")!,
          complete: layout.capture(generation),
        });
      },
      synchronous: (write) => write(),
    });

    let sourceLength = 0;
    let completedPublications = 0;
    let delayedPublications = 0;
    let growthSamples = 0;
    let lastGrowthAt: number | null = null;
    let maxGrowthGap = 0;
    let previousHeight = Number.parseFloat(frame.style.height) || 20;
    let previousHidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
    const endAt = 7_000;
    try {
      for (now = frameStep; now <= endAt; now += frameStep) {
        const nextLength = Math.min(source.length, Math.floor(now / sourceInterval) * chunkSize);
        if (nextLength !== sourceLength) {
          await render(view(baseline + source.slice(0, nextLength)));
          sourceLength = nextLength;
        }

        while (
          publications[completedPublications] &&
          now - publications[completedPublications]!.requestedAt >= frameStep * 3
        ) {
          const publication = publications[completedPublications++]!;
          committedHeight = publication.height;
          delayedPublications += 1;
          await act(publication.complete);
        }

        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height) || 0;
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        const sourcePending = hidden >= 80;
        if (sourcePending) {
          if (height > previousHeight + 0.05) {
            growthSamples += 1;
          }
          if (lastGrowthAt !== null) maxGrowthGap = Math.max(maxGrowthGap, now - lastGrowthAt);
          if (height > previousHeight + 0.05 || lastGrowthAt === null) lastGrowthAt = now;
        } else {
          lastGrowthAt = null;
        }

        if (hidden < previousHidden) {
          expect(completedPublications).toBeGreaterThan(0);
          const visibleText = (baseline + source.slice(0, sourceLength)).slice(
            0,
            baseline.length + sourceLength - hidden,
          );
          const lastGlyph = visibleText.search(/\S(?=\s*$)/u);
          if (lastGlyph >= 0) {
            const range = document.createRange();
            range.setStart(codeText, lastGlyph);
            range.setEnd(codeText, lastGlyph + 1);
            expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(committedHeight + 0.5);
          }
        }

        expect(height - previousHeight).toBeLessThanOrEqual(frameStep * 1.5 + 0.5);
        previousHidden = hidden;
        previousHeight = height;
      }

      expect(delayedPublications).toBeGreaterThan(0);
      expect(growthSamples).toBeGreaterThan(20);
      expect(sourceLength).toBe(source.length);
      expect(hiddenHighlight()).toBeUndefined();
      expect(
        maxGrowthGap,
        `height growth gap=${maxGrowthGap}ms while code FIFO remained queued`,
      ).toBeLessThanOrEqual(16.667);
    } finally {
      layout.dispose();
    }
  });

  it("keeps code handoff timing equal for ASCII and multicode-unit graphemes", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(1000, true);
    const heights: number[][] = [];
    for (const glyph of ["x", "e\u0301", "👩‍💻"]) {
      now = 0;
      const source = Array.from({ length: 8 }, (_, index) => [
        ...Array.from({ length: index % 2 ? 9 : 40 }, () => glyph),
        "\n",
      ]).flat();
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          mode="auto"
          initialBufferMs={0}
          claimInitialText={() => true}
          richText={
            <pre>
              <code>{text}</code>
            </pre>
          }
        />
      );
      await render(view(""));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const samples: number[] = [];
      for (now = 0; now <= 1600; now += 4) {
        if (now % 40 === 0) await render(view(source.slice(0, (now / 40 + 1) * 12).join("")));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        samples.push(Number.parseFloat(frame.style.height));
      }
      expect(hiddenHighlight()).toBeUndefined();
      heights.push(samples);
      await render(<></>);
    }
    for (const samples of heights.slice(1))
      for (let index = 0; index < samples.length; index++)
        expect(samples[index]).toBeCloseTo(heights[0]![index]!, 5);
  });

  it("keeps an empty pending code box clipped and animates its space when it closes", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    let naturalHeight = 20;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(80);
    const originalBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const bounds = originalBounds.call(this);
      return this.matches("[data-probe]")
        ? { ...bounds, height: naturalHeight, bottom: bounds.top + naturalHeight }
        : bounds;
    });
    const view = (code: "none" | "pending" | "closed") => (
      <Probe
        text="H"
        frame
        richText={
          <>
            <p>H</p>
            {code === "none" ? null : (
              <div
                className="chat-markdown-codeblock"
                data-markdown-code-pending={code === "pending" ? "" : undefined}
              >
                <pre>
                  <code />
                </pre>
              </div>
            )}
          </>
        }
      />
    );
    await render(view("none"));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    naturalHeight = 80;
    now = 10;
    await render(view("pending"));
    expect(Number.parseFloat(frame.style.height)).toBe(20);
    expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(true);
    now = 20;
    await render(view("closed"));
    expect(Number.parseFloat(frame.style.height)).toBe(20);
    now = 80;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(80);
    await flushFrames();
    expect(Number.parseFloat(frame.style.height)).toBe(80);
    expect(frames.size).toBe(0);
  });

  it.each(["plain", "highlighted"] as const)(
    "animates trailing code-only blank rows with %s text nodes instead of snapping to natural height",
    async (kind) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, fadeRanges, mockWrappedRows, render } =
        fixture;
      let now = 0;
      let naturalHeight = 20;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(80);
      const originalBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const bounds = originalBounds.call(this);
        return this.matches("[data-probe]")
          ? { ...bounds, height: naturalHeight, bottom: bounds.top + naturalHeight }
          : bounds;
      });
      const view = (blank: string) => (
        <Probe
          text={`const a = 1;${blank}`}
          frame
          richText={
            <pre>
              <code>
                {kind === "plain" ? (
                  `const a = 1;${blank}`
                ) : (
                  <>
                    <span>const a = 1;</span>
                    {blank}
                  </>
                )}
              </code>
            </pre>
          }
        />
      );
      await render(view(""));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      naturalHeight = 80;
      now = 10;
      await render(view("\n\n\n"));
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      const heights: number[] = [];
      for (now = 20; now <= 350; now += 10) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        heights.push(Number.parseFloat(frame.style.height));
        expect(fadeRanges()).toEqual([]);
      }
      expect(heights.some((height) => height > 20 && height < 80)).toBe(true);
      expect(
        Math.max(...heights.map((height, index) => height - (heights[index - 1] ?? 20))),
      ).toBeLessThan(15);
      expect(heights.at(-1)).toBe(80);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it.each([true, false])(
    "drains repeated code-only blank appends with streaming=%s",
    async (streaming) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
      let now = 0;
      let naturalHeight = 20;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(80);
      const originalBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const bounds = originalBounds.call(this);
        return this.matches("[data-probe]")
          ? { ...bounds, height: naturalHeight, bottom: bounds.top + naturalHeight }
          : bounds;
      });
      const view = (blank: string, live = true) => (
        <Probe
          text={`a${blank}`}
          frame
          streaming={live}
          richText={
            <pre>
              <code>{`a${blank}`}</code>
            </pre>
          }
        />
      );
      await render(view(""));
      now = 10;
      naturalHeight = 80;
      await render(view("\n\n\n"));
      now = 30;
      const first = [...frames.values()];
      frames.clear();
      await act(() => first.forEach((callback) => callback(now)));
      now = 40;
      naturalHeight = 140;
      await render(view("\n\n\n\n\n\n", streaming));
      for (now = 50; now <= 600; now += 10) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(
        Number.parseFloat(
          container.querySelector<HTMLElement>("[data-smooth-text-frame]")!.style.height,
        ) || naturalHeight,
      ).toBe(140);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it("keeps Suspense's hidden primary code out of the live glyph queue", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(12, true);
    await render(<Probe text="H" frame richText={<p>H</p>} />);
    const code = "const answer = 42;\nreturn answer;";
    await render(
      <Probe
        text={`H${code}`}
        frame
        richText={
          <>
            <p>H</p>
            <pre style={{ display: "none" }}>
              <code>{code}</code>
            </pre>
            <pre>
              <code>{code}</code>
            </pre>
          </>
        }
      />,
    );
    const hiddenPrimary = container.querySelector("pre")!;
    expect(
      [...(hiddenHighlight() ?? [])].some((range) => hiddenPrimary.contains(range.startContainer)),
    ).toBe(false);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(code);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    await render(
      <Probe
        text={`H${code}`}
        frame
        richText={
          <>
            <p>H</p>
            <pre>
              <code>{code}</code>
            </pre>
          </>
        }
      />,
    );
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("does not publish a loaded image's large natural height in one reflow", async () => {
    await using fixture = await setup();
    const { container, Probe, mockMediaRows, render, flushFrames } = fixture;
    let now = 0;
    let imageHeight = 40;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockMediaRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      // The configured 200ms curve has a distance-proportional Bezier peak.
      // Include the folded tail's 20px rather than the old image-duration cap.
      expect(
        Math.max(...heights.slice(1).map((height, index) => height - heights[index]!)),
      ).toBeLessThan((500 * (1000 / fps)) / (200 * 0.58));
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each([30, 60, 240])(
    "splits a large completed provider fragment into bounded grapheme batches at %s Hz",
    async (fps) => {
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    let drainDeadline = 5_000;
    for (let step = 1; now < drainDeadline; step++) {
      now = step * (1_000 / 60);
      if (step <= 120 && step % 6 === 0) await render(view(step / 6));
      if (step === 121) {
        await render(view(20, false));
        // These source revisions supply no physical arrival rate. The unread
        // rows still need their remaining travel at the independent peak.
        drainDeadline = now + remainingSpaceMs(60);
      }
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

  it.each([30, 60, 240])(
    "does not reserve a retained footer while revealing an earlier insertion at %s Hz",
    async (hz) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(68, true);
      const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
      const elementBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.matches("[data-retained-footer]")) {
          const range = document.createRange();
          range.selectNodeContents(this);
          const bounds = rangeBounds.call(range);
          const top = Math.floor(bounds.top / 20) * 20;
          const bottom = Math.ceil(bounds.bottom / 20) * 20;
          return { ...bounds, top, bottom, height: bottom - top };
        }
        return elementBounds.call(this);
      });
      const view = (insert: boolean) => (
        <Probe
          text={insert ? "History1FootnoteFooter" : "HistoryFootnoteFooter"}
          frame
          richText={
            <>
              <p>History{insert ? <a>1</a> : null}</p>
              <section data-retained-footer="">
                <p>Footnote</p>
                <p>Footer</p>
              </section>
            </>
          }
        />
      );
      await render(view(false));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const message = container.querySelector<HTMLElement>("[data-probe]")!;
      const naturalHeight = message.getBoundingClientRect().height;
      now = 100;
      await render(view(true));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("1");
      for (let step = 0; step < hz; step++) {
        now += 1_000 / hz;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect(Number.parseFloat(frame.style.height)).toBeCloseTo(naturalHeight);
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it("measures an inserted FIFO line after a taller retained inline run without replaying that run", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    for (now = 0; now < 1_000; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    now = 1_000;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    expect(fadeRanges().map(rangeText)).toContain("F");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("irst line");
    await flushFrames();
  });

  it("keeps the displayed edge on visible text when a closed details body is far above the viewport", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, fadeRanges, render, flushFrames } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, render } = fixture;
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, fadeRanges, render } = fixture;
    const text =
      "# Heading\n\n**Bold** and *italic*.\n\n| Column |\n| --- |\n| Value |\n\n```txt\ncode body\n```";
    await render(<Probe text="" markdown claimInitialText={() => true} />);
    await render(<Probe text={text} markdown claimInitialText={() => true} />);
    const seen = new Set<string>();
    let now = fixture.clock() + 1_000;
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    const opening = kind === "code" ? "`" : "[";
    const closing = kind === "code" ? "`" : "](https://example.com)";
    const selector = kind === "code" ? "code" : "a";
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    // The 1s initial window contains 100 real glyphs. A source-paced
    // continuous curve retains that finite queue instead of overspeeding.
    expect(Math.max(...backlogs)).toBeLessThan(100 + 64);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  describe("source append native segmentation", () => {
    function observeNativeYields(suffix: string) {
      const nativeSegment = Intl.Segmenter.prototype.segment;
      let yields = 0;
      const observer = vi.spyOn(Intl.Segmenter.prototype, "segment").mockImplementation(function (
        this: Intl.Segmenter,
        input: string,
      ) {
        const segments = nativeSegment.call(this, input);
        if (input === suffix) {
          const nativeIterator = segments[Symbol.iterator].bind(segments);
          Object.defineProperty(segments, Symbol.iterator, {
            value: function* () {
              for (const segment of nativeIterator()) {
                yields++;
                yield segment;
              }
            },
          });
        }
        return segments;
      });
      return { count: () => yields, restore: () => observer.mockRestore() };
    }

    it("segments an aligned source-only append once and preserves grapheme FIFO through EOF", async () => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        render,
        flushFrames,
      } = fixture;
      const suffix = "e\u0301👩‍💻🇨🇳";
      const nativeGraphemes = [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(suffix),
      ];
      expect(nativeGraphemes.map(({ segment }) => segment)).toEqual(["e\u0301", "👩‍💻", "🇨🇳"]);
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      await render(<Probe text="" sourceText="" mode="token" claimInitialText={() => true} />);
      await flushFrames();
      const observer = observeNativeYields(suffix);
      let sourceOnlyYields: number;
      try {
        await render(<Probe text="" sourceText={suffix} mode="token" />);
        sourceOnlyYields = observer.count();
        expect(container.querySelector("[data-probe]")!.textContent).toBe("");
        expect(hiddenHighlight()).toBeUndefined();
      } finally {
        observer.restore();
      }

      const text = `${suffix} second`;
      now = 100;
      await render(<Probe text="" sourceText={text} mode="token" />);
      now = 200;
      const onSettled = vi.fn();
      await render(<Probe text={text} sourceText={text} mode="token" onSettled={onSettled} />);
      const node = container.querySelector("[data-probe]")!.firstChild!;
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 2);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        now = 1_000;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(" second");
        expect(fadeRanges().map(rangeText).join("")).toBe(suffix);
        expect(onSettled).not.toHaveBeenCalled();
        const boundaries = new Set([
          0,
          ...nativeGraphemes.map(({ index, segment }) => index + segment.length),
        ]);
        for (const fade of fadeRanges()) {
          expect(boundaries.has(fade.startOffset)).toBe(true);
          expect(boundaries.has(fade.endOffset)).toBe(true);
        }
        await render(
          <Probe
            text={text}
            sourceText={text}
            mode="token"
            streaming={false}
            complete
            onSettled={onSettled}
          />,
        );
        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(hiddenHighlight()).toBeUndefined();
        expect(fadeRanges().length).toBeGreaterThan(0);
        await flushFrames();
        expect(container.querySelector("[data-probe]")!.firstChild).toBe(node);
        expect(node.textContent).toBe(text);
        expect(selection.getRangeAt(0)).toBe(range);
        expect(selection.anchorNode).toBe(node);
        expect(selection.focusNode).toBe(node);
        expect(selection.toString()).toBe("e\u0301");
        expect(hiddenHighlight()).toBeUndefined();
        expect(fadeRanges()).toEqual([]);
        expect(
          container.querySelector("[data-smooth-text-clipping], [data-smooth-inline-pending]"),
        ).toBeNull();
        expect(frames.size).toBe(0);
        expect(onSettled).toHaveBeenCalledTimes(1);
      } finally {
        selection.removeAllRanges();
      }
      // Only the necessary provider-arrival traversal remains; DOM work was observed separately.
      expect(sourceOnlyYields!).toBe(nativeGraphemes.length);
    });

    it.each(["e\u0301👩‍💻🇨🇳", " \t\n", "\uD800", "\u0301"])(
      "keeps arrival and playback source clocks independent for %j",
      async (suffix) => {
        await using fixture = await setup();
        const { container, frames, Probe, hiddenHighlight, fadeRanges, render, flushFrames } =
          fixture;
        const graphemes = [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(suffix),
        ].length;
        await render(
          <Probe
            text=""
            sourceText="A"
            arrivalSourceText="A"
            mode="token"
            claimInitialText={() => true}
          />,
        );
        const observer = observeNativeYields(suffix);
        try {
          await render(
            <Probe text="" sourceText="A" arrivalSourceText={`A${suffix}`} mode="token" />,
          );
          expect(observer.count()).toBe(graphemes);
          await render(
            <Probe
              text=""
              sourceText={`A${suffix}`}
              arrivalSourceText={`A${suffix}`}
              mode="token"
            />,
          );
          expect(observer.count()).toBe(graphemes);
          await render(
            <Probe
              text=""
              sourceText={`A${suffix}`}
              arrivalSourceText={`A${suffix}`}
              mode="token"
            />,
          );
          expect(observer.count()).toBe(graphemes);
        } finally {
          observer.restore();
        }
        await render(
          <Probe
            text={`A${suffix}`}
            sourceText={`A${suffix}`}
            arrivalSourceText={`A${suffix}`}
            mode="token"
            streaming={false}
            complete
          />,
        );
        await flushFrames();
        expect(container.querySelector("[data-probe]")!.textContent).toBe(`A${suffix}`);
        expect(hiddenHighlight()).toBeUndefined();
        expect(fadeRanges()).toEqual([]);
        expect(frames.size).toBe(0);
      },
    );

    it("keeps empty, equal-length and non-prefix source rewrites on their existing paths", async () => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, fadeRanges, render, flushFrames } =
        fixture;
      await render(
        <Probe
          text=""
          sourceText="A"
          arrivalSourceText="A"
          mode="token"
          claimInitialText={() => true}
        />,
      );
      const observer = observeNativeYields("B");
      try {
        await render(<Probe text="" sourceText="B" arrivalSourceText="A" mode="token" />);
        expect(observer.count()).toBe(0);
        await render(<Probe text="B" sourceText="B" arrivalSourceText="A" mode="token" />);
      } finally {
        observer.restore();
      }
      await flushFrames();
      expect(container.querySelector("[data-probe]")!.textContent).toBe("B");
      await render(<Probe text="" sourceText="" arrivalSourceText="A" mode="token" />);
      expect(hiddenHighlight()).toBeUndefined();
      await render(
        <Probe
          text="rewrite"
          sourceText="rewrite"
          arrivalSourceText="A"
          mode="token"
          streaming={false}
          complete
        />,
      );
      await flushFrames();
      expect(container.querySelector("[data-probe]")!.textContent).toBe("rewrite");
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toEqual([]);
      expect(frames.size).toBe(0);
    });
  });

  it("releases one received text batch at a time in token mode", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render } = fixture;
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    expect(code.style.clipPath.replace(/[ ,]/gu, "")).toBe('path("M00H18V20H0Z")');
    await step(1_025);
    expect(code.style.clipPath.replace(/[ ,]/gu, "")).toBe('path("M00H28V20H0Z")');
    await step(1_050);
    expect(code.style.clipPath.replace(/[ ,]/gu, "")).toBe('path("M00H28V20H0ZM020H18V40H0Z")');
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("本");
    expect(code.textContent).toBe("示例文本");
    await step(1_051);
    expect(code.style.clipPath.replace(/[ ,]/gu, "")).toBe('path("M00H28V20H0ZM020H18V40H0Z")');
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
    await using fixture = await setup();
    const {
      container,
      getMediaQuery,
      Probe,
      mockWrappedRows,
      render,
      flushFrames,
      setDocumentHidden,
      unmount,
    } = fixture;
    mockWrappedRows(64);
    await render(<Probe text="`pending code`" frame markdown claimInitialText={() => true} />);
    const code = container.querySelector("code")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(true);
    if (reason === "complete") {
      await render(<Probe text="`pending code`" frame markdown streaming={false} complete />);
      expect(code.hasAttribute("data-smooth-inline-pending")).toBe(true);
      await flushFrames();
    } else if (reason === "disabled") {
      await render(<Probe text="`pending code`" frame markdown enabled={false} />);
    } else if (reason === "hidden") {
      setDocumentHidden(true);
    } else if (reason === "reduced motion") {
      getMediaQuery("(prefers-reduced-motion: reduce)").setMatches(true);
    } else if (reason === "forced colors") {
      getMediaQuery("(forced-colors: active)").setMatches(true);
    } else {
      await unmount();
    }
    expect(code.hasAttribute("data-smooth-inline-pending")).toBe(false);
    expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
  });

  it("shows the final character after its opening space and preserves completion fades", async () => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      frames,
      Probe,
      hiddenHighlight,
      fadeRanges,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40);
    const onSettled = vi.fn();
    await render(
      <Probe
        text="Final answer"
        frame
        initialBufferMs={SMOOTH_TEXT_BUFFER_MS}
        claimInitialText={() => true}
      />,
    );
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);

    await render(
      <Probe
        text="Final answer."
        initialBufferMs={SMOOTH_TEXT_BUFFER_MS}
        frame
        streaming={false}
        complete
        claimInitialText={() => true}
        onSettled={onSettled}
      />,
    );
    expect(hiddenHighlight()?.size).toBeGreaterThan(0);
    expect(onSettled).not.toHaveBeenCalled();
    for (now = 4; now <= 500 && onSettled.mock.calls.length === 0; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expectPaintedGlyphsToFit();
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(now).toBeGreaterThanOrEqual(SMOOTH_TEXT_BUFFER_MS);
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).not.toHaveBeenCalled();
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("aligns an opening line on completion while preserving its character fades", async () => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      frames,
      Probe,
      hiddenHighlight,
      fadeRanges,
      mockLineAwareRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, highlights, frames, Probe, rangeText, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockLineAwareRanges, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    expect(committed).toBeGreaterThanOrEqual(before);
    // RAF timestamps describe the start of a frame, before its queued commits.
    await step(140);
    expect(Number.parseFloat(frameElement.style.height)).toBeGreaterThanOrEqual(committed);
  });

  it("keeps fast row displacement moving while its admitted glyphs approach the handoff", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it.each([false, true])(
    "does not turn short code delimiters into a scroll sprint inherited by prose (highlighted: %s)",
    async (highlighted) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const code = "const value = compute(input);\n}\n}\n".repeat(8);
      const source = code + "字".repeat(400);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          mode="auto"
          initialBufferMs={0}
          claimInitialText={() => true}
          richText={
            <>
              <pre>
                <code>
                  {highlighted
                    ? [...text.slice(0, code.length).matchAll(/[^\n]*(?:\n|$)/gu)]
                        .filter((line) => line[0].length > 0)
                        .map((line) => (
                          <Fragment key={line.index}>
                            <span>{line[0].replace(/\n$/u, "")}</span>
                            {line[0].endsWith("\n") ? "\n" : null}
                          </Fragment>
                        ))
                    : text.slice(0, code.length)}
                </code>
              </pre>
              {text.length > code.length ? <p>{text.slice(code.length)}</p> : null}
            </>
          }
        />
      );
      await render(view(""));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let arrival = 0;
      let previous = 0;
      let peak = 0;
      for (let timestamp = 6; timestamp <= 3000; timestamp += 6) {
        while (arrival * 80 <= timestamp) {
          now = arrival++ * 80;
          await render(view(source.slice(0, arrival * 24)));
        }
        now = timestamp;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        if (timestamp > 800) peak = Math.max(peak, height - previous);
        previous = height;
      }
      // 300 source glyphs/s across 11-glyph code rows is about 0.55px/ms.
      // Allow catch-up headroom, but not a delimiter-driven multi-row sprint.
      expect(peak).toBeLessThan(6);
      expect(previous).toBeGreaterThan(400);
      await flushFrames();
    },
  );

  it("keeps the code-to-prose height moving through queued glyph handoffs", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(30, true);
    const code = "let a = 1;\nlet b = 2;\n}\n";
    const source = code + "字".repeat(2000);
    const view = (text: string) => (
      <Probe
        text={text}
        frame
        mode="auto"
        richText={
          <>
            <pre>
              <code>{text.slice(0, code.length)}</code>
            </pre>
            {text.length > code.length ? <p>{text.slice(code.length)}</p> : null}
          </>
        }
      />
    );
    await render(view(source.slice(0, 1)));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let received = 1;
    let arrival = 0;
    let previousHeight = 20;
    const steps: number[] = [];
    for (let timestamp = 4; timestamp <= 2500; timestamp += 4) {
      while (arrival * 25 <= timestamp) {
        now = arrival++ * 25;
        received += 18;
        await render(view(source.slice(0, received)));
      }
      now = timestamp;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height);
      const step = height - previousHeight;
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      expect(step).toBeGreaterThanOrEqual(-1e-9);
      expectPaintedGlyphsToFit();
      if (timestamp > 1500 && hidden.length >= 30) steps.push(step);
      previousHeight = height;
    }
    expect(steps.length).toBeGreaterThan(0);
    expect(Math.min(...steps)).toBeGreaterThan(0.001);
    expect(Math.max(...steps)).toBeLessThan(20 / 4);
    await flushFrames();
  });

  it("does not freeze a completed footnote at the pace of its opening space", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40, true);
    const finished = vi.fn();
    const text = `\n${"字".repeat(31)}`;
    const view = (streaming: boolean) => (
      <Probe
        text={text}
        frame
        streaming={streaming}
        initialBufferMs={0}
        fadeDurationMs={500}
        drainOnComplete={false}
        claimInitialText={() => true}
        onPlaybackComplete={finished}
        richText={
          <>
            {"\n"}
            <p>{text.slice(1)}</p>
          </>
        }
      />
    );
    await render(view(true));
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    let firstAt: number | null = null;
    for (let at = 0; at <= 1000; at += 4) {
      await step(at);
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").replace(/\s/gu, "");
      if (hidden.length < 31) {
        firstAt = at;
        break;
      }
    }
    expect(firstAt).not.toBeNull();
    now = firstAt! + 1;
    await render(view(false));
    let remaining = 31;
    for (let at = firstAt! + 4; at <= firstAt! + 1000 && remaining > 0; at += 4) {
      await step(at);
      remaining = [...(hiddenHighlight() ?? [])].map(rangeText).join("").replace(/\s/gu, "").length;
    }
    expect(remaining).toBe(0);
    expect(finished).not.toHaveBeenCalled();
    await flushFrames();
    expect(finished).toHaveBeenCalledOnce();
  });

  it("plays a footnote queue inside the pinned activity row without a new first window or self-blocking", async () => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    const endAt = remainingSpaceMs(30);
    for (let index = 1; (index * 1000) / 30 <= endAt && hiddenHighlight(); index++) {
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
      await using fixture = await setup();
      const {
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      let activityTop = 20;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    let activityTop = 20;
    let synchronousCommits = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, mockMediaRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      const clipped = Number(
        /inset\(0px 0px ([\d.]+)px(?: 0px)?\)/u.exec(image.style.clipPath)?.[1],
      );
      expect(300 - clipped).toBeCloseTo(height - 20, 3);
    }
    expect(partialFrames).toBeGreaterThan(3);
    await flushFrames();
  });

  it("admits a media frame when pinned end-follow rounds its edge by a fraction of a pixel", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockMediaRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    let rootTop = 0;
    fixture.clock.mockImplementation(() => now);
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
    const deadline = remainingSpaceMs();
    for (now = 16; now <= deadline && frames.size; now += 16) {
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
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      let layoutCost = 0;
      let activityTop = 20;
      fixture.clock.mockImplementation(() => now + layoutCost);
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
      await render(content(text.slice(0, 41)));
      now = 1;
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockLineAwareRanges, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    // 200ms travel plus the delivered FIFO/glyph handoff paints.
    expect(followingAt! - firstAt!).toBeLessThanOrEqual(200 + 5 * 16);
  });

  it("eases a live partial wrapped row instead of interpreting its first increment as a complete row", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows();
      await render(<Probe text={text} frame claimInitialText={() => true} />);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      for (now = 0; now < 999; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      const next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 999;
      await act(async () => next[1](now));
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(0);
      expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(20);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        remainingSpaceMs,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      for (now = 0; now < 999; now += 16) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      let next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 999;
      await act(async () => next[1](now));
      expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(0);
      expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(20);
      expect(fadeRanges()).toHaveLength(0);
      next = frames.entries().next().value!;
      frames.delete(next[0]);
      now = 1_000;
      await act(async () => next[1](now));
      expectPaintedGlyphsToFit();
      expect(frame.style.height).toBe("20px");
      expect(fadeRanges().map(rangeText)).toEqual(kind === "code" ? [] : ["A"]);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("B\nC\nD");
      const deadline = now + remainingSpaceMs();
      for (now = 1_016; now <= deadline && frames.size > 0; now += 16) {
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
    } = fixture;
    let now = 0;
    let columns = 4;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    let columns = 4;
    fixture.clock.mockImplementation(() => now);
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
    const deadline = now + remainingSpaceMs();
    for (now += 16; now <= deadline && frames.size > 0; now += 16) {
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
        fixture;
      let now = 0;
      let displacement = 2;
      fixture.clock.mockImplementation(() => now);
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
      fixture.use(
        stubGlobal("getComputedStyle", (element: Element) => {
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
        }),
      );
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        renders,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        unmount,
      } = fixture;
      let now = 0;
      let columns = 20;
      let notifyResize: ResizeObserverCallback | undefined;
      const observe = vi.fn();
      const disconnect = vi.fn();
      fixture.use(
        stubGlobal(
          "ResizeObserver",
          class {
            constructor(callback: ResizeObserverCallback) {
              notifyResize = callback;
            }
            observe = observe;
            disconnect = disconnect;
          },
        ),
      );
      fixture.clock.mockImplementation(() => now);
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
        if (trigger === "resize observer")
          notifyResize?.(resizeEntries(container), {} as ResizeObserver);
        else window.dispatchEvent(new Event("resize"));
      });
      expectPaintedGlyphsToFit();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hiddenBefore);
      expect(fadeRanges()).toEqual(fadesBefore);
      expect(renders.get("message")).toBe(rendersBefore);
      const fittedHeight = frame.style.height;
      await act(async () => notifyResize?.(resizeEntries(container), {} as ResizeObserver));
      expect(frame.style.height).toBe(fittedHeight);
      expect(fadeRanges()).toEqual(fadesBefore);
      await unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(["resize observer", "window resize"] as const)(
    "fits a reflowed visible prefix while its unchanged last row is reserving after %s",
    async (trigger) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      let columns = 4;
      let notifyResize: ResizeObserverCallback | undefined;
      fixture.use(
        stubGlobal(
          "ResizeObserver",
          class {
            constructor(callback: ResizeObserverCallback) {
              notifyResize = callback;
            }
            observe() {}
            disconnect() {}
          },
        ),
      );
      fixture.clock.mockImplementation(() => now);
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
        if (trigger === "resize observer")
          notifyResize?.(resizeEntries(container), {} as ResizeObserver);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        fadeRanges,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
        expect(hiddenHighlight()?.size).toBeGreaterThan(0);
        expect(frame.hasAttribute("data-smooth-text-clipping")).toBe(true);
        expect(frame.style.height).toBe("0px");
        expect(fadeRanges()).toHaveLength(0);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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

  it("keeps a completed post-code gap within the fitted pixel velocity", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, remainingSpaceMs } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40, true);
    const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const bounds = rangeBounds.call(this);
      const shift = this.startContainer.parentElement?.closest("[data-final-gap]") ? 100 : 0;
      return new DOMRect(bounds.left, bounds.top + shift, bounds.width, bounds.height);
    });
    const elementBounds = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const bounds = elementBounds.call(this);
      if (!this.hasAttribute("data-probe") || !this.querySelector("[data-final-gap]"))
        return bounds;
      return new DOMRect(bounds.left, bounds.top, bounds.width, bounds.height + 100);
    });
    const view = (complete: boolean) => (
      <Probe
        text="H结束"
        frame
        complete={complete}
        streaming={!complete}
        richText={
          <>
            <pre>
              <code>H</code>
            </pre>
            <p data-final-gap="">结束</p>
          </>
        }
      />
    );
    await render(
      <Probe
        text="H"
        frame
        richText={
          <pre>
            <code>H</code>
          </pre>
        }
      />,
    );
    now = 100;
    await render(view(false));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    now = 104;
    await render(view(true));
    let previous = Number.parseFloat(frame.style.height);
    let peak = 0;
    const deadline = now + remainingSpaceMs(250);
    for (; now < deadline && frames.size > 0;) {
      now += 4;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height);
      if (Number.isFinite(height)) {
        peak = Math.max(peak, height - previous);
        previous = height;
      }
    }
    expect(peak).toBeLessThan(8);
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("finishes a final same-row insertion before retained footnotes in the activity completion commit", async () => {
    await using fixture = await setup();
    const {
      container,
      Probe,
      hiddenHighlight,
      fadeRanges,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it.each([0, 10])(
    "admits table text without requiring the intervening cells' full border boxes (glyph shift %s)",
    async (shift) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, render, flushFrames } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      // A Range crossing cells includes fully selected TD boxes in Chromium.
      // Individual glyphs fit at 36px; the middle cell's box extends to 56px.
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        const first = this.startContainer.parentElement?.closest("td");
        const last = this.endContainer.parentElement?.closest("td");
        if (first && last)
          return new DOMRect(
            0,
            24 + (first === last && first.cellIndex === 1 ? shift : 0),
            100,
            first === last ? 12 : 32,
          );
        return new DOMRect(0, this.startContainer.textContent === "Z" ? 64 : 4, 100, 12);
      });
      vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
        return [this.getBoundingClientRect()] as unknown as DOMRectList;
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.hasAttribute("data-timeline-status-height")) {
          const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
          return new DOMRect(0, (Number.parseFloat(frame.style.height) || 20) + 5, 100, 20);
        }
        if (this.hasAttribute("data-smooth-text-frame"))
          return new DOMRect(0, 0, 100, Number.parseFloat(this.style.height) || 20);
        return new DOMRect(0, 0, 100, this.querySelector("table") ? 80 : 20);
      });
      const view = (tail: boolean, streaming = true) => (
        <main>
          <Probe
            text={tail ? "HABCDEFGHIJKLZ" : "H"}
            frame
            initialBufferMs={0}
            streaming={streaming}
            richText={
              <>
                <p>H</p>
                {tail && (
                  <>
                    <table>
                      <tbody>
                        <tr>
                          <td>ABCD</td>
                          <td>EFGH</td>
                          <td>IJKL</td>
                        </tr>
                      </tbody>
                    </table>
                    <p>Z</p>
                  </>
                )}
              </>
            }
          />
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view(false));
      await render(view(true));
      for (let index = 0; index < 120 && frames.size; index++) {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(hiddenHighlight()).toBeUndefined();
      await render(view(true, false));
      await flushFrames();
      expect(frames.size).toBe(0);
    },
  );

  it.each([false, true])(
    "does not reserve a live table's empty tail while its last row drains (real toolbar: %s)",
    async (toolbar) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(64, true);
      const originalBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const rect = originalBounds.call(this);
        if (this.matches("[data-test-table-toolbar]"))
          return { ...rect, top: 40, bottom: 60, height: 20 };
        if (this.hasAttribute("data-smooth-text-frame") && this.style.height) return rect;
        const message = this.matches("[data-probe]") ? this : this.querySelector("[data-probe]");
        return message?.querySelector("table")
          ? { ...rect, height: rect.height + 60, bottom: rect.bottom + 60 }
          : rect;
      });
      const table = (
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
      );
      const initial = (
        <>
          <p>H</p>
          {toolbar ? (
            <div className="chat-markdown-table-container">
              {table}
              <div data-smooth-atomic="" data-test-table-toolbar="">
                <button type="button" aria-label="Copy table" />
              </div>
            </div>
          ) : (
            table
          )}
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
        expect(Number.parseFloat(frame.style.height)).toBeLessThanOrEqual(toolbar ? 60 : 40);
        expectPaintedGlyphsToFit();
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.style.height).toBe(toolbar ? "60px" : "40px");
      await render(<Probe text="HABCDEFGHIJ" frame richText={initial} streaming={false} />);
      await flushFrames();
      expect(frame.style.height).toBe("");
      expect(frame.getBoundingClientRect().height).toBe(100);
    },
  );

  it("keeps the pending row's deadline when earlier layout keeps moving its glyphs", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    let shift = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it.each([true, false])(
    "resumes only appended glyphs after completed playback disposes, streaming: %s",
    async (streaming) => {
      await using fixture = await setup();
      const { Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
      const finished = vi.fn();
      await render(
        <Probe
          text="AB"
          streaming={false}
          initialBufferMs={0}
          drainOnComplete={false}
          claimInitialText={() => true}
          onPlaybackComplete={finished}
        />,
      );
      await flushFrames();
      expect(finished).toHaveBeenCalledTimes(1);
      await render(
        <Probe
          text="AB new tail"
          streaming={streaming}
          initialBufferMs={0}
          drainOnComplete={false}
          onPlaybackComplete={finished}
        />,
      );
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      expect(hidden).toContain("new tail");
      expect(hidden).not.toContain("AB");
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("keeps a newly selected completed footnote out of the main answer's fast drain", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render, flushFrames } =
        fixture;
      let now = 0;
      let shift = 0;
      fixture.clock.mockImplementation(() => now);
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
      // The fixed-duration reflow is 200ms, followed by the admission paint.
      for (now = 16; now <= 256; now += 16) {
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
    await using fixture = await setup();
    const {
      container,
      frames,
      renders,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    let columns = 20;
    fixture.clock.mockImplementation(() => now);
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
    const deadline = now + remainingSpaceMs();
    for (now += 16; now <= deadline && frames.size > 0; now += 16) {
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      highlights,
      frames,
      Probe,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    for (now = 208; now <= 2_400 && frames.size > 0; now += 16) {
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      ).toBeLessThanOrEqual((bufferInitial ? 100 : 0) + 40);
      expect(backlog.at(-1)!.characters).toBeLessThanOrEqual(
        Math.max(...early.map((sample) => sample.characters)) + 4,
      );
      const pendingRows = [...(hiddenHighlight() ?? [])]
        .map(rangeText)
        .join("")
        .replace(/\s/gu, "").length;
      const drainMs = pendingRows * 10 + (2 * 20) / DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 64;
      for (now = streamEnd + 16; now <= streamEnd + drainMs && hiddenHighlight(); now += 16) {
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
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        for (const glyph of "abcdef") expect(hidden).not.toContain(glyph);
      }
      expect(hiddenHighlight()).toBeUndefined();
      expectPaintedGlyphsToFit();
      if (inlineCode) {
        expect(container.querySelector("code")?.textContent).toBe("abcdefg");
        expect(container.querySelector("code")?.style.clipPath).toBe("");
      }
    },
  );

  it("waits for terminal code to render before draining and reporting completion", async () => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    for (now = 800; now < 999; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, render } = fixture;
      fixture.clock.mockReturnValue(0);
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, render } = fixture;
      fixture.clock.mockReturnValue(0);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    fixture.clock.mockReturnValue(0);
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

  it("opens only the first row before a new multi-line burst's glyph buffer expires", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockLineAwareRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    for (now = 0; now < 999; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
      expect(fadeRanges()).toHaveLength(0);
    }
    const first = frames.entries().next().value!;
    frames.delete(first[0]);
    now = 999;
    await act(async () => first[1](now));
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(0);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
    expect(fadeRanges()).toHaveLength(0);
    const next = frames.entries().next().value!;
    frames.delete(next[0]);
    now = 1_000;
    await act(async () => next[1](now));
    expect(fadeRanges().map(rangeText)).toEqual(["A"]);
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("B\nC");
    await flushFrames();
    expect(frame.style.height).toBe("60px");
  });

  it("shows history immediately and masks appended text without React renders per frame", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      renders,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
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
    await using fixture = await setup();
    const { frames, Probe, rangeText, fadeRanges, render, flushMutations, flushFrames } = fixture;
    const history = "Existing history.";
    await render(<Probe text={history} />);
    expect(fadeRanges()).toHaveLength(0);

    await render(<Probe text={`${history} new`} />);
    const firstFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(firstFrame).toBeDefined();
    frames.delete(firstFrame![0]);
    await act(async () => firstFrame![1](fixture.clock() + 1_030));
    await flushMutations();
    const secondFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(secondFrame).toBeDefined();
    frames.delete(secondFrame![0]);
    await act(async () => secondFrame![1](fixture.clock() + 1_080));
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
      await using fixture = await setup();
      const { container, frames, Probe, rangeText, fadeRanges, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      await render(<Probe fadeDurationMs={180} text="History" coloredText />);
      const code = container.querySelector("span")!;
      const property = "--t3-smooth-foreground";
      code.style.color = "rgb(90, 140, 180)";
      if (hasExistingProperty) code.style.setProperty(property, "rgb(8, 9, 10)", "important");
      const previousValue = code.style.getPropertyValue(property);
      const previousPriority = code.style.getPropertyPriority(property);
      const foreground = getComputedStyle(code).color;
      expect(foreground).toBe("rgb(90, 140, 180)");
      await render(<Probe fadeDurationMs={180} text="HistoryAB" coloredText />);

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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        rangeText,
        fadeRanges,
        render,
        flushMutations,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      frames,
      getMediaQuery,
      Probe,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
      setDocumentHidden,
      unmount,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await unmount();
    }
    expect(fadeRanges()).toHaveLength(0);
    expect(code.style.getPropertyValue(property)).toBe(originalValue);
    expect(code.style.getPropertyPriority(property)).toBe("important");
    expect(code.style.color).toBe("rgb(90, 140, 180)");
    expect(code.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE)).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("restores an existing fade marker and foreground property after the last active glyph", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, fadeRanges, render, flushMutations, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    const content = (tail = false) => (
      <span style={{ color: "rgb(90, 140, 180)" }}>
        History{tail ? "A" : ""}
        <strong style={{ color: "rgb(220, 130, 40)" }}>{tail ? "B" : ""}</strong>
      </span>
    );
    await render(<Probe fadeDurationMs={180} text="History" richText={content()} />);
    await render(<Probe fadeDurationMs={180} text="HistoryAB" richText={content(true)} />);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockLineAwareRanges,
      render,
      flushMutations,
      flushFrames,
    } = fixture;
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

    let now = fixture.clock();
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      rangeText,
      fadeRanges,
      mockLineAwareRanges,
      render,
      flushMutations,
      flushFrames,
    } = fixture;
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

    let now = fixture.clock();
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, fadeRanges, render, flushMutations } =
      fixture;
    const onSettled = vi.fn(() => readSmoothTextEnd(container)?.bottom);
    await render(<Probe text="A" onSettled={onSettled} />);
    await render(<Probe text="AB" streaming={false} onSettled={onSettled} />);
    expect(onSettled).not.toHaveBeenCalled();

    let now = fixture.clock();
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
    await using fixture = await setup();
    const { container, frames, Probe, fadeRanges, render, flushMutations } = fixture;
    let clock = 0;
    fixture.clock.mockImplementation(() => clock);
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

    for (let index = 0; index < 20 && !onSettled.mock.calls.length; index += 1) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      frames.delete(next![0]);
      clock += 50;
      await act(async () => next![1](clock));
      await flushMutations();
    }

    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled.mock.results[0]?.value).toBe(2);
    expect(fadeRanges().length).toBeGreaterThan(0);
    expect(frames.size).toBeGreaterThan(0);
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(20);
    expect(Number.parseFloat(frame.style.height)).toBeLessThan(40);
    for (let index = 0; index < 80 && frames.size; index++) {
      clock += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(clock)));
    }
    expect(frame.style.height).toBe("");
    expect(frames.size).toBe(0);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("keeps text nodes, selection, code headers, and copied code unchanged", async () => {
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
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
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      frames,
      Probe,
      hiddenHighlight,
      render,
      flushFrames,
    } = fixture;
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, render, flushMutations, flushFrames } =
      fixture;
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

    let now = fixture.clock();
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
    await using fixture = await setup();
    const { container, frames, Probe, fadeRanges, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(20, true);
    const text = "持续播放正文".repeat(60);
    await render(<Probe text="" frame claimInitialText={() => true} />);
    await render(<Probe text={text} frame richText={<p>{text}</p>} />);
    const message = container.querySelector<HTMLElement>("[data-probe]")!;
    const query = vi.spyOn(message, "querySelector");
    for (now = 0; now < 1_050; now += 1_000 / 60) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render, flushMutations, flushFrames } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  const openingMotion = async (
    fixture: Awaited<ReturnType<typeof setup>>,
    velocity: number,
    distance = 20,
    stall = 0,
  ) => {
    const { container, frames, highlights, Probe, mockWrappedRows, render, unmount, remount } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40, true, false, undefined, distance);
    const first = "A".repeat(40);
    const second = `\n${"B".repeat(40)}`;
    const view = (text: string) => (
      <Probe
        text={text}
        frame
        initialBufferMs={0}
        claimInitialText={() => true}
        richText={<p style={{ lineHeight: `${distance}px` }}>{text}</p>}
      />
    );
    await render(view(first));
    // Two source samples establish the real arrival rate. The filled pool
    // plays at twice that rate; the measured row includes its separator.
    now = 40 / velocity;
    await render(view(first + second));
    const startedAt = now;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let previous = 0;
    let peak = 0;
    let stalledGrowth = 0;
    for (let elapsed = 0; elapsed <= 600; elapsed++) {
      now = startedAt + elapsed + (elapsed >= 21 ? stall : 0);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height);
      expect(height).toBeGreaterThanOrEqual(previous);
      if (elapsed === 21) stalledGrowth = height - previous;
      if (elapsed !== 21 || stall === 0) peak = Math.max(peak, height - previous);
      previous = height;
      if (height >= distance) break;
    }
    expect(previous).toBeGreaterThanOrEqual(distance);
    await unmount();
    frames.clear();
    highlights.clear();
    await remount();
    fixture.restoreMocks();
    return { peak, stalledGrowth };
  };

  it("retains painted header glyphs when a source append turns a paragraph into a table", async () => {
    await using fixture = await setup();
    const {
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40, true);
    const source = "ANCHOR\n\nHead A | Head B\n";
    await render(
      <Probe
        text={source}
        sourceText={source}
        frame
        richText={
          <>
            <p>ANCHOR</p>
            <p>Head A | Head B</p>
          </>
        }
      />,
    );
    expect(hiddenHighlight()).toBeUndefined();
    now = 100;
    await render(
      <Probe
        text={source + "| --- | --- |\n"}
        sourceText={source + "| --- | --- |\n"}
        frame
        richText={
          <>
            <p>ANCHOR</p>
            <table>
              <thead>
                <tr>
                  <th>Head A</th>
                  <th>Head B</th>
                </tr>
              </thead>
            </table>
          </>
        }
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("Head");
    expect(fadeRanges().map(rangeText).join("")).not.toContain("Head");
    for (now = 104; now <= 600; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).not.toContain("Head");
    }
    await flushFrames();
  });

  it("keeps an unread header masked when an appended delimiter changes its DOM", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, mockWrappedRows, render, flushFrames } = fixture;
    mockWrappedRows(40, true);
    const source = "ANCHOR\n\nHead A | Head B\n";
    await render(<Probe text="ANCHOR" frame richText={<p>ANCHOR</p>} />);
    await render(
      <Probe
        text={source}
        frame
        richText={
          <>
            <p>ANCHOR</p>
            <p>Head A | Head B</p>
          </>
        }
      />,
    );
    await render(
      <Probe
        text={source + "| --- | --- |\n"}
        frame
        richText={
          <>
            <p>ANCHOR</p>
            <table>
              <thead>
                <tr>
                  <th>Head A</th>
                  <th>Head B</th>
                </tr>
              </thead>
            </table>
          </>
        }
      />,
    );
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden).toContain("Head A");
    expect(hidden).toContain("Head B");
    await flushFrames();
  });

  it("animates a genuinely edited header when a paragraph becomes a table", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, mockWrappedRows, render, flushFrames } = fixture;
    mockWrappedRows(40, true);
    const source = "ANCHOR\n\nHead A | Head B\n";
    await render(
      <Probe
        text={source}
        frame
        richText={
          <>
            <p>ANCHOR</p>
            <p>Head A | Head B</p>
          </>
        }
      />,
    );
    await render(
      <Probe
        text={source.replace("Head A", "Other A") + "| --- | --- |\n"}
        frame
        richText={
          <>
            <p>ANCHOR</p>
            <table>
              <thead>
                <tr>
                  <th>Other A</th>
                  <th>Head B</th>
                </tr>
              </thead>
            </table>
          </>
        }
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("Other A");
    await flushFrames();
  });

  it.each(["adaptive", "parallel"] as const)(
    "carries the actual painted velocity through active %s source redirects",
    async (lineMode) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          lineMode={lineMode}
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      await render(view("AAAA"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        return Number.parseFloat(frame.style.height);
      };
      let text = "AAAA";
      for (const at of [80, 100]) {
        for (let frameAt = now + 1; frameAt < at; frameAt++) await step(frameAt);
        const before = await step(at - 0.1);
        const painted = await step(at);
        const incomingVelocity = (painted - before) / 0.1;
        expect(incomingVelocity).toBeGreaterThan(0);
        text += "\nAAAA";
        await render(view(text));
        expect(Number.parseFloat(frame.style.height)).toBeCloseTo(painted, 9);
        const after = await step(at + 0.1);
        expect((after - painted) / 0.1).toBeCloseTo(incomingVelocity, 3);
        expectPaintedGlyphsToFit();
      }
      await flushFrames();
    },
  );

  it.each([120, 1000])(
    "continues from the painted position when a redirect shares a %s ms stall",
    async (stallMs) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      await render(view("AAAA"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        return Number.parseFloat(frame.style.height);
      };
      for (let at = 0; at <= 80; at++) await step(at);
      const before = Number.parseFloat(frame.style.height);
      await render(view("AAAA\nAAAA"));
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 9);
      const after = await step(80 + stallMs);
      expect(after).toBeGreaterThan(before);
      expect(after - before).toBeLessThan(5);
      expectPaintedGlyphsToFit();
      await flushFrames();
    },
  );

  it.each([24, 32, 40, 50, 64, 80, 120])(
    "keeps a redirect moving across geometry sync after a %s ms delayed frame",
    async (gap) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      await render(view("AAAA"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expectPaintedGlyphsToFit();
        return Number.parseFloat(frame.style.height);
      };
      for (let at = 0; at <= 80; at += 16) await step(at);
      const before = Number.parseFloat(frame.style.height);
      await render(view("AAAA\nAAAA"));
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 9);
      const after = await step(80 + gap);
      expect(after).toBeGreaterThan(before + 0.01);
      expect(after - before).toBeLessThan(5);
      const next = await step(80 + gap + 16);
      expect(next).toBeGreaterThan(after + 0.01);
      await flushFrames();
      expect(hiddenHighlight()?.size ?? 0).toBe(0);
    },
  );

  it.each([
    { duration: 80, frameMs: 8, gap: 50, repeatGeometry: true },
    { duration: 80, frameMs: 16, gap: 64, repeatGeometry: false },
    { duration: 200, frameMs: 1000 / 30, gap: 80, repeatGeometry: true },
    { duration: 200, frameMs: 8, gap: 64, repeatGeometry: false },
    { duration: 1000, frameMs: 16, gap: 80, repeatGeometry: true },
    { duration: 1000, frameMs: 1000 / 30, gap: 120, repeatGeometry: false },
  ])(
    "preserves the painted clock at duration=$duration frame=$frameMs gap=$gap repeatGeometry=$repeatGeometry",
    async ({ duration, frameMs, gap, repeatGeometry }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          yieldDurationMs={duration}
          claimInitialText={() => true}
        />
      );
      await render(view("AAAA"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expectPaintedGlyphsToFit();
        return Number.parseFloat(frame.style.height);
      };
      const elapsedFrames = Math.floor((duration * 0.4) / frameMs);
      for (let index = 0; index <= elapsedFrames; index++) await step(index * frameMs);
      const before = Number.parseFloat(frame.style.height);
      await render(view("AAAA\nAAAA"));
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 9);
      const after = await step(now + gap);
      expect(after).toBeGreaterThan(before + 0.01);
      expect(after).toBeLessThan(20);
      if (repeatGeometry) {
        for (let index = 0; index < 2; index++) {
          await act(() => window.dispatchEvent(new Event("resize")));
          await render(view("AAAA\nAAAA"));
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(after, 9);
        }
      }
      const next = await step(now + frameMs);
      expect(next).toBeGreaterThan(after + 0.01);
      await flushFrames();
      expect(hiddenHighlight()?.size ?? 0).toBe(0);
    },
  );

  it.each(["adaptive", "parallel"] as const)(
    "applies a duration change to the next %s action without retiming an isolated active row",
    async (lineMode) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      const view = (yieldDurationMs: number) => (
        <Probe
          text="ROW"
          frame
          lineMode={lineMode}
          initialBufferMs={0}
          yieldDurationMs={yieldDurationMs}
          claimInitialText={() => true}
        />
      );
      await render(view(200));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      for (now = 0; now <= 200; now++) {
        if (now === 80) await render(view(80));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        if (now === 100) expect(Number.parseFloat(frame.style.height)).toBeCloseTo(10, 7);
        if (now === 150) expect(Number.parseFloat(frame.style.height)).toBeCloseTo(17.4167614, 3);
      }
      await flushFrames();
    },
  );

  it.each([80, 1000])(
    "continues fast arrivals without serial %s ms row waits",
    async (yieldDurationMs) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          yieldDurationMs={yieldDurationMs}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      let text = "AAAA";
      await render(view(text));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let previous = 0;
      let previousVelocity = 0;
      let minimumMovingVelocity = Infinity;
      for (now = 0; now <= 32 * 40 + yieldDurationMs + 400; now++) {
        if (now > 0 && now % 40 === 0 && now < 32 * 40) {
          const painted = Number.parseFloat(frame.style.height);
          text += "\nAAAA";
          await render(view(text));
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(painted, 8);
        }
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        const velocity = height - previous;
        expect(velocity).toBeGreaterThanOrEqual(-1e-9);
        expect(Math.abs(velocity - previousVelocity)).toBeLessThan(0.08);
        if (now > 700 && now < 1100)
          minimumMovingVelocity = Math.min(minimumMovingVelocity, velocity);
        expectPaintedGlyphsToFit();
        previous = height;
        previousVelocity = velocity;
      }
      expect(minimumMovingVelocity).toBeGreaterThan(0.01);
      expect(previous).toBe(640);
      expect(hiddenHighlight()).toBeUndefined();
      await flushFrames();
    },
  );

  it.each([100, 200, 300])(
    "changes real 150ms row arrivals from resting to connected at %s ms",
    async (yieldDurationMs) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          yieldDurationMs={yieldDurationMs}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      let text = "AAAA";
      await render(view(text));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let previous = 0;
      let minimumVelocity = Infinity;
      for (now = 0; now <= 2400 + yieldDurationMs; now++) {
        if (now > 0 && now < 2400 && now % 150 === 0) {
          text += "\nAAAA";
          await render(view(text));
        }
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        if (now > 1000 && now < 2200)
          minimumVelocity = Math.min(minimumVelocity, height - previous);
        previous = height;
        expectPaintedGlyphsToFit();
      }
      if (yieldDurationMs === 100) expect(minimumVelocity).toBeCloseTo(0, 8);
      else expect(minimumVelocity).toBeGreaterThan(0.001);
      // A bounded redirect may leave a subpixel tail at this wall-clock edge.
      // It must settle completely on the next delivered 60Hz paint.
      expect(previous).toBeCloseTo(320, 2);
      now = 2400 + yieldDurationMs + 1000 / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(frame.style.height)).toBe(320);
      expect(hiddenHighlight()).toBeUndefined();
      await flushFrames();
    },
  );

  it.each(
    (["adaptive", "parallel"] as const).flatMap((lineMode) =>
      [undefined, 80, 100, 300, 1000].map((yieldDurationMs) => ({ lineMode, yieldDurationMs })),
    ),
  )(
    "reserves an isolated $lineMode row with the configured $yieldDurationMs ms Bezier duration",
    async ({ lineMode, yieldDurationMs }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      await render(
        <Probe
          text="ROW"
          frame
          lineMode={lineMode}
          initialBufferMs={0}
          yieldDurationMs={yieldDurationMs}
          claimInitialText={() => true}
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const duration = yieldDurationMs ?? 200;
      const samples = new Map<number, number>();
      for (now = 0; now <= duration; now++) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        samples.set(now, Number.parseFloat(frame.style.height));
        expectPaintedGlyphsToFit();
      }
      expect(samples.get(duration / 4)).toBeCloseTo(2.5832386, 5);
      expect(samples.get(duration / 2)).toBeCloseTo(10, 7);
      expect(samples.get(duration - 10)).toBeLessThan(20);
      expect(samples.get(duration)).toBeCloseTo(20, 7);
      await flushFrames();
    },
  );

  it.each([
    { kind: "paragraph", distance: 20, buffer: SMOOTH_TEXT_BUFFER_MS, firstFrame: 4.2 },
    { kind: "heading", distance: 26, buffer: SMOOTH_TEXT_BUFFER_MS, firstFrame: 4.2 },
    { kind: "paragraph", distance: 20, buffer: SMOOTH_TEXT_BUFFER_MS, firstFrame: 84 },
    { kind: "heading", distance: 26, buffer: SMOOTH_TEXT_BUFFER_MS, firstFrame: 84 },
    { kind: "paragraph", distance: 20, buffer: 1000, firstFrame: 4.2 },
    { kind: "heading", distance: 26, buffer: 1000, firstFrame: 4.2 },
  ])(
    "plays a complete opening pulse for a $kind with a $buffer ms buffer and first frame at $firstFrame ms",
    async ({ kind, distance, buffer, firstFrame }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true, false, undefined, distance);
      const view = (received: boolean) => (
        <Probe
          text={received ? (kind === "heading" ? "# HEADER\n" : "NORMAL\n") : ""}
          frame
          initialBufferMs={buffer}
          claimInitialText={() => true}
          richText={
            received ? (
              kind === "heading" ? (
                <h1 style={{ lineHeight: `${distance}px` }}>HEADER</h1>
              ) : (
                <p style={{ lineHeight: `${distance}px` }}>NORMAL</p>
              )
            ) : null
          }
        />
      );
      await render(view(false));
      await render(view(true));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(Number.parseFloat(frame.style.height)).toBe(0);
      const dt = 4.2;
      const duration = 200;
      const isolatedPeak = distance / (duration * 0.58);
      let previous = 0;
      let firstStep: number | null = null;
      let peak = 0;
      let firstGlyphAt: number | null = null;
      for (now = firstFrame; now <= buffer + duration + 250; now += dt) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        const velocity = (height - previous) / dt;
        expect(velocity).toBeGreaterThanOrEqual(-1e-9);
        expect(velocity).toBeLessThanOrEqual(isolatedPeak + 1e-6);
        if (height > previous) firstStep ??= velocity;
        peak = Math.max(peak, velocity);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        if (!hidden.includes(kind === "heading" ? "HEADER" : "NORMAL")) firstGlyphAt ??= now;
        if (now < buffer) expect(hidden).toContain(kind === "heading" ? "HEADER" : "NORMAL");
        expectPaintedGlyphsToFit();
        previous = height;
      }
      expect(firstStep).not.toBeNull();
      expect(firstStep).toBeLessThan(isolatedPeak * 0.1);
      expect(peak).toBeGreaterThan(isolatedPeak * 0.99);
      expect(firstGlyphAt).not.toBeNull();
      expect(firstGlyphAt).toBeGreaterThanOrEqual(buffer);
      expect(previous).toBe(distance);
      expect(hiddenHighlight()).toBeUndefined();
      await flushFrames();
    },
  );

  it.each([16, 20, 40])(
    "keeps separate %s px rows symmetric with a real stationary interval",
    async (distance) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4, true, false, undefined, distance);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          claimInitialText={() => true}
          richText={<p style={{ lineHeight: `${distance}px` }}>{text}</p>}
        />
      );
      await render(view("AAAA"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const samples: Array<{ at: number; height: number; velocity: number }> = [];
      let previous = 0;
      const duration = 200;
      const isolatedPeak = distance / (duration * 0.58);
      const arrival = Math.ceil(duration + 200);
      for (now = 0; now <= arrival + duration + 250; now++) {
        if (now === arrival) await render(view("AAAA\nBBBB"));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        samples.push({ at: now, height, velocity: height - previous });
        expect(height).toBeGreaterThanOrEqual(previous - 1e-10);
        expectPaintedGlyphsToFit();
        previous = height;
      }
      for (const [start, target] of [
        [0, distance],
        [arrival, distance * 2],
      ] as const) {
        const cycle = samples.filter(
          (sample) => sample.at >= start && sample.at < start + duration + 50,
        );
        const peak = cycle.reduce((best, sample) =>
          sample.velocity > best.velocity ? sample : best,
        );
        expect(peak.velocity).toBeGreaterThan(isolatedPeak * 0.999);
        expect(peak.velocity).toBeLessThanOrEqual(isolatedPeak + 1e-6);
        expect(peak.at - start).toBeGreaterThan(duration * 0.49);
        expect(peak.at - start).toBeLessThan(duration * 0.51);
        expect(cycle.at(-1)!.height).toBeCloseTo(target, 8);
      }
      const idle = samples.filter((sample) => sample.at > duration + 10 && sample.at < arrival);
      expect(idle.length).toBeGreaterThan(100);
      for (const sample of idle) expect(sample.velocity).toBe(0);
      expect(hiddenHighlight()?.size ?? 0).toBe(0);
      await flushFrames();
    },
  );

  it.each(["paragraph", "heading", "code"] as const)(
    "eases a moving %s row through a burst from the following row",
    async (kind) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const row = (text: string) =>
        kind === "heading" ? <h2>{text}</h2> : kind === "code" ? <pre>{text}</pre> : <p>{text}</p>;
      const view = (second: boolean, third: boolean) => (
        <Probe
          text={`H${second ? "\nBBBB" : ""}${third ? "\nCCCC" : ""}`}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          richText={
            <>
              {row("H")}
              {second && row("BBBB")}
              {third && row("CCCC")}
            </>
          }
        />
      );
      await render(view(false, false));
      now = 300;
      await render(view(true, false));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const samples = new Map<number, number>();
      for (; now <= 520; now += 4) {
        if (now === 340) await render(view(true, true));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        samples.set(now, Number.parseFloat(frame.style.height));
        expectPaintedGlyphsToFit();
      }
      // One fast following block must not squeeze the moving row into one
      // paint. It can accelerate gradually without charging 200ms per row.
      expect(samples.get(400)).toBeGreaterThan(20);
      expect(samples.get(440)).toBeLessThan(40);
      expect(samples.get(520)).toBeGreaterThanOrEqual(40);
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it("does not squeeze a moving tail above its planned or incoming speed", async () => {
    await using fixture = await setup();
    const {
      frames,
      Probe,
      hiddenHighlight,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(4);
    let plannedPeak = DEFAULT_LINE_BEZIER_PEAK_VELOCITY;
    const createCadence = originals.cadenceModule.createSmoothLineCadence;
    vi.mocked(cadenceModule.createSmoothLineCadence).mockImplementation(() => {
      const cadence = createCadence();
      const plan = cadence.plan;
      cadence.plan = (...args) => {
        const result = plan(...args);
        plannedPeak = result.peakVelocity ?? Infinity;
        return result;
      };
      return cadence;
    });
    const createPulse = originals.motionModule.createSmoothLinePulse;
    const continuations: { pulse: motionModule.SmoothLinePulse; peak: number }[] = [];
    vi.mocked(motionModule.createSmoothLinePulse).mockImplementation((...args) => {
      const pulse = createPulse(...args);
      if (pulse.distance < 19.99 && pulse.startVelocity > 0)
        continuations.push({
          pulse,
          peak: Math.max(plannedPeak, pulse.startVelocity, pulse.endVelocity),
        });
      return pulse;
    });
    const view = (text: string) => (
      <Probe text={text} frame initialBufferMs={0} fadeDurationMs={0} />
    );
    let text = "AAAA";
    await render(view(text));
    for (now = 0; now <= 1200; now += 4) {
      if ([300, 340, 352, 360, 480, 500, 520, 540].includes(now)) {
        text += "\nBBBB";
        await render(view(text));
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expectPaintedGlyphsToFit();
    }
    expect(continuations.length).toBeGreaterThan(3);
    let peakRatio = 0;
    for (const { pulse, peak } of continuations) {
      for (let step = 0; step <= 100; step++)
        peakRatio = Math.max(
          peakRatio,
          motionModule.smoothLinePulseVelocity(pulse, (pulse.duration * step) / 100) / peak,
        );
    }
    expect(peakRatio).toBeLessThanOrEqual(1 + 1e-8);
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("brakes an overlapping row without a second speed peak when its target pace slows", async () => {
    await using fixture = await setup();
    const {
      frames,
      Probe,
      hiddenHighlight,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(4);
    const createCadence = originals.cadenceModule.createSmoothLineCadence;
    vi.mocked(cadenceModule.createSmoothLineCadence).mockImplementation(() => {
      const cadence = createCadence();
      const plan = cadence.plan;
      cadence.plan = (...args) => ({
        ...plan(...args),
        duration: now < 360 ? 40 : 200,
        endVelocity: now < 360 ? 0.4 : 0,
        peakVelocity: 0.4,
      });
      return cadence;
    });
    const createPulse = originals.motionModule.createSmoothLinePulse;
    const tails: motionModule.SmoothLinePulse[] = [];
    vi.mocked(motionModule.createSmoothLinePulse).mockImplementation((...args) => {
      const pulse = createPulse(...args);
      if (pulse.distance < 19.99 && pulse.startVelocity > 0 && pulse.endVelocity === 0)
        tails.push(pulse);
      return pulse;
    });
    const view = (text: string) => (
      <Probe text={text} frame mode="auto" initialBufferMs={0} fadeDurationMs={0} />
    );
    let text = "AAAA";
    await render(view(text));
    for (now = 0; now <= 1200; now += 4) {
      if ([300, 340, 352, 360, 480, 500, 520, 540].includes(now)) {
        text += "\nBBBB";
        await render(view(text));
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expectPaintedGlyphsToFit();
    }
    expect(tails.length).toBeGreaterThan(0);
    for (const pulse of tails) {
      const peak = Math.max(pulse.startVelocity, pulse.distance / (0.58 * 200));
      for (let step = 0; step <= 100; step++)
        expect(
          motionModule.smoothLinePulseVelocity(pulse, (pulse.duration * step) / 100),
        ).toBeLessThanOrEqual(peak + 1e-8);
    }
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
  });

  it.each([180, 20 / DEFAULT_LINE_BEZIER_PEAK_VELOCITY, 60])(
    "bridges actual %s ms physical arrivals with a monotone continuous handoff",
    async (period) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      let text = "AAAA";
      await render(view(text));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      let nextArrival = period;
      let rows = 1;
      let previous = 0;
      let peak = 0;
      const velocities: number[] = [];
      for (let at = 0; at <= period * 16 + 600; at++) {
        if (at >= nextArrival && rows < 16) {
          now = nextArrival;
          text += "\nAAAA";
          await render(view(text));
          nextArrival = ++rows * period;
        }
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        const velocity = height - previous;
        expect(velocity).toBeGreaterThanOrEqual(-1e-9);
        expect(velocity).toBeLessThanOrEqual(
          Math.max(DEFAULT_LINE_BEZIER_PEAK_VELOCITY, (1.5 * 20) / period) + 1e-6,
        );
        peak = Math.max(peak, velocity);
        if (at >= period * 8 && at <= period * 13) velocities.push(velocity);
        expectPaintedGlyphsToFit();
        previous = height;
      }
      expect(peak).toBeGreaterThan(Math.max(DEFAULT_LINE_BEZIER_PEAK_VELOCITY, 20 / period) * 0.99);
      expect(Math.min(...velocities)).toBeGreaterThan(0.001);
      expect(previous).toBe(16 * 20);
      expect(hiddenHighlight()).toBeUndefined();
      await flushFrames();
    },
  );

  it.each(["adaptive", "parallel"] as const)(
    "keeps the painted x/v through repeated slow-fast-slow %s source changes",
    async (lineMode) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          lineMode={lineMode}
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      let text = "AAAA";
      await render(view(text));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const periods = [
        300,
        300,
        ...Array<number>(8).fill(60),
        300,
        300,
        300,
        ...Array<number>(6).fill(60),
      ];
      const arrivals: number[] = [];
      for (const period of periods) arrivals.push((arrivals.at(-1) ?? 0) + period);
      let received = 0;
      let previous = 0;
      let previousVelocity = 0;
      let fastPeak = 0;
      let settledSlowPeak = 0;
      for (now = 0; now <= arrivals.at(-1)! + 600; now++) {
        while (received < arrivals.length && arrivals[received]! <= now) {
          const before = Number.parseFloat(frame.style.height);
          text += "\nAAAA";
          received++;
          await render(view(text));
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 9);
        }
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        const velocity = height - previous;
        expect(velocity).toBeGreaterThanOrEqual(-1e-9);
        expect(velocity).toBeLessThanOrEqual(20 / (60 * 0.58) + 1e-6);
        // This bounds finite-frame acceleration for the new short continuations.
        // The redirect test separately measures C1 speed at 0.1ms resolution.
        expect(Math.abs(velocity - previousVelocity), `frame at ${now}ms`).toBeLessThan(0.08);
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(text.endsWith(hidden)).toBe(true);
        expectPaintedGlyphsToFit();
        if (now >= 900 && now <= 1080) fastPeak = Math.max(fastPeak, velocity);
        if (now >= 1700 && now <= 1900) settledSlowPeak = Math.max(settledSlowPeak, velocity);
        previous = height;
        previousVelocity = velocity;
      }
      expect(fastPeak).toBeGreaterThan(0.3);
      expect(settledSlowPeak).toBeLessThanOrEqual(DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 0.001);
      expect(previous).toBe((periods.length + 1) * 20);
      expect(hiddenHighlight()).toBeUndefined();
      await flushFrames();
    },
  );

  it("keeps the hook peak continuous across nearby source rates", async () => {
    await using fixture = await setup();

    const before = await openingMotion(fixture, 0.1306);
    const after = await openingMotion(fixture, 0.1307);
    expect(before.peak).toBeGreaterThan(DEFAULT_LINE_BEZIER_PEAK_VELOCITY * 0.999);
    expect(after.peak).toBeLessThanOrEqual(DEFAULT_LINE_BEZIER_PEAK_VELOCITY);
    expect(Math.abs(after.peak - before.peak)).toBeLessThan(0.0002);
  });

  it.each([79, 80, 81, 120, 1000])(
    "does not repay a %s ms interruption above the basic hook pixel peak",
    async (stall) => {
      await using fixture = await setup();

      const result = await openingMotion(fixture, 0.045, 20, stall);
      expect(result.peak).toBeLessThanOrEqual(DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 0.001);
      expect(result.stalledGrowth).toBeLessThan(3);
    },
  );

  it("finishes 20 and 40 px isolated rows in the same time with proportional peak speeds", async () => {
    await using fixture = await setup();

    const short = await openingMotion(fixture, 0.045, 20);
    const tall = await openingMotion(fixture, 0.045, 40);
    expect(short.peak).toBeGreaterThan(DEFAULT_LINE_BEZIER_PEAK_VELOCITY * 0.999);
    expect(short.peak).toBeLessThanOrEqual(DEFAULT_LINE_BEZIER_PEAK_VELOCITY);
    expect(tall.peak).toBeCloseTo(short.peak * 2, 7);
  });

  it("changes long-frame travel continuously across the joined-curve midpoint", async () => {
    await using fixture = await setup();

    const before = await openingMotion(fixture, 0.1306, 20, 120);
    const after = await openingMotion(fixture, 0.1307, 20, 120);
    expect(before.stalledGrowth).toBeGreaterThan(0);
    expect(Math.abs(after.stalledGrowth - before.stalledGrowth)).toBeLessThan(0.1);
  });

  it.each([120, 1000])(
    "does not skip a low-speed text reservation after a %s ms main-thread stall",
    async (stall) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(20, true);
      await render(
        <Probe text="甲\n乙\n丙" frame initialBufferMs={0} claimInitialText={() => true} />,
      );
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await step(0);
      await step(60);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const before = Number.parseFloat(frame.style.height);
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThan(10);
      await step(60 + stall);
      const after = Number.parseFloat(frame.style.height);
      expect(after).toBeGreaterThan(before);
      expect(after - before).toBeLessThan(5);
      expect(after).toBeLessThan(20);
      await flushFrames();
      expect(hiddenHighlight()?.size ?? 0).toBe(0);
    },
  );

  it.each([120, 1000])(
    "resumes text within its remaining space pulse after a %s ms main-thread stall",
    async (stall) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const text = `${"A".repeat(40)}\n${"B".repeat(40)}`;
      await render(
        <Probe
          text={text}
          frame
          mode="auto"
          initialBufferMs={0}
          fadeDurationMs={500}
          drainOnComplete={false}
          claimInitialText={() => true}
        />,
      );
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await step(0);
      await step(60);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const before = Number.parseFloat(frame.style.height);
      await step(60 + stall);
      expect(Number.parseFloat(frame.style.height) - before).toBeLessThan(5);
      const limit = (2 * 20) / DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 3 * 16;
      for (let index = 1; index * 16 <= limit && hiddenHighlight() && !fadeRanges().length; index++)
        await step(60 + stall + index * 16);
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      expect(hidden.length).toBeLessThan(text.length);
      expect(text.endsWith(hidden)).toBe(true);
      expect(fadeRanges().length).toBeGreaterThan(0);
      await flushFrames();
    },
  );

  it("does not repay an obsolete stall after geometry refits the moving row", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    let extra = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40, true);
    const rangeRect = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    const elementRect = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = rangeRect.call(this);
      return { ...rect, top: rect.top + extra, bottom: rect.bottom + extra } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = elementRect.call(this);
      return this.matches("[data-probe]")
        ? { ...rect, bottom: rect.bottom + extra, height: rect.height + extra }
        : rect;
    });
    const text = `${"A".repeat(40)}\n${"B".repeat(40)}`;
    await render(<Probe text={text} frame initialBufferMs={0} claimInitialText={() => true} />);
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    await step(0);
    await step(60);
    now = 180;
    extra = 20;
    await act(() => window.dispatchEvent(new Event("resize")));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let previous = Number.parseFloat(frame.style.height);
    for (let at = 196; at <= 500 && previous < 40; at += 16) {
      await step(at);
      const height = Number.parseFloat(frame.style.height);
      expect(height).toBeGreaterThanOrEqual(previous);
      expect(height - previous).toBeLessThan(9);
      previous = height;
    }
    expect(previous).toBeGreaterThanOrEqual(40);
    await flushFrames();
  });

  it("does not squeeze geometry growth at the end of a row's curve into one frame", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    let extra = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(20, true);
    const measureRange = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    const measureElement = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    // Everything from the second row down moves when, e.g., a web font swaps in.
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = measureRange.call(this);
      return rect.top >= 20
        ? { ...rect, top: rect.top + extra, bottom: rect.bottom + extra }
        : rect;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = measureElement.call(this);
      return this.matches("[data-probe]")
        ? { ...rect, height: rect.height + extra, bottom: rect.bottom + extra }
        : rect;
    });
    await render(
      <Probe text={"甲\n乙\n丙\n丁"} frame initialBufferMs={0} claimInitialText={() => true} />,
    );
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    // Stop while the second row is near the end of its own curve.
    let at = 0;
    for (; at <= 600; at += 4) {
      await step(at);
      const height = Number.parseFloat(frame.style.height);
      if (height > 37 && height < 39.9) break;
    }
    const before = Number.parseFloat(frame.style.height);
    expect(before).toBeGreaterThan(37);
    expect(before).toBeLessThan(40);
    // A Markdown commit pushes that row's first glyph 20 px down.
    extra = 20;
    await render(
      <Probe text={"甲\n乙\n丙\n丁\n戊"} frame initialBufferMs={0} claimInitialText={() => true} />,
    );
    let previous = Number.parseFloat(frame.style.height);
    expect(previous - before).toBeLessThan(1);
    for (let frameAt = at + 16; frameAt <= at + 16 * 3; frameAt += 16) {
      await step(frameAt);
      const height = Number.parseFloat(frame.style.height);
      expect(height).toBeGreaterThanOrEqual(previous);
      // The old deadline had ~50 ms left for ~23 px. Re-easing must start from
      // the painted velocity instead of accelerating to meet that deadline.
      expect(height - previous).toBeLessThan(2.5);
      previous = height;
    }
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
  });

  it("does not finish a late-growing text row in its geometry commit", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } =
      fixture;
    let now = 0;
    let extra = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(20, true);
    const measureRange = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
    const measureElement = vi
      .mocked(HTMLElement.prototype.getBoundingClientRect)
      .getMockImplementation()!;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rect = measureRange.call(this);
      return rect.top >= 20
        ? { ...rect, top: rect.top + extra, bottom: rect.bottom + extra }
        : rect;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = measureElement.call(this);
      return this.matches("[data-probe]")
        ? { ...rect, height: rect.height + extra, bottom: rect.bottom + extra }
        : rect;
    });
    const text = "甲\n乙\n丙";
    await render(<Probe text={text} frame initialBufferMs={0} claimInitialText={() => true} />);
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let before = 0;
    for (let at = 0; at <= 400; at += 5) {
      await step(at);
      before = Number.parseFloat(frame.style.height);
      if (before > 20.1 && before < 39.9) break;
    }
    expect(before).toBeGreaterThan(20);
    expect(before).toBeLessThan(40);
    now += 300;
    extra = 20;
    await render(<Probe text={`${text}\n戊`} frame initialBufferMs={0} />);
    const after = Number.parseFloat(frame.style.height);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after - before).toBeLessThan(1);
    await step(now + 20);
    // This row may already be in a fast glide. Retain that velocity, but do
    // not finish the newly added 20 px in its first delivered frame.
    expect(Number.parseFloat(frame.style.height) - after).toBeLessThan(10);
    await flushFrames();
    expect(hiddenHighlight()?.size ?? 0).toBe(0);
  });

  it("does not let a decorative favicon change a short text row's motion plan", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(20, true);
    const text = "甲\n乙\n丙\n丁";
    await render(
      <>
        <Probe
          id="plain"
          text={text}
          frame
          initialBufferMs={0}
          claimInitialText={() => true}
          richText={<p>{text}</p>}
        />
        <Probe
          id="decorated"
          text={text}
          frame
          initialBufferMs={0}
          claimInitialText={() => true}
          richText={
            <p>
              <span aria-hidden="true">
                <img alt="" />
              </span>
              {text}
            </p>
          }
        />
      </>,
    );
    const plain = container.querySelector<HTMLElement>('[data-probe="plain"]')!.parentElement!;
    const decorated = container.querySelector<HTMLElement>(
      '[data-probe="decorated"]',
    )!.parentElement!;
    for (let index = 0; index <= 90; index++) {
      now = (index * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expect(Number.parseFloat(decorated.style.height)).toBeCloseTo(
        Number.parseFloat(plain.style.height),
        5,
      );
    }
    await flushFrames();
  });

  it("ignores decorative icon swaps and loads while the pending text keeps playing", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushMutations,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    for (now = 0; now < 1_050; now += 1_000 / 60) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, fadeRanges, render } = fixture;
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
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
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, fadeRanges, render, flushMutations } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      fadeRanges,
      render,
      flushMutations,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, render, flushMutations, flushFrames } = fixture;
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

    let now = fixture.clock();
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
    await using fixture = await setup();
    const { container, Probe, render, unmount } = fixture;
    await render(<Probe text="Existing text." />);
    expect(readSmoothTextEnd(container)).toBeDefined();

    await render(<Probe text="Existing text." enabled={false} />);
    expect(readSmoothTextEnd(container)).toBeUndefined();
    expect(container.querySelector("[data-probe]")?.hasAttribute("data-smooth-text-end")).toBe(
      false,
    );

    await render(<Probe text="Existing text." />);
    expect(readSmoothTextEnd(container)).toBeDefined();
    await unmount();
    expect(readSmoothTextEnd(container)).toBeUndefined();
  });

  it("clears masks when disabled or unmounted and can smooth a later append", async () => {
    await using fixture = await setup();
    const { MockIntersectionObserver, frames, Probe, hiddenHighlight, render, unmount } = fixture;
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

    await unmount();
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
  });

  it("keeps up with 120 characters per second on a 60 Hz display with separate glyph fades", async () => {
    await using fixture = await setup();
    const { highlights, frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(20);
      const text = "ABCDEFGHIJ\n一二三四五六七八九十";
      await render(<Probe text={text} frame={frame} claimInitialText={() => true} />);
      const advance = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      for (let at = 0; at < 999; at += 16) await advance(at);
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
    await using fixture = await setup();
    const {
      highlights,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockLineAwareRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    for (now = 0; now < 1_000; now += 1_000 / 60) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    expect(container.querySelector("code")?.style.clipPath).toContain("H 10");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(
      "一二三四五六七八九十",
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("BCDEFGHIJ");
    await flushFrames();
  });

  it("keeps up with short lines without waiting for each height animation to settle", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockLineAwareRanges,
      render,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    // Twenty source rows arrive during the intentional 1s initial buffer.
    expect(hidden.length).toBeLessThan(120 + 40);
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render } = fixture;
    let now = 0;
    let workMs = 0;
    let measure = false;
    fixture.clock.mockImplementation(() => now + workMs);
    const NativeStaticRange = StaticRange;
    fixture.use(
      stubGlobal(
        "StaticRange",
        class extends NativeStaticRange {
          constructor(init: StaticRangeInit) {
            super(init);
            if (measure) workMs += 4;
          }
        },
      ),
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

  it("opens an empty Markdown toolbar with the bounded text space pulse", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockMediaRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    const deadline = now + remainingSpaceMs(30);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let previous = Number.parseFloat(frame.style.height);
    while (now < deadline) {
      now += 1_000 / 30;
      await step();
      const height = Number.parseFloat(frame.style.height);
      expect(height - previous).toBeLessThanOrEqual(
        // The 24px toolbar shares the configured duration, not a 20px velocity cap.
        ((24 / (200 * 0.58)) * 1_000) / 30 + 1e-6,
      );
      expectPaintedGlyphsToFit();
      previous = height;
    }
    const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
    expect(hidden.length).toBeLessThan(80);
    const toolbar = container.querySelector<HTMLElement>("[data-media-object]")!;
    expect(toolbar.hasAttribute("data-smooth-inline-pending")).toBe(false);
    await flushFrames();
  });

  it("recovers from irregular frames and repeated main-thread stalls without replaying an unbounded batch", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        flushFrames,
        remainingSpaceMs,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(20);
      await render(
        <Probe text="" frame mode="auto" lineMode={lineMode} claimInitialText={() => true} />,
      );
      let text = "";
      let batch = 0;
      const early: number[] = [];
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
        if (now >= 3_000 && now < 4_000) early.push(hidden.length);
        if (now >= 5_000) late.push(hidden.length);
      }
      const bufferedGlyphs = lineMode === "adaptive" ? 120 * "流动字符甲乙\n".length : 0;
      expect(late.reduce((sum, count) => sum + count, 0) / late.length).toBeLessThan(
        bufferedGlyphs + 100,
      );
      expect(late.reduce((sum, count) => sum + count, 0) / late.length).toBeLessThanOrEqual(
        early.reduce((sum, count) => sum + count, 0) / early.length + 8,
      );
      await render(
        <Probe text={text} frame mode="auto" lineMode={lineMode} streaming={false} complete />,
      );
      // Completion may contain several short rows. They must obtain their
      // space within the drain window instead of being exposed in its commit.
      expectPaintedGlyphsToFit();
      const drainMs = remainingSpaceMs(fps);
      for (let index = 0; (index * 1000) / fps <= drainMs && hiddenHighlight(); index++) {
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
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
      remainingSpaceMs,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    const drainAt = now + remainingSpaceMs(30);
    for (; now <= drainAt && hiddenHighlight(); now += 1000 / 30) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expectPaintedGlyphsToFit();
      const edge = readSmoothTextEnd(container);
      if (edge?.bottom != null)
        expect(edge.bottom).toBeLessThanOrEqual(activity.getBoundingClientRect().top);
    }
    expect([...(hiddenHighlight() ?? [])].map(rangeText)).toEqual([]);
    expect(readSmoothTextEnd(container)?.hiddenTailHeight).toBe(0);
    await flushFrames();
  });

  it("drains dense Markdown before work ends with a 30 Hz display", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render, remainingSpaceMs } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    const drainAt = now + remainingSpaceMs(30);
    for (; now <= drainAt && hiddenHighlight(); now += 1000 / 30) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(hiddenHighlight()).toBeUndefined();
    expect(container.querySelector("[data-probe]")!.textContent).toContain("末尾逐字衔接。");
  });

  it("keeps individual character fades when work ends with a queued tail", async () => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      highlights,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    await render(<Probe fadeDurationMs={180} text="History" coloredText />);
    await render(<Probe fadeDurationMs={180} text="HistoryABCDE" coloredText />);
    now = 16;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    const existingRange = fadeRanges()[0]!;
    const existingBucket = [...highlights].find(([, ranges]) => ranges.has(existingRange))?.[0];
    now = 20;
    await render(
      <Probe fadeDurationMs={180} text="HistoryABCDEFGH" coloredText streaming={false} complete />,
    );
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    await render(<Probe fadeDurationMs={180} text="History" mode="token" />);
    await render(<Probe fadeDurationMs={180} text="HistoryABCDE" mode="token" />);
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

  it("plays an ambiguous emphasis pair's arriving tail without exposing its markers", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
        // Later delimiters can still resolve this pair. Preview its body while
        // its following text enters playback, without exposing marker glyphs.
        expect(container.querySelector("p:last-child")?.textContent).toBe(
          suffix.replaceAll("**", ""),
        );
        expect(container.querySelector("strong")).not.toBeNull();
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
      const visible = suffix.replaceAll("**", "").length - hidden;
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
    // Completion restores the four genuinely literal markers as well as the
    // three final glyphs; their provisional omission must not lose source text.
    expect(container.textContent!.length - previousDomLength).toBe(7);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges().length).toBeGreaterThan(0);
    for (const range of fadeRanges()) expect(rangeText(range)).toHaveLength(1);
    await flushFrames();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("plays a 53-character completed snapshot before work ends 187 ms later", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    "drains a final structural tail within its measured space window at %s Hz",
    async (fps) => {
      await using fixture = await setup();
      const {
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        remainingSpaceMs,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      const deadline = remainingSpaceMs(fps);
      for (let index = 1; (index * 1000) / fps <= deadline && hiddenHighlight(); index++) {
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
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
        remainingSpaceMs,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      await render(<Probe text="History" frame />);
      const text = "History\nA\nB\nC\nD\nE\nF";
      await render(<Probe text={text} frame streaming={false} complete={complete} />);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("A\nB\nC\nD\nE\nF");
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      const heights = new Set<number>();
      const deadline = remainingSpaceMs(fps);
      for (let index = 1; (index * 1000) / fps <= deadline && frames.size; index++) {
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
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
        remainingSpaceMs,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      const deadline = framed ? remainingSpaceMs() : 170;
      for (let index = 1; index * 17 <= deadline && hiddenHighlight(); index++) {
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
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
      await using fixture = await setup();
      const {
        frames,
        getMediaQuery,
        Probe,
        hiddenHighlight,
        fadeRanges,
        render,
        flushFrames,
        setDocumentHidden,
      } = fixture;
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

  it("keeps the painted height across hidden completion and eases the remaining space in when visible", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      mockWrappedRows,
      render,
      setDocumentHidden,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(4);
    const onSettled = vi.fn();
    await render(
      <Probe
        text={"abcd".repeat(6)}
        frame
        initialBufferMs={0}
        claimInitialText={() => true}
        onSettled={onSettled}
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 1; now <= 2_000 && (Number.parseFloat(frame.style.height) || 0) < 40; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    const painted = Number.parseFloat(frame.style.height);
    expect(painted).toBeGreaterThanOrEqual(40);
    expect(painted).toBeLessThan(120);

    setDocumentHidden(true);
    await render(
      <Probe
        text={"abcd".repeat(10)}
        frame
        streaming={false}
        complete
        initialBufferMs={0}
        claimInitialText={() => true}
        onSettled={onSettled}
      />,
    );
    // Hidden output becomes readable at once, but the frame keeps the height
    // it had painted. A reader returning to the window should watch the
    // remaining rows yield into place instead of seeing the whole response
    // jump down in one paint.
    expect(hiddenHighlight()).toBeUndefined();
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(painted, 0);

    setDocumentHidden(false);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(painted, 0);
    const heightOf = () =>
      Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height;
    const recoverStart = now;
    let midHeight: number | null = null;
    const samples: number[] = [];
    for (now = 1; now <= 2_000 && heightOf() < 200; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      if (callbacks.length === 0) break;
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (midHeight === null && now - recoverStart >= 300) midHeight = heightOf();
      samples.push(heightOf());
    }
    expect(samples.length).toBeGreaterThan(1);
    expect(samples[0]! - painted).toBeLessThan(20);
    // A 160px settle must keep its distance-scaled clock; a regular 200ms
    // yield would already be at the natural height by 300ms.
    expect(midHeight).not.toBeNull();
    expect(midHeight!).toBeLessThan(180);
    expect(heightOf()).toBeCloseTo(200, 0);
  });

  it("retargets a hidden settle when the restored layout reflows", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render, setDocumentHidden } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    const columns = { value: 4 };
    mockWrappedRows(() => columns.value);
    await render(
      <Probe text={"abcd".repeat(6)} frame initialBufferMs={0} claimInitialText={() => true} />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    for (now = 1; now <= 2_000 && (Number.parseFloat(frame.style.height) || 0) < 40; now += 4) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    const painted = Number.parseFloat(frame.style.height);
    expect(painted).toBeLessThan(120);

    setDocumentHidden(true);
    await render(
      <Probe
        text={"abcd".repeat(10)}
        frame
        streaming={false}
        complete
        initialBufferMs={0}
        claimInitialText={() => true}
      />,
    );
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(painted, 0);

    setDocumentHidden(false);
    // Advance into the restore, then reflow the visible layout so its natural
    // height doubles. The restored curve must redirect, not run to the old
    // target and snap onto the new one in its final frame.
    for (let index = 0; index < 40; index++) {
      now += 4;
      const callbacks = [...frames.values()];
      frames.clear();
      if (callbacks.length === 0) break;
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    columns.value = 2;
    await act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    const heightOf = () =>
      Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height;
    let previous = heightOf();
    let maxDelta = 0;
    for (let index = 0; index < 800 && heightOf() < 400; index++) {
      now += 4;
      const callbacks = [...frames.values()];
      frames.clear();
      if (callbacks.length === 0) break;
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = heightOf();
      maxDelta = Math.max(maxDelta, height - previous);
      previous = height;
    }
    expect(heightOf()).toBeCloseTo(400, 0);
    expect(maxDelta).toBeLessThan(100);
  });

  it.each(["completion", "live reflow"] as const)(
    "eases a final block margin instead of snapping it in during %s",
    async (arrival) => {
      await using fixture = await setup();
      const { MockIntersectionObserver, container, frames, Probe, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      const natural = { value: 20 };
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const message = this.matches("[data-probe]")
          ? this
          : (this.querySelector<HTMLElement>("[data-probe]") ??
            this.closest<HTMLElement>("[data-probe]"));
        const height = message ? natural.value : 0;
        const explicit = Number.parseFloat(this.style.height);
        const value =
          this.hasAttribute("data-smooth-text-frame") && Number.isFinite(explicit)
            ? explicit
            : height;
        return { top: 0, bottom: value, height: value, width: 640 } as DOMRect;
      });
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        if (!this.toString().trim()) return { top: 0, bottom: 0, height: 0 } as DOMRect;
        return { top: 4, bottom: 16, height: 12, width: 10 } as DOMRect;
      });
      const onComplete = vi.fn();
      await render(
        <Probe
          text="AB"
          frame
          claimInitialText={() => true}
          initialBufferMs={0}
          onPlaybackComplete={onComplete}
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      for (now = 1; now <= 2_000; now += 4) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        if (callbacks.length === 0 && (Number.parseFloat(frame.style.height) || 0) >= 20) break;
      }
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(20, 0);
      expect(frames.size).toBe(0);

      // The final block's margin arrives after the row curve has drained.
      natural.value = 60;
      if (arrival === "completion") {
        await render(
          <Probe
            text="AB"
            frame
            streaming={false}
            complete
            claimInitialText={() => true}
            initialBufferMs={0}
            onPlaybackComplete={onComplete}
          />,
        );
      } else {
        await act(() => {
          window.dispatchEvent(new Event("resize"));
        });
      }
      // Neither path may adopt the 60px natural height in this paint.
      const heightOf = () =>
        Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height;
      expect(heightOf()).toBeLessThan(60);
      let previous = heightOf();
      let maxDelta = 0;
      for (let index = 0; index < 400 && heightOf() < 60; index++) {
        now += 4;
        const callbacks = [...frames.values()];
        frames.clear();
        if (callbacks.length === 0) break;
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = heightOf();
        maxDelta = Math.max(maxDelta, height - previous);
        previous = height;
      }
      expect(previous).toBeCloseTo(60, 0);
      expect(maxDelta).toBeLessThan(20);
      if (arrival === "completion") {
        expect(onComplete).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
        expect(MockIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalled();
      }
    },
  );

  it("opens at most two rows of new space in a single paint", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(8);
    await render(<Probe text="" frame initialBufferMs={0} claimInitialText={() => true} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    // A provider chunk that spans four physical rows must still yield space a
    // bounded number of rows at a time; one paint may not move the whole block.
    await render(
      <Probe text={"abcdefgh".repeat(4)} frame initialBufferMs={0} claimInitialText={() => true} />,
    );
    let previous = 0;
    let maxDelta = 0;
    for (let index = 0; index < 60; index++) {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      if (callbacks.length === 0) break;
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height) || 0;
      maxDelta = Math.max(maxDelta, height - previous);
      previous = height;
    }
    expect(previous).toBe(80);
    expect(maxDelta).toBeLessThanOrEqual(40 + 0.5);
  });

  it("bounds a sustained provider burst to two rows of new space per paint", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(20);
    await render(<Probe text="" frame initialBufferMs={0} claimInitialText={() => true} />);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let text = "";
    let previous = 0;
    let maxDelta = 0;
    // A fast provider delivers several rows in each snapshot. The queue may
    // hold them, but one paint must not move the whole block at once.
    for (let step = 0; step < 6; step++) {
      text += "abcd".repeat(40);
      await render(<Probe text={text} frame initialBufferMs={0} claimInitialText={() => true} />);
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const height = Number.parseFloat(frame.style.height) || 0;
      maxDelta = Math.max(maxDelta, height - previous);
      previous = height;
    }
    expect(maxDelta).toBeLessThanOrEqual(40 + 0.5);
    // The queue must actually make progress, not merely stay bounded at zero.
    expect(previous).toBeGreaterThan(0);
    expect(previous).toBeLessThan(960);
    const heightOf = () =>
      Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height;
    for (let index = 0; index < 800 && heightOf() < 960; index++) {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      if (callbacks.length === 0) break;
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(heightOf()).toBeCloseTo(960, 0);
  });

  it("recreates the shared highlight after an idle drain and isolates parallel messages", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, render, flushFrames } = fixture;
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
    await using fixture = await setup();
    const {
      highlights,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    expect([...highlights.values()].every((region) => region.size === 0)).toBe(true);
  });

  it("keeps the registered fade palette stable while glyphs change alpha buckets", async () => {
    await using fixture = await setup();
    const { highlights, frames, Probe, fadeRanges, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    await render(<Probe text="History" />);
    await render(<Probe text={"History" + "字".repeat(80)} />);
    const step = async () => {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    await step();
    expect(fadeRanges().length).toBeGreaterThan(0);
    const palette = new Map([...highlights].filter(([name]) => name.startsWith("t3-smooth-fade-")));
    for (let index = 0; index < 6; index++) {
      await step();
      expect(fadeRanges().length).toBeGreaterThan(0);
      const activePalette = new Map(
        [...highlights].filter(([name]) => name.startsWith("t3-smooth-fade-")),
      );
      expect([...activePalette.keys()]).toEqual([...palette.keys()]);
      for (const [name, region] of palette) expect(activePalette.get(name)).toBe(region);
    }
    await flushFrames();
    expect([...highlights.values()].every((region) => region.size === 0)).toBe(true);
  });

  it("retains an empty fade palette between live arrivals and releases it at completion", async () => {
    await using fixture = await setup();
    const { highlights, frames, Probe, fadeRanges, render, flushFrames } = fixture;
    await render(<Probe text="History" />);
    await render(<Probe text="HistoryA" />);
    await flushFrames();
    expect(fadeRanges()).toEqual([]);
    expect(
      [...highlights.keys()].filter((name) => name.startsWith("t3-smooth-fade-")),
    ).toHaveLength(16);
    expect([...highlights.values()].every((region) => region.size === 0)).toBe(true);
    expect(frames.size).toBe(0);
    await render(<Probe text="HistoryA" streaming={false} />);
    await flushFrames();
    expect(highlights.size).toBe(0);
  });

  it("measures appended text before clearing the previous glyph fades", async () => {
    await using fixture = await setup();
    const {
      container,
      highlights,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    expect([...highlights.values()].every((region) => region.size === 0)).toBe(true);
  });

  it.each(["retained text append", "source-only append"] as const)(
    "keeps active glyph ranges registered through a %s without rebuilding them",
    async (revision) => {
      await using fixture = await setup();
      const {
        MockHighlight,
        container,
        highlights,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        render,
        flushFrames,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      expect([...highlights.values()].every((region) => region.size === 0)).toBe(true);
    },
  );

  it("keeps a pending row's painted height stable between frames when later text arrives", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render, flushMutations } = fixture;
    const history = Array.from({ length: 100 }, (_, index) => <p key={index}>History {index}</p>);
    const view = (text: string) => (
      <Probe
        text={text}
        paused
        richText={
          <>
            {history}
            <span aria-hidden="true">
              <span data-decoration="" />
            </span>
            <p>{text}</p>
          </>
        }
      />
    );
    await render(view("tail"));
    const first = container.querySelector("p")!;
    const decoration = container.querySelector("[data-decoration]")!;
    const classify = vi.spyOn(first, "closest");
    for (let index = 1; index <= 20; index++) {
      await act(() => {
        decoration.classList.toggle("opacity-100");
        flushSync(() => fixture.renderCommit(view("tail" + " new".repeat(index))));
      });
      await flushMutations();
    }
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
      await using fixture = await setup();
      const { container, Probe, hiddenHighlight, rangeText, render, flushMutations } = fixture;
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
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render, flushMutations } = fixture;
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

  it("keeps playback ownership through redundant checkbox attribute writes", async () => {
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, rangeText, render, flushMutations } = fixture;
    await render(
      <Probe
        text="ABC"
        paused
        claimInitialText={() => true}
        richText={
          <>
            <p>A</p>
            <input type="checkbox" />
            <p>BC</p>
          </>
        }
      />,
    );
    const checkbox = container.querySelector("input")!;
    const scan = vi.spyOn(document, "createTreeWalker");
    expect(checkbox.hasAttribute("data-smooth-inline-pending")).toBe(true);
    await act(() => checkbox.setAttribute("type", "checkbox"));
    await flushMutations();
    expect(scan).not.toHaveBeenCalled();
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("ABC");
    await act(() => checkbox.setAttribute("type", "text"));
    await flushMutations();
    expect(scan).toHaveBeenCalled();
    expect(checkbox.hasAttribute("data-smooth-inline-pending")).toBe(false);
  });

  it("records source-only arrivals without rescanning deferred Markdown or rebuilding its masks", async () => {
    await using fixture = await setup();
    const { MockHighlight, Probe, hiddenHighlight, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it.each(["complete", "stream-ended"] as const)(
    "reuses the current DOM index at a mutation-free %s boundary without clearing fades",
    async (boundary) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      const history = Array.from({ length: 96 }, (_, index) => `History${index} `);
      const prefix = history.join("");
      const done = vi.fn();
      const content = (tail: string) => (
        <p>
          {history.map((text) => (
            <span key={text}>{text}</span>
          ))}
          <span>{tail}</span>
        </p>
      );
      const view = (tail: string, eof = false) => (
        <Probe
          text={prefix + tail}
          richText={content(tail)}
          mode="auto"
          lineMode="adaptive"
          fadeDurationMs={500}
          yieldDurationMs={200}
          initialBufferMs={0}
          streaming={!eof}
          complete={eof && boundary === "complete"}
          onPlaybackComplete={done}
        />
      );
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await render(view(""));
      now = 100;
      await render(view("AB"));
      await step(116);
      const active = fadeRanges().find((range) => rangeText(range) === "A");
      expect(active).toBeDefined();
      const message = container.querySelector("[data-probe]")!;
      const scan = vi.spyOn(document, "createTreeWalker");
      now = 120;
      await render(view("AB", true));
      expect(
        scan.mock.calls.filter(
          ([node, filter]) =>
            node === message && filter === (NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT),
        ),
      ).toHaveLength(0);
      expect(fadeRanges()).toContain(active);
      expect(done).not.toHaveBeenCalled();
      await step(140);
      await step(370);
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toContain(active);
      expect(done).not.toHaveBeenCalled();
      await step(700);
      expect(fadeRanges()).toHaveLength(0);
      expect(done).toHaveBeenCalledOnce();
    },
  );

  it.each(["append", "rewrite"] as const)(
    "rebuilds the DOM index when an EOF commit includes a text %s",
    async (change) => {
      await using fixture = await setup();
      const { container, Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      await render(<Probe text="History" />);
      await render(<Probe text="HistoryAB" />);
      const message = container.querySelector("[data-probe]")!;
      const scan = vi.spyOn(document, "createTreeWalker");
      const finalTail = change === "append" ? "ABXYZ" : "XYZ";
      now = 100;
      await render(<Probe text={"History" + finalTail} streaming={false} complete />);
      expect(
        scan.mock.calls.filter(
          ([node, filter]) =>
            node === message && filter === (NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT),
        ),
      ).toHaveLength(1);
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges().map(rangeText).toSorted()).toEqual(finalTail.split("").toSorted());
      expect(fadeRanges().every((range) => range.startContainer.isConnected)).toBe(true);
      await flushFrames();
    },
  );

  it("rebuilds the DOM index when an EOF commit changes a text-filtering attribute", async () => {
    await using fixture = await setup();
    const { container, Probe, rangeText, fadeRanges, render, flushFrames } = fixture;
    const view = (eof = false) => (
      <Probe
        text="HistoryXYZ"
        richText={
          <>
            <span>History</span>
            <span aria-hidden={!eof}>XYZ</span>
          </>
        }
        streaming={!eof}
        complete={eof}
      />
    );
    await render(view());
    const message = container.querySelector("[data-probe]")!;
    const scan = vi.spyOn(document, "createTreeWalker");
    await render(view(true));
    expect(
      scan.mock.calls.filter(
        ([node, filter]) =>
          node === message && filter === (NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT),
      ),
    ).toHaveLength(1);
    expect(fadeRanges().map(rangeText).toSorted()).toEqual(["X", "Y", "Z"]);
    await flushFrames();
  });

  it("rebuilds the DOM index for an EOF commit that replaces a measured candidate", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(20);
    const commit = vi.fn();
    const candidate = { measure: () => 60, commit };
    await render(<Probe text="History" frame />);
    await render(<Probe text="History" sourceText="HistoryXYZ" frame candidate={candidate} />);
    for (now = 16; now < 1_000 && !commit.mock.calls.length; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(commit).toHaveBeenCalledOnce();
    const message = container.querySelector("[data-probe]")!;
    const scan = vi.spyOn(document, "createTreeWalker");
    await render(
      <Probe text="HistoryXYZ" frame richText={<p>HistoryXYZ</p>} streaming={false} complete />,
    );
    expect(
      scan.mock.calls.some(
        ([node, filter]) =>
          node === message && filter === (NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT),
      ),
    ).toBe(true);
    expect(fadeRanges().map(rangeText).toSorted()).toEqual(["X", "Y", "Z"]);
    expect(fadeRanges().every((range) => message.contains(range.startContainer))).toBe(true);
    expectPaintedGlyphsToFit();
    await flushFrames();
  });

  it("remeasures real wrapping after reusing an EOF DOM index and preserves glyph fades", async () => {
    await using fixture = await setup();
    const {
      frames,
      Probe,
      hiddenHighlight,
      fadeRanges,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
    } = fixture;
    let now = 0;
    let columns = 40;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(() => columns);
    const view = (eof = false) => (
      <Probe
        text="HistoryAB"
        frame
        mode="auto"
        lineMode="adaptive"
        fadeDurationMs={500}
        yieldDurationMs={200}
        initialBufferMs={0}
        streaming={!eof}
        complete={eof}
      />
    );
    await render(<Probe text="History" frame mode="auto" initialBufferMs={0} />);
    now = 100;
    await render(view());
    now = 116;
    let callbacks = [...frames.values()];
    frames.clear();
    await act(() => callbacks.forEach((callback) => callback(now)));
    now = 120;
    await render(view(true));
    const active = fadeRanges();
    expect(active.length).toBeGreaterThan(0);
    const bounds = vi.mocked(Range.prototype.getBoundingClientRect);
    bounds.mockClear();
    columns = 2;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(bounds).toHaveBeenCalled();
    expectPaintedGlyphsToFit();
    expect(fadeRanges()).toEqual(active);
    for (let index = 0; index < 80 && frames.size; index++) {
      now += 16;
      callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expectPaintedGlyphsToFit();
    }
    expect(frames.size).toBe(0);
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges()).toHaveLength(0);
  });

  it("keeps buffered inline frames free of repeated hidden-state attribute writes", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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

  it("does not revisit queued inline surfaces on buffered frames", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    const chunks = Array.from({ length: 200 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index).repeat(5),
    );
    await render(
      <Probe
        text={chunks.join("")}
        richText={
          <p>
            {chunks.map((text) => (
              <code key={text}>{text}</code>
            ))}
          </p>
        }
        claimInitialText={() => true}
      />,
    );
    const reads = [...container.querySelectorAll("code")].map((code) =>
      vi.spyOn(code.style, "getPropertyValue"),
    );
    for (now = 16; now <= 64; now += 16) {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(reads.reduce((count, read) => count + read.mock.calls.length, 0)).toBeLessThan(10);
    expect(container.querySelectorAll("[data-smooth-inline-pending]")).toHaveLength(200);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(chunks.join(""));
    await flushFrames();
    expect(container.querySelectorAll("[data-smooth-inline-pending]")).toHaveLength(0);
  });

  it("reuses an inline frame's clipping geometry between character deadlines", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    const writeClip = vi.fn((value: string) => code.style.setProperty("clip-path", value));
    Object.defineProperty(code.style, "clipPath", {
      configurable: true,
      get: () => code.style.getPropertyValue("clip-path"),
      set: writeClip,
    });

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
      await using fixture = await setup();
      const { container, highlights, frames, Probe, fadeRanges, render, flushFrames } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
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
      expect([...highlights.values()].every((region) => region.size === 0)).toBe(true);
    },
  );

  it("reads a batch of new glyph colors before writing their highlight color bindings", async () => {
    await using fixture = await setup();
    const { frames, Probe, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { container, frames, Probe, fadeRanges, mockWrappedRows, render, flushFrames } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const {
      container,
      highlights,
      frames,
      Probe,
      hiddenHighlight,
      fadeRanges,
      mockWrappedRows,
      render,
      flushFrames,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
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
    await using fixture = await setup();
    const { MockIntersectionObserver, container, frames, Probe, render } = fixture;
    fixture.use(stubGlobal("CSS", {}));
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

describe("resume lifecycle regressions", () => {
  it.each([false, true])(
    "shows an incompatible committed mount version and smooths later live text (strict=%s)",
    async (strict) => {
      await using fixture = await setup();
      const { Probe, hiddenHighlight, rangeText, fadeRanges, render, flushFrames } = fixture;
      const resume = {
        key: `resume-mount-version-${strict}`,
        mountText: "A" + "b".repeat(100),
        baselineText: "A",
        synchronized: true,
      };
      const text = "A" + "b".repeat(50) + "X" + "b".repeat(49);
      const show = (source: string) => {
        const probe = <Probe text={source} resume={resume} />;
        return render(strict ? <StrictMode>{probe}</StrictMode> : probe);
      };
      await show(text);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
      expect(fadeRanges()).toHaveLength(0);
      await show(text + "NEXT");
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("NEXT");
      await flushFrames();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
    },
  );
  it("pending replay must remain immediately visible on an existing observer", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = { key: "astra/pending", baselineText: "", synchronized: true, forceShow: true };
    await render(<Probe text="A" resume={resume} />);
    await render(<Probe text={"A" + "b".repeat(100)} resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
  });
  it("an updated marker must show history and queue only its live suffix", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = { key: "astra/reconnect", baselineText: "A", synchronized: true };
    await render(<Probe text="A" resume={resume} />);
    const history = "A" + "b".repeat(100);
    await render(<Probe text={history + "LIVE"} resume={{ ...resume, baselineText: history }} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("LIVE");
  });
  it("keepalive remount without a checkpoint must not replay old post-marker text", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = {
      key: "astra/keepalive-missing",
      mountText: "A" + "b".repeat(100),
      baselineText: "A",
      synchronized: true,
    };
    await render(<Probe text={"A" + "b".repeat(100)} resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
  });
  it("a fresh longer marker baseline must allow a small safe checkpoint", async () => {
    await using _fixture = await setup();

    const module = await import("../lib/smoothTextPlayback");
    const result = module.resolveSmoothTextResume({
      checkpoint: {
        sourceText: "AB",
        visibleText: "A",
        intervalMs: null,
        recordedAt: FIXTURE_EPOCH,
      },
      baselineText: "ABC",
      currentText: "ABC",
      now: FIXTURE_EPOCH,
      complete: false,
    });
    expect(result).toEqual({ kind: "resume", visibleText: "A" });
  });
  it("a large marker backlog with checkpoint must still queue marker-after live text", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = {
      key: "astra/large-with-live",
      mountText: "AB",
      baselineText: "A" + "b".repeat(100),
      synchronized: true,
    };
    smoothTextPlaybackStore.set(resume.key, {
      visibleText: "A",
      sourceText: "AB",
      intervalMs: null,
      recordedAt: FIXTURE_EPOCH,
    });
    await render(<Probe text={resume.baselineText + "LIVE"} resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("LIVE");
  });
  it("late code belonging to a forced-visible snapshot must not enter playback", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const source = "```ts\n" + "x".repeat(100) + "\n```";
    const resume = {
      key: "astra/late-code",
      baselineText: source,
      synchronized: true,
      forceShow: true,
    };
    await render(<Probe text={"x".repeat(100)} sourceText={source} codePending resume={resume} />);
    await render(<Probe text={"x".repeat(100)} sourceText={source} codeBlock resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
  });
});
describe("Astra identity and StrictMode boundaries", () => {
  it("identity replacement must not inherit the previous item queue", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    await render(
      <Probe text="A" resume={{ key: "astra/item-old", baselineText: "A", synchronized: true }} />,
    );
    const source = "A" + "b".repeat(100);
    await render(
      <Probe
        text={source}
        resume={{ key: "astra/item-new", baselineText: source, synchronized: true }}
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
  });
  it("StrictMode must retain marker-after live playback on its effect remount", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = { key: "astra/strict", mountText: "A", baselineText: "A", synchronized: true };
    await render(
      <StrictMode>
        <Probe text={"A" + "L".repeat(50)} resume={resume} />
      </StrictMode>,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("L".repeat(50));
  });
});
describe("Astra positive controls", () => {
  it("isolates a live suffix on the first marker commit without a checkpoint", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = {
      key: "astra/control-marker",
      mountText: "History",
      baselineText: "History",
      synchronized: true,
    };
    await render(<Probe text="HistoryLIVE" resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("LIVE");
  });
  it("resumes a small backlog when the marker baseline does not grow", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, render } = fixture;
    const resume = { key: "astra/control-small", baselineText: "A", synchronized: true };
    smoothTextPlaybackStore.set(resume.key, {
      visibleText: "A",
      sourceText: "ABC",
      intervalMs: null,
      recordedAt: FIXTURE_EPOCH,
    });
    await render(<Probe text="ABC" resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BC");
  });
  it("renders a completed background body immediately", async () => {
    await using fixture = await setup();
    const { frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    const resume = { key: "astra/control-complete", baselineText: "A", synchronized: true };
    await render(<Probe text={"A" + "b".repeat(100)} complete resume={resume} />);
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("");
    expect(fadeRanges()).toHaveLength(0);
    expect(frames.size).toBe(0);
  });
});

describe("resume ownership across deferred DOM", () => {
  it("retains forced history across repeated legacy deltas and animates the next run", async () => {
    await using fixture = await setup();
    const { Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    const resume = {
      key: "resume-legacy-deltas",
      baselineText: "",
      synchronized: true,
      forceShow: true,
    };
    for (const text of ["A", "AB", "ABC", "A" + "b".repeat(100)]) {
      await render(<Probe text={text} resume={resume} frame />);
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toHaveLength(0);
    }
    await render(
      <Probe
        text="NEW"
        claimInitialText={() => true}
        resume={{
          key: "new-run-after-legacy",
          baselineText: "",
          mountText: "",
          synchronized: false,
        }}
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("NEW");
  });

  it.each(["expired", "evicted", "disabled"])(
    "uses current mounted history after a checkpoint is %s",
    async (reason) => {
      await using fixture = await setup();
      const { Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
      const text = "A" + "b".repeat(100);
      const resume = {
        key: `resume-missing-${reason}`,
        baselineText: "A",
        mountText: text,
        synchronized: true,
      };
      smoothTextPlaybackStore.set(resume.key, {
        visibleText: "A",
        sourceText: "AB",
        intervalMs: null,
        recordedAt: reason === "expired" ? FIXTURE_EPOCH - 300_001 : FIXTURE_EPOCH,
      });
      if (reason === "evicted")
        for (let i = 0; i < 100; i++)
          smoothTextPlaybackStore.set(`eviction-${i}`, {
            visibleText: "A",
            sourceText: "A",
            intervalMs: null,
            recordedAt: FIXTURE_EPOCH,
          });
      if (reason === "disabled")
        await render(<Probe text={text} resume={{ ...resume, mountText: "A" }} enabled={false} />);
      expect(smoothTextPlaybackStore.get(resume.key)).toBeNull();
      await render(
        <Probe
          text={text}
          resume={reason === "disabled" ? { ...resume, mountText: "A" } : resume}
          frame
        />,
      );
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toHaveLength(0);
      await render(<Probe text={text + "LIVE"} resume={resume} frame />);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("LIVE");
    },
  );

  it.each([false, true])(
    "keeps a small marker backlog separate from a long live tail (StrictMode=%s)",
    async (strict) => {
      await using fixture = await setup();
      const { Probe, hiddenHighlight, rangeText, render } = fixture;
      const resume = {
        key: `small-history-long-live-${strict}`,
        baselineText: "ABC",
        mountText: "AB",
        synchronized: true,
      };
      smoothTextPlaybackStore.set(resume.key, {
        visibleText: "A",
        sourceText: "AB",
        intervalMs: null,
        recordedAt: FIXTURE_EPOCH,
      });
      const probe = <Probe text={"ABC" + "L".repeat(100)} resume={resume} />;
      await render(strict ? <StrictMode>{probe}</StrictMode> : probe);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BC" + "L".repeat(100));
    },
  );

  it("shows late historical media and code while preserving subsequent live text", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, fadeRanges, render } = fixture;
    const source = "```ts\n" + "x".repeat(100) + "\n```\n\n![history](image.png)";
    const resume = {
      key: "late-history-media",
      baselineText: source,
      mountText: source,
      synchronized: true,
    };
    await render(<Probe text="" sourceText={source} codePending resume={resume} frame />);
    await render(
      <Probe
        text=""
        sourceText={source}
        richText={
          <>
            <pre data-smooth-history="">
              <code>{"x".repeat(100)}</code>
            </pre>
            <img data-smooth-history="" alt="history" />
          </>
        }
        resume={resume}
        frame
      />,
    );
    expect(hiddenHighlight()).toBeUndefined();
    expect(fadeRanges()).toHaveLength(0);
    await act(() =>
      container.querySelector("img")!.dispatchEvent(new Event("load", { bubbles: true })),
    );
    expect(frames.size).toBe(0);
    expect(container.querySelector("img")!.hasAttribute("data-smooth-media-pending")).toBe(false);
    await render(
      <Probe
        text=""
        sourceText={source + "LIVE"}
        richText={
          <>
            <pre data-smooth-history="">
              <code>{"x".repeat(100)}</code>
            </pre>
            <img data-smooth-history="" alt="history" />
            <p>LIVE</p>
          </>
        }
        resume={resume}
        frame
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("LIVE");
    await render(
      <Probe
        text=""
        sourceText={source + "LIVE"}
        richText={
          <>
            <pre data-smooth-history="">
              <code>
                <span>{"x".repeat(100)}</span>
              </code>
            </pre>
            <img data-smooth-history="" alt="history" />
            <p>LIVE</p>
          </>
        }
        resume={resume}
        frame
      />,
    );
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("LIVE");
  });
});

describe("Astra R2 recovery boundaries", () => {
  it.each(
    [4, 16].flatMap((frameMs) =>
      ["complete", "stream-ended"].map((boundary) => ({ frameMs, boundary })),
    ),
  )(
    "opens space for a first live $boundary snapshot at $frameMs ms frames",
    async ({ frameMs, boundary }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const settled = vi.fn();
      await render(
        <Probe
          text="HELLO"
          frame
          markdownParagraph
          resume={{
            key: `r2-first-${boundary}-${frameMs}`,
            baselineText: "",
            mountText: "",
            synchronized: false,
          }}
          complete={boundary === "complete"}
          streaming={false}
          initialBufferMs={80}
          fadeDurationMs={0}
          claimInitialText={() => true}
          onSettled={settled}
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(frame.getBoundingClientRect().height).toBe(0);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("HELLO");
      expect(frames.size).toBe(1);
      expect(settled).not.toHaveBeenCalled();
      let previous = 0;
      for (now = frameMs; now <= 640; now += frameMs) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = frame.getBoundingClientRect().height;
        expect(height).toBeGreaterThanOrEqual(previous);
        expect(height - previous).toBeLessThanOrEqual(
          frameMs * DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6,
        );
        expectPaintedGlyphsToFit();
        expect(frames.size).toBeLessThanOrEqual(1);
        previous = height;
      }
      expect(previous).toBe(20);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.style.height).toBe("");
      expect(frames.size).toBe(0);
      expect(settled).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["synchronized", "unclaimed", "forced", "checkpoint"])(
    "keeps a first completed %s snapshot static",
    async (ownership) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, fadeRanges, mockWrappedRows, render } =
        fixture;
      mockWrappedRows(40, true);
      const key = `r2-completed-history-${ownership}`;
      if (ownership === "checkpoint")
        smoothTextPlaybackStore.set(key, {
          visibleText: "H",
          sourceText: "HELLO",
          intervalMs: null,
          recordedAt: FIXTURE_EPOCH,
        });
      await render(
        <Probe
          text="HELLO"
          frame
          markdownParagraph
          resume={{
            key,
            baselineText: ownership === "synchronized" ? "HELLO" : "",
            mountText: ownership === "synchronized" ? "HELLO" : "",
            synchronized: ownership === "synchronized",
            forceShow: ownership === "forced",
          }}
          complete
          streaming={false}
          initialBufferMs={80}
          claimInitialText={() => ownership !== "unclaimed"}
        />,
      );
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(frame.getBoundingClientRect().height).toBe(20);
      expect(hiddenHighlight()).toBeUndefined();
      expect(fadeRanges()).toHaveLength(0);
      expect(frame.style.height).toBe("");
      expect(frames.size).toBe(0);
    },
  );
});

describe("Astra R2 paused updates", () => {
  it.each(
    [4, 16].flatMap((frameMs) =>
      ["complete", "stream-ended", "append", "dom-replace"].map((update) => ({ frameMs, update })),
    ),
  )(
    "continues on the next $frameMs ms frame after receiving $update while paused",
    async ({ frameMs, update }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      let closed = false;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const elementBounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const bounds = elementBounds.call(this);
        return closed ? { ...bounds, top: 0, bottom: 0, height: 0, width: 0 } : bounds;
      });
      const rangeBounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        const bounds = rangeBounds.call(this);
        return closed ? { ...bounds, top: 0, bottom: 0, height: 0, width: 0 } : bounds;
      });
      const initialText = update === "stream-ended" ? "AAAA\nBBBB" : "AAAA";
      const nextText = update === "append" || update === "dom-replace" ? "AAAA\nBBBB" : initialText;
      const endsSource = update === "complete" || update === "stream-ended";
      const settled = vi.fn();
      const view = (paused: boolean, changed = false, finished = changed && endsSource) => (
        <Probe
          text={changed ? nextText : initialText}
          richText={
            update === "dom-replace" ? (
              <p key={changed ? nextText : initialText}>{changed ? nextText : initialText}</p>
            ) : undefined
          }
          frame
          paused={paused}
          streaming={!finished}
          complete={finished && update !== "stream-ended"}
          drainOnComplete={update !== "stream-ended"}
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
          onSettled={settled}
        />
      );
      const step = async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await render(view(false));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const pauseAt = update === "stream-ended" ? Math.ceil(300 / frameMs) * frameMs : 80;
      for (now = 0; now <= pauseAt; now += frameMs) await step();
      now = pauseAt;
      const before = Number.parseFloat(frame.style.height);
      closed = true;
      await render(view(true));
      expect(frames.size).toBe(0);
      now = pauseAt + 500;
      await render(view(true, true));
      expect.soft(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 8);
      expect(frames.size).toBe(0);
      now = pauseAt + 1000;
      closed = false;
      await render(view(false, true));
      const resumed = Number.parseFloat(frame.style.height);
      expect.soft(resumed).toBeCloseTo(before, 8);
      now += frameMs;
      await step();
      const first = frame.getBoundingClientRect().height;
      expect(first).toBeGreaterThan(resumed + 1e-5);
      expect(first - before).toBeLessThanOrEqual(
        frameMs * DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6,
      );
      let previous = first;
      for (let index = 0; index < 800 / frameMs; index++) {
        now += frameMs;
        await step();
        const height = frame.getBoundingClientRect().height;
        expect(height).toBeGreaterThanOrEqual(previous);
        expect(height - previous).toBeLessThanOrEqual(
          frameMs * DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6,
        );
        expectPaintedGlyphsToFit();
        expect(frames.size).toBeLessThanOrEqual(1);
        previous = height;
      }
      expect(previous).toBe(nextText.includes("\n") ? 40 : 20);
      await render(view(false, true, true));
      expect(hiddenHighlight()).toBeUndefined();
      expect(frame.style.height).toBe("");
      expect(frames.size).toBe(0);
      expect(settled).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Astra R1 motion boundaries", () => {
  it.each(["complete", "stream-ended"])(
    "keeps an active same-key resume behind opening space when %s",
    async (boundary) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const resume = {
        key: `r1-active-${boundary}`,
        baselineText: "",
        mountText: "",
        synchronized: false,
      };
      const view = (text: string, done = false) => (
        <Probe
          text={text}
          frame
          markdownParagraph
          resume={resume}
          initialBufferMs={SMOOTH_TEXT_BUFFER_MS}
          fadeDurationMs={0}
          claimInitialText={() => true}
          complete={done && boundary === "complete"}
          streaming={!done}
        />
      );
      await render(view(""));
      now = 10;
      await render(view("HELLO"));
      now = 20;
      await render(view("HELLO", true));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(frame.getBoundingClientRect().height).toBeLessThan(1);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("HELLO");
      let previous = 0;
      let peak = 0;
      for (; now <= 420; now += 4) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = frame.getBoundingClientRect().height;
        const velocity = (height - previous) / 4;
        expect(velocity).toBeLessThanOrEqual(DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6);
        expectPaintedGlyphsToFit();
        peak = Math.max(peak, velocity);
        previous = height;
      }
      expect(peak).toBeGreaterThan(DEFAULT_LINE_BEZIER_PEAK_VELOCITY * 0.99);
      expect(previous).toBe(20);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );
  it.each([
    { paragraph: false, completion: "before-frame" },
    { paragraph: true, completion: "before-frame" },
    { paragraph: false, completion: "mid-pulse" },
    { paragraph: true, completion: "mid-pulse" },
    { paragraph: false, completion: "initial-snapshot" },
    { paragraph: true, completion: "initial-snapshot" },
  ])(
    "keeps a $completion EOF behind its opening space (paragraph=$paragraph)",
    async ({ paragraph, completion }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const settled = vi.fn();
      const view = (text: string, complete = false) => (
        <Probe
          text={text}
          frame
          markdownParagraph={paragraph}
          initialBufferMs={80}
          fadeDurationMs={0}
          claimInitialText={() => true}
          complete={complete}
          streaming={!complete}
          onSettled={settled}
        />
      );
      if (completion === "initial-snapshot") await render(view("HELLO", true));
      else {
        await render(view(""));
        now = 10;
        await render(view("HELLO"));
        if (completion === "mid-pulse") {
          for (now = 10; now <= 110; now += 4) {
            const callbacks = [...frames.values()];
            frames.clear();
            await act(() => callbacks.forEach((callback) => callback(now)));
          }
        } else now = 20;
        await render(view("HELLO", true));
      }
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(frame.getBoundingClientRect().height).toBeLessThan(
        completion === "mid-pulse" ? 20 : 1,
      );
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("HELLO");
      expect(settled).not.toHaveBeenCalled();
      let previous = Number.parseFloat(frame.style.height);
      let peak = 0;
      for (; now <= 420; now += 4) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = frame.getBoundingClientRect().height;
        peak = Math.max(peak, (height - previous) / 4);
        expect(height - previous).toBeLessThanOrEqual(4 * DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6);
        expectPaintedGlyphsToFit();
        previous = height;
      }
      expect(peak).toBeGreaterThan(DEFAULT_LINE_BEZIER_PEAK_VELOCITY * 0.99);
      expect(previous).toBe(20);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
      expect(settled).toHaveBeenCalledTimes(1);
    },
  );

  it.each([40, 80, 140, 188])(
    "resumes a spatial reservation immediately after pausing at %s ms",
    async (pauseAt) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (paused: boolean) => (
        <Probe
          text="AAAA"
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
          paused={paused}
        />
      );
      await render(view(false));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const step = async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      for (now = 0; now <= pauseAt; now += 4) await step();
      now = pauseAt;
      const before = Number.parseFloat(frame.style.height);
      await render(view(true));
      now += 1000;
      await render(view(false));
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(before, 8);
      now += 4;
      await step();
      const first = Number.parseFloat(frame.style.height);
      expect(first).toBeGreaterThan(before + 1e-5);
      expect(first - before).toBeLessThanOrEqual(4 * DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6);
      for (let index = 0; index < 80; index++) {
        now += 4;
        await step();
        expectPaintedGlyphsToFit();
      }
      expect(Number.parseFloat(frame.style.height)).toBe(20);
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each([180, 200, 220])(
    "connects a late row at %s ms from the painted boundary without a speed reset",
    async (arrival) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          claimInitialText={() => true}
        />
      );
      await render(view("AAAA"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const tail: number[] = [];
      let previous = 0;
      let incoming = 0;
      for (now = 0; now < arrival + 600; now++) {
        if (now === arrival) await render(view("AAAA\nAAAA"));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = Number.parseFloat(frame.style.height);
        const velocity = height - previous;
        if (now === arrival - 1) incoming = velocity;
        if (now >= arrival && height < 20 - 1e-8) tail.push(velocity);
        expect(velocity).toBeGreaterThanOrEqual(-1e-9);
        expect(velocity).toBeLessThanOrEqual(DEFAULT_LINE_BEZIER_PEAK_VELOCITY + 1e-6);
        expectPaintedGlyphsToFit();
        previous = height;
      }
      if (arrival < 200) {
        expect(tail.length).toBeGreaterThan(1);
        // A late live redirect keeps its incoming speed; its short Hermite
        // continuation can change acceleration without recreating a full peak.
        expect(tail[0]).toBeCloseTo(incoming, 2);
        expect(Math.max(...tail)).toBeLessThan(incoming + 0.01);
        for (let index = 1; index < tail.length; index++)
          expect(Math.abs(tail[index]! - tail[index - 1]!)).toBeLessThan(0.01);
      } else {
        // The 200ms isolated action has already reached rest before this arrival.
        expect(tail).toHaveLength(0);
      }
      expect(previous).toBe(40);
      expect(hiddenHighlight()).toBeUndefined();
    },
  );

  it.each(["width", "font", "existing-media"])(
    "does not count %s reflow as newly arriving physical lines",
    async (kind) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      let columns = 4;
      let oldShift = 0;
      const fontEvents = new EventTarget();
      const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
      Object.defineProperty(document, "fonts", { configurable: true, value: fontEvents });
      try {
        mockWrappedRows(() => columns, false, false, 40);
        if (kind !== "width") {
          const bounds = vi.mocked(Range.prototype.getBoundingClientRect).getMockImplementation()!;
          vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (
            this: Range,
          ) {
            const box = bounds.call(this);
            return { ...box, top: box.top + oldShift, bottom: box.bottom + oldShift } as DOMRect;
          });
          const elementBounds = vi
            .mocked(HTMLElement.prototype.getBoundingClientRect)
            .getMockImplementation()!;
          vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
            this: HTMLElement,
          ) {
            const box = elementBounds.call(this);
            if (this.tagName === "IMG")
              return { ...box, top: 0, bottom: oldShift, height: oldShift };
            if (this.matches("[data-probe]"))
              return { ...box, bottom: box.bottom + oldShift, height: box.height + oldShift };
            return box;
          });
        }
        const plans: number[] = [];
        const create = originals.cadenceModule.createSmoothLineCadence;
        vi.mocked(cadenceModule.createSmoothLineCadence).mockImplementation(() => {
          const cadence = create();
          const plan = cadence.plan;
          cadence.plan = (...args) => {
            const result = plan(...args);
            if (now >= 680 && result.peakVelocity !== null) plans.push(result.peakVelocity);
            return result;
          };
          return cadence;
        });
        const view = (text: string) => (
          <Probe
            text={text}
            frame
            initialBufferMs={0}
            fadeDurationMs={0}
            claimInitialText={() => true}
            richText={
              kind === "existing-media" ? (
                <>
                  <img data-smooth-history="" alt="history" />
                  <p>{text}</p>
                </>
              ) : undefined
            }
          />
        );
        let text = "AAAA\nBBBB\nCCCC";
        await render(view(text));
        for (now = 0; now <= 1200; now += 4) {
          if (now === 300 || now === 600) {
            text += "\nDDDD";
            await render(view(text));
          }
          if (now === 640) {
            if (kind === "width") columns = 2;
            else oldShift = 100;
            if (kind === "existing-media")
              container.querySelector("img")!.dispatchEvent(new Event("load", { bubbles: true }));
            else if (kind === "font") fontEvents.dispatchEvent(new Event("loadingdone"));
            else window.dispatchEvent(new Event("resize"));
          }
          if (now === 680) {
            text += kind === "width" ? "E" : "\nE";
            await render(view(text));
          }
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        }
        expect(plans.length).toBeGreaterThan(0);
        expect(Math.max(...plans)).toBeLessThanOrEqual(0.25 + 1e-9);
      } finally {
        if (fontsDescriptor) Object.defineProperty(document, "fonts", fontsDescriptor);
        else Reflect.deleteProperty(document, "fonts");
      }
    },
  );

  it.each(["long-link", "footnote-definition"])(
    "bounds retained source arrivals and refresh work for %s streams",
    async (kind) => {
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      let source = "";
      let display = "";
      let retained = 0;
      let visited = 0;
      const nativePush = Array.prototype.push;
      const nativeFilter = Array.prototype.filter;
      const isSourceArrival = (value: unknown): boolean =>
        typeof value === "object" &&
        value !== null &&
        "end" in value &&
        value.end === source.length &&
        "at" in value &&
        value.at === now;
      // Observe ordinary collection operations, without adding a hook debug API.
      // eslint-disable-next-line no-extend-native -- A push spy recursively records its own calls.
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        if (source.length > display.length && items.length === 1 && isSourceArrival(items[0]))
          retained = Math.max(retained, this.length + 1);
        return nativePush.apply(this, items);
      };
      // eslint-disable-next-line no-extend-native -- Observe the real refresh traversal cost.
      Array.prototype.filter = function (
        this: unknown[],
        callback: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        if (source.length > display.length && isSourceArrival(this.at(-1))) visited += this.length;
        return nativeFilter.call(this, callback, thisArg);
      };
      try {
        const view = () => (
          <Probe
            text={display}
            sourceText={source}
            frame
            initialBufferMs={0}
            fadeDurationMs={0}
            claimInitialText={() => true}
          />
        );
        await render(view());
        for (let batch = 0; batch < 100; batch++) {
          now = batch * 300;
          source +=
            kind === "long-link"
              ? "[A](https://example.invalid/" + "x".repeat(80) + ")\n\n"
              : "A[^n]\n\n[^n]: " + "definition ".repeat(10) + "\n\n";
          display += (display ? "\n" : "") + "A";
          await render(view());
          for (let index = 1; index <= 19; index++) {
            now = batch * 300 + index * 16;
            const callbacks = [...frames.values()];
            frames.clear();
            await act(() => callbacks.forEach((callback) => callback(now)));
          }
        }
        expect(hiddenHighlight()).toBeUndefined();
        expect(retained).toBeGreaterThan(0);
        expect(retained).toBeLessThanOrEqual(3);
        expect(visited).toBeLessThanOrEqual(400);
      } finally {
        // eslint-disable-next-line no-extend-native -- Restore temporary collection instrumentation.
        Array.prototype.push = nativePush;
        // eslint-disable-next-line no-extend-native -- Restore temporary collection instrumentation.
        Array.prototype.filter = nativeFilter;
      }
    },
  );
});

describe("delivered space regression paths", () => {
  it("hands an unfinished tail settle to a newly arriving row without adding another yield wait", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
      fixture;
    let now = 0;
    let natural = 20;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(40);
    const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement,
    ) {
      const bounds = rect.call(this);
      return this.matches("[data-probe]")
        ? { ...bounds, height: natural, bottom: natural }
        : bounds;
    });
    const view = (text: string) => (
      <Probe text={text} frame lineMode="parallel" yieldDurationMs={150} />
    );
    const step = async () => {
      now += 4;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    await render(view("AB"));
    now = 40;
    natural = 37;
    await render(view("ABCD"));
    for (let index = 0; index < 60 && hiddenHighlight(); index++) await step();
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.getBoundingClientRect().height).toBeLessThan(37);
    expect(frames.size).toBeGreaterThan(0);
    const arrivedAt = now;
    natural = 57;
    await render(view("ABCD\nKKKKKKKKKK"));
    let firstGlyphAt: number | undefined;
    for (let index = 0; index < 100 && frames.size; index++) {
      await step();
      const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      expect(hidden).not.toMatch(/[ABCD]/u);
      if (hidden.replace(/\s/gu, "").length < 10) firstGlyphAt ??= now;
    }
    expect(firstGlyphAt).toBeDefined();
    expect(firstGlyphAt! - arrivedAt).toBeLessThanOrEqual(150 + 32);
  });

  it.each([false, true])(
    "waits for an initially paused text claim before completing playback (streaming=%s)",
    async (streaming) => {
      await using fixture = await setup();
      const { frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } = fixture;
      let now = 0;
      let ready = false;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      const onComplete = vi.fn();
      const claim = () => ready;
      const view = (paused: boolean) => (
        <Probe
          text="Pending note body."
          frame
          paused={paused}
          streaming={streaming}
          claimInitialText={claim}
          initialBufferMs={0}
          fadeDurationMs={0}
          onPlaybackComplete={onComplete}
        />
      );
      await render(view(true));
      expect(onComplete).not.toHaveBeenCalled();
      now = 400;
      ready = true;
      await render(view(false));
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("Pending note body.");
      expect(onComplete).not.toHaveBeenCalled();
      for (let index = 0; index < 100 && frames.size; index++) {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
      expect(onComplete).toHaveBeenCalledTimes(streaming ? 0 : 1);
    },
  );

  it.each(["character", "token"] as const)(
    "keeps a word-wrapped visible prefix inside its frame without replay in %s mode",
    async (mode) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(14, false, true);
      const view = (text: string) => <Probe text={text} frame mode={mode} yieldDurationMs={150} />;
      await render(view("H abcdef"));
      const body = container.querySelector<HTMLElement>("[data-probe]")!;
      const node = body.firstChild;
      const frame = body.parentElement!;
      expect(frame.getBoundingClientRect().height).toBe(20);
      now = 40;
      await render(view("H abcdefghijklmn"));
      expect(body.firstChild).toBe(node);
      // Reflow already moved these visible glyphs. Their frame must contain
      // them so following content cannot overlap them while the FIFO drains.
      expectPaintedGlyphsToFit();
      for (let index = 0; index < 160 && frames.size; index++) {
        now += 4;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        for (const hidden of hiddenHighlight() ?? []) {
          expect(hidden.startContainer).toBe(node);
          expect(hidden.startOffset).toBeGreaterThanOrEqual(8);
        }
        expectPaintedGlyphsToFit();
      }
      expect(frame.getBoundingClientRect().height).toBe(40);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it.each(
    [17, 20, 20.1].flatMap((extra) => [
      { extra, complete: false },
      { extra, complete: true },
    ]),
  )(
    "eases $extra px of final space when the FIFO empties (complete=$complete)",
    async ({ extra, complete }) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockWrappedRows, render } = fixture;
      let now = 0;
      let natural = 20;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement,
      ) {
        const bounds = rect.call(this);
        return this.matches("[data-probe]") ||
          (this.hasAttribute("data-smooth-text-frame") && !this.style.height)
          ? { ...bounds, height: natural, bottom: natural }
          : bounds;
      });
      const onComplete = vi.fn();
      const view = (text: string, finished = false) => (
        <Probe
          text={text}
          frame
          complete={finished}
          streaming={!finished}
          yieldDurationMs={150}
          fadeDurationMs={0}
          onPlaybackComplete={onComplete}
        />
      );
      await render(view("AB"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(frame.getBoundingClientRect().height).toBe(20);
      now = 40;
      natural += extra;
      await render(view("ABCDEFGHIJ", complete));
      let previous = 20;
      let peak = frame.getBoundingClientRect().height - previous;
      const samples: number[] = [];
      for (let index = 0; index < 180 && frames.size; index++) {
        now += 4;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        const height = frame.getBoundingClientRect().height;
        expect(height).toBeGreaterThanOrEqual(previous - 1e-8);
        peak = Math.max(peak, height - previous);
        samples.push(height);
        previous = height;
      }
      expect(peak).toBeLessThan(4);
      expect(samples.some((height) => height > 20 && height < natural)).toBe(true);
      expect(frame.getBoundingClientRect().height).toBeCloseTo(natural, 8);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
      expect(onComplete).toHaveBeenCalledTimes(complete ? 1 : 0);
    },
  );

  it.each([30, 60])(
    "delivers intermediate space for a short paragraph burst at %s Hz",
    async (hz) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        mockWrappedRows,
        expectPaintedGlyphsToFit,
        render,
      } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40, true);
      const view = (text: string) => (
        <Probe text={text} frame markdownParagraph yieldDurationMs={150} />
      );
      await render(view("Z"));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      expect(frame.getBoundingClientRect().height).toBe(20);
      now = 16;
      const text = "Z\n" + "ABCDEFGHIJKLMNOPQRSTUVWXY".split("").join("\n");
      await render(view(text));
      const samples: number[] = [];
      for (let index = 1; index <= hz * 3 && frames.size; index++) {
        now = Math.max(16, (index * 1000) / hz);
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expectPaintedGlyphsToFit();
        samples.push(frame.getBoundingClientRect().height);
      }
      expect(samples.find((height) => height > 20)).toBeLessThan(40);
      expect(frame.getBoundingClientRect().height).toBe(520);
      expect(hiddenHighlight()).toBeUndefined();
      expect(frames.size).toBe(0);
    },
  );

  it.each([120, 1000])(
    "resumes final space after a %s ms interruption without skipping its curve",
    async (stall) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      let natural = 20;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(40);
      const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement,
      ) {
        const bounds = rect.call(this);
        return this.matches("[data-probe]") ||
          (this.hasAttribute("data-smooth-text-frame") && !this.style.height)
          ? { ...bounds, height: natural, bottom: natural }
          : bounds;
      });
      const onComplete = vi.fn();
      const view = (finished: boolean) => (
        <Probe
          text="AB"
          frame
          streaming={!finished}
          complete={finished}
          yieldDurationMs={150}
          fadeDurationMs={0}
          onPlaybackComplete={onComplete}
        />
      );
      await render(view(false));
      natural = 60;
      await render(view(true));
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        return frame.getBoundingClientRect().height;
      };
      const before = await step(16);
      expect(before).toBeGreaterThan(20);
      expect(before).toBeLessThan(22);
      const resumed = await step(16 + stall);
      expect(resumed).toBeGreaterThan(before);
      expect(resumed - before).toBeLessThan(5);
      expect(onComplete).not.toHaveBeenCalled();
      for (let index = 1; index <= 80 && frames.size; index++) await step(16 + stall + index * 16);
      expect(frame.getBoundingClientRect().height).toBe(60);
      expect(frames.size).toBe(0);
      expect(onComplete).toHaveBeenCalledOnce();
      await step(now + 16);
      expect(onComplete).toHaveBeenCalledOnce();
    },
  );
});

describe("stream motion performance regressions", () => {
  const hiddenUnits = (fixture: Awaited<ReturnType<typeof setup>>) =>
    [...(fixture.hiddenHighlight() ?? [])].reduce(
      (sum, range) => sum + range.endOffset - range.startOffset,
      0,
    );

  it.each([
    { rows: 100, hz: 60, lineMode: "adaptive", mode: "character" },
    { rows: 300, hz: 60, lineMode: "adaptive", mode: "character" },
    { rows: 150, hz: 30, lineMode: "adaptive", mode: "character" },
    { rows: 200, hz: 60, lineMode: "parallel", mode: "character" },
    { rows: 200, hz: 60, lineMode: "adaptive", mode: "auto" },
  ] as const)(
    "bounds empty space under glyph backpressure: $rows rows, $hz Hz, $lineMode/$mode",
    async ({ rows, hz, lineMode, mode }) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockStreamRows, render, flushMutations } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockStreamRows(80);
      const unit = "a".repeat(79) + "\n";
      let text = unit;
      const view = () => <Probe text={text} frame lineMode={lineMode} mode={mode} />;
      await render(view());
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const body = container.querySelector<HTMLElement>("[data-probe]")!;
      const node = body.firstChild;
      const pulse = vi.mocked(motionModule.createSmoothLinePulse);
      let previousVisible = unit.length;
      let maxBlank = 0;
      let stationaryFrames = 0;
      let restedHandoffs = 0;
      const step = async () => {
        const fromHeight = Number.parseFloat(frame.style.height);
        const pulseCount = pulse.mock.calls.length;
        now += 1000 / hz;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        await flushMutations();
        expect(body.firstChild).toBe(node);
        const hidden = [...(hiddenHighlight() ?? [])];
        expect(hidden.length).toBeLessThanOrEqual(1);
        if (hidden.length) expect(hidden[0]!.endOffset).toBe(text.length);
        const visible = text.length - hiddenUnits(fixture);
        expect(visible).toBeGreaterThanOrEqual(previousVisible);
        previousVisible = visible;
        const visibleBottom = Math.ceil(visible / unit.length) * 20;
        const height = Number.parseFloat(frame.style.height);
        const blank = height - visibleBottom;
        expect(height).toBeGreaterThanOrEqual(fromHeight - 1e-8);
        // 露字必须完整 fits；同时允许一个已预留行和一个正在打开的行，不能累计空白。
        expect(blank).toBeGreaterThanOrEqual(-0.001);
        maxBlank = Math.max(maxBlank, blank);
        const handoff = pulse.mock.calls.slice(pulseCount).find(([distance]) => distance >= 19.99);
        if (stationaryFrames >= 2 && handoff) {
          // 容量恢复时，已经停过数帧的空间不能复活过期的高速交接。
          expect(handoff[1]).toBe(0);
          restedHandoffs++;
        }
        stationaryFrames = Math.abs(height - fromHeight) < 1e-8 ? stationaryFrames + 1 : 0;
      };
      for (let row = 0; row < rows; row++) {
        text += unit;
        await render(view());
        await step();
      }
      expect(previousVisible).toBeGreaterThan(unit.length * rows * 0.4);
      expect(maxBlank).toBeLessThanOrEqual(40.001);
      // 79 glyph/帧超过 character 的 64 glyph 容量，字符排队是预期；停止输入后仍须恢复并排空。
      for (let tick = 0; tick < hz * 6 && frames.size; tick++) await step();
      expect(maxBlank).toBeLessThanOrEqual(40.001);
      expect(hiddenUnits(fixture)).toBe(0);
      expect(frames.size).toBe(0);
      if (rows === 300) expect(restedHandoffs).toBeGreaterThan(0);
    },
  );

  it.each([100, 1000])(
    "keeps a bounded FIFO backlog through %s rows at 60 rows per second",
    async (rows) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, mockStreamRows, render, flushMutations } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockStreamRows(40);
      const unit = "abcdefghijklmnop\n";
      let text = unit;
      const view = () => <Probe text={text} frame />;
      await render(view());
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const tail: number[] = [];
      let previousVisible = 0;
      const step = async () => {
        now += 1000 / 60;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        await flushMutations();
        const hidden = [...(hiddenHighlight() ?? [])];
        // 普通单 Text 的隐藏范围必须始终是后缀；空间先行不能变成提前露出下一行。
        expect(hidden.length).toBeLessThanOrEqual(1);
        const visible = text.length - hiddenUnits(fixture);
        expect(visible).toBeGreaterThanOrEqual(previousVisible);
        previousVisible = visible;
        if (hidden.length) expect(hidden[0]!.endOffset).toBe(text.length);
        const lastGlyph = text.slice(0, visible).search(/\S\s*$/u);
        if (lastGlyph >= 0)
          expect((Math.floor(lastGlyph / unit.length) + 1) * 20).toBeLessThanOrEqual(
            Number.parseFloat(frame.style.height) + 0.001,
          );
      };
      for (let row = 0; row < rows; row++) {
        text += unit;
        await render(view());
        await step();
        if (row >= rows / 2) tail.push(hiddenUnits(fixture));
      }
      const pending = hiddenUnits(fixture);
      const heightLag = (rows + 1) * 20 - Number.parseFloat(frame.style.height);
      const stoppedAt = now;
      let drainedAt = now;
      for (let drainFrame = 0; frames.size && drainFrame < 54; drainFrame++) {
        await step();
        if (hiddenUnits(fixture)) drainedAt = now;
      }
      // F1 修复的 50 单元 / 约 117ms 基线必须维持，不能为限制空白重新逐行停车。
      expect(pending).toBeLessThanOrEqual(51);
      expect(heightLag).toBeLessThanOrEqual(40.001);
      expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(34);
      expect(drainedAt - stoppedAt + 1000 / 60).toBeLessThanOrEqual(120);
      expect(hiddenUnits(fixture)).toBe(0);
      expect(frames.size).toBe(0);
    },
  );

  it.each([60, 240])("bounds idle replanning for stable parallel input at %s Hz", async (hz) => {
    await using fixture = await setup();
    const { container, frames, Probe, mockStreamRows, render, flushMutations } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockStreamRows(80);
    const style = vi.spyOn(window, "getComputedStyle");
    const pulse = vi.mocked(motionModule.createSmoothLinePulse);
    let text = "a".repeat(160);
    const view = () => <Probe text={text} frame initialBufferMs={80} lineMode="parallel" />;
    await render(view());
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    let idlePulses = 0;
    let previous = Number.parseFloat(frame.style.height);
    const heights: number[] = [];
    for (let tick = 1; tick <= hz * 2; tick++) {
      now = (tick * 1000) / hz;
      if (tick % (hz / 10) === 0) {
        text += "b".repeat(40);
        await render(view());
      }
      const before = pulse.mock.calls.length;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      await flushMutations();
      if (tick % (hz / 10) !== 0)
        idlePulses += pulse.mock.calls
          .slice(before)
          .filter(([distance]) => distance < 19.99).length;
      const height = Number.parseFloat(frame.style.height);
      expect(height).toBeGreaterThanOrEqual(previous - 1e-8);
      const visible = text.length - hiddenUnits(fixture);
      if (visible > 0) expect(Math.ceil(visible / 80) * 20).toBeLessThanOrEqual(height + 0.001);
      previous = height;
      heights.push(height);
    }
    expect(heights.at(-1)).toBeGreaterThan(200);
    expect(hiddenUnits(fixture)).toBeLessThanOrEqual(160);
    // 20 次 source 到达可以改变需求；两次到达之间不应每个 RAF 重建相同行。
    expect(idlePulses).toBeLessThanOrEqual(24);
    expect(style.mock.calls.length).toBeLessThanOrEqual(140);
    expect(pulse.mock.calls.length).toBeLessThanOrEqual(64);
    expect(vi.mocked(Range.prototype.getBoundingClientRect).mock.calls.length).toBeLessThanOrEqual(
      260,
    );
  });

  it("invalidates cached parallel lookahead after a same-length rewrite and reflow", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      mockWrappedRows,
      expectPaintedGlyphsToFit,
      render,
    } = fixture;
    let now = 0;
    let columns = 40;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(() => columns);
    const view = (text: string) => (
      <Probe
        text={text}
        frame
        lineMode="parallel"
        initialBufferMs={0}
        claimInitialText={() => true}
      />
    );
    await render(view("AAAA BBBB"));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      expectPaintedGlyphsToFit();
      return Number.parseFloat(frame.style.height);
    };
    for (now = 0; now < 80; now++) await step(now);
    const before = await step(79.999);
    const painted = await step(80);
    await render(view("AAAA\nBBBB"));
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(painted, 9);
    const after = await step(80.001);
    expect((after - painted) / 0.1).toBeCloseTo((painted - before) / 0.1, 3);
    // 长帧也应从最后的 paint 继续，而不是用缓存或过期时钟跳到终点。
    const stalled = await step(200);
    expect(stalled).toBeGreaterThan(after);
    expect(stalled - after).toBeLessThan(5);
    columns = 2;
    await act(() => window.dispatchEvent(new Event("resize")));
    for (let index = 1; index <= 120; index++) await step(200 + index * 16);
    expect(hiddenHighlight()).toBeUndefined();
    expect(frame.getBoundingClientRect().height).toBe(80);
    expect(frames.size).toBe(0);
  });

  it.each(["raw", "markdown"] as const)(
    "__feedback_hr__ reserves a standalone %s horizontal rule through its margins",
    async (format) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockHorizontalRuleFlow, horizontalRuleFrameState, render } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockHorizontalRuleFlow();
      const view = (present: boolean) =>
        format === "raw" ? (
          <Probe
            text=""
            sourceText={present ? "---" : ""}
            richText={present ? <hr /> : undefined}
            frame
            initialBufferMs={0}
          />
        ) : (
          <Probe
            text={present ? "---" : ""}
            sourceText={present ? "---" : ""}
            markdown
            frame
            initialBufferMs={0}
          />
        );
      await render(view(false));
      await render(view(true));

      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const rule = container.querySelector<HTMLElement>("hr")!;
      const initialHeight = Number.parseFloat(frame.style.height) || 0;
      const evidence = [horizontalRuleFrameState(now, frame, [rule])];
      for (let index = 0; index < 120 && frames.size > 0; index++) {
        now = ((index + 1) * 1000) / 60;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        evidence.push(horizontalRuleFrameState(now, frame, [rule]));
      }

      expect(initialHeight).toBe(0);
      expect(evidence.some((sample) => sample.height > 0 && sample.height < 33)).toBe(true);
      expect(frame.getBoundingClientRect().height).toBe(33);
    },
  );

  it("__feedback_hr__ plays the line entrance for a standalone raw rule", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (present: boolean) => (
      <Probe
        text=""
        sourceText={present ? "---" : ""}
        richText={present ? <hr /> : undefined}
        frame
        initialBufferMs={0}
      />
    );
    await render(view(false));
    await render(view(true));
    const rule = container.querySelector<HTMLElement>("hr")!;
    let entered = false;
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      entered ||= rule.hasAttribute("data-smooth-line-enter");
    }
    expect(entered).toBe(true);
  });

  it("__feedback_hr__ keeps the completed rule entrance until it finishes", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (present: boolean, streaming: boolean, complete: boolean) => (
      <Probe
        text=""
        sourceText={present ? "---" : ""}
        richText={present ? <hr /> : undefined}
        frame
        initialBufferMs={0}
        fadeDurationMs={0}
        yieldDurationMs={1}
        streaming={streaming}
        complete={complete}
      />
    );
    await render(view(false, true, false));
    await render(view(true, true, false));
    const rule = container.querySelector<HTMLElement>("hr")!;
    let sawEnter = false;
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (rule.hasAttribute("data-smooth-line-enter")) {
        sawEnter = true;
        break;
      }
    }
    expect(sawEnter).toBe(true);
    // The source ends while the entrance is still playing. Completion must not
    // dispose the row and strip the attribute before the CSS animation ends.
    await render(view(true, false, true));
    for (let index = 0; index < 5 && frames.size > 0; index++) {
      now += 1000 / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(rule.hasAttribute("data-smooth-line-enter")).toBe(true);
    for (let index = 0; index < 20 && frames.size > 0; index++) {
      now += 1000 / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(rule.hasAttribute("data-smooth-line-enter")).toBe(false);
  });

  it("__feedback_hr__ retires an entrance that expires while paused", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (present: boolean, paused: boolean) => (
      <Probe
        text={present ? "---" : ""}
        sourceText={present ? "---" : ""}
        richText={present ? <hr /> : undefined}
        frame
        initialBufferMs={0}
        fadeDurationMs={0}
        yieldDurationMs={1}
        streaming
        paused={paused}
      />
    );
    await render(view(false, false));
    await render(view(true, false));
    const rule = container.querySelector<HTMLElement>("hr")!;
    let seen = false;
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (rule.hasAttribute("data-smooth-line-enter")) {
        seen = true;
        break;
      }
    }
    expect(seen).toBe(true);
    await render(view(true, true));
    // The CSS animation keeps running while playback is paused. Resuming must
    // retire an entrance that already finished instead of leaving it for an
    // unrelated future frame.
    now += 200;
    await render(view(true, false));
    expect(rule.hasAttribute("data-smooth-line-enter")).toBe(false);
  });

  it("__feedback_hr__ retires an entrance when the row leaves the viewport", async () => {
    await using fixture = await setup();
    const { MockIntersectionObserver, container, frames, Probe, mockHorizontalRuleFlow, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (present: boolean) => (
      <Probe
        text=""
        sourceText={present ? "---" : ""}
        richText={present ? <hr /> : undefined}
        frame
        initialBufferMs={0}
        fadeDurationMs={0}
        yieldDurationMs={1}
        streaming
      />
    );
    await render(view(false));
    await render(view(true));
    const rule = container.querySelector<HTMLElement>("hr")!;
    let seen = false;
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (rule.hasAttribute("data-smooth-line-enter")) {
        seen = true;
        break;
      }
    }
    expect(seen).toBe(true);
    // Leaving the viewport cancels the frame that would have retired the
    // entrance, so the exit path itself must clear it.
    MockIntersectionObserver.instances.at(-1)!.trigger(false);
    expect(rule.hasAttribute("data-smooth-line-enter")).toBe(false);
    expect(rule.style.getPropertyValue("--t3-smooth-line-offset")).toBe("");
  });

  it("__feedback_hr__ keeps a reused element's new entrance until its own clock ends", async () => {
    using _timers = fakeTimers();
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (present: boolean, text: string, enabled: boolean) => (
      <Probe
        text={text}
        sourceText={text}
        richText={present ? <hr /> : undefined}
        frame
        initialBufferMs={0}
        fadeDurationMs={0}
        yieldDurationMs={1}
        streaming
        enabled={enabled}
      />
    );
    await render(view(false, "", true));
    await render(view(true, "---", true));
    const rule = container.querySelector<HTMLElement>("hr")!;
    let seen = false;
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (rule.hasAttribute("data-smooth-line-enter")) {
        seen = true;
        break;
      }
    }
    expect(seen).toBe(true);
    // Disabling the hook disposes the observer while the element stays mounted.
    // Its deferred clear must be owned by the element, not the disposed closure.
    await render(view(true, "---", false));
    expect(rule.hasAttribute("data-smooth-line-enter-token")).toBe(true);
    // A new observer does not replay already visible text, so model
    // the newer write directly. This pins the ownership contract: the old
    // deferred clear must not touch an entrance it no longer owns.
    rule.removeAttribute("data-smooth-line-enter-token");
    rule.setAttribute("data-smooth-line-enter", "up");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(rule.hasAttribute("data-smooth-line-enter")).toBe(true);
  });

  it("joins a compact rule to the following row instead of spending an action on one pixel", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, horizontalRuleFrameState, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow(0);
    const view = (appended: boolean) => (
      <Probe
        text={appended ? "before---tail" : "before"}
        frame
        initialBufferMs={0}
        richText={
          <>
            <p>before</p>
            {appended && (
              <>
                <hr />
                <p>tail</p>
              </>
            )}
          </>
        }
      />
    );
    await render(view(false));
    now = 80;
    await render(view(true));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const rule = container.querySelector<HTMLElement>("hr")!;
    const evidence = [];
    let independentEntrance = false;
    for (let step = 1; step <= 40; step++) {
      now = 80 + step * (1000 / 60);
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      evidence.push(horizontalRuleFrameState(now, frame, [rule]));
      independentEntrance ||= rule.hasAttribute("data-smooth-line-enter");
    }
    expect(independentEntrance).toBe(false);
    expect(evidence[5]!.height).toBeGreaterThan(25);
    expect(evidence.some((sample) => sample.height > 21 && sample.height < 41)).toBe(true);
    expect(Number.parseFloat(frame.style.height)).toBe(41);
  });

  it("__feedback_hr__ animates an appended raw rule after its preceding text", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, horizontalRuleFrameState, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (appended: boolean) => (
      <Probe
        text={appended ? "before---" : "before"}
        sourceText={appended ? "before---" : "before"}
        richText={
          appended ? (
            <>
              <p>before</p>
              <hr />
            </>
          ) : (
            <p>before</p>
          )
        }
        frame
        initialBufferMs={0}
      />
    );
    await render(view(false));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(frame.getBoundingClientRect().height).toBe(20);

    await render(view(true));
    const rule = container.querySelector<HTMLElement>("hr")!;
    const initialHeight = Number.parseFloat(frame.style.height) || 0;
    const evidence = [horizontalRuleFrameState(now, frame, [rule])];
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      evidence.push(horizontalRuleFrameState(now, frame, [rule]));
    }

    expect(initialHeight).toBe(20);
    expect(evidence.some((sample) => sample.height > 20 && sample.height < 53)).toBe(true);
    expect(frame.getBoundingClientRect().height).toBe(53);
  });

  it("__feedback_hr__ keeps a middle Markdown rule visible before its trailing text leaves the FIFO", async () => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      mockHorizontalRuleFlow,
      horizontalRuleFrameState,
      render,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const view = (text: string) => (
      <Probe text={text} markdown sourceText={text} frame initialBufferMs={0} />
    );
    await render(view("before"));
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    expect(frame.getBoundingClientRect().height).toBe(20);

    await render(view("before\n\n---\n\ntail"));
    const rule = container.querySelector<HTMLElement>("hr")!;
    const initialHeight = Number.parseFloat(frame.style.height) || 0;
    const initialState = horizontalRuleFrameState(now, frame, [rule]);
    const evidence = [initialState];
    for (let index = 0; index < 180 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      evidence.push(horizontalRuleFrameState(now, frame, [rule]));
    }

    expect(initialHeight).toBe(20);
    expect(initialState.rules[0]!.pending).toBe(true);
    expect(
      evidence.some(
        (sample) =>
          sample.height > 20 &&
          sample.height < 73 &&
          sample.rules[0]!.visible &&
          sample.hidden.includes("tail"),
      ),
    ).toBe(true);
    expect(frame.getBoundingClientRect().height).toBe(73);
    expect(hiddenHighlight()).toBeUndefined();
  });

  it("__feedback_hr__ admits adjacent rules in order through their collapsed margins", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockHorizontalRuleFlow, horizontalRuleFrameState, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    await render(<Probe text="" sourceText="" frame initialBufferMs={0} />);
    await render(
      <Probe
        text=""
        sourceText="------"
        richText={
          <>
            <hr />
            <hr />
          </>
        }
        frame
        initialBufferMs={0}
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const rules = [...container.querySelectorAll<HTMLElement>("hr")];
    const initialHeight = Number.parseFloat(frame.style.height) || 0;
    const evidence = [horizontalRuleFrameState(now, frame, rules)];
    for (let index = 0; index < 120 && frames.size > 0; index++) {
      now = ((index + 1) * 1000) / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      evidence.push(horizontalRuleFrameState(now, frame, rules));
    }

    expect(initialHeight).toBe(0);
    expect(evidence.some((sample) => sample.rules[0]!.visible && !sample.rules[1]!.visible)).toBe(
      true,
    );
    expect(frame.getBoundingClientRect().height).toBe(50);
  });
});

describe("Markdown decoration admission", () => {
  it.each(
    (["blockquote", "alert"] as const).flatMap((kind) =>
      (["pause", "append", "resize", "font"] as const).flatMap((refresh) =>
        [1, 3].map((separators) => ({ kind, refresh, separators })),
      ),
    ),
  )(
    "keeps $kind ink at a trailing separator after $refresh (separators=$separators)",
    async ({ kind, refresh, separators }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
      } = fixture;
      let now = 0;
      let columns = 4;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(() => columns, false, false, refresh === "font" ? 100 : undefined);
      const fonts = new EventTarget();
      const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
      Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
      const prefix = "ABCDEFGHIJKL";
      const tail = "MNOPQRSTUVWXYZ".repeat(8);
      const text = prefix + "\n".repeat(separators) + tail;
      const view = (value: string, paused = false) => (
        <Probe
          text={value}
          frame
          paused={paused}
          initialBufferMs={0}
          richText={
            kind === "blockquote" ? (
              <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                {value}
              </blockquote>
            ) : (
              <div role="note" style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                {value}
              </div>
            )
          }
        />
      );
      const hidden = () => [...(hiddenHighlight() ?? [])].map(rangeText).join("");
      try {
        await render(view(prefix));
        await render(view(text));
        const border = container.querySelector<HTMLElement>("blockquote, [role=note]")!;
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        for (let i = 0; i < 20 && hidden() !== tail; i++) {
          now += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          await act(() => callbacks.forEach((callback) => callback(now)));
        }
        expect(hidden()).toBe(tail);
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
        const fades = fadeRanges();
        if (refresh === "pause") await render(view(text, true));
        else if (refresh === "append") await render(view(text + "extra"));
        else {
          columns = 6;
          await act(() =>
            refresh === "font"
              ? fonts.dispatchEvent(new Event("loadingdone"))
              : window.dispatchEvent(new Event("resize")),
          );
        }
        expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(60);
        expect(border.getBoundingClientRect().height).toBeGreaterThanOrEqual(60);
        expect(hidden()).toBe(tail + (refresh === "append" ? "extra" : ""));
        expect(fadeRanges()).toEqual(fades);
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe(
          refresh === "pause" || refresh === "append" ? "60px" : "40px",
        );
        // A second generation at the same endpoint must retain the ink anchor too.
        await act(() => window.dispatchEvent(new Event("resize")));
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe(
          columns === 4 ? "60px" : "40px",
        );
        columns = 6;
        await act(() => window.dispatchEvent(new Event("resize")));
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        expect(hidden()).toBe(tail + (refresh === "append" ? "extra" : ""));
        if (refresh === "pause") expect(frames.size).toBe(0);
      } finally {
        await render(null);
        if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
        else Reflect.deleteProperty(document, "fonts");
      }
    },
  );

  it.each(
    (["blockquote", "alert"] as const).flatMap((kind) =>
      (["window resize", "resize observer", "font load"] as const).flatMap((trigger) =>
        [false, true].flatMap((paused) =>
          (["curve", "owner permit"] as const).flatMap((phase) =>
            [0, 2].map((separators) => ({ kind, trigger, paused, phase, separators })),
          ),
        ),
      ),
    ),
  )(
    "remaps committed $kind during candidate $phase after $trigger (paused=$paused, separators=$separators)",
    async ({ kind, trigger, paused, phase, separators }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
        flushMutations,
      } = fixture;
      let now = 0;
      let columns = 4;
      const clock = fixture.clock.mockImplementation(() => now);
      mockWrappedRows(() => columns, false, false, trigger === "font load" ? 100 : undefined);
      const resizes: ResizeObserverCallback[] = [];
      fixture.use(
        stubGlobal(
          "ResizeObserver",
          class {
            constructor(callback: ResizeObserverCallback) {
              resizes.push(callback);
            }
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
          },
        ),
      );
      const fonts = new EventTarget();
      const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
      Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
      const prefix = "ABCDEFGHIJKL";
      const tail = "MNOPQRSTUVWXYZ".repeat(8);
      const text = prefix + "\n".repeat(separators) + tail;
      const commit = vi.fn();
      const measure = vi.fn(() => 180);
      const candidate = { measure, commit };
      const permits: Array<{ callback: () => void; cancelled: boolean }> = [];
      const documentRoot = document.documentElement;
      const originalTheme = documentRoot.getAttribute("data-theme-id");
      let actualEdge = 101;
      let unregister = () => {};
      const view = (value: string, request?: SmoothTextCandidate, frozen = false) => (
        <main>
          <Probe
            text={value}
            sourceText={request ? text + "candidate" : value}
            frame
            paused={frozen}
            {...(request ? { candidate: request } : {})}
            initialBufferMs={0}
            richText={
              kind === "blockquote" ? (
                <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                  {value}
                </blockquote>
              ) : (
                <div role="note" style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                  {value}
                </div>
              )
            }
          />
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      const step = async () => {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      try {
        await render(view(prefix));
        container.querySelector<HTMLElement>(
          "[data-timeline-status-height]",
        )!.getBoundingClientRect = () => new DOMRect(0, actualEdge, 100, 20);
        await render(view(text));
        const heldTail = "\n".repeat(Math.max(0, separators - 1)) + tail;
        for (
          let i = 0;
          i < 20 && [...(hiddenHighlight() ?? [])].map(rangeText).join("") !== heldTail;
          i++
        )
          await step();
        const border = container.querySelector<HTMLElement>("blockquote, [role=note]")!;
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
        unregister = registerSmoothTextLayoutScope(container, {
          frame(callback) {
            const id = fixture.requestFrame(callback);
            return () => fixture.cancelFrame(id);
          },
          afterCommit(_element, callback) {
            const permit = { callback, cancelled: false };
            permits.push(permit);
            return () => {
              permit.cancelled = true;
            };
          },
        });
        await render(view(text, candidate));
        if (phase === "owner permit") {
          for (let i = 0; i < 80 && !permits.length; i++) await step();
          expect(permits).toHaveLength(1);
          expect(frame.style.height).toBe("180px");
        }
        if (paused) await render(view(text, candidate, true));
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(hidden).toBe(heldTail);
        const fades = fadeRanges();
        const height = frame.style.height;
        const pendingFrames = [...frames];
        const frameId = fixture.nextFrameId;
        const measured = measure.mock.calls.length;
        columns = 6;
        clock.mockClear();
        await act(() => {
          if (trigger === "resize observer")
            resizes[0]?.(resizeEntries(container), {} as ResizeObserver);
          else if (trigger === "font load") fonts.dispatchEvent(new Event("loadingdone"));
          else window.dispatchEvent(new Event("resize"));
        });
        expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(60);
        expect(border.getBoundingClientRect().height).toBeGreaterThanOrEqual(60);
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        expect(frame.style.height).toBe(height);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
        expect(fadeRanges()).toEqual(fades);
        expect(measure).toHaveBeenCalledTimes(measured);
        expect(commit).not.toHaveBeenCalled();
        expect(clock).not.toHaveBeenCalled();
        if (paused) {
          expect([...frames]).toEqual(pendingFrames);
          expect(fixture.nextFrameId).toBe(frameId);
          expect(frames.size).toBe(0);
        }
        // Actual committed boundaries still constrain decorations, even when the
        // candidate's local planned frame has already reached 180px.
        actualEdge = 30;
        await act(() => window.dispatchEvent(new Event("resize")));
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("30px");
        expect(frame.style.height).toBe(height);
        actualEdge = 101;
        await act(() => window.dispatchEvent(new Event("resize")));
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("30px");
        border.style.borderLeftColor = "blue";
        documentRoot.setAttribute("data-theme-id", "anchor-candidate-theme");
        await flushMutations();
        expect(border.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(0, 0, 255)");
        expect(clock).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(measure).toHaveBeenCalledTimes(measured);
        if (paused) {
          expect([...frames]).toEqual(pendingFrames);
          expect(fixture.nextFrameId).toBe(frameId);
        } else if (phase === "owner permit") {
          // A later owner callback cannot deliver an invalidated candidate.
          await act(() => permits[0]!.callback());
          expect(commit).not.toHaveBeenCalled();
          expect(measure).toHaveBeenCalledTimes(measured);
        }
        // A normal running candidate frame must remeasure before requesting a new permit.
        if (!paused) {
          await step();
          expect(measure).toHaveBeenCalledTimes(measured + 1);
          expect(commit).not.toHaveBeenCalled();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
          const drawn = Number.parseFloat(
            border.style.getPropertyValue("--t3-smooth-border-height"),
          );
          expect(drawn).toBeGreaterThan(30);
          expect(drawn).toBeLessThan(40);
          expect(border.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(0, 0, 255)");
        }
      } finally {
        await render(null);
        unregister();
        if (originalTheme === null) documentRoot.removeAttribute("data-theme-id");
        else documentRoot.setAttribute("data-theme-id", originalTheme);
        if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
        else Reflect.deleteProperty(document, "fonts");
      }
    },
  );

  it.each(
    (["blockquote", "alert"] as const).flatMap((kind) =>
      (["window resize", "resize observer", "font load"] as const).flatMap((trigger) =>
        [false, true].map((paused) => ({ kind, trigger, paused })),
      ),
    ),
  )(
    "remaps a retained $kind border after $trigger with unchanged visible text (paused=$paused)",
    async ({ kind, trigger, paused }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
      } = fixture;
      let now = 0;
      let columns = 4;
      let notifyResize: ResizeObserverCallback | undefined;
      const disconnect = vi.fn();
      fixture.use(
        stubGlobal(
          "ResizeObserver",
          class {
            constructor(callback: ResizeObserverCallback) {
              notifyResize = callback;
            }
            observe = vi.fn();
            disconnect = disconnect;
          },
        ),
      );
      const fonts = new EventTarget();
      const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
      Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(() => columns, false, false, trigger === "font load" ? 100 : undefined);
      const prefix = "ABCDEFGHIJKL";
      const text = prefix + "MNOPQRSTUVWXYZ".repeat(8);
      const view = (value: string, frozen = false) => (
        <Probe
          text={value}
          frame
          paused={frozen}
          initialBufferMs={0}
          richText={
            kind === "blockquote" ? (
              <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                {value}
              </blockquote>
            ) : (
              <div role="note" style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                {value}
              </div>
            )
          }
        />
      );
      const invalidate = () => {
        if (trigger === "resize observer")
          notifyResize?.(resizeEntries(container), {} as ResizeObserver);
        else if (trigger === "font load") fonts.dispatchEvent(new Event("loadingdone"));
        else window.dispatchEvent(new Event("resize"));
      };
      try {
        await render(view(prefix));
        await render(view(text));
        const border = container.querySelector<HTMLElement>("blockquote, [role=note]")!;
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
        await render(view(text + "tail", paused));
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        expect(hidden).toBe((text + "tail").slice(prefix.length));
        const fades = fadeRanges();
        const frameId = fixture.nextFrameId;
        columns = 6;
        await act(async () => invalidate());
        expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(60);
        expect(border.getBoundingClientRect().height).toBeGreaterThanOrEqual(60);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
        expect(fadeRanges()).toEqual(fades);
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        columns = 4;
        await act(async () => invalidate());
        // A wider physical endpoint starts from the already drawn line. A
        // following shrink still caps it synchronously, including while paused.
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        columns = 6;
        await act(async () => invalidate());
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        if (paused) {
          expect(frames.size).toBe(0);
          expect(fixture.nextFrameId).toBe(frameId);
          now = 1_000;
          await render(view(text + "tail"));
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
          expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        }
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(async () => callbacks.forEach((callback) => callback(now)));
        const visible =
          text.length + 4 - [...(hiddenHighlight() ?? [])].map(rangeText).join("").length;
        expect(
          Number.parseFloat(border.style.getPropertyValue("--t3-smooth-border-height")),
        ).toBeLessThanOrEqual(Math.ceil(visible / columns) * 20);
        await render(null);
        expect(border.hasAttribute("data-smooth-quote-border")).toBe(false);
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
        expect(frames.size).toBe(0);
        expect(disconnect).toHaveBeenCalledOnce();
      } finally {
        await render(null);
        if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
        else Reflect.deleteProperty(document, "fonts");
      }
    },
  );

  it.each(
    (["class", "style", "data-theme-id"] as const).flatMap((attribute) =>
      (["waiting for provider", "paused", "stream ended"] as const).map((state) => ({
        attribute,
        state,
      })),
    ),
  )(
    "refreshes active border paint for a pure root $attribute theme change without advancing playback ($state)",
    async ({ attribute, state }) => {
      await using fixture = await setup();
      const {
        container,
        frames,
        Probe,
        hiddenHighlight,
        rangeText,
        fadeRanges,
        mockWrappedRows,
        render,
        flushMutations,
      } = fixture;
      let now = 0;
      const clock = fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const documentRoot = document.documentElement;
      const original = documentRoot.getAttribute(attribute);
      const themeValue = (value: string) =>
        attribute === "style" ? `--smooth-theme: ${value};` : `smooth-theme-${value}`;
      const selector = (value: string) =>
        attribute === "class"
          ? `html.${themeValue(value)}`
          : `html[${attribute}="${themeValue(value)}"]`;
      const stylesheet = document.createElement("style");
      stylesheet.textContent = `${selector("one")} blockquote { border-left:2px solid rgb(90,140,180);color:rgb(1,2,3) } ${selector("two")} blockquote { border-left-color:rgb(220,130,40);color:rgb(1,2,3) }`;
      document.head.append(stylesheet);
      documentRoot.setAttribute(attribute, themeValue("one"));
      const prefix = "ABCD";
      const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const view = (value: string, settled = false) => (
        <Probe
          text={value}
          frame
          paused={settled && state === "paused"}
          streaming={!settled || state !== "stream ended"}
          initialBufferMs={0}
          richText={<blockquote style={{ lineHeight: "20px" }}>{value}</blockquote>}
        />
      );
      try {
        await render(view(prefix));
        await render(view(text));
        await render(view(text, true));
        const border = container.querySelector<HTMLElement>("blockquote")!;
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        const hidden = [...(hiddenHighlight() ?? [])].map(rangeText).join("");
        const height = frame.style.height;
        const painted = border.style.getPropertyValue("--t3-smooth-border-height");
        const fades = fadeRanges();
        const frameId = fixture.nextFrameId;
        expect(border.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(90, 140, 180)");
        const pendingFrames = [...frames];
        now = 1_000;
        clock.mockClear();
        documentRoot.setAttribute(attribute, themeValue("two"));
        await flushMutations();
        expect(getComputedStyle(border).borderLeftColor).toBe("rgb(220, 130, 40)");
        expect(getComputedStyle(border).color).toBe("rgb(1, 2, 3)");
        expect(border.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(220, 130, 40)");
        expect(frame.style.height).toBe(height);
        expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe(painted);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe(hidden);
        expect(fadeRanges()).toEqual(fades);
        expect([...frames]).toEqual(pendingFrames);
        expect(fixture.nextFrameId).toBe(frameId);
        expect(clock).not.toHaveBeenCalled();
      } finally {
        await render(null);
        stylesheet.remove();
        if (original === null) documentRoot.removeAttribute(attribute);
        else documentRoot.setAttribute(attribute, original);
      }
    },
  );

  it("hands a committed candidate to the existing HR object gate before a possible paint", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, hiddenHighlight, rangeText, mockHorizontalRuleFlow, render } =
      fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockHorizontalRuleFlow();
    const commit = vi.fn();
    const request = { measure: () => 20, commit };
    await render(<Probe text="before" frame richText={<p>before</p>} initialBufferMs={0} />);
    await render(
      <Probe
        text="before"
        sourceText="before---tail"
        frame
        candidate={request}
        richText={<p>before</p>}
        initialBufferMs={0}
      />,
    );
    for (let index = 1; index <= 30 && !commit.mock.calls.length; index++) {
      now = index * 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    }
    expect(commit).toHaveBeenCalledOnce();
    await render(
      <Probe
        text="before---tail"
        sourceText="before---tail"
        frame
        initialBufferMs={0}
        richText={
          <>
            <p>before</p>
            <hr />
            <p>tail</p>
          </>
        }
      />,
    );
    const rule = container.querySelector<HTMLElement>("hr")!;
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    // This is the post-layout-effect state before a browser could paint.
    expect(rule.hasAttribute("data-smooth-inline-pending")).toBe(true);
    expect(rule.style.getPropertyValue("--t3-smooth-surface-opacity")).toBe("0");
    expect(frame.style.height).toBe("20px");
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("tail");
    let sawRuleBeforeTail = false;
    for (let index = 1; index <= 120 && frames.size; index++) {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const pending = rule.hasAttribute("data-smooth-inline-pending");
      if (!pending) {
        expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(53);
        if ([...(hiddenHighlight() ?? [])].map(rangeText).join("").includes("tail"))
          sawRuleBeforeTail = true;
      }
    }
    expect(sawRuleBeforeTail).toBe(true);
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
  });

  it.each(["blockquote", "alert"] as const)(
    "bounds a multiline %s border while its text remains in FIFO",
    async (kind) => {
      await using fixture = await setup();
      const { container, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } = fixture;
      mockWrappedRows(4, true);
      await render(<Probe text="" frame initialBufferMs={0} />);
      const quote = (text: string) =>
        kind === "blockquote" ? (
          <blockquote style={{ borderLeft: "2px solid red" }}>{text}</blockquote>
        ) : (
          <div role="note" style={{ borderLeft: "2px solid red" }}>
            {text}
          </div>
        );
      await render(
        <Probe text="ABCDEFGHIJKL" frame initialBufferMs={0} richText={quote("ABCDEFGHIJKL")} />,
      );
      const border = container.querySelector<HTMLElement>("blockquote, [role=note]")!;
      expect(border.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
      expect(border.style.opacity).toBe("");
      expect(border.hasAttribute("data-smooth-atomic")).toBe(false);
      const selected = document.createRange();
      selected.selectNodeContents(border);
      expect(selected.toString()).toBe("ABCDEFGHIJKL");
      await flushFrames();
      expect(hiddenHighlight()).toBeUndefined();
      expect(border.hasAttribute("data-smooth-quote-border")).toBe(false);
    },
  );

  it("withholds every table divider without making a wrapped cell atomic", async () => {
    await using fixture = await setup();
    const { container, Probe, hiddenHighlight, mockWrappedRows, render, flushFrames } = fixture;
    mockWrappedRows(4, true);
    await render(<Probe text="" frame initialBufferMs={0} />);
    await render(
      <Probe
        text="ABCDEFGHIJKL"
        frame
        initialBufferMs={0}
        richText={
          <table>
            <thead>
              <tr>
                <th>ABCD</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>EFGHIJKL</td>
              </tr>
            </tbody>
          </table>
        }
      />,
    );
    const rows = [...container.querySelectorAll<HTMLElement>("tr")];
    expect(rows.every((row) => row.hasAttribute("data-smooth-row-divider"))).toBe(true);
    expect(rows.every((row) => !row.hasAttribute("data-smooth-atomic") && !row.style.opacity)).toBe(
      true,
    );
    await flushFrames();
    expect(hiddenHighlight()).toBeUndefined();
    expect(rows.every((row) => !row.hasAttribute("data-smooth-row-divider"))).toBe(true);
  });
});

describe("finite decoration drawing", () => {
  const hiddenUnits = (fixture: Awaited<ReturnType<typeof setup>>) =>
    [...(fixture.hiddenHighlight() ?? [])].map(fixture.rangeText).join("").length;
  type ReceiptOptions = {
    candidate?: SmoothTextCandidate;
    eof?: boolean;
    paused?: boolean;
    enabled?: boolean;
  };
  async function receiptFixture(
    fixture: Awaited<ReturnType<typeof setup>>,
    kind: "quote" | "table",
    fading?: "text" | "surface",
  ) {
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      fadeRanges,
      mockWrappedRows,
      render,
    } = fixture;
    const naturalHeight = kind === "quote" ? 40 : 100;
    let now = 0;
    let edge = 21;
    let holdActual = false;
    const actual: layoutModule.SmoothTextLayoutPublication[] = [];
    const held: Array<() => void> = [];
    const receipts: Array<{
      allow: boolean;
      cancelled: boolean;
      callback: (publication?: layoutModule.SmoothTextLayoutPublication) => void;
    }> = [];
    const after = originals.layoutModule.afterSmoothTextLayoutCommit;
    vi.mocked(layoutModule.afterSmoothTextLayoutCommit).mockImplementation(
      (element, callback, allow = false) => {
        const receipt = { allow, cancelled: false, callback };
        receipts.push(receipt);
        const cancel = after(
          element,
          (publication) => {
            if (allow && publication) {
              actual.push(publication);
              if (holdActual) {
                held.push(() => callback(publication));
                return;
              }
            }
            callback(publication);
          },
          allow,
        );
        return cancel
          ? () => {
              receipt.cancelled = true;
              cancel();
            }
          : null;
      },
    );
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(4, true);
    const box = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches("blockquote, tr")) {
        const index = [...this.parentElement!.children].indexOf(this);
        return new DOMRect(0, index * 20, 40, kind === "table" && index === 1 ? 80 : 20);
      }
      if (kind === "table" && this.matches("[data-probe]") && this.textContent!.length > 4) {
        // The final row's bottom padding leaves a real divider-only tail after glyph fades.
        return new DOMRect(0, 0, 40, naturalHeight);
      }
      if (this.dataset.receiptRow !== undefined) {
        const frame = this.querySelector<HTMLElement>("[data-smooth-text-frame]");
        return new DOMRect(0, 0, 40, Number.parseFloat(frame?.style.height ?? "") || 40);
      }
      return box.call(this);
    });
    const done = vi.fn();
    const settled = vi.fn();
    const view = (text: string, options: ReceiptOptions = {}) => (
      <main>
        <div data-receipt-row="" data-timeline-row-id="body">
          <Probe
            text={text}
            frame
            initialBufferMs={0}
            fadeDurationMs={fading ? 500 : kind === "quote" ? 0 : 200}
            yieldDurationMs={200}
            streaming={!options.eof}
            complete={options.eof ?? false}
            paused={options.paused ?? false}
            enabled={options.enabled ?? true}
            onPlaybackComplete={done}
            onSettled={settled}
            {...(options.candidate ? { candidate: options.candidate } : {})}
            richText={
              kind === "quote" ? (
                text.match(/.{1,4}/gu)?.map((line) => (
                  <blockquote
                    key={line}
                    style={{ borderLeft: "2px solid red", lineHeight: "20px" }}
                  >
                    {fading === "surface" && line === "BBBB" ? (
                      <button data-smooth-atomic="">{line}</button>
                    ) : (
                      line
                    )}
                  </blockquote>
                ))
              ) : (
                <table>
                  <tbody>
                    {text.match(/.{1,4}/gu)?.map((line) => (
                      <tr key={line}>
                        <td
                          style={{
                            borderBottom: "1px solid red",
                            paddingBottom: line === "BBBB" ? "60px" : undefined,
                          }}
                        >
                          {line}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          />
        </div>
        <div data-receipt-row="" data-timeline-row-id="next" />
        <div data-timeline-status-height="fixture:thinking" />
      </main>
    );
    await render(view("AAAA"));
    const main = container.querySelector("main")!;
    const holder = main.querySelector<HTMLElement>("[data-timeline-row-id=body]")!;
    const next = main.querySelector<HTMLElement>("[data-timeline-row-id=next]")!;
    main.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect = () =>
      new DOMRect(0, edge, 100, 20);
    const sizes = new Map([
      ["body", 20],
      ["next", 40],
    ]);
    const publications: Array<() => void> = [];
    const owners: ReturnType<typeof createTimelineLayout>[] = [];
    const owner = () => {
      const layout = createTimelineLayout(main, {
        list: () => ({
          getState: () => ({ sizes }),
          setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
        }),
        control: () => null,
        requestCommit: (generation) => publications.push(layout.capture(generation)),
        synchronous: (write) => write(),
      });
      owners.push(layout);
      return layout;
    };
    const layout = owner();
    const step = async (complete = false) => {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (complete) await act(() => publications.at(-1)?.());
    };
    await render(view("AAAABBBB"));
    for (let index = 0; index < 40; index++) await step();
    expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BBBB");
    edge = 161;
    await act(() => publications.at(-1)?.());
    const probe = holder.querySelector<HTMLElement>("[data-probe]")!;
    const frame = probe.parentElement!;
    const old = probe.querySelectorAll<HTMLElement>("blockquote, tr")[1]!;
    const attribute = kind === "quote" ? "data-smooth-quote-border" : "data-smooth-row-divider";
    const progress = () => {
      if (!old.hasAttribute(attribute)) return 1;
      return kind === "quote"
        ? Number.parseFloat(old.style.getPropertyValue("--t3-smooth-border-height")) / 20
        : Number(
            (old.firstElementChild as HTMLElement).style
              .getPropertyValue("--t3-smooth-divider-color")
              .match(/ ([\d.]+)%, transparent\)$/u)?.[1] ?? 0,
          ) / 100;
    };
    if (kind === "table") {
      for (let index = 0; index < 120 && (hiddenUnits(fixture) || fadeRanges().length); index++)
        await step(true);
      // A normal structure commit opens the table's final padding; remove C
      // before the lifecycle scenario so no candidate can keep the observer alive.
      const commit = vi.fn();
      await render(view("AAAABBBB", { candidate: { measure: () => naturalHeight, commit } }));
      for (let index = 0; index < 120 && !commit.mock.calls.length; index++) await step(true);
      expect(commit).toHaveBeenCalledOnce();
      await render(view("AAAABBBB"));
    }
    const tailPending = () =>
      fading ? frame.hasAttribute("data-smooth-text-clipping") : fadeRanges().length > 0;
    for (
      let index = 0;
      index < 120 &&
      (hiddenUnits(fixture) ||
        tailPending() ||
        frame.style.height !== `${naturalHeight}px` ||
        !(progress() > 0));
      index++
    )
      await step(true);
    expect(hiddenUnits(fixture)).toBe(0);
    if (!fading) expect(fadeRanges()).toHaveLength(0);
    expect(frame.style.height).toBe(`${naturalHeight}px`);
    expect(progress()).toBeGreaterThan(0);
    expect(progress()).toBeLessThan(1);
    expect(actual.at(-1)!.containerHeight).toBeGreaterThanOrEqual(naturalHeight);
    return {
      main,
      holder,
      next,
      probe,
      frame,
      old,
      attribute,
      progress,
      actual,
      held,
      receipts,
      layout,
      owner,
      naturalHeight,
      done,
      settled,
      step,
      publications,
      get now() {
        return now;
      },
      hold() {
        holdActual = true;
      },
      async release() {
        holdActual = false;
        await act(() => held.splice(0).forEach((callback) => callback()));
      },
      async render(options: ReceiptOptions = {}, text = "AAAABBBB") {
        await render(view(text, options));
      },
      async close() {
        holder.append(frame);
        if (!main.contains(holder)) main.append(holder);
        await render(null);
        for (const layout of owners) layout.dispose();
        expect(frames.size).toBe(0);
      },
    };
  }

  it.each(
    (["text", "surface"] as const).flatMap((fading) =>
      (["container", "state", "scope"] as const).map((change) => ({ fading, change })),
    ),
  )(
    "gated idle P2-1 finishes $fading fade during $change reconfirmation without cosmetic actual",
    async ({ fading, change }) => {
      await using fixture = await setup();
      const { MockIntersectionObserver, frames, fadeRanges } = fixture;
      const f = await receiptFixture(fixture, "quote", fading);
      try {
        const observer = MockIntersectionObserver.instances.at(-1)!;
        const observerCount = MockIntersectionObserver.instances.length;
        const surface = f.old.querySelector<HTMLElement>("button");
        const unfinished = () =>
          fading === "text"
            ? fadeRanges().length > 0
            : surface!.hasAttribute("data-smooth-surface");
        expect(unfinished(), "the real fade must outlive the FIFO and space curve").toBe(true);
        expect(f.frame.hasAttribute("data-smooth-text-clipping")).toBe(false);
        if (surface) {
          expect(fadeRanges()).toHaveLength(0);
          expect(
            Number(surface.style.getPropertyValue("--t3-smooth-surface-opacity")),
          ).toBeGreaterThan(0);
          expect(
            Number(surface.style.getPropertyValue("--t3-smooth-surface-opacity")),
          ).toBeLessThan(1);
        }
        const oldView = f.actual.at(-1)!;
        f.hold();
        if (change === "container") f.next.append(f.frame);
        else if (change === "state") {
          f.holder.dataset.timelineRowId = "recycled";
          await act(f.layout.captureList(f.layout.itemSizeChanged("recycled", 40)));
          f.holder.dataset.timelineRowId = "body";
        } else {
          f.layout.dispose();
          f.owner();
        }
        expect(oldView.container.contains(f.probe) && oldView.containerHeight > 0).toBe(false);
        await f.render({ eof: true });
        expect(hiddenUnits(fixture)).toBe(0);
        expect(unfinished()).toBe(true);
        expect(f.done).not.toHaveBeenCalled();
        expect(f.settled).toHaveBeenCalledOnce();
        expect(f.progress()).toBe(0);
        for (let index = 0; index < 60 && frames.size; index++) await f.step(true);
        expect(f.held).toHaveLength(1);
        expect(unfinished(), "a cosmetic receipt cannot stop an already admitted fade").toBe(false);
        expect(f.done).toHaveBeenCalledOnce();
        expect(f.settled).toHaveBeenCalledOnce();
        expect(f.old.hasAttribute(f.attribute)).toBe(true);
        expect(f.progress()).toBe(0);
        expect(observer.disconnect).not.toHaveBeenCalled();
        expect(frames.size).toBe(0);
        const requests = f.receipts.length;
        for (let index = 0; index < 8; index++) await f.step();
        expect(frames.size).toBe(0);
        expect(f.receipts).toHaveLength(requests);
        await f.release();
        let intermediate = false;
        for (let index = 0; index < 90 && frames.size; index++) {
          await f.step(true);
          intermediate ||= f.progress() > 0 && f.progress() < 1;
        }
        expect(intermediate).toBe(true);
        expect(f.old.hasAttribute(f.attribute)).toBe(false);
        expect(observer.disconnect).toHaveBeenCalledOnce();
        expect(MockIntersectionObserver.instances).toHaveLength(observerCount);
        expect(f.receipts.every((receipt) => receipt.cancelled)).toBe(true);
        expect(f.done).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["quote", "table"] as const)(
    "receipt lifecycle P2-A keeps cosmetic %s owner actual alive through EOF",
    async (kind) => {
      await using fixture = await setup();
      const { MockIntersectionObserver, container, frames } = fixture;
      const f = await receiptFixture(fixture, kind);
      try {
        const observer = MockIntersectionObserver.instances.at(-1)!;
        const observerCount = MockIntersectionObserver.instances.length;
        const oldView = f.actual.at(-1)!;
        container.append(f.holder);
        await f.render();
        expect(oldView.containerHeight).toBe(-Infinity);
        expect(f.progress()).toBeGreaterThan(0);
        expect(f.progress()).toBeLessThan(1);
        f.main.append(f.holder);
        f.layout.dispose();
        f.owner();
        const requests = f.receipts.length;
        await f.render({ eof: true });
        expect(
          f.receipts.slice(requests).some((receipt) => receipt.allow && !receipt.cancelled),
        ).toBe(true);
        expect(f.old.hasAttribute(f.attribute)).toBe(true);
        expect(f.progress()).toBe(0);
        expect(f.done).toHaveBeenCalledOnce();
        expect(f.settled).toHaveBeenCalledOnce();
        expect(observer.disconnect).not.toHaveBeenCalled();
        expect(MockIntersectionObserver.instances).toHaveLength(observerCount);
        for (let index = 0; index < 8; index++) await f.step();
        expect(f.progress()).toBe(0);
        expect(frames.size).toBe(0);
        await act(() => f.publications.at(-1)!());
        let intermediate = false;
        for (let index = 0; index < 90 && frames.size; index++) {
          await f.step(true);
          intermediate ||= f.progress() > 0 && f.progress() < 1;
        }
        expect(intermediate).toBe(true);
        expect(f.actual.at(-1)).not.toBe(oldView);
        expect(f.old.hasAttribute(f.attribute)).toBe(false);
        expect(observer.disconnect).toHaveBeenCalledOnce();
        expect(f.receipts.every((receipt) => receipt.cancelled)).toBe(true);
        expect(f.done).toHaveBeenCalledOnce();
        expect(hiddenUnits(fixture)).toBe(0);
        expect(frames.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it.each(
    (["quote", "table"] as const).flatMap((kind) =>
      (["container", "state"] as const).flatMap((change) =>
        (["C", "cosmetic"] as const).map((work) => ({ kind, change, work })),
      ),
    ),
  )(
    "receipt lifecycle P2-C reacquires $kind actual after same-scope $change with $work",
    async ({ kind, change, work }) => {
      await using fixture = await setup();
      const { frames } = fixture;
      const f = await receiptFixture(fixture, kind);
      try {
        const oldView = f.actual.at(-1)!;
        if (change === "container") f.next.append(f.frame);
        else {
          f.holder.dataset.timelineRowId = "recycled";
          const revision = f.layout.itemSizeChanged("recycled", 40);
          await act(f.layout.captureList(revision));
          f.holder.dataset.timelineRowId = "body";
          expect(oldView.containerHeight).toBe(-Infinity);
        }
        expect(oldView.container.contains(f.probe) && oldView.containerHeight > 0).toBe(false);
        const commit = vi.fn();
        f.hold();
        if (work === "C")
          await f.render({ candidate: { measure: () => f.naturalHeight + 20, commit } });
        else await f.step();
        for (
          let index = 0;
          index < 60 && (work === "C" ? !commit.mock.calls.length : frames.size > 0);
          index++
        )
          await f.step(true);
        if (work === "C") {
          expect(commit).toHaveBeenCalledOnce();
          // Apply C's ordinary structure commit without adding any glyphs.
          await f.render();
        }
        expect(f.old.hasAttribute(f.attribute)).toBe(true);
        expect(f.progress()).toBe(0);
        expect(f.held.length).toBeGreaterThan(0);
        expect(f.actual.at(-1)).not.toBe(oldView);
        expect(hiddenUnits(fixture)).toBe(0);
        await f.release();
        let intermediate = false;
        for (let index = 0; index < 90 && frames.size; index++) {
          await f.step(true);
          intermediate ||= f.progress() > 0 && f.progress() < 1;
        }
        expect(intermediate).toBe(true);
        expect(f.old.hasAttribute(f.attribute)).toBe(false);
        expect(frames.size).toBe(0);
        expect(commit).toHaveBeenCalledTimes(work === "C" ? 1 : 0);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["quote", "table"] as const)(
    "keeps a valid smaller %s actual view without requesting decoration receipts",
    async (kind) => {
      await using fixture = await setup();
      const { frames } = fixture;
      const f = await receiptFixture(fixture, kind);
      try {
        const requests = f.receipts.length;
        const view = f.actual.at(-1)!;
        const revision = f.layout.itemSizeChanged("body", 21);
        await act(f.layout.captureList(revision));
        for (let index = 0; index < 30; index++) await f.step();
        expect(view.containerHeight).toBe(21);
        expect(f.old.hasAttribute(f.attribute)).toBe(true);
        expect(f.progress()).toBeLessThanOrEqual(kind === "quote" ? 1 / 20 : 0);
        expect(f.receipts).toHaveLength(requests);
        expect(frames.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it.each(
    (["quote", "table"] as const).flatMap((kind) =>
      (["refresh", "tick"] as const).map((finish) => ({ kind, finish })),
    ),
  )(
    "gated idle P2-2 preserves $kind finite actual through EOF $finish and recovers on its live growth",
    async ({ kind, finish }) => {
      await using fixture = await setup();
      const { MockIntersectionObserver, frames, renders, fadeRanges } = fixture;
      const f = await receiptFixture(fixture, kind);
      try {
        const observer = MockIntersectionObserver.instances.at(-1)!;
        const observerCount = MockIntersectionObserver.instances.length;
        const requests = f.receipts.length;
        const view = f.actual.at(-1)!;
        if (finish === "tick") {
          // EOF starts while the original decoration phase still owns a frame.
          await f.render({ eof: true });
          expect(f.progress()).toBeGreaterThan(0);
          expect(f.progress()).toBeLessThan(1);
          expect(observer.disconnect).not.toHaveBeenCalled();
          expect(frames.size).toBeGreaterThan(0);
        }
        const revision = f.layout.itemSizeChanged("body", 21);
        await act(f.layout.captureList(revision));
        expect(view.containerHeight).toBe(21);
        for (let index = 0; index < 30 && frames.size; index++) await f.step();
        expect(hiddenUnits(fixture)).toBe(0);
        expect(fadeRanges()).toHaveLength(0);
        expect(frames.size).toBe(0);
        if (finish === "refresh") {
          expect(f.old.hasAttribute(f.attribute)).toBe(true);
          await f.render({ eof: true });
        }
        expect(f.old.hasAttribute(f.attribute), "EOF must retain an insufficient actual gate").toBe(
          true,
        );
        expect(f.progress()).toBeLessThanOrEqual(kind === "quote" ? 1 / 20 : 0);
        expect(f.receipts).toHaveLength(requests);
        expect(f.done).toHaveBeenCalledOnce();
        expect(f.settled).toHaveBeenCalledOnce();
        expect(observer.disconnect).not.toHaveBeenCalled();
        for (let index = 0; index < 8; index++) await f.step();
        expect(frames.size).toBe(0);
        expect(view.containerHeight).toBe(21);
        // Same-size actual commits may retry once, but cannot self-schedule or
        // turn a finite small view into a permission-receipt polling loop.
        for (let repeat = 0; repeat < 3; repeat++) {
          await act(f.layout.captureList(f.layout.itemSizeChanged("body", 21)));
          for (let index = 0; index < 8 && frames.size; index++) await f.step();
          expect(frames.size).toBe(0);
          expect(f.old.hasAttribute(f.attribute)).toBe(true);
          expect(f.progress()).toBeLessThanOrEqual(kind === "quote" ? 1 / 20 : 0);
          expect(f.receipts).toHaveLength(requests);
        }
        const rendersBeforeGrowth = renders.get("message");
        const growth = f.layout.itemSizeChanged("body", f.naturalHeight);
        await act(f.layout.captureList(growth));
        expect(f.actual.at(-1)).toBe(view);
        let intermediate = false;
        for (let index = 0; index < 90 && frames.size; index++) {
          await f.step();
          intermediate ||= f.progress() > 0 && f.progress() < 1;
        }
        expect(intermediate, "live actual growth must resume the original finite draw").toBe(true);
        expect(f.old.hasAttribute(f.attribute)).toBe(false);
        expect(observer.disconnect).toHaveBeenCalledOnce();
        expect(MockIntersectionObserver.instances).toHaveLength(observerCount);
        expect(f.receipts).toHaveLength(requests);
        expect(f.receipts.every((receipt) => receipt.cancelled)).toBe(true);
        expect(renders.get("message")).toBe(rendersBeforeGrowth);
        expect(f.done).toHaveBeenCalledOnce();
        expect(f.settled).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
        const historicalRead = vi.fn(f.probe.getBoundingClientRect.bind(f.probe));
        f.probe.getBoundingClientRect = historicalRead;
        await act(f.layout.captureList(f.layout.itemSizeChanged("next", 60)));
        for (let index = 0; index < 8 && frames.size; index++) await f.step();
        expect(historicalRead).not.toHaveBeenCalled();
        expect(frames.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["quote", "table"] as const)(
    "gated idle recovery resumes %s on actual growth without source or refresh",
    async (kind) => {
      await using fixture = await setup();
      const { MockIntersectionObserver, frames, renders } = fixture;
      const f = await receiptFixture(fixture, kind);
      try {
        const observer = MockIntersectionObserver.instances.at(-1)!;
        const requests = f.receipts.length;
        const view = f.actual.at(-1)!;
        await act(f.layout.captureList(f.layout.itemSizeChanged("body", 21)));
        for (let index = 0; index < 30 && frames.size; index++) await f.step();
        expect(f.old.hasAttribute(f.attribute)).toBe(true);
        expect(f.progress()).toBeLessThanOrEqual(kind === "quote" ? 1 / 20 : 0);
        expect(frames.size).toBe(0);
        const rendersBeforeGrowth = renders.get("message");
        await act(f.layout.captureList(f.layout.itemSizeChanged("body", f.naturalHeight)));
        expect(view.containerHeight).toBe(f.naturalHeight);
        let intermediate = false;
        for (let index = 0; index < 90 && frames.size; index++) {
          await f.step();
          intermediate ||= f.progress() > 0 && f.progress() < 1;
        }
        expect(f.old.hasAttribute(f.attribute), "commit must wake a retained idle gate").toBe(
          false,
        );
        expect(intermediate).toBe(true);
        expect(renders.get("message")).toBe(rendersBeforeGrowth);
        expect(f.receipts).toHaveLength(requests);
        expect(frames.size).toBe(0);
        await f.render({ eof: true });
        expect(observer.disconnect).toHaveBeenCalledOnce();
        expect(f.done).toHaveBeenCalledOnce();
        expect(f.settled).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );

  it("gated idle keeps text fade clocks paused while cosmetic actual is withheld", async () => {
    await using fixture = await setup();
    const { highlights, frames, fadeRanges } = fixture;
    const f = await receiptFixture(fixture, "quote", "text");
    try {
      expect(fadeRanges().length).toBeGreaterThan(0);
      f.hold();
      f.next.append(f.frame);
      await f.render({ eof: true, paused: true });
      const frozen = [...highlights.entries()]
        .filter(([name]) => name.startsWith("t3-smooth-fade-"))
        .flatMap(([name, ranges]) => [...ranges].map((range) => [name, range]));
      for (let index = 0; index < 80; index++) await f.step(true);
      expect(frames.size).toBe(0);
      expect(
        [...highlights.entries()]
          .filter(([name]) => name.startsWith("t3-smooth-fade-"))
          .flatMap(([name, ranges]) => [...ranges].map((range) => [name, range])),
      ).toEqual(frozen);
      expect(f.done).not.toHaveBeenCalled();
      await f.render({ eof: true });
      expect(fadeRanges().length).toBeGreaterThan(0);
      expect(f.done).not.toHaveBeenCalled();
      for (let index = 0; index < 60 && frames.size; index++) await f.step(true);
      expect(fadeRanges()).toHaveLength(0);
      expect(f.done).toHaveBeenCalledOnce();
      expect(f.progress()).toBe(0);
      expect(frames.size).toBe(0);
      await f.release();
      for (let index = 0; index < 90 && frames.size; index++) await f.step(true);
      expect(f.old.hasAttribute(f.attribute)).toBe(false);
      expect(frames.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each(["quote", "table"] as const)(
    "gated idle keeps %s stopped during pause and resumes after actual growth",
    async (kind) => {
      await using fixture = await setup();
      const { frames } = fixture;
      const f = await receiptFixture(fixture, kind);
      try {
        await act(f.layout.captureList(f.layout.itemSizeChanged("body", 21)));
        for (let index = 0; index < 30 && frames.size; index++) await f.step();
        await f.render({ eof: true, paused: true });
        const frozen = f.progress();
        await act(f.layout.captureList(f.layout.itemSizeChanged("body", f.naturalHeight)));
        for (let index = 0; index < 80; index++) await f.step();
        expect(f.old.hasAttribute(f.attribute)).toBe(true);
        expect(f.progress()).toBe(frozen);
        expect(frames.size).toBe(0);
        await f.render({ eof: true });
        expect(f.progress()).toBe(frozen);
        for (let index = 0; index < 90 && frames.size; index++) await f.step();
        expect(f.old.hasAttribute(f.attribute)).toBe(false);
        expect(f.done).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    { kind: "quote", reason: "remove" },
    { kind: "table", reason: "rewrite" },
    { kind: "quote", reason: "unmount" },
    { kind: "table", reason: "disable" },
    { kind: "quote", reason: "reduced motion" },
    { kind: "table", reason: "forced colors" },
  ] as const)("gated idle releases $kind resources on $reason", async ({ kind, reason }) => {
    await using fixture = await setup();
    const { MockIntersectionObserver, frames, getMediaQuery, render, flushMutations } = fixture;
    const f = await receiptFixture(fixture, kind);
    try {
      const observer = MockIntersectionObserver.instances.at(-1)!;
      const requests = f.receipts.length;
      await act(f.layout.captureList(f.layout.itemSizeChanged("body", 21)));
      for (let index = 0; index < 30 && frames.size; index++) await f.step();
      await f.render({ eof: true });
      expect(f.old.hasAttribute(f.attribute)).toBe(true);
      expect(frames.size).toBe(0);
      if (reason === "remove") {
        f.old.remove();
        await flushMutations();
      } else if (reason === "rewrite") {
        // Source ownership is unchanged; a real DOM rewrite removes the old
        // decoration entries through the existing mutation/index path.
        f.probe.replaceChildren(document.createTextNode("AAAA"));
        await flushMutations();
      } else if (reason === "unmount") await render(null);
      else if (reason === "disable") await f.render({ eof: true, enabled: false });
      else
        await act(() =>
          getMediaQuery(
            reason === "reduced motion"
              ? "(prefers-reduced-motion: reduce)"
              : "(forced-colors: active)",
          ).setMatches(true),
        );
      for (let index = 0; index < 90 && frames.size; index++) await f.step(true);
      expect(f.old.hasAttribute(f.attribute)).toBe(false);
      expect(f.old.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
      if (kind === "table")
        expect(
          (f.old.firstElementChild as HTMLElement).style.getPropertyValue(
            "--t3-smooth-divider-color",
          ),
        ).toBe("");
      expect(observer.disconnect).toHaveBeenCalledOnce();
      if (reason !== "remove" && reason !== "rewrite") expect(f.receipts).toHaveLength(requests);
      expect(f.receipts.every((receipt) => receipt.cancelled)).toBe(true);
      expect(frames.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("does not let a decoration reconfirmation complete C's own strict receipt", async () => {
    await using fixture = await setup();
    const { frames } = fixture;
    const f = await receiptFixture(fixture, "quote");
    try {
      f.next.append(f.frame);
      const commit = vi.fn();
      await f.render({ candidate: { measure: () => 60, commit } });
      await f.step();
      const decorationActual = f.publications.at(-1)!;
      for (let index = 0; index < 50 && f.frame.style.height !== "60px"; index++) await f.step();
      expect(f.frame.style.height).toBe("60px");
      expect(commit).not.toHaveBeenCalled();
      await act(decorationActual);
      for (let index = 0; index < 5 && frames.size; index++) await f.step();
      expect(f.actual.at(-1)!.container).toBe(f.next);
      expect(f.progress()).toBeGreaterThan(0);
      expect(commit).not.toHaveBeenCalled();
      await act(() => f.publications.at(-1)!());
      expect(commit).toHaveBeenCalledOnce();
      await f.render();
      for (let index = 0; index < 90 && frames.size; index++) await f.step(true);
      expect(f.old.hasAttribute(f.attribute)).toBe(false);
      expect(frames.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("requires a new glyph admission after a decoration-only actual reconfirmation", async () => {
    await using fixture = await setup();
    const { frames, hiddenHighlight, rangeText } = fixture;
    const f = await receiptFixture(fixture, "quote");
    try {
      f.hold();
      f.next.append(f.frame);
      await f.step();
      await f.step(true);
      expect(f.held).toHaveLength(1);
      expect(f.progress()).toBe(0);
      await f.release();
      const receipts = f.receipts.length;
      await f.render({}, "AAAABBBBCCCC");
      for (let index = 0; index < 40; index++) await f.step();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CCCC");
      const future = f.probe.querySelectorAll<HTMLElement>("blockquote")[2]!;
      expect(future.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
      expect(
        f.receipts.slice(receipts).some((receipt) => receipt.allow && !receipt.cancelled),
      ).toBe(true);
      await act(() => f.publications.at(-1)!());
      for (let index = 0; index < 120 && frames.size; index++) await f.step(true);
      expect(hiddenUnits(fixture)).toBe(0);
      expect(future.hasAttribute(f.attribute)).toBe(false);
      expect(frames.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("lets glyph admission and playback finish while a redundant cosmetic actual callback is withheld", async () => {
    await using fixture = await setup();
    const { frames, hiddenHighlight, rangeText } = fixture;
    const f = await receiptFixture(fixture, "quote");
    try {
      f.hold();
      f.next.append(f.frame);
      await f.step();
      await f.step(true);
      expect(f.held).toHaveLength(1);
      const cosmetic = f.receipts.at(-1)!;
      await f.render({ eof: true }, "AAAABBBBCCCC");
      for (let index = 0; index < 60 && f.held.length < 2; index++) await f.step(true);
      expect(f.held).toHaveLength(2);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CCCC");
      // Deliver the glyph's own real actual; the cosmetic callback stays delayed.
      await act(() => f.held[1]!());
      for (let index = 0; index < 30 && !f.done.mock.calls.length; index++) await f.step(true);
      expect(hiddenUnits(fixture)).toBe(0);
      expect(f.done).toHaveBeenCalledOnce();
      expect(cosmetic.cancelled).toBe(true);
      const actual = f.actual.at(-1)!;
      await act(() => cosmetic.callback(actual));
      expect(f.done).toHaveBeenCalledOnce();
      for (let index = 0; index < 90 && frames.size; index++) await f.step(true);
      expect(f.old.hasAttribute(f.attribute)).toBe(false);
      expect(frames.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("transfers a decoration actual callback that first discovers a new owner without cancelling its replacement", async () => {
    await using fixture = await setup();
    const { frames } = fixture;
    const f = await receiptFixture(fixture, "quote");
    try {
      f.hold();
      f.next.append(f.frame);
      await f.step();
      await f.step(true);
      expect(f.held).toHaveLength(1);
      const stale = f.receipts.at(-1)!;
      const oldView = f.actual.at(-1)!;
      f.layout.dispose();
      f.owner();
      await f.release();
      expect(f.progress()).toBe(0);
      expect(stale.cancelled).toBe(true);
      const replacement = f.receipts.at(-1)!;
      expect(replacement).not.toBe(stale);
      await act(() => stale.callback(oldView));
      expect(replacement.cancelled).toBe(false);
      for (let index = 0; index < 5 && frames.size; index++) await f.step();
      expect(f.progress()).toBe(0);
      expect(frames.size).toBe(0);
      await act(() => f.publications.at(-1)!());
      for (let index = 0; index < 90 && frames.size; index++) await f.step(true);
      expect(f.old.hasAttribute(f.attribute)).toBe(false);
      expect(replacement.cancelled).toBe(true);
      expect(frames.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each(["managed", "standalone", "dispose"] as const)(
    "receipt lifecycle P2-B hands off the last standalone C microtask to %s",
    async (finish) => {
      await using fixture = await setup();
      const { container, frames, Probe, fadeRanges, mockWrappedRows, render, flushFrames } =
        fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const commit = vi.fn();
      const candidate = { measure: () => 60, commit };
      const view = (request?: SmoothTextCandidate) => (
        <main>
          <div data-timeline-row-id="body">
            <Probe
              text="AAAA"
              frame
              initialBufferMs={0}
              fadeDurationMs={0}
              {...(request ? { candidate: request } : {})}
            />
          </div>
        </main>
      );
      await render(view());
      await flushFrames();
      expect(frames.size).toBe(0);
      const queued: VoidFunction[] = [];
      const strict: Array<() => void> = [];
      let standaloneDelivery = false;
      const after = originals.layoutModule.afterSmoothTextLayoutCommit;
      vi.mocked(layoutModule.afterSmoothTextLayoutCommit).mockImplementation(
        (element, callback, allow) => {
          const cancel = after(element, callback, allow);
          if (!allow) {
            strict.push(callback);
            standaloneDelivery = cancel === null;
          }
          return cancel;
        },
      );
      const queue = globalThis.queueMicrotask;
      const microtask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
        // Hold the actual standalone delivery; unrelated layout notifications retain their normal queue.
        if (standaloneDelivery) {
          standaloneDelivery = false;
          queued.push(callback);
        } else queue(callback);
      });
      const step = async () => {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await render(view(candidate));
      for (let index = 0; index < 120 && queued.length === 0; index++) await step();
      expect(queued).toHaveLength(1);
      expect(frames.size).toBe(0);
      expect(fadeRanges()).toHaveLength(0);
      expect(hiddenUnits(fixture)).toBe(0);
      const publications: Array<() => void> = [];
      const sizes = new Map([["body", 20]]);
      const main = container.querySelector("main")!;
      const layout = createTimelineLayout(main, {
        list: () => ({
          getState: () => ({ sizes }),
          setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
        }),
        control: () => null,
        requestCommit: (generation) => publications.push(layout.capture(generation)),
        synchronous: (write) => write(),
      });
      try {
        // No render/source/geometry/tick occurs between registration and this old continuation.
        await act(() => queued[0]!());
        expect(commit).not.toHaveBeenCalled();
        expect(frames.size).toBeGreaterThan(0);
        for (let index = 0; index < 5 && frames.size; index++) await step();
        expect(publications.length).toBeGreaterThan(0);
        expect(commit).not.toHaveBeenCalled();
        await act(() => queued[0]!());
        expect(commit).not.toHaveBeenCalled();
        if (finish === "dispose") {
          await render(null);
          for (const complete of publications) await act(complete);
        } else if (finish === "standalone") {
          layout.dispose();
          await act(() => queued[0]!());
          // The captured current strict callback discovers the next handoff too.
          await act(() => strict.at(-1)!());
          for (let index = 0; index < 10 && frames.size; index++) await step();
          for (const callback of queued.slice(1)) await act(callback);
          expect(commit).toHaveBeenCalledOnce();
        } else {
          await act(() => publications.at(-1)!());
          expect(commit).toHaveBeenCalledOnce();
        }
        await act(() => queued[0]!());
        await act(() => strict[1]?.());
        expect(commit).toHaveBeenCalledTimes(finish === "dispose" ? 0 : 1);
        for (let index = 0; index < 10 && frames.size; index++) await step();
        expect(frames.size).toBe(0);
      } finally {
        microtask.mockRestore();
        layout.dispose();
      }
    },
  );

  it.each(
    (["quote", "table"] as const).flatMap((kind) =>
      (
        [
          "next admission",
          "pending candidate",
          "EOF candidate replacement",
          "actual shrink",
          "rowId",
          "state replacement",
          "container moved",
          "container disconnected",
          "element reparented",
          "owner disposed",
          "natural CSS shrink",
          "width",
          "font",
          "standalone move",
          "standalone dispose",
          "standalone limited move",
          "standalone limited dispose",
          "standalone pending C move",
          "standalone pending C dispose",
          "standalone new owner move",
          "standalone new owner dispose",
        ] as const
      ).map((change) => ({ kind, change })),
    ),
  )("retains only valid actual-admitted $kind drawing during $change", async ({ kind, change }) => {
    await using fixture = await setup();
    const {
      MockIntersectionObserver,
      container,
      frames,
      Probe,
      hiddenHighlight,
      rangeText,
      mockWrappedRows,
      render,
    } = fixture;
    let now = 0;
    let edge = 21;
    let cssCap = Infinity;
    let geometryShift = 0;
    let columns = 4;
    let received: layoutModule.SmoothTextLayoutPublication | undefined;
    const lateCallbacks: Array<(publication?: layoutModule.SmoothTextLayoutPublication) => void> =
      [];
    const after = originals.layoutModule.afterSmoothTextLayoutCommit;
    vi.mocked(layoutModule.afterSmoothTextLayoutCommit).mockImplementation(
      (element, callback, allow) => {
        lateCallbacks.push(callback);
        return after(
          element,
          (publication) => {
            if (allow && publication) received = publication;
            callback(publication);
          },
          allow,
        );
      },
    );
    const fonts = new EventTarget();
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(() => columns, true);
    const box = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches("blockquote, tr")) {
        const index = [...this.parentElement!.children].indexOf(this);
        return new DOMRect(0, index * 20 + geometryShift, columns * 10, 20);
      }
      if (this.dataset.publicationContainer !== undefined) {
        const frame = this.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        return new DOMRect(
          0,
          0,
          columns * 10,
          Math.min(cssCap, Number.parseFloat(frame.style.height) || 20),
        );
      }
      const rect = box.call(this);
      return new DOMRect(0, rect.top, 40, rect.height);
    });
    const view = (
      text: string,
      candidate?: SmoothTextCandidate,
      complete = false,
      sourceText = text,
    ) => (
      <main>
        <div
          data-publication-container=""
          data-timeline-row-id={change === "natural CSS shrink" ? undefined : "body"}
        >
          <Probe
            text={text}
            sourceText={sourceText}
            frame
            initialBufferMs={0}
            yieldDurationMs={200}
            fadeDurationMs={200}
            {...(candidate ? { candidate } : {})}
            streaming={!complete}
            complete={complete}
            richText={
              kind === "quote" ? (
                text.match(/.{1,4}/gu)?.map((line) => (
                  <blockquote
                    key={line}
                    style={{ borderLeft: "2px solid red", lineHeight: "20px" }}
                  >
                    {line}
                  </blockquote>
                ))
              ) : (
                <table>
                  <tbody>
                    {text.match(/.{1,4}/gu)?.map((line) => (
                      <tr key={line}>
                        <td style={{ borderBottom: "1px solid red" }}>{line}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          />
        </div>
        <div data-timeline-status-height="fixture:thinking" />
      </main>
    );
    await render(view("AAAA"));
    container.querySelector<HTMLElement>("[data-timeline-status-height]")!.getBoundingClientRect =
      () => new DOMRect(0, edge, 100, 20);
    const main = container.querySelector("main")!;
    const holder = container.querySelector<HTMLElement>("[data-publication-container]")!;
    const sizes = new Map([["body", 20]]);
    const publications: Array<{ generation: number; complete(): void }> = [];
    const layout = createTimelineLayout(main, {
      footer: () => (change === "natural CSS shrink" ? holder : null),
      list: () => ({
        getState: () => ({ sizes }),
        setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
      }),
      control: () => null,
      requestCommit: (generation) =>
        publications.push({ generation, complete: layout.capture(generation) }),
      synchronous: (write) => write(),
    });
    const step = async (complete = false) => {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (complete) await act(() => publications.at(-1)?.complete());
    };
    const attribute = kind === "quote" ? "data-smooth-quote-border" : "data-smooth-row-divider";
    const progress = (owner: HTMLElement) => {
      if (!owner.hasAttribute(attribute)) return 1;
      const color = (owner.firstElementChild as HTMLElement)?.style.getPropertyValue(
        "--t3-smooth-divider-color",
      );
      return kind === "quote"
        ? Number.parseFloat(owner.style.getPropertyValue("--t3-smooth-border-height")) / 20
        : color === ""
          ? 0
          : Number(color?.match(/ ([\d.]+)%, transparent\)$/u)?.[1]) / 100;
    };
    try {
      await render(view("AAAABBBB"));
      for (let index = 0; index < 40; index++) await step();
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BBBB");
      edge = 41;
      await act(() => publications.at(-1)?.complete());
      const old = container.querySelectorAll<HTMLElement>("blockquote, tr")[1]!;
      for (let index = 0; index < 120 && (hiddenUnits(fixture) || !(progress(old) > 0)); index++)
        await step(true);
      expect(hiddenUnits(fixture)).toBe(0);
      const before = progress(old);
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThan(1);
      expect(received!.containerHeight).toBeGreaterThanOrEqual(40);
      const startedBy = now;
      if (change.startsWith("standalone")) {
        const probe = holder.querySelector<HTMLElement>("[data-probe]")!;
        const frame = probe.parentElement!;
        const observer = MockIntersectionObserver.instances.at(-1)!;
        const observerCount = MockIntersectionObserver.instances.length;
        const oldPublication = received!;
        const oldCallbacks = [...lateCallbacks];
        const commit = vi.fn();
        const request = {
          measure: () => (change.includes("new owner") || change.includes("limited") ? 40 : 60),
          commit,
        };
        if (change.includes("pending C")) {
          await render(view("AAAABBBB", request));
          for (let index = 0; index < 50 && lateCallbacks.length === oldCallbacks.length; index++)
            await step();
          expect(lateCallbacks.length).toBeGreaterThan(oldCallbacks.length);
          expect(commit).not.toHaveBeenCalled();
          oldCallbacks.push(...lateCallbacks.slice(oldCallbacks.length));
        }
        if (change.endsWith("dispose")) layout.dispose();
        else container.append(holder);
        expect(oldPublication.containerHeight).toBe(-Infinity);
        expect(probe.isConnected).toBe(true);
        expect(probe.parentElement).toBe(frame);
        edge = change.includes("limited") ? 1 : 81;
        await render(view("AAAABBBB", request, false, "AAAABBBBCCCC"));
        for (const callback of oldCallbacks) await act(() => callback(oldPublication));
        if (change.includes("limited")) {
          await render(view("AAAABBBBCCCC"));
          for (let index = 0; index < 6; index++) await step();
          expect(commit).toHaveBeenCalledOnce();
          expect(progress(old)).toBeLessThanOrEqual(kind === "quote" ? 1 / 20 : 0);
          // A candidate fitting the current frame does not authorize new glyphs
          // through the current Thinking/clip edge.
          for (let index = 0; index < 24; index++) await step();
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CCCC");
          edge = 81;
          await act(() => window.dispatchEvent(new Event("resize")));
        }
        let restored = progress(old) > 0 && progress(old) < 1;
        let nativeAt: number | undefined;
        let previous = before;
        for (let index = 0; index < 90 && !commit.mock.calls.length; index++) {
          await step();
          restored ||= progress(old) > 0 && progress(old) < 1;
          if (change === "standalone move" || change === "standalone dispose") {
            expect(progress(old)).toBeGreaterThanOrEqual(previous);
            previous = progress(old);
            if (!old.hasAttribute(attribute)) nativeAt ??= now;
            if (index < 6) expect(commit).not.toHaveBeenCalled();
          }
        }
        expect(commit).toHaveBeenCalledOnce();
        await render(view("AAAABBBBCCCC"));
        if (change.includes("new owner")) {
          if (!main.contains(holder)) main.append(holder);
          layout.dispose();
          const nextPublications: Array<() => void> = [];
          const nextLayout = createTimelineLayout(main, {
            list: () => ({
              getState: () => ({ sizes }),
              setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
            }),
            control: () => null,
            requestCommit: (generation) => nextPublications.push(nextLayout.capture(generation)),
            synchronous: (write) => write(),
          });
          try {
            const nextCommit = vi.fn();
            await render(view("AAAABBBBCCCC", { measure: () => 80, commit: nextCommit }));
            for (const callback of oldCallbacks) await act(() => callback(oldPublication));
            for (let index = 0; index < 50; index++) await step();
            expect(nextCommit).not.toHaveBeenCalled();
            expect(progress(old)).toBe(0);
            expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CCCC");
            expect(nextPublications.length).toBeGreaterThan(0);
            await act(() => nextPublications.at(-1)!());
            expect(received).not.toBe(oldPublication);
            expect(received!.containerHeight).toBeGreaterThanOrEqual(80);
            for (let index = 0; index < 50 && !nextCommit.mock.calls.length; index++) {
              await step();
              await act(() => nextPublications.at(-1)?.());
            }
            expect(nextCommit).toHaveBeenCalledOnce();
            await render(view("AAAABBBBCCCCDDDD"));
            for (let index = 0; index < 120 && frames.size; index++) {
              await step();
              await act(() => nextPublications.at(-1)?.());
            }
          } finally {
            nextLayout.dispose();
          }
        } else {
          for (let index = 0; index < 120 && frames.size; index++) {
            await step();
            restored ||= progress(old) > 0 && progress(old) < 1;
            if (!old.hasAttribute(attribute)) nativeAt ??= now;
          }
          if (!change.includes("pending C")) expect(restored).toBe(true);
          if (change === "standalone move" || change === "standalone dispose")
            // This bound starts at the first observed intermediate, not private phase.startedAt.
            expect(nativeAt).toBeLessThanOrEqual(startedBy + 200 + 16);
        }
        expect(probe).toBe(holder.querySelector("[data-probe]"));
        expect(probe.parentElement).toBe(frame);
        expect(MockIntersectionObserver.instances.length).toBe(observerCount);
        expect(observer.disconnect).not.toHaveBeenCalled();
        expect(hiddenUnits(fixture)).toBe(0);
        expect(old.hasAttribute(attribute)).toBe(false);
        expect(frames.size).toBe(0);
        return;
      }
      // ChatMarkdown clears glyph admission when a new source candidate starts.
      // Keep its real Timeline receipt pending while the old decoration is active.
      const commit = vi.fn();
      if (change === "pending candidate" || change === "EOF candidate replacement") {
        const replacement = vi.fn();
        const request = { measure: () => 60, commit };
        await render(view("AAAABBBB", request));
        let previous = before;
        let nativeAt: number | undefined;
        for (let index = 0; index < 24; index++) {
          if (index === 4 && change === "EOF candidate replacement")
            await render(view("AAAABBBB", { measure: () => 80, commit: replacement }, true));
          await step();
          expect(progress(old)).toBeGreaterThanOrEqual(previous);
          previous = progress(old);
          if (!old.hasAttribute(attribute)) nativeAt ??= now;
        }
        expect(nativeAt).toBeLessThanOrEqual(startedBy + 200 + 16);
        expect(commit).not.toHaveBeenCalled();
        expect(replacement).not.toHaveBeenCalled();
        expect(hiddenUnits(fixture)).toBe(0);
        return;
      }
      await render(view("AAAABBBB", { measure: () => 40, commit }));
      await render(view("AAAABBBBCCCC"));
      if (change !== "next admission") {
        if (change === "actual shrink") {
          const revision = layout.itemSizeChanged("body", 21);
          const complete = layout.captureList(revision);
          // Eager/planned sizes alone do not change the retained actual view.
          expect(progress(old)).toBeGreaterThanOrEqual(before);
          await act(complete);
          expect(received!.containerHeight).toBe(21);
        } else if (change === "rowId" || change === "state replacement") {
          holder.dataset.timelineRowId = "recycled";
          if (change === "state replacement") {
            const revision = layout.itemSizeChanged("recycled", 40);
            await act(layout.captureList(revision));
            holder.dataset.timelineRowId = "body";
          }
        } else if (change === "container moved") {
          container.append(holder);
          edge = 20;
          expect(received!.containerHeight).toBe(-Infinity);
        } else if (change === "container disconnected") {
          holder.remove();
          expect(received!.containerHeight).toBe(-Infinity);
          expect(old.isConnected).toBe(false);
          await step();
          expect(progress(old)).toBe(before);
          return;
        } else if (change === "element reparented") main.append(holder.firstElementChild!);
        else if (change === "owner disposed") {
          layout.dispose();
          edge = 20;
          expect(received!.containerHeight).toBe(-Infinity);
        } else if (change === "natural CSS shrink") cssCap = 21;
        else {
          geometryShift = 20;
          if (change === "width") columns = 2;
          else old.style.lineHeight = "30px";
        }
        await act(() =>
          change === "font"
            ? fonts.dispatchEvent(new Event("loadingdone"))
            : window.dispatchEvent(new Event("resize")),
        );
        await step();
        const height = Number.parseFloat(old.style.getPropertyValue("--t3-smooth-border-height"));
        expect(old.hasAttribute(attribute)).toBe(true);
        if (kind === "quote")
          expect(height).toBeLessThanOrEqual(
            change === "actual shrink" || change === "natural CSS shrink" ? 1 : 0,
          );
        else expect(progress(old)).toBe(0);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CCCC");
        return;
      }
      let previous = before;
      let nativeAt: number | undefined;
      for (let index = 0; index < 20; index++) {
        await step();
        expect(progress(old)).toBeGreaterThanOrEqual(previous);
        previous = progress(old);
        if (!old.hasAttribute(attribute)) nativeAt ??= now;
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("CCCC");
        const future = container.querySelectorAll<HTMLElement>("blockquote, tr")[2]!;
        expect(future.hasAttribute(attribute)).toBe(true);
        expect(progress(future)).toBe(0);
      }
      expect(nativeAt).toBeLessThanOrEqual(startedBy + 200 + 16);
      expect(old.hasAttribute(attribute)).toBe(false);
      expect(commit).toHaveBeenCalledOnce();
      expect(publications.length).toBeGreaterThan(1);
    } finally {
      await render(null);
      layout.dispose();
      holder.remove();
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
      expect(frames.size).toBe(0);
    }
  });

  it.each(["quote", "table"] as const)(
    "keeps %s cosmetic drawing finite without delaying text completion, and freezes it on pause",
    async (kind) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4, true);
      const done = vi.fn();
      const view = (text: string, paused = false, complete = false) => (
        <Probe
          text={text}
          frame
          paused={paused}
          initialBufferMs={0}
          streaming={!complete}
          complete={complete}
          onPlaybackComplete={done}
          fadeDurationMs={kind === "quote" ? 0 : 200}
          yieldDurationMs={200}
          richText={
            kind === "quote" ? (
              <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                {text}
              </blockquote>
            ) : (
              <table>
                <tbody>
                  <tr>
                    <td style={{ borderBottom: "1px solid red" }}>{text}</td>
                  </tr>
                </tbody>
              </table>
            )
          }
        />
      );
      const step = async (at = now + 16) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await render(view(""));
      await render(view("ABCD"));
      const owner = container.querySelector<HTMLElement>(kind === "quote" ? "blockquote" : "tr")!;
      const cell = owner.firstElementChild as HTMLElement;
      const attribute = kind === "quote" ? "data-smooth-quote-border" : "data-smooth-row-divider";
      const progress = () =>
        kind === "quote"
          ? Number.parseFloat(owner.style.getPropertyValue("--t3-smooth-border-height")) / 20
          : Number(
              cell.style
                .getPropertyValue("--t3-smooth-divider-color")
                .match(/ ([\d.]+)%, transparent\)$/u)?.[1],
            ) / 100;
      for (let index = 0; index < 120 && (hiddenUnits(fixture) || !(progress() > 0)); index++)
        await step();
      expect(hiddenUnits(fixture)).toBe(0);
      expect(progress()).toBeGreaterThan(0);
      expect(progress()).toBeLessThan(1);
      await render(view("ABCD", true));
      const frozen = progress();
      expect(frames.size).toBe(0);
      now += 1_000;
      await render(view("ABCD", true));
      expect(progress()).toBe(frozen);
      await render(view("ABCD"));
      expect(progress()).toBe(frozen);
      // Repeating the same resumed presentation must not shift the clock again.
      await render(view("ABCD"));
      expect(progress()).toBe(frozen);
      await step();
      expect(progress()).toBeGreaterThan(frozen);
      expect(progress()).toBeLessThan(1);
      await render(view("ABCD", false, true));
      for (let index = 0; index < 60 && !done.mock.calls.length; index++) await step();
      expect(done).toHaveBeenCalledOnce();
      if (kind === "quote") {
        expect(owner.hasAttribute(attribute)).toBe(true);
        expect(progress()).toBeGreaterThan(0);
        expect(progress()).toBeLessThan(1);
        expect(frames.size).toBeGreaterThan(0);
      }
      for (let index = 0; index < 60 && frames.size; index++) await step();
      expect(owner.hasAttribute(attribute)).toBe(false);
      expect(owner.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
      if (kind === "table")
        expect(cell.style.getPropertyValue("--t3-smooth-divider-color")).toBe("");
      expect(owner.style.opacity).toBe("");
      expect(done).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
    },
  );

  it.each(["quote", "table"] as const)(
    "does not draw the next %s line from planned space or another owner's publication",
    async (kind) => {
      await using fixture = await setup();
      const { container, frames, Probe, hiddenHighlight, rangeText, mockWrappedRows, render } =
        fixture;
      let now = 0;
      let edge = 21;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4, true);
      const box = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.tagName === "TR") {
          const index = [...this.parentElement!.children].indexOf(this);
          return new DOMRect(0, index * 20, 40, 20);
        }
        return box.call(this);
      });
      const view = (text: string) => (
        <main>
          <div data-timeline-row-id="body">
            <Probe
              text={text}
              frame
              initialBufferMs={0}
              yieldDurationMs={200}
              fadeDurationMs={200}
              richText={
                kind === "quote" ? (
                  <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
                    {text}
                  </blockquote>
                ) : (
                  <table>
                    <tbody>
                      <tr>
                        <td>ABCD</td>
                      </tr>
                      {text.length > 4 && (
                        <tr>
                          <td>EFGH</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )
              }
            />
          </div>
          <div data-timeline-status-height="fixture:thinking" />
        </main>
      );
      await render(view("ABCD"));
      const boundary = container.querySelector<HTMLElement>("[data-timeline-status-height]")!;
      boundary.getBoundingClientRect = () => new DOMRect(0, edge, 100, 20);
      const main = container.querySelector("main")!;
      const sizes = new Map([["body", 20]]);
      let requestedGeneration = 0;
      const layout = createTimelineLayout(main, {
        list: () => ({
          getState: () => ({ sizes }),
          setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
        }),
        control: () => null,
        requestCommit: (generation) => {
          requestedGeneration = generation;
        },
        synchronous: (write) => write(),
      });
      const step = async () => {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      const withheld = () => {
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("EFGH");
        if (kind === "quote")
          expect(
            Number.parseFloat(
              container
                .querySelector("blockquote")!
                .style.getPropertyValue("--t3-smooth-border-height"),
            ),
          ).toBeLessThanOrEqual(20);
        else {
          const row = container.querySelectorAll("tr")[1]!;
          expect(row.hasAttribute("data-smooth-row-divider")).toBe(true);
          const color = (row.firstElementChild as HTMLElement).style.getPropertyValue(
            "--t3-smooth-divider-color",
          );
          expect(color === "" || color.endsWith(" 0%, transparent)")).toBe(true);
        }
      };
      try {
        await render(view("ABCDEFGH"));
        for (let index = 0; index < 40; index++) await step();
        withheld();
        expect(requestedGeneration).toBeGreaterThan(0);
        edge = 41;
        await act(() => publishSmoothTextLayoutCommit(container.querySelector("main")!));
        for (let index = 0; index < 4; index++) await step();
        withheld();
        await act(() => layout.complete(requestedGeneration));
        let intermediate = false;
        for (let index = 0; index < 100 && frames.size; index++) {
          await step();
          if (kind === "quote") {
            const value = Number.parseFloat(
              container
                .querySelector("blockquote")!
                .style.getPropertyValue("--t3-smooth-border-height"),
            );
            if (value > 20 && value < 40) intermediate = true;
          } else {
            const value = (
              container.querySelectorAll("td")[1] as HTMLElement
            ).style.getPropertyValue("--t3-smooth-divider-color");
            const percent = Number(value.match(/ ([\d.]+)%, transparent\)$/u)?.[1]);
            if (percent > 0 && percent < 100) intermediate = true;
          }
        }
        expect(hiddenUnits(fixture)).toBe(0);
        expect(intermediate).toBe(true);
        expect(frames.size).toBe(0);
      } finally {
        layout.dispose();
      }
    },
  );

  it.each(["reduced motion", "forced colors", "forceShow", "unmount"] as const)(
    "cleans finite drawing on %s without leaving a frame",
    async (reason) => {
      await using fixture = await setup();
      const { container, frames, getMediaQuery, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const view = (text: string, forceShow = false) => (
        <Probe
          text={text}
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          yieldDurationMs={200}
          {...(forceShow
            ? {
                resume: {
                  key: "decoration-force",
                  baselineText: text,
                  mountText: text,
                  synchronized: true,
                  forceShow: true,
                },
              }
            : {})}
          richText={
            <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
              {text}
            </blockquote>
          }
        />
      );
      await render(view(""));
      await render(view("ABCD"));
      const owner = container.querySelector("blockquote")!;
      for (let index = 0; index < 100 && hiddenUnits(fixture); index++) {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      }
      expect(hiddenUnits(fixture)).toBe(0);
      expect(owner.hasAttribute("data-smooth-quote-border")).toBe(true);
      expect(frames.size).toBeGreaterThan(0);
      if (reason === "unmount") await render(null);
      else if (reason === "forceShow") await render(view("ABCD", true));
      else
        await act(() =>
          getMediaQuery(
            reason === "reduced motion"
              ? "(prefers-reduced-motion: reduce)"
              : "(forced-colors: active)",
          ).setMatches(true),
        );
      expect(owner.hasAttribute("data-smooth-quote-border")).toBe(false);
      expect(owner.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
      expect(frames.size).toBe(0);
    },
  );
});

describe("table EOF geometry continuity", () => {
  it.each([
    ...[200, 500, 0].flatMap((eofFade) =>
      [0, 35].map((shift) => ({ eofFade, shift, retreat: false })),
    ),
    { eofFade: 500, shift: 35, retreat: true },
  ])(
    "keeps an admitted divider on its current origin through an EOF candidate (fade=$eofFade, shift=$shift, actual retreat=$retreat)",
    async ({ eofFade, shift, retreat }) => {
      await using fixture = await setup();
      const { container, frames, renders, Probe, hiddenHighlight, rangeText, render } = fixture;
      let now = 0;
      let rootTop = 0;
      let boundaryEdge = 21;
      let actualHeight = 120;
      let received: layoutModule.SmoothTextLayoutPublication | undefined;
      fixture.clock.mockImplementation(() => now);
      const after = originals.layoutModule.afterSmoothTextLayoutCommit;
      vi.mocked(layoutModule.afterSmoothTextLayoutCommit).mockImplementation(
        (element, callback, allow) =>
          after(
            element,
            (publication) => {
              if (publication) received = publication;
              callback(publication);
            },
            allow,
          ),
      );
      // Every measured box belongs to the current tree. EOF can move the
      // whole followed root without changing any row's local paint bounds.
      const geometry = () => {
        const boxes = new Map<Element, DOMRect>();
        const glyphs = new Map<Text, DOMRect>();
        const probe = container.querySelector<HTMLElement>('[data-probe="table-eof"]');
        if (!probe) return { boxes, glyphs };
        const rows = [...probe.querySelectorAll("tr")];
        const naturalHeight = rows.length * 20;
        const box = (top: number, height: number) => new DOMRect(0, rootTop + top, 100, height);
        boxes.set(probe, box(0, naturalHeight));
        boxes.set(probe.querySelector("table")!, box(0, naturalHeight));
        boxes.set(probe.querySelector("tbody")!, box(0, naturalHeight));
        rows.forEach((row, index) => {
          boxes.set(row, box(index * 20, 20));
          const cell = row.firstElementChild!;
          boxes.set(cell, box(index * 20, 20));
          glyphs.set(cell.firstChild as Text, box(index * 20 + 4, 12));
        });
        const frame = probe.parentElement!;
        const explicit = Number.parseFloat(frame.style.height);
        boxes.set(frame, box(0, Number.isFinite(explicit) ? explicit : naturalHeight));
        boxes.set(container.querySelector("[data-eof-actual]")!, box(0, actualHeight));
        const main = container.querySelector("main")!;
        boxes.set(main, box(0, 140));
        const status = container.querySelector("[data-eof-status]");
        if (status) boxes.set(status, box(boundaryEdge, 20));
        return { boxes, glyphs };
      };
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const rect = geometry().boxes.get(this);
        if (rect) return rect;
        if (!this.isConnected) return new DOMRect();
        throw new Error(`Unmapped current EOF element: ${this.tagName}`);
      });
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
        const rects = [...geometry().glyphs].flatMap(([node, rect]) =>
          this.intersectsNode(node) &&
          (this.startContainer !== node || this.startOffset < node.length) &&
          (this.endContainer !== node || this.endOffset > 0)
            ? [rect]
            : [],
        );
        if (!rects.length) return new DOMRect();
        const top = Math.min(...rects.map((rect) => rect.top));
        return new DOMRect(0, top, 100, Math.max(...rects.map((rect) => rect.bottom)) - top);
      });
      vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
        const rect = this.getBoundingClientRect();
        return (rect.height ? [rect] : []) as unknown as DOMRectList;
      });
      const paints: Array<{ height: number; origin: number; current: number; end: number }> = [];
      const factory = originals.decorationModule.createSmoothTextDecorations;
      vi.mocked(decorationModule.createSmoothTextDecorations).mockImplementation(() => {
        const decorations = factory();
        const prepare = decorations.prepare;
        decorations.prepare = (input) => {
          paints.push({
            height: input.height,
            origin: input.rootTop,
            current: rootTop,
            end: input.visibleEnd(4, 8),
          });
          return prepare(input);
        };
        return decorations;
      });
      const view = (text: string, candidate?: SmoothTextCandidate, eof = false) => (
        <main>
          <div data-eof-actual="" data-timeline-row-id="body">
            <Probe
              id="table-eof"
              text={text}
              frame
              initialBufferMs={0}
              fadeDurationMs={eof ? eofFade : eofFade || 200}
              yieldDurationMs={200}
              streaming={!eof}
              complete={eof}
              {...(candidate ? { candidate } : {})}
              richText={
                <table style={{ borderCollapse: "collapse" }}>
                  <tbody>
                    {text.match(/.{1,4}/gu)?.map((line) => (
                      <tr key={line}>
                        <td style={{ borderBottom: "1px solid red" }}>
                          <Fragment key={eof && !candidate && line === "CCCC" ? "eof" : "stream"}>
                            {line}
                          </Fragment>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }
            />
          </div>
          {!eof && <div data-eof-status="" data-timeline-status-height="fixture:thinking" />}
        </main>
      );
      await render(view("AAAA"));
      const main = container.querySelector("main")!;
      const sizes = new Map([["body", 120]]);
      const publications: Array<() => void> = [];
      const owner = createTimelineLayout(main, {
        list: () => ({
          getState: () => ({ sizes }),
          setItemSize: (id, size) => sizes.set(id, Math.round(size.height)),
        }),
        control: () => null,
        requestCommit: (generation) => publications.push(owner.capture(generation)),
        synchronous: (write) => write(),
      });
      const step = async (publish = true) => {
        now += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        if (publish) await act(() => publications.at(-1)?.());
      };
      try {
        await render(view("AAAABBBBCCCC"));
        for (let index = 0; index < 40; index++) await step();
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toBe("BBBBCCCC");
        boundaryEdge = 121;
        await act(() => publications.at(-1)?.());
        const probe = main.querySelector<HTMLElement>("[data-probe]")!;
        const frame = probe.parentElement!;
        const row = probe.querySelectorAll("tr")[1]!;
        const progress = () =>
          row.hasAttribute("data-smooth-row-divider")
            ? Number(
                (row.firstElementChild as HTMLElement).style
                  .getPropertyValue("--t3-smooth-divider-color")
                  .match(/ ([\d.]+)%, transparent\)$/u)?.[1] ?? 0,
              ) / 100
            : 1;
        for (let index = 0; index < 120 && !(progress() > 0 && progress() < 1); index++)
          await step();
        const before = progress();
        expect(before).toBeGreaterThan(0);
        expect(before).toBeLessThan(1);
        expect(paints.at(-1)!.end).toBe(8);
        expect(received!.containerHeight).toBeGreaterThanOrEqual(60);
        const height = Number.parseFloat(frame.style.height);
        expect(height).toBeGreaterThanOrEqual(40.5);
        // C measures the current natural target, while the old tree and its
        // active divider remain mounted until C receives its own real commit.
        const commit = vi.fn();
        const candidate = {
          measure: () => probe.getBoundingClientRect().height,
          commit,
        };
        rootTop = shift;
        await render(view("AAAABBBBCCCC", candidate, true));
        expect(probe.querySelectorAll("tr")[1]).toBe(row);
        expect(row.getBoundingClientRect().bottom - probe.getBoundingClientRect().top).toBe(40);
        expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(height);
        expect(received!.containerHeight).toBeGreaterThanOrEqual(60);
        expect(paints.at(-1)!.height).toBeGreaterThanOrEqual(40.5);
        expect(progress()).toBeGreaterThanOrEqual(before);
        expect(paints.at(-1)!.origin).toBe(paints.at(-1)!.current);
        if (eofFade === 0) expect(progress()).toBe(1);
        if (retreat) {
          // A later followed frame must use its own origin too. A real smaller
          // owner actual revokes the divider even while local C keeps growing.
          rootTop += 35;
          actualHeight = 21;
          await act(owner.captureList(owner.itemSizeChanged("body", 21)));
          expect(received!.containerHeight).toBe(21);
          await step(false);
          expect(received!.containerHeight).toBe(21);
          expect(progress()).toBe(0);
          expect(paints.at(-1)!.height).toBe(21);
          const renderCount = renders.get("table-eof");
          actualHeight = 120;
          await act(owner.captureList(owner.itemSizeChanged("body", 120)));
          await step();
          await step();
          expect(progress()).toBeGreaterThan(0);
          expect(progress()).toBeLessThan(1);
          expect(renders.get("table-eof")).toBe(renderCount);
        }
        let previous = progress();
        for (let index = 0; index < 120 && !commit.mock.calls.length; index++) {
          await step();
          expect(progress()).toBeGreaterThanOrEqual(previous);
          previous = progress();
        }
        expect(commit).toHaveBeenCalledOnce();
        // Commit C's EOF reconciliation, replacing only the unread tail Text.
        await render(view("AAAABBBBCCCC", undefined, true));
        expect(probe.querySelectorAll("tr")[1]).toBe(row);
        expect(progress()).toBeGreaterThanOrEqual(previous);
        previous = progress();
        for (let index = 0; index < 120 && frames.size; index++) {
          await step();
          expect(progress()).toBeGreaterThanOrEqual(previous);
          previous = progress();
        }
        expect(progress()).toBe(1);
        expect(hiddenHighlight()).toBeUndefined();
        expect(frames.size).toBe(0);
      } finally {
        await render(null);
        owner.dispose();
      }
    },
  );
});

// Chromium 的 CSSOM 以有限精度序列化像素值；曲线年龄和提交归属仍按精确值验证。
describe("candidate curve continuity", () => {
  it.each([60, 120])(
    "keeps the original 137/200ms curve and strict candidate receipt at %s Hz",
    async (hz) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(4);
      const progress = originals.motionModule.smoothLineCurveProgress;
      const curve = vi.mocked(motionModule.smoothLineCurveProgress);
      const create = originals.smoothTextModule.createSmoothTextLines;
      let fifo: ReturnType<typeof create>;
      vi.mocked(smoothTextModule.createSmoothTextLines).mockImplementation((...args) => {
        fifo = create(...args);
        return fifo;
      });
      const commit = vi.fn();
      const candidate = { measure: () => 20 * progress(180, 200, 0, 0), commit };
      const view = (request?: SmoothTextCandidate, paused = false) => (
        <Probe
          text="AAAA"
          frame
          initialBufferMs={0}
          fadeDurationMs={0}
          yieldDurationMs={200}
          claimInitialText={() => true}
          {...(request ? { candidate: request } : {})}
          paused={paused}
        />
      );
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await render(view());
      for (let at = 0; at < 137; at += 1000 / hz) await step(at);
      await step(137);
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const before = Number.parseFloat(frame.style.height);
      expect(before).toBeGreaterThan(0);
      expect(before).toBeCloseTo(20 * progress(137, 200, 0, 0), 3);
      const permits: Array<{ callback: () => void; cancelled: boolean }> = [];
      const unregister = registerSmoothTextLayoutScope(container, {
        frame(callback) {
          const id = fixture.requestFrame(callback);
          return () => fixture.cancelFrame(id);
        },
        afterCommit(_element, callback) {
          const permit = { callback, cancelled: false };
          permits.push(permit);
          return () => {
            permit.cancelled = true;
          };
        },
      });
      try {
        const offset = fifo!.offset;
        await render(view(candidate));
        expect(Number.parseFloat(frame.style.height)).toBe(before);
        for (let at = 137 + 1000 / hz; at < 201; at += 1000 / hz) {
          curve.mockClear();
          await step(at);
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(
            20 * progress(at, 200, 0, 0),
            3,
          );
          // Elapsed curve age proves startedAt stayed at zero, rather than
          // fitting a new short curve through the same endpoint.
          expect(curve.mock.calls.some(([age, duration]) => age === at && duration === 200)).toBe(
            true,
          );
          expect(fifo!.offset).toBe(offset);
          expect(commit).not.toHaveBeenCalled();
        }
        expect(permits).toHaveLength(1);
        expect(now - 137).toBeLessThanOrEqual(63 + 1000 / hz);
        await step(240);
        expect(commit).not.toHaveBeenCalled();
        await act(() => permits[0]!.callback());
        expect(commit).toHaveBeenCalledOnce();
      } finally {
        unregister();
      }
    },
  );

  it.each(["pause", "cancel", "width", "font", "exceeds", "retired"] as const)(
    "protects the existing action across %s",
    async (kind) => {
      await using fixture = await setup();
      const { container, frames, Probe, mockWrappedRows, render } = fixture;
      let now = 0;
      let columns = 4;
      fixture.clock.mockImplementation(() => now);
      mockWrappedRows(() => columns);
      const fonts = new EventTarget();
      const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
      Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
      const progress = originals.motionModule.smoothLineCurveProgress;
      const commit = vi.fn();
      const measure = vi.fn(() => (kind === "exceeds" ? 30 : kind === "retired" ? 21 : 19.8));
      const candidate = { measure, commit };
      const view = (request?: SmoothTextCandidate, paused = false) => (
        <Probe
          text="AAAA"
          frame
          claimInitialText={() => true}
          initialBufferMs={0}
          fadeDurationMs={0}
          yieldDurationMs={200}
          {...(request ? { candidate: request } : {})}
          paused={paused}
        />
      );
      const step = async (at: number) => {
        now = at;
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      try {
        await render(view());
        for (let at = 0; at < 137; at += 1000 / 60) await step(at);
        await step(137);
        if (kind === "retired") {
          for (let at = 137 + 1000 / 60; at <= 300; at += 1000 / 60) await step(at);
        }
        await render(view(candidate));
        const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
        if (kind === "pause") {
          await step(153);
          const frozen = frame.style.height;
          await render(view(candidate, true));
          now += 1000;
          await render(view(candidate));
          expect(frame.style.height).toBe(frozen);
          await step(1169);
          // The real pause shifts the original action once; candidate frames
          // before/after it do not charge that time a second time.
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(
            20 * progress(169, 200, 0, 0),
            3,
          );
        } else if (kind === "cancel") {
          await step(153);
          await render(view());
          await step(169);
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(
            20 * progress(169, 200, 0, 0),
            3,
          );
        } else {
          if (kind === "width" || kind === "font") {
            await step(153);
            if (kind === "width") columns = 8;
            else await act(() => fonts.dispatchEvent(new Event("loadingdone")));
            await step(169);
            expect(measure).toHaveBeenCalledTimes(2);
          }
          const from = Number.parseFloat(frame.style.height);
          const at = now;
          await step(at + 16);
          expect(Number.parseFloat(frame.style.height)).toBeCloseTo(
            from + (measure() - from) * progress(16, 200, 0, 0),
            3,
          );
          expect(commit).not.toHaveBeenCalled();
        }
      } finally {
        if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
        else Reflect.deleteProperty(document, "fonts");
      }
    },
  );

  it("preserves a moving pulse and its slopes while freezing the candidate owner", async () => {
    await using fixture = await setup();
    const { container, frames, Probe, mockWrappedRows, expectPaintedGlyphsToFit, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(16);
    const progress = originals.motionModule.smoothLineCurveProgress;
    const curve = vi.mocked(motionModule.smoothLineCurveProgress);
    let raw = "";
    let candidate: SmoothTextCandidate | undefined;
    const commit = vi.fn();
    const view = () => (
      <Probe
        text={raw}
        sourceText={raw}
        frame
        mode="auto"
        initialBufferMs={80}
        fadeDurationMs={200}
        yieldDurationMs={200}
        claimInitialText={() => true}
        {...(candidate ? { candidate } : {})}
      />
    );
    await render(view());
    let arrival = 0;
    let moving: Parameters<typeof progress> | undefined;
    for (let index = 0; index < 360 && !moving; index++) {
      const at = index * (1000 / 60);
      while (arrival <= at) {
        now = arrival;
        raw += "ab";
        await render(view());
        arrival += 12.5;
      }
      now = at;
      curve.mockClear();
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      const sample = curve.mock.calls.at(-1);
      if (
        sample?.[4] &&
        sample[4].startVelocity + sample[4].endVelocity > 0 &&
        sample[0] > sample[1] * 0.6 &&
        sample[0] < sample[1] * 0.8
      )
        moving = sample;
    }
    expect(moving).toBeDefined();
    const [age, duration, startSlope, endSlope, pulse] = moving!;
    expect(pulse).toBeDefined();
    expect(pulse!.startVelocity + pulse!.endVelocity).toBeGreaterThan(0);
    const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
    const height = Number.parseFloat(frame.style.height);
    const from = height - pulse!.distance * progress(...moving!);
    const target =
      from + pulse!.distance * progress(duration * 0.9, duration, startSlope, endSlope, pulse);
    candidate = { measure: () => target, commit };
    const permits: (() => void)[] = [];
    const unregister = registerSmoothTextLayoutScope(container, {
      frame(callback) {
        const id = fixture.requestFrame(callback);
        return () => fixture.cancelFrame(id);
      },
      afterCommit(_element, callback) {
        permits.push(callback);
        return () => {};
      },
    });
    try {
      await render(view());
      const started = now;
      for (let index = 1; index <= 8 && !permits.length; index++) {
        now = started + index * (1000 / 60);
        curve.mockClear();
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        expect(Number.parseFloat(frame.style.height)).toBeCloseTo(
          from +
            pulse!.distance * progress(age + now - started, duration, startSlope, endSlope, pulse),
          3,
        );
        expect(
          curve.mock.calls.some((args) => args[4] === pulse && args[0] === age + now - started),
        ).toBe(true);
        expect(commit).not.toHaveBeenCalled();
        expectPaintedGlyphsToFit();
      }
      expect(permits).toHaveLength(1);
      expect(now - started).toBeLessThan(200);
      await act(() => permits[0]!());
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("requires the EOF replacement's own receipt after reusing the same live action", async () => {
    await using fixture = await setup();
    const { container, frames, mockWrappedRows, expectPaintedGlyphsToFit, render } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    mockWrappedRows(4);
    const complete = vi.fn();
    const measured: string[] = [];
    function Replacement({ stage }: { stage: "A" | "B" | "C" }) {
      const [released, setReleased] = useState("A");
      const ref = useRef<HTMLDivElement>(null);
      const request = {
        measure: () => {
          measured.push(stage);
          return stage === "B" ? 17 : 19;
        },
        commit: () => setReleased(stage),
      };
      useSmoothText(ref, {
        enabled: true,
        sourceText: stage === "A" ? "AAAA" : stage === "B" ? "AAAAX" : "AAAAZZ",
        candidate: stage !== "A" && released !== stage ? request : undefined,
        claimInitialText: () => true,
        initialBufferMs: 0,
        fadeDurationMs: 0,
        yieldDurationMs: 200,
        streaming: stage !== "C",
        complete: stage === "C",
        onPlaybackComplete: complete,
      });
      return (
        <div data-smooth-text-frame="">
          <div ref={ref} data-probe="message">
            {released === "A" ? "AAAA" : released === "B" ? "AAAAX" : "AAAAZZ"}
          </div>
        </div>
      );
    }
    const step = async (at: number) => {
      now = at;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
    };
    await render(<Replacement stage="A" />);
    for (let at = 0; at < 137; at += 1000 / 60) await step(at);
    await step(137);
    const permits: Array<{ callback: () => void; cancelled: boolean }> = [];
    const unregister = registerSmoothTextLayoutScope(container, {
      frame(callback) {
        const id = fixture.requestFrame(callback);
        return () => fixture.cancelFrame(id);
      },
      afterCommit(_element, callback) {
        const permit = { callback, cancelled: false };
        permits.push(permit);
        return () => {
          permit.cancelled = true;
        };
      },
    });
    try {
      await render(<Replacement stage="B" />);
      await step(153);
      expect(permits).toHaveLength(1);
      const stale = permits[0]!;
      await render(<Replacement stage="C" />);
      expect(measured).toEqual(["B", "C"]);
      await act(() => stale.callback());
      expect(stale.cancelled).toBe(true);
      expect(container.querySelector("[data-probe]")?.textContent).toBe("AAAA");
      await step(169);
      await step(185);
      const own = permits.find((permit) => !permit.cancelled)!;
      expect(own).toBeDefined();
      await step(201);
      expect(container.querySelector("[data-probe]")?.textContent).toBe("AAAA");
      expect(complete).not.toHaveBeenCalled();
      await act(() => own.callback());
      expect(container.querySelector("[data-probe]")?.textContent).toBe("AAAAZZ");
      unregister();
      for (let index = 0; index < 80 && !complete.mock.calls.length; index++) {
        await step(now + 16);
        expectPaintedGlyphsToFit();
      }
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
});

describe("quote rewrite anchor continuity", () => {
  const tightSource =
    "> 检查清单\n>\n> - 确认输入完整。\n> - 确认配置有效。\n> - 确认输出满足标准。\n";
  const looseSource = tightSource + ">\n>";

  async function quoteRewriteFixture(fixture: Awaited<ReturnType<typeof setup>>) {
    const { container, frames, Probe, render } = fixture;
    let now = 0;
    let actualHeight = 120;
    let boundaryEdge = 1;
    let rowHeight = 20;
    const create = originals.smoothTextModule.createSmoothTextLines;
    let fifo: ReturnType<typeof create>;
    vi.mocked(smoothTextModule.createSmoothTextLines).mockImplementation((...args) => {
      fifo = create(...args);
      return fifo;
    });
    fixture.clock.mockImplementation(() => now);
    const decorationFactory = originals.decorationModule.createSmoothTextDecorations;
    const paints: Array<{
      height: number;
      offset: number;
      visibleEnd: number;
      glyphs: Array<{ start: number; end: number; bounds: { top: number; bottom: number } | null }>;
    }> = [];
    vi.mocked(decorationModule.createSmoothTextDecorations).mockImplementation(() => {
      const decorations = decorationFactory();
      const prepare = decorations.prepare;
      decorations.prepare = (input) => {
        const sample = {
          height: input.height,
          offset: input.offset,
          visibleEnd: input.visibleEnd(0, 37),
          glyphs: [] as (typeof paints)[number]["glyphs"],
        };
        paints.push(sample);
        return prepare({
          ...input,
          bounds(start, end) {
            const bounds = input.bounds(start, end);
            sample.glyphs.push({ start, end, bounds });
            return bounds;
          },
        });
      };
      return decorations;
    });
    const components = {
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote style={{ borderLeft: "2px solid red", lineHeight: `${rowHeight}px` }}>
          {children}
        </blockquote>
      ),
    };
    // Bind geometry to current DOM identities; retired Text has no replacement box.
    const layout = () => {
      const probe = container.querySelector<HTMLElement>('[data-probe="quote-anchor"]');
      const boxes = new Map<Element, DOMRect>();
      const glyphs = new Map<Text, DOMRect>();
      if (!probe) return { boxes, glyphs };
      const boundary = container.querySelector("[data-quote-boundary]");
      if (boundary) boxes.set(boundary, new DOMRect(0, boundaryEdge, 300, 20));
      const quote = probe.querySelector("blockquote");
      if (!quote) {
        const paragraph = probe.querySelector("p")!;
        const box = new DOMRect(0, 0, 300, rowHeight);
        boxes.set(probe, box);
        boxes.set(paragraph, box);
        const node = paragraph.firstChild as Text;
        glyphs.set(node, new DOMRect(0, 4, node.length * 10, rowHeight - 8));
        boxes.set(probe.parentElement!, box);
        boxes.set(
          container.querySelector("[data-quote-actual]")!,
          new DOMRect(0, 0, 300, actualHeight),
        );
        return { boxes, glyphs };
      }
      const list = quote.querySelector("ul")!;
      const loose = list.querySelector("li > p") !== null;
      const stride = loose ? rowHeight + 10 : rowHeight;
      const height = rowHeight + 3 * stride;
      boxes.set(probe, new DOMRect(0, 0, 300, height));
      boxes.set(quote, new DOMRect(0, 0, 300, height));
      boxes.set(list, new DOMRect(0, rowHeight, 300, 3 * stride));
      boxes.set(quote.querySelector(":scope > p")!, new DOMRect(0, 0, 300, rowHeight));
      [...list.children].forEach((item, index) => {
        const rect = new DOMRect(0, rowHeight + index * stride, 300, rowHeight);
        boxes.set(item, rect);
        const paragraph = item.querySelector("p");
        if (paragraph) boxes.set(paragraph, rect);
      });
      const walker = document.createTreeWalker(quote, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!/\S/u.test(node.data)) continue;
        const owner = node.parentElement!;
        const box = boxes.get(owner);
        if (!box) throw new Error(`Unmapped current quote text: ${owner.tagName}`);
        glyphs.set(node, new DOMRect(0, box.top + 4, node.length * 10, rowHeight - 8));
      }
      const holder = container.querySelector("[data-quote-actual]")!;
      boxes.set(holder, new DOMRect(0, 0, 300, actualHeight));
      const frame = probe.parentElement!;
      const explicit = Number.parseFloat(frame.style.height);
      boxes.set(frame, new DOMRect(0, 0, 300, Number.isFinite(explicit) ? explicit : height));
      return { boxes, glyphs };
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return layout().boxes.get(this) ?? new DOMRect();
    });
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rects: DOMRect[] = [];
      for (const [node, rect] of layout().glyphs) {
        if (this.intersectsNode(node) && this.toString().trim()) rects.push(rect);
      }
      if (rects.length === 0) return new DOMRect();
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(0, top, 100, bottom - top);
    });
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      const rect = this.getBoundingClientRect();
      return (rect.height ? [rect] : []) as unknown as DOMRectList;
    });
    const pending = new Set<(publication?: layoutModule.SmoothTextLayoutPublication) => void>();
    const publications: number[] = [];
    const registerScope = () =>
      registerSmoothTextLayoutScope(container, {
        frame(callback) {
          const id = fixture.requestFrame(callback);
          return () => fixture.cancelFrame(id);
        },
        afterCommit(_element, callback) {
          pending.add(callback);
          return () => pending.delete(callback);
        },
      });
    const publish = async () => {
      await act(() => {
        const callbacks = [...pending];
        pending.clear();
        if (callbacks.length) boundaryEdge = actualHeight + 1;
        const holder = container.querySelector<HTMLElement>("[data-quote-actual]")!;
        for (const callback of callbacks) {
          publications.push(actualHeight);
          callback({ container: holder, containerHeight: actualHeight, rowId: undefined });
        }
        publishSmoothTextLayoutCommit(container);
      });
    };
    const view = (source: string, candidate?: SmoothTextCandidate) => (
      <main>
        <div data-quote-actual="">
          <Probe
            id="quote-anchor"
            text={source}
            sourceText={source}
            frame
            claimInitialText={() => true}
            initialBufferMs={0}
            yieldDurationMs={200}
            fadeDurationMs={200}
            {...(candidate ? { candidate } : {})}
            richText={<ReactMarkdown components={components}>{source}</ReactMarkdown>}
          />
        </div>
        <div data-quote-boundary="" data-timeline-status-height="fixture:thinking" />
      </main>
    );
    const step = async () => {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      await publish();
    };
    const unregister = registerScope();
    await render(view(tightSource));
    const quote = container.querySelector("blockquote")!;
    const borderHeight = () =>
      Number.parseFloat(quote.style.getPropertyValue("--t3-smooth-border-height"));
    for (
      let index = 0;
      index < 160 && ((fifo!.nextStart ?? 32) < 14 || borderHeight() <= 25);
      index++
    )
      await step();
    expect(quote.querySelector("li > p")).toBeNull();
    expect(fifo!.visibleEnd(7, 14)).toBe(14);
    expect(borderHeight()).toBeGreaterThan(20);
    expect(borderHeight()).toBeLessThan(40);
    expect(publications).toContain(120);
    return {
      quote,
      borderHeight,
      view,
      step,
      publish,
      unregister,
      model: () => fifo!,
      paints,
      publications,
      setActual: (height: number) => {
        actualHeight = height;
        boundaryEdge = height + 1;
      },
      setRowHeight: (height: number) => {
        rowHeight = height;
      },
    };
  }

  it.each([
    { limit: "enough actual", actual: 120, row: 20 },
    { limit: "smaller current actual", actual: 25, row: 20 },
    { limit: "shorter current ink", actual: 120, row: 10 },
    { limit: "zero current actual", actual: 0, row: 20 },
  ])(
    "preserves only current qualified quote ink across a loose-list rewrite ($limit)",
    async ({ actual, row }) => {
      await using fixture = await setup();
      const { container, hiddenHighlight, render } = fixture;
      const f = await quoteRewriteFixture(fixture);
      try {
        const before = f.borderHeight();
        const previousText = f.quote.textContent!;
        const oldInk = f.quote.querySelector("li")!.firstChild!;
        f.setActual(actual);
        f.setRowHeight(row);
        await render(f.view(looseSource));
        await f.publish();
        const model = f.model();
        const currentInk = f.quote.querySelector("li > p")!.firstChild as Text;
        expect(looseSource.startsWith(tightSource)).toBe(true);
        expect(previousText.trimEnd()).toBe(
          "\n检查清单\n\n确认输入完整。\n确认配置有效。\n确认输出满足标准。",
        );
        expect(f.quote.textContent!.trimEnd()).toBe(
          "\n检查清单\n\n\n确认输入完整。\n\n\n确认配置有效。\n\n\n确认输出满足标准。",
        );
        expect(container.querySelector("blockquote")).toBe(f.quote);
        expect(oldInk.isConnected).toBe(false);
        expect(currentInk.data).toBe("确认输入完整。");
        expect(model.visibleEnd(8, 15)).toBe(15);
        for (const source of hiddenHighlight() ?? []) {
          const hidden = document.createRange();
          hidden.setStart(source.startContainer, source.startOffset);
          hidden.setEnd(source.endContainer, source.endOffset);
          expect(hidden.intersectsNode(currentInk)).toBe(false);
        }
        expect(model.hiddenRanges).toContainEqual({ start: 7, end: 8 });
        expect(model.visibleEnd(0, 37)).toBe(7);
        const inkRange = document.createRange();
        inkRange.selectNodeContents(currentInk);
        expect(inkRange.getBoundingClientRect().bottom).toBe(row * 2 - 4);
        const currentEdge = row * 2;
        const legal = Math.min(before, actual, currentEdge);
        const paint = f.paints.at(-1)!;
        expect(paint.height).toBeGreaterThanOrEqual(legal);
        expect(paint.height).toBeLessThanOrEqual(actual);
        expect(paint.glyphs).toContainEqual({ start: 6, end: 7, bounds: null });
        expect(f.quote.hasAttribute("data-smooth-quote-border")).toBe(true);
        expect(f.borderHeight()).toBe(legal);
      } finally {
        await render(null);
        f.unregister();
      }
    },
  );

  it("measures the retained ink's mapped endpoint rather than the old relative offset", async () => {
    await using fixture = await setup();
    const { render } = fixture;
    const f = await quoteRewriteFixture(fixture);
    try {
      const before = f.borderHeight();
      await render(f.view(looseSource));
      await f.publish();
      const paint = f.paints.at(-1)!;
      expect(paint.glyphs).toContainEqual({
        start: 14,
        end: 15,
        bounds: { top: 24, bottom: 36 },
      });
      expect(paint.glyphs.some(({ end }) => end === 14)).toBe(false);
      expect(f.borderHeight()).toBe(before);
      await render(f.view(looseSource + "\n>"));
      await f.publish();
      expect(f.borderHeight()).toBe(before);
      expect(f.model().visibleEnd(8, 15)).toBe(15);
    } finally {
      await render(null);
      f.unregister();
    }
  });

  it.each(["source rewrite", "quote removal"] as const)(
    "does not lend a retired quote anchor to new ink after %s",
    async (change) => {
      await using fixture = await setup();
      const { hiddenHighlight, rangeText, render } = fixture;
      const f = await quoteRewriteFixture(fixture);
      try {
        const oldInk = f.quote.querySelector("li")!.firstChild!;
        const source =
          change === "source rewrite"
            ? looseSource.replace("确认输入完整。", "全新文字未准入")
            : "新的普通段落";
        await render(f.view(source));
        await f.publish();
        expect(oldInk.isConnected).toBe(false);
        if (change === "quote removal") {
          expect(f.quote.isConnected).toBe(false);
          expect(f.quote.hasAttribute("data-smooth-quote-border")).toBe(false);
          expect(f.quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
        } else {
          expect(f.model().visibleEnd(8, 15)).toBe(8);
          expect(f.model().hiddenRanges.some(({ start, end }) => start <= 8 && end >= 15)).toBe(
            true,
          );
          expect(f.borderHeight()).toBeLessThanOrEqual(20);
          expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(
            "全新文字未准入",
          );
        }
      } finally {
        await render(null);
        f.unregister();
      }
    },
  );

  it("does not lend retained decoration space to unread glyphs or a pending candidate", async () => {
    await using fixture = await setup();
    const { hiddenHighlight, render } = fixture;
    const f = await quoteRewriteFixture(fixture);
    try {
      await render(f.view(looseSource));
      await f.publish();
      expect(f.model().visibleEnd(8, 15)).toBe(15);
      expect(f.model().visibleEnd(18, 25)).toBe(18);
      const commit = vi.fn();
      await render(f.view(looseSource, { measure: () => 160, commit }));
      for (let index = 0; index < 30; index++) await f.step();
      expect(commit).not.toHaveBeenCalled();
      expect(f.model().visibleEnd(18, 25)).toBe(18);
      expect(f.model().visibleEnd(0, 37)).toBeLessThan(37);
      expect(hiddenHighlight()).toBeDefined();
    } finally {
      await render(null);
      f.unregister();
    }
  });
});

describe("quote native anchor remapping", () => {
  const source = "Reference [guide][ref].\n\n> Finished quote.\n\nFollowing.";
  const definition = "\n\n[ref]: /guide\n\nUnread tail.";

  async function nativeQuoteFixture(fixture: Awaited<ReturnType<typeof setup>>) {
    const { container, frames, Probe, render, hiddenHighlight } = fixture;
    let now = 0;
    let actualHeight = 120;
    let boundaryEdge = 1;
    const create = originals.smoothTextModule.createSmoothTextLines;
    let fifo: ReturnType<typeof create>;
    vi.mocked(smoothTextModule.createSmoothTextLines).mockImplementation((...args) => {
      fifo = create(...args);
      return fifo;
    });
    fixture.clock.mockImplementation(() => now);
    const factory = originals.decorationModule.createSmoothTextDecorations;
    let decoration: ReturnType<typeof factory>;
    const entries: Array<{ start: number; end: number; remappedEnd: number | undefined }> = [];
    const paints: Array<{
      height: number;
      glyphs: Array<{ start: number; end: number; bounds: { top: number; bottom: number } | null }>;
    }> = [];
    vi.mocked(decorationModule.createSmoothTextDecorations).mockImplementation(() => {
      decoration = factory();
      const index = decoration.index;
      decoration.index = (...args) => {
        for (const entry of args[0])
          if (entry.element.tagName === "BLOCKQUOTE")
            entries.push({
              start: entry.start,
              end: entry.end,
              remappedEnd: args[2]?.get(entry.element),
            });
        index(...args);
      };
      const prepare = decoration.prepare;
      decoration.prepare = (input) => {
        const sample = { height: input.height, glyphs: [] as (typeof paints)[number]["glyphs"] };
        paints.push(sample);
        return prepare({
          ...input,
          bounds(start, end) {
            const bounds = input.bounds(start, end);
            sample.glyphs.push({ start, end, bounds });
            return bounds;
          },
        });
      };
      return decoration;
    });
    // Every box belongs to the current DOM. The reference changes coordinates,
    // while this quote's local rows and its existing ink keep their geometry.
    const layout = () => {
      const probe = container.querySelector<HTMLElement>('[data-probe="native-quote"]');
      const boxes = new Map<Element, DOMRect>();
      const glyphs = new Map<Text, Array<DOMRect | undefined>>();
      if (!probe) return { boxes, glyphs };
      const quote = probe.querySelector("blockquote");
      const paragraph = quote?.querySelector("p");
      const rows = paragraph?.textContent?.split("\n").length ?? 0;
      const quoteHeight = quote ? rows * 20 + 60 : 0;
      const paragraphs = [...probe.querySelectorAll(":scope > p")];
      const naturalHeight = 20 + quoteHeight + Math.max(0, paragraphs.length - 1) * 20;
      boxes.set(probe, new DOMRect(0, 0, 300, naturalHeight));
      paragraphs.forEach((paragraph, index) => {
        boxes.set(
          paragraph,
          new DOMRect(0, index === 0 ? 0 : 20 + quoteHeight + (index - 1) * 20, 300, 20),
        );
      });
      if (quote) boxes.set(quote, new DOMRect(0, 20, 300, quoteHeight));
      if (paragraph) boxes.set(paragraph, new DOMRect(0, 20, 300, rows * 20));
      const frame = probe.parentElement!;
      const explicit = Number.parseFloat(frame.style.height);
      boxes.set(
        frame,
        new DOMRect(0, 0, 300, Number.isFinite(explicit) ? explicit : naturalHeight),
      );
      boxes.set(
        container.querySelector("[data-native-actual]")!,
        new DOMRect(0, 0, 300, actualHeight),
      );
      boxes.set(
        container.querySelector("[data-native-boundary]")!,
        new DOMRect(0, boundaryEdge, 300, 20),
      );
      const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const owner = node.parentElement?.closest("p");
        if (!owner) continue;
        const box = boxes.get(owner);
        if (!box) throw new Error("Unmapped current native quote text");
        let row = 0;
        glyphs.set(
          node,
          [...node.data].map((glyph) => {
            if (glyph === "\n") {
              row++;
              return undefined;
            }
            return /\S/u.test(glyph) ? new DOMRect(0, box.top + row * 20 + 4, 10, 12) : undefined;
          }),
        );
      }
      return { boxes, glyphs };
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return layout().boxes.get(this) ?? new DOMRect();
    });
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const rects: DOMRect[] = [];
      for (const [node, glyphs] of layout().glyphs) {
        if (!this.intersectsNode(node)) continue;
        const start = this.startContainer === node ? this.startOffset : 0;
        const end = this.endContainer === node ? this.endOffset : node.length;
        for (const rect of glyphs.slice(start, end)) if (rect) rects.push(rect);
      }
      if (!rects.length) return new DOMRect();
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(0, top, 100, bottom - top);
    });
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      const rect = this.getBoundingClientRect();
      return (rect.height ? [rect] : []) as unknown as DOMRectList;
    });
    const pending = new Set<(publication?: layoutModule.SmoothTextLayoutPublication) => void>();
    const unregister = registerSmoothTextLayoutScope(container, {
      frame(callback) {
        const id = fixture.requestFrame(callback);
        return () => fixture.cancelFrame(id);
      },
      afterCommit(_element, callback) {
        pending.add(callback);
        return () => pending.delete(callback);
      },
    });
    const publish = async () => {
      await act(() => {
        const callbacks = [...pending];
        pending.clear();
        if (callbacks.length) boundaryEdge = actualHeight + 1;
        const holder = container.querySelector<HTMLElement>("[data-native-actual]")!;
        for (const callback of callbacks)
          callback({ container: holder, containerHeight: actualHeight, rowId: undefined });
        publishSmoothTextLayoutCommit(container);
      });
    };
    const components = {
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote style={{ borderLeft: "2px solid red", lineHeight: "20px" }}>
          {children}
        </blockquote>
      ),
    };
    const view = (text: string) => (
      <main>
        <div data-native-actual="">
          <Probe
            id="native-quote"
            text={text}
            sourceText={text}
            frame
            claimInitialText={() => true}
            initialBufferMs={0}
            yieldDurationMs={200}
            fadeDurationMs={200}
            richText={<ReactMarkdown components={components}>{text}</ReactMarkdown>}
          />
        </div>
        <div data-native-boundary="" data-timeline-status-height="fixture:thinking" />
      </main>
    );
    const step = async () => {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      await publish();
    };
    await render(view(source));
    const quote = container.querySelector("blockquote")!;
    let sawFinitePhase = false;
    for (let stepIndex = 0; stepIndex < 240; stepIndex++) {
      const painted = Number.parseFloat(quote.style.getPropertyValue("--t3-smooth-border-height"));
      if (painted > 0 && painted < 80) sawFinitePhase = true;
      if (sawFinitePhase && !quote.hasAttribute("data-smooth-quote-border") && !hiddenHighlight())
        break;
      await step();
    }
    expect(sawFinitePhase).toBe(true);
    expect(quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    for (const name of ["height", "width", "color"])
      expect(quote.style.getPropertyValue(`--t3-smooth-border-${name}`)).toBe("");
    expect(decoration!.pending).toBe(false);
    expect(decoration!.gated).toBe(false);
    expect(hiddenHighlight()).toBeUndefined();
    return {
      quote,
      view,
      publish,
      unregister,
      entries,
      paints,
      model: () => fifo!,
      decorations: () => decoration!,
      setActual(height: number) {
        actualHeight = height;
        boundaryEdge = height + 1;
      },
    };
  }

  it.each([120, 55])(
    "rechecks native quote proof after a preceding reference resolves with actual %s",
    async (actual) => {
      await using fixture = await setup();
      const { container, hiddenHighlight, rangeText, render } = fixture;
      const f = await nativeQuoteFixture(fixture);
      try {
        const before = f.entries.at(-1)!;
        const ink = f.quote.querySelector("p")!.firstChild as Text;
        const text = f.quote.textContent;
        const writes = vi.spyOn(f.quote.style, "setProperty");
        f.setActual(actual);
        await render(f.view(source + definition));
        await f.publish();
        const after = f.entries.at(-1)!;
        expect((source + definition).startsWith(source)).toBe(true);
        expect(container.querySelector("a")?.textContent).toBe("guide");
        expect(after.start).toBeLessThan(before.start);
        expect(after.end - after.start).toBe(before.end - before.start);
        expect(container.querySelector("blockquote")).toBe(f.quote);
        expect(f.quote.querySelector("p")!.firstChild).toBe(ink);
        expect(f.quote.textContent).toBe(text);
        expect(f.model().visibleEnd(after.start, after.end)).toBe(after.end);
        for (const source of hiddenHighlight() ?? []) {
          const hidden = document.createRange();
          hidden.setStart(source.startContainer, source.startOffset);
          hidden.setEnd(source.endContainer, source.endOffset);
          expect(hidden.intersectsNode(ink)).toBe(false);
        }
        const range = document.createRange();
        range.selectNodeContents(ink);
        expect(range.getBoundingClientRect().top).toBe(24);
        expect(range.getBoundingClientRect().bottom).toBe(36);
        expect(f.quote.getBoundingClientRect().bottom).toBe(100);
        expect(f.paints.at(-1)!.height).toBeGreaterThanOrEqual(Math.min(100, actual));
        expect(f.paints.at(-1)!.height).toBeLessThanOrEqual(actual);
        expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain("Unread tail.");
        const borderWrites = writes.mock.calls.filter(
          ([name]) => name === "--t3-smooth-border-height",
        );
        if (actual >= 100) {
          expect(borderWrites).toEqual([]);
          expect(f.quote.hasAttribute("data-smooth-quote-border")).toBe(false);
          expect(f.decorations().pending).toBe(false);
        } else {
          expect(f.quote.hasAttribute("data-smooth-quote-border")).toBe(true);
          expect(
            Number.parseFloat(f.quote.style.getPropertyValue("--t3-smooth-border-height")),
          ).toBe(actual - 20);
          expect(borderWrites.every(([, value]) => Number.parseFloat(value!) <= actual - 20)).toBe(
            true,
          );
          expect(f.decorations().pending).toBe(false);
        }
      } finally {
        await render(null);
        f.unregister();
      }
    },
  );

  it("keeps an extended quote gated when only its old ink island is qualified", async () => {
    await using fixture = await setup();
    const { hiddenHighlight, rangeText, render } = fixture;
    const f = await nativeQuoteFixture(fixture);
    try {
      const extended =
        source.replace("Finished quote.", "Finished quote.\n> New unread glyphs.") + definition;
      await render(f.view(extended));
      await f.publish();
      const entry = f.entries.at(-1)!;
      const oldEnd = entry.start + "\nFinished quote.".length;
      expect(f.model().visibleEnd(entry.start, oldEnd)).toBe(oldEnd);
      expect(f.model().visibleEnd(entry.start, entry.end)).toBeLessThan(entry.end);
      expect([...(hiddenHighlight() ?? [])].map(rangeText).join("")).toContain(
        "New unread glyphs.",
      );
      expect(f.quote.hasAttribute("data-smooth-quote-border")).toBe(true);
      expect(
        Number.parseFloat(f.quote.style.getPropertyValue("--t3-smooth-border-height")),
      ).toBeLessThan(f.quote.getBoundingClientRect().height);
    } finally {
      await render(null);
      f.unregister();
    }
  });
});

describe("uniform source inventory", () => {
  it.each([
    { kind: "prose", hz: 60, fade: 200 },
    { kind: "prose", hz: 60, fade: 500 },
    { kind: "prose", hz: 120, fade: 200 },
    { kind: "short rows", hz: 60, fade: 200 },
    { kind: "line transition", hz: 60, fade: 200 },
    { kind: "headings", hz: 60, fade: 200 },
    { kind: "long history", hz: 60, fade: 500 },
    { kind: "resume", hz: 60, fade: 200 },
    { kind: "candidate", hz: 60, fade: 200 },
  ])("paces 80 token/s $kind at $hz Hz with fade $fade", async ({ kind, hz, fade }) => {
    await using fixture = await setup();
    const {
      container,
      frames,
      Probe,
      hiddenHighlight,
      mockWrappedRows,
      mockStreamRows,
      expectPaintedGlyphsToFit,
      render,
    } = fixture;
    let now = 0;
    fixture.clock.mockImplementation(() => now);
    const create = originals.smoothTextModule.createSmoothTextLines;
    let fifo: ReturnType<typeof create>;
    let layoutWait = 0;
    vi.mocked(smoothTextModule.createSmoothTextLines).mockImplementation((...args) => {
      const model = create(...args);
      const advance = model.advance;
      model.advance = (...input) => {
        layoutWait = Math.max(layoutWait, input[3] ?? 0);
        return advance.apply(model, input);
      };
      fifo = model;
      return model;
    });
    const cadenceFactory = originals.cadenceModule.createSmoothLineCadence;
    let wholeLinePlans = 0;
    vi.mocked(cadenceModule.createSmoothLineCadence).mockImplementation(() => {
      const cadence = cadenceFactory();
      const plan = cadence.plan;
      cadence.plan = (...input) => {
        const result = plan(...input);
        if (result.wholeLine) wholeLinePlans++;
        return result;
      };
      return cadence;
    });
    if (kind === "long history") mockStreamRows(40);
    else mockWrappedRows(40, true);
    const history = kind === "long history" ? "History ".repeat(750) : "";
    let raw = history,
      dom = history,
      arrival = 0,
      commitAt = 0;
    let candidate: SmoothTextCandidate | undefined;
    let candidateSource = "";
    let candidateCommitted = false;
    const headingSource = Array.from(
      { length: 20 },
      (_, index) =>
        `## Section ${index}\n\n${"Some steady prose for the next physical row. ".repeat(6)}\n\n`,
    ).join("");
    const view = (eof = false) => (
      <Probe
        text={dom}
        sourceText={raw}
        frame
        mode="auto"
        markdown={kind === "headings"}
        markdownParagraph={kind !== "headings" && kind !== "long history"}
        initialBufferMs={80}
        fadeDurationMs={fade}
        yieldDurationMs={200}
        {...(history ? {} : { claimInitialText: () => true })}
        streaming={!eof}
        {...(candidate ? { candidate } : {})}
      />
    );
    await render(view());
    let shown = history.length,
      lastReveal = 0,
      maxGap = 0,
      maxRelease = 0,
      completedRows = 0;
    let maxWholeRows = 0,
      maxRecoveryGap = 0;
    const samples: Array<{
      at: number;
      pending: number;
      parserPending: number;
      [key: string]: number;
    }> = [];
    const frameMs = 1000 / hz;
    const assertFits = () => {
      if (kind !== "long history") return expectPaintedGlyphsToFit();
      const body = container.querySelector<HTMLElement>("[data-probe]")!;
      const range = document.createRange();
      range.setStart(body.firstChild!, history.length);
      range.setEnd(body.firstChild!, fifo!.offset);
      const explicit = Number.parseFloat(body.parentElement!.style.height);
      expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        Number.isFinite(explicit) ? explicit : body.parentElement!.getBoundingClientRect().height,
      );
      expect([...(hiddenHighlight() ?? [])]).toHaveLength(fifo!.pending ? 1 : 0);
    };
    for (let frame = 0; frame < hz * 8; frame++) {
      const frameAt = frame * frameMs;
      let arrived = 0;
      while (arrival <= frameAt + 1e-8) {
        now = arrival;
        if (!(kind === "resume" && arrival >= 4000 && arrival < 4600)) {
          const count = (raw.length - history.length) / 2;
          raw +=
            kind === "short rows" || (kind === "line transition" && arrival >= 3000)
              ? String.fromCharCode(0x4e00 + count) + "\n"
              : kind === "headings"
                ? headingSource.slice(count * 2, count * 2 + 2)
                : "ab";
          arrived++;
          await render(view());
        }
        arrival += 12.5;
      }
      now = frameAt;
      if (kind === "candidate" && frame === hz * 3) {
        candidateSource = raw;
        const height = Number.parseFloat(
          container.querySelector<HTMLElement>("[data-smooth-text-frame]")!.style.height,
        );
        candidate = {
          measure: () => height + 20,
          commit: () => {
            candidateCommitted = true;
          },
        };
        await render(view());
      }
      if (frameAt >= commitAt && !candidate) {
        dom = raw;
        await render(view());
        commitAt = frameAt + 96;
      }
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      if (candidateCommitted && candidate) {
        dom = candidateSource;
        candidate = undefined;
        await render(view());
      }
      const pending = fifo!.pendingGraphemeCount;
      const nextShown = fifo!.graphemeCount - pending;
      const released = Math.max(0, nextShown - shown);
      const lines = dom.slice(0, fifo!.offset).split("\n");
      const rows = lines.reduce(
        (sum, line, index) =>
          sum +
          (index < lines.length - 1 ? Math.ceil(line.length / 40) : Math.floor(line.length / 40)),
        0,
      );
      const wholeRows = Math.max(0, rows - completedRows);
      completedRows = rows;
      // An actual candidate and a real upstream pause retain their own barriers.
      // Measure their recovery separately from uninterrupted, admitted supply.
      // A real pause remains in the one-second source-rate window. A row
      // planned inside that window keeps its 200ms action before steady state.
      const steady =
        frameAt >= 2000 &&
        !(kind === "resume" && frameAt >= 4000 && frameAt < 5800) &&
        !(kind === "candidate" && frameAt >= 3000 && frameAt < 4000);
      if (released) {
        if (steady) maxGap = Math.max(maxGap, frameAt - lastReveal);
        if (kind === "resume" && frameAt >= 4600 && frameAt < 5800)
          maxRecoveryGap = Math.max(maxRecoveryGap, frameAt - Math.max(4600, lastReveal));
        if (kind === "candidate" && frameAt >= 3000 && frameAt < 4000)
          maxRecoveryGap = Math.max(maxRecoveryGap, frameAt - Math.max(3000, lastReveal));
        lastReveal = frameAt;
      }
      if (frameAt >= 2000) maxRelease = Math.max(maxRelease, released);
      if (steady) maxWholeRows = Math.max(maxWholeRows, wholeRows);
      shown = nextShown;
      samples.push({
        at: +now.toFixed(2),
        arrived,
        raw: raw.length - history.length,
        dom: dom.length - history.length,
        parserPending: raw.length - dom.length,
        candidate: Number(!!candidate),
        pending,
        shown: shown - history.length,
        released,
        wholeRows,
        wholeLinePlans,
        layoutWait,
      });
      wholeLinePlans = 0;
      layoutWait = 0;
      assertFits();
    }
    const limit = kind === "headings" ? 200 + 96 + 2 * frameMs : 2 * frameMs;
    expect(maxGap).toBeLessThanOrEqual(limit + 0.001);
    expect(maxRecoveryGap).toBeLessThanOrEqual(200 + 96 + 2 * frameMs);
    // The existing source catch-up ceiling is 2x; neither stock feedback nor
    // admission debt gets an additional multiplier after a stalled row.
    expect(maxRelease).toBeLessThanOrEqual(Math.ceil((160 * 2 * frameMs) / 1000));
    if (kind === "prose" || kind === "long history") expect(maxWholeRows).toBeLessThanOrEqual(1);
    const tail = samples.filter((sample) => sample.at >= 6000);
    expect(
      Math.max(...tail.map((sample) => sample.pending + sample.parserPending)),
    ).toBeLessThanOrEqual(32 + Math.ceil((160 * (200 + 96)) / 1000));
    dom = raw;
    await render(view(true));
    for (let frame = 0; frame < hz * 3 && frames.size; frame++) {
      now += frameMs;
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => callbacks.forEach((callback) => callback(now)));
      assertFits();
    }
    expect(fifo!.pendingGraphemeCount).toBe(0);
    expect(hiddenHighlight()).toBeUndefined();
    expect(frames.size).toBe(0);
  });
});
