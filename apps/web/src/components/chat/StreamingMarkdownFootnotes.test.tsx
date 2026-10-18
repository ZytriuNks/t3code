// @vitest-environment jsdom
import { act, Profiler, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  StreamingFootnoteHost,
  StreamingFootnoteHostContext,
  StreamingFootnoteProvider,
  StreamingMarkdownFootnotes,
  StreamingMarkdownFootnoteItem,
} from "./StreamingMarkdownFootnotes";
import { use } from "react";

let root: Root;
let page: HTMLDivElement;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let clock: number;

const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

class TestHighlight extends Set<AbstractRange> {}

function enableSmoothPlayback() {
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map<string, TestHighlight>() });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return { bottom: 20, height: this.toString().trim() ? 10 : 0 } as DOMRect;
    },
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
}

async function stepPlayback(ms = 16) {
  clock += ms;
  await act(async () => {
    vi.advanceTimersByTime(ms);
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(clock));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function backrefPhase(link: HTMLElement) {
  return link.style.visibility === "hidden"
    ? "waiting"
    : (link.dataset.smoothFootnoteBackref ?? "ready");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page = document.createElement("div");
  host = document.createElement("div");
  document.body.append(page, host);
  root = createRoot(page);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  let frameId = 0;
  clock = 0;
  frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(async () => {
  await act(() => root.unmount());
  page.remove();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (rangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBounds);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
});

function Body({
  text = "first",
  detached = true,
  target = host,
  second = false,
  autoCollapse = false,
  finished = false,
}: {
  text?: string;
  detached?: boolean;
  target?: HTMLElement | null;
  second?: boolean;
  autoCollapse?: boolean;
  finished?: boolean;
}) {
  return (
    <StreamingMarkdownFootnotes
      host={target}
      detached={detached}
      streaming={detached}
      smooth={false}
      mode="character"
      lineMode="adaptive"
      autoCollapse={autoCollapse}
      items={[
        { id: "footnote-one", text, complete: finished || !detached },
        ...(second
          ? [{ id: "footnote-two", text: "second", complete: finished || !detached }]
          : []),
      ]}
    >
      <ol>
        <StreamingMarkdownFootnoteItem id="footnote-one">
          <p>
            {text}
            <a href="#reference-one">↩</a>
          </p>
        </StreamingMarkdownFootnoteItem>
        {second ? (
          <StreamingMarkdownFootnoteItem id="footnote-two">second</StreamingMarkdownFootnoteItem>
        ) : null}
      </ol>
    </StreamingMarkdownFootnotes>
  );
}

describe("footnote backref playback", () => {
  const view = ({
    text = "AB",
    complete = true,
    secondRef = false,
    smooth = true,
    streaming = true,
    duration = 200,
    collapse = false,
    queued = false,
    block = "paragraph",
  }: {
    text?: string;
    complete?: boolean;
    secondRef?: boolean;
    smooth?: boolean;
    streaming?: boolean;
    duration?: number;
    collapse?: boolean;
    queued?: boolean;
    block?: "paragraph" | "paragraphs" | "code" | "list";
  } = {}) => (
    <StreamingMarkdownFootnotes
      host={host}
      detached
      streaming={streaming}
      smooth={smooth}
      mode="character"
      lineMode="adaptive"
      fadeDurationMs={duration}
      autoCollapse={collapse}
      items={[
        { id: "footnote-one", text, complete },
        ...(queued ? [{ id: "footnote-two", text: "CD", complete: true }] : []),
      ]}
    >
      <ol>
        <StreamingMarkdownFootnoteItem id="footnote-one">
          {block === "code" ? (
            <pre>
              <code>{text}</code>
            </pre>
          ) : block === "list" ? (
            <ul>
              <li>{text}</li>
            </ul>
          ) : block === "paragraphs" ? (
            <>
              <p>Prefix</p>
              <p>{text}</p>
            </>
          ) : (
            <p>{text}</p>
          )}
          <p>
            <a data-footnote-backref="" href="#reference-one" aria-label="Back to reference 1">
              ↩
            </a>
            {secondRef ? (
              <a data-footnote-backref="" href="#reference-two" aria-label="Back to reference 2">
                ↩<sup>2</sup>
              </a>
            ) : null}
          </p>
        </StreamingMarkdownFootnoteItem>
        {queued ? (
          <StreamingMarkdownFootnoteItem id="footnote-two">
            <p>CD</p>
            <p>
              <a data-footnote-backref="" href="#reference-two">
                ↩
              </a>
            </p>
          </StreamingMarkdownFootnoteItem>
        ) : null}
      </ol>
    </StreamingMarkdownFootnotes>
  );

  async function finishBody(link: HTMLElement) {
    for (let frame = 0; frame < 250 && backrefPhase(link) === "waiting"; frame++)
      await stepPlayback();
    expect(backrefPhase(link)).not.toBe("waiting");
  }

  it("drains a completed footnote instead of replaying it one glyph at a time", async () => {
    enableSmoothPlayback();
    const text = "A".repeat(200);
    await act(() => root.render(view({ text, complete: true, streaming: false })));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    const started = clock;
    await finishBody(link);
    expect(clock - started).toBeLessThanOrEqual(400);
  });

  it("hides an already displayed backref while appended text waits for its new tail fade", async () => {
    enableSmoothPlayback();
    await act(() => root.render(view()));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    await finishBody(link);
    await stepPlayback(200);
    expect(backrefPhase(link)).toBe("ready");
    await act(() => root.render(view({ text: "AB new tail", complete: false })));
    expect(backrefPhase(link)).toBe("waiting");
    expect(CSS.highlights.get("t3-smooth-hidden")?.size ?? 0).toBeGreaterThan(0);
    const hiddenTail = CSS.highlights.get("t3-smooth-hidden") as TestHighlight;
    const hiddenText = [...hiddenTail]
      .map((range) => {
        const copy = document.createRange();
        copy.setStart(range.startContainer, range.startOffset);
        copy.setEnd(range.endContainer, range.endOffset);
        return copy.toString();
      })
      .join("");
    expect(hiddenText).not.toContain("AB");
    await stepPlayback(400);
    expect(backrefPhase(link)).toBe("waiting");
    await act(() => root.render(view({ text: "AB new tail" })));
    await finishBody(link);
    expect(backrefPhase(link)).toBe("enter");
    await stepPlayback(200);
    expect(backrefPhase(link)).toBe("ready");
  });

  it("waits for an appended completed snapshot's new glyphs rather than replaying the prefix", async () => {
    enableSmoothPlayback();
    await act(() => root.render(view()));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    await finishBody(link);
    await stepPlayback(200);
    await act(() => root.render(view({ text: "AB a completed appended tail" })));
    expect(backrefPhase(link)).toBe("waiting");
    expect(CSS.highlights.get("t3-smooth-hidden")?.size ?? 0).toBeGreaterThan(0);
    await finishBody(link);
    expect(backrefPhase(link)).toBe("enter");
  });

  it("animates only a newly added reference without replaying completed body or collapsing over it", async () => {
    enableSmoothPlayback();
    await act(() => root.render(view({ collapse: true })));
    const first = host.querySelector<HTMLAnchorElement>("a")!;
    await finishBody(first);
    await stepPlayback(200);
    await stepPlayback(600);
    await act(() => root.render(view({ collapse: true, secondRef: true })));
    const second = host.querySelectorAll<HTMLAnchorElement>("a")[1]!;
    expect(backrefPhase(first)).toBe("ready");
    expect(backrefPhase(second)).toBe("enter");
    expect(CSS.highlights.get("t3-smooth-hidden")?.size ?? 0).toBe(0);
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await stepPlayback(60);
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await stepPlayback(140);
    expect(backrefPhase(second)).toBe("ready");
    await stepPlayback(649);
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await stepPlayback(1);
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
  });

  it("resumes an interrupted tail after hiding and expanding without replaying completed glyphs", async () => {
    enableSmoothPlayback();
    await act(() => root.render(view()));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    await finishBody(link);
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await act(() => widget.querySelector<HTMLButtonElement>("button")!.click());
    const end = new Event("transitionend", { bubbles: true });
    Object.defineProperty(end, "propertyName", { value: "height" });
    await act(() => widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(end));
    await stepPlayback(500);
    expect(link.closest("li")!.hidden).toBe(true);
    await act(() => widget.dispatchEvent(new Event("t3-expand-footnotes")));
    expect(backrefPhase(link)).toBe("enter");
    expect(CSS.highlights.get("t3-smooth-hidden")?.size ?? 0).toBe(0);
    await stepPlayback(200);
    expect(backrefPhase(link)).toBe("ready");
  });

  it("does not advance a queued note until every outgoing backref has finished entering", async () => {
    enableSmoothPlayback();
    const queued = (
      <StreamingMarkdownFootnotes
        host={host}
        detached
        streaming
        smooth
        mode="character"
        lineMode="adaptive"
        autoCollapse
        items={[
          { id: "footnote-one", text: "AB", complete: true },
          { id: "footnote-two", text: "CD", complete: true },
        ]}
      >
        <ol>
          <StreamingMarkdownFootnoteItem id="footnote-one">
            <p>
              AB{" "}
              <a data-footnote-backref="" href="#one">
                ↩
              </a>{" "}
              <a data-footnote-backref="" href="#one-two">
                ↩
              </a>
            </p>
          </StreamingMarkdownFootnoteItem>
          <StreamingMarkdownFootnoteItem id="footnote-two">
            <p>
              CD{" "}
              <a data-footnote-backref="" href="#two">
                ↩
              </a>
            </p>
          </StreamingMarkdownFootnoteItem>
        </ol>
      </StreamingMarkdownFootnotes>
    );
    await act(() => root.render(queued));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const items = widget.querySelectorAll("li");
    const links = widget.querySelectorAll<HTMLAnchorElement>("a");
    expect(items[1]!.hidden).toBe(true);
    await finishBody(links[0]!);
    expect(backrefPhase(links[0]!)).toBe("enter");
    expect(backrefPhase(links[1]!)).toBe("enter");
    await stepPlayback(199);
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    expect(items[1]!.hidden).toBe(true);
    await stepPlayback(1);
    await stepPlayback(249);
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await stepPlayback(1);
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    const end = new Event("transitionend", { bubbles: true });
    Object.defineProperty(end, "propertyName", { value: "height" });
    await act(() => widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(end));
    expect(items[0]!.hidden).toBe(true);
    expect(items[1]!.hidden).toBe(false);
    expect(backrefPhase(links[2]!)).toBe("waiting");
    await finishBody(links[2]!);
    expect(backrefPhase(links[2]!)).toBe("enter");
  });

  it.each(["visibility", "(prefers-reduced-motion: reduce)", "(forced-colors: active)"])(
    "keeps a queued note waiting for its body after temporary %s bypass",
    async (bypass) => {
      enableSmoothPlayback();
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      const media = new Map<string, EventTarget & { matches: boolean }>();
      vi.stubGlobal("matchMedia", (query: string) => {
        if (!media.has(query))
          media.set(query, Object.assign(new EventTarget(), { matches: false }));
        return media.get(query)!;
      });
      const setBypass = (active: boolean) => {
        if (bypass === "visibility") {
          hidden.mockReturnValue(active);
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          const query = media.get(bypass)!;
          query.matches = active;
          query.dispatchEvent(new Event("change"));
        }
      };
      await act(() => root.render(view({ collapse: true, queued: true })));
      const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      const items = widget.querySelectorAll("li");
      const links = widget.querySelectorAll<HTMLAnchorElement>("a");
      expect(items[1]!.hidden).toBe(true);
      expect(backrefPhase(links[1]!)).toBe("waiting");
      await act(() => setBypass(true));
      await act(() => root.render(view({ collapse: true, queued: true })));
      await act(() => setBypass(false));
      expect(backrefPhase(links[0]!)).toBe("ready");
      await stepPlayback(249);
      expect(widget.dataset.markdownDetailsOpen).toBe("true");
      expect(items[1]!.hidden).toBe(true);
      await stepPlayback(1);
      expect(widget.dataset.markdownDetailsOpen).toBe("false");
      const end = new Event("transitionend", { bubbles: true });
      Object.defineProperty(end, "propertyName", { value: "height" });
      await act(() => widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(end));
      expect(items[1]!.hidden).toBe(false);
      const masks = CSS.highlights.get("t3-smooth-hidden") as TestHighlight;
      expect([...masks].some((range) => items[1]!.contains(range.startContainer))).toBe(true);
      expect(backrefPhase(links[1]!)).toBe("waiting");
      await finishBody(links[1]!);
      expect(backrefPhase(links[1]!)).toBe("enter");
      await stepPlayback(200);
      expect(backrefPhase(links[1]!)).toBe("ready");
    },
  );

  it("finishes an empty note's tail when Strict Mode replays its mount effects", async () => {
    enableSmoothPlayback();
    await act(() => root.render(<StrictMode>{view({ text: "" })}</StrictMode>));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    await finishBody(link);
    expect(backrefPhase(link)).toBe("enter");
    await stepPlayback(200);
    expect(backrefPhase(link)).toBe("ready");
  });

  it("does not commit React renders while the local navigation tail enters", async () => {
    enableSmoothPlayback();
    let commits = 0;
    await act(() =>
      root.render(
        <Profiler
          id="footnotes"
          onRender={() => {
            commits++;
          }}
        >
          {view()}
        </Profiler>,
      ),
    );
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    await finishBody(link);
    expect(backrefPhase(link)).toBe("enter");
    // The heading's one-time admission commit precedes this local tail.
    const initialCommits = commits;
    await stepPlayback(100);
    expect(backrefPhase(link)).toBe("enter");
    await stepPlayback(100);
    expect(backrefPhase(link)).toBe("ready");
    expect(commits).toBe(initialCommits);
  });

  it.each(["(prefers-reduced-motion: reduce)", "(forced-colors: active)"])(
    "settles an in-flight tail when %s becomes active",
    async (query) => {
      enableSmoothPlayback();
      const listeners = new Map<string, () => void>();
      const media = new Map<
        string,
        {
          matches: boolean;
          addEventListener: (_type: string, listener: () => void) => void;
          removeEventListener: () => void;
        }
      >();
      vi.stubGlobal("matchMedia", (key: string) => {
        if (!media.has(key))
          media.set(key, {
            matches: false,
            addEventListener: (_type, listener) => {
              listeners.set(key, listener);
            },
            removeEventListener: () => {},
          });
        return media.get(key)!;
      });
      await act(() => root.render(view()));
      const link = host.querySelector<HTMLAnchorElement>("a")!;
      await finishBody(link);
      expect(backrefPhase(link)).toBe("enter");
      media.get(query)!.matches = true;
      await act(() => listeners.get(query)!());
      expect(backrefPhase(link)).toBe("ready");
    },
  );

  it("still waits for the FIFO with zero-duration fades, then shows the backref without animation", async () => {
    enableSmoothPlayback();
    await act(() => root.render(view({ duration: 0 })));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(backrefPhase(link)).toBe("waiting");
    await finishBody(link);
    expect(backrefPhase(link)).toBe("ready");
  });

  it.each(["history", "non-smooth", "unsupported", "reduced-motion", "forced-colors"])(
    "shows navigation immediately for %s",
    async (fallback) => {
      if (fallback !== "unsupported") enableSmoothPlayback();
      if (fallback === "reduced-motion" || fallback === "forced-colors")
        vi.stubGlobal("matchMedia", (query: string) => ({
          matches:
            query ===
            (fallback === "reduced-motion"
              ? "(prefers-reduced-motion: reduce)"
              : "(forced-colors: active)"),
          addEventListener: () => {},
          removeEventListener: () => {},
        }));
      await act(() =>
        root.render(
          view({
            streaming: fallback !== "history",
            smooth: fallback !== "non-smooth",
            duration: 200,
            complete: fallback === "history",
          }),
        ),
      );
      expect(backrefPhase(host.querySelector<HTMLAnchorElement>("a")!)).toBe("ready");
    },
  );

  it.each(["non-smooth", "unsupported"])(
    "shows a queued note's navigation after opening with %s static output",
    async (fallback) => {
      enableSmoothPlayback();
      if (fallback === "unsupported") vi.stubGlobal("Highlight", undefined);
      await act(() =>
        root.render(view({ collapse: true, queued: true, smooth: fallback !== "non-smooth" })),
      );
      const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      const items = widget.querySelectorAll("li");
      expect(items[1]!.hidden).toBe(true);
      await stepPlayback(250);
      expect(widget.dataset.markdownDetailsOpen).toBe("false");
      const end = new Event("transitionend", { bubbles: true });
      Object.defineProperty(end, "propertyName", { value: "height" });
      await act(() => widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(end));
      expect(items[1]!.hidden).toBe(false);
      expect(backrefPhase(items[1]!.querySelector<HTMLAnchorElement>("a")!)).toBe("ready");
      await stepPlayback(650);
      expect(widget.dataset.markdownDetailsOpen).toBe("false");
    },
  );

  it.each(["paragraph", "paragraphs", "code", "list"] as const)(
    "waits for the %s tail's FIFO and fade before entering every backref",
    async (block) => {
      enableSmoothPlayback();
      await act(() => root.render(view({ block, secondRef: true, collapse: true })));
      const links = [...host.querySelectorAll<HTMLAnchorElement>("a[data-footnote-backref]")];
      expect(links.map(backrefPhase)).toEqual(["waiting", "waiting"]);
      const hidden = CSS.highlights.get("t3-smooth-hidden") as TestHighlight | undefined;
      expect(
        [...(hidden ?? [])]
          .map((range) => {
            const copy = document.createRange();
            copy.setStart(range.startContainer, range.startOffset);
            copy.setEnd(range.endContainer, range.endOffset);
            return copy.toString();
          })
          .join(""),
      ).not.toContain("↩");
      let entered = false;
      for (let frame = 0; frame < 250; frame++) {
        await stepPlayback();
        if (links.some((link) => backrefPhase(link) === "enter")) {
          entered = true;
          expect(
            [...CSS.highlights.entries()]
              .filter(([name]) => name.startsWith("t3-smooth-fade-"))
              .flatMap(([, ranges]) => [...ranges]),
          ).toHaveLength(0);
          break;
        }
        expect(links.map(backrefPhase)).toEqual(["waiting", "waiting"]);
      }
      expect(entered).toBe(true);
      expect(links.map(backrefPhase)).toEqual(["enter", "enter"]);
      expect(links[0]!.getAttribute("href")).toBe("#reference-one");
      expect(links[1]!.getAttribute("aria-label")).toBe("Back to reference 2");
      const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      await stepPlayback(199);
      expect(widget.dataset.markdownDetailsOpen).toBe("true");
      await stepPlayback(1);
      expect(links.map(backrefPhase)).toEqual(["ready", "ready"]);
      await stepPlayback(649);
      expect(widget.dataset.markdownDetailsOpen).toBe("true");
      await stepPlayback(1);
      expect(widget.dataset.markdownDetailsOpen).toBe("false");
    },
  );
});

describe("streaming footnote ownership", () => {
  it("keeps the same local placement when source playback and Thinking end separately", async () => {
    const local = document.createElement("div");
    document.body.append(local);
    const view = (streaming: boolean) => (
      <StreamingMarkdownFootnotes
        host={host}
        inlineHost={local}
        detached={streaming}
        streaming={streaming}
        smooth={false}
        mode="character"
        lineMode="adaptive"
      >
        <ol>
          <li>Note</li>
        </ol>
      </StreamingMarkdownFootnotes>
    );
    try {
      await act(() => root.render(view(true)));
      const widget = local.querySelector("[data-stream-footnotes]");
      expect(widget).not.toBeNull();
      await act(() => root.render(view(false)));
      expect(local.querySelector("[data-stream-footnotes]")).toBe(widget);
      expect(host.querySelector("[data-stream-footnotes]")).toBeNull();
    } finally {
      local.remove();
    }
  });

  it("does not restart the completed note's reading pause when another note arrives", async () => {
    await act(() => root.render(<Body autoCollapse finished />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await act(() => vi.advanceTimersByTime(500));
    await act(() => root.render(<Body autoCollapse second finished />));
    await act(() => vi.advanceTimersByTime(1));
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
  });

  it("cancels automatic collapse when a note grows again or the reader expands it", async () => {
    await act(() => root.render(<Body autoCollapse finished />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await act(() => vi.advanceTimersByTime(500));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await act(() => root.render(<Body autoCollapse text="continued note" />));
    await act(() => vi.advanceTimersByTime(1000));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await act(() => root.render(<Body autoCollapse text="continued note" finished />));
    await act(() => vi.advanceTimersByTime(500));
    await act(() => widget.dispatchEvent(new Event("t3-expand-footnotes")));
    await act(() => vi.advanceTimersByTime(1000));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
  });

  it("finishes a manual collapse before opening a newly queued footnote", async () => {
    await act(() => root.render(<Body />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await act(() => widget.querySelector<HTMLButtonElement>("button")!.click());
    await act(() => root.render(<Body second />));
    const [first, second] = [...widget.querySelectorAll("li")];
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    expect(first!.hidden).toBe(false);
    expect(second!.hidden).toBe(true);
    const event = new Event("transitionend", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "height" });
    await act(() => widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(event));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    expect(first!.hidden).toBe(true);
    expect(second!.hidden).toBe(false);
    expect(second!.value).toBe(2);
  });

  it("keeps a reopened panel visible when an interrupted collapse reports completion", async () => {
    await act(() => root.render(<Body second />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const toggle = widget.querySelector<HTMLButtonElement>("button")!;
    await act(() => toggle.click());
    await act(() => toggle.click());
    const event = new Event("transitionend", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "height" });
    await act(() => widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(event));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    expect([...widget.querySelectorAll("li")].every((item) => !item.hidden)).toBe(true);
  });

  it("keeps every displayed item during manual collapse and hides them after the height transition", async () => {
    await act(() => root.render(<Body second />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const items = [...widget.querySelectorAll("li")];
    await act(() => widget.querySelector<HTMLButtonElement>("button")!.click());
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    expect(items.every((item) => !item.hidden)).toBe(true);
    const panel = widget.querySelector('[data-slot="collapsible-panel"]')!;
    const event = new Event("transitionend", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "height" });
    await act(() => panel.dispatchEvent(event));
    expect(items.every((item) => item.hidden)).toBe(true);
    await act(() => widget.querySelector<HTMLButtonElement>("button")!.click());
    expect(items.every((item) => !item.hidden)).toBe(true);
  });

  it("clears a queued footnote removed by a Markdown rewrite", async () => {
    await act(() => root.render(<Body autoCollapse second />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await act(() => root.render(<Body autoCollapse second finished />));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await act(() => vi.advanceTimersByTime(250));
    const panel = widget.querySelector('[data-slot="collapsible-panel"]')!;
    const event = new Event("transitionend", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "height" });
    await act(() => panel.dispatchEvent(event));
    expect(widget.querySelectorAll("li")[1]!.hidden).toBe(false);
    await act(() => root.render(<Body autoCollapse finished />));
    expect(widget.querySelectorAll("li")).toHaveLength(1);
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
  });
  it("applies changed auto-collapse preferences without replaying existing footnotes", async () => {
    await act(() => root.render(<Body detached={false} />));
    const widget = page.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const item = widget.querySelector("li");
    await act(() => root.render(<Body detached={false} autoCollapse />));
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    await act(() => root.render(<Body detached={false} />));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    expect(widget.querySelector("li")).toBe(item);
  });
  it("shows only one new footnote while collapsed, waits for collapse, then opens the next", async () => {
    await act(() => root.render(<Body autoCollapse />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const first = widget.querySelector("li")!;
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await act(() => root.render(<Body autoCollapse second />));
    const second = widget.querySelectorAll("li")[1]!;
    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(true);
    await act(() => root.render(<Body autoCollapse second finished />));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await act(() => vi.advanceTimersByTime(250));
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    expect(first.hidden).toBe(false);
    const panel = widget.querySelector('[data-slot="collapsible-panel"]')!;
    const completeTransition = () => {
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "height" });
      panel.dispatchEvent(event);
    };
    await act(completeTransition);
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    await act(() => vi.advanceTimersByTime(650));
    await act(completeTransition);
    expect(second.hidden).toBe(true);
    expect(widget.querySelectorAll("li")[0]).toBe(first);
    expect(widget.querySelectorAll("li")[1]).toBe(second);
  });

  describe("a run of notes written back to back", () => {
    const run = ({ second, finished }: { second: boolean; finished: boolean }) => (
      <StreamingMarkdownFootnotes
        host={host}
        detached
        streaming
        smooth={false}
        mode="character"
        lineMode="adaptive"
        autoCollapse
        items={[
          { id: "footnote-one", text: "first", complete: second || finished },
          ...(second
            ? [{ id: "footnote-two", text: "second", complete: finished, follows: "footnote-one" }]
            : []),
        ]}
      >
        <ol>
          <StreamingMarkdownFootnoteItem id="footnote-one">first</StreamingMarkdownFootnoteItem>
          {second ? (
            <StreamingMarkdownFootnoteItem id="footnote-two">second</StreamingMarkdownFootnoteItem>
          ) : null}
        </ol>
      </StreamingMarkdownFootnotes>
    );
    const completeTransition = (widget: HTMLElement) => {
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "height" });
      widget.querySelector('[data-slot="collapsible-panel"]')!.dispatchEvent(event);
    };

    it("plays every note of the run, then collapses them together", async () => {
      await act(() => root.render(run({ second: false, finished: false })));
      const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      const first = widget.querySelector("li")!;
      await act(() => root.render(run({ second: true, finished: false })));
      const second = widget.querySelectorAll("li")[1]!;
      // The first note is finished, but the next one continues the run.
      expect(widget.dataset.markdownDetailsOpen).toBe("true");
      expect(first.hidden).toBe(false);
      expect(second.hidden).toBe(false);
      await act(() => vi.advanceTimersByTime(1_000));
      expect(widget.dataset.markdownDetailsOpen).toBe("true");
      await act(() => root.render(run({ second: true, finished: true })));
      await act(() => vi.advanceTimersByTime(650));
      expect(widget.dataset.markdownDetailsOpen).toBe("false");
      // Both stay measurable until the shared collapse reaches zero height.
      expect(first.hidden).toBe(false);
      expect(second.hidden).toBe(false);
      await act(() => completeTransition(widget));
      expect(first.hidden).toBe(true);
      expect(second.hidden).toBe(true);
      expect(widget.dataset.markdownDetailsOpen).toBe("false");
    });

    it("keeps the run open when its next note arrives during the reading pause", async () => {
      await act(() => root.render(run({ second: false, finished: true })));
      const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      const first = widget.querySelector("li")!;
      await act(() => vi.advanceTimersByTime(300));
      await act(() => root.render(run({ second: true, finished: false })));
      await act(() => vi.advanceTimersByTime(1_000));
      const second = widget.querySelectorAll("li")[1]!;
      expect(widget.dataset.markdownDetailsOpen).toBe("true");
      expect(first.hidden).toBe(false);
      expect(second.hidden).toBe(false);
    });
  });
  it("moves the same default-open widget into the body and preserves a user collapse and footnote nodes", async () => {
    await act(() => root.render(<Body />));
    const widget = host.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const item = host.querySelector("li")!;
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    await act(() => {
      widget.querySelector<HTMLButtonElement>("button")!.click();
    });
    await act(() => root.render(<Body text="first extended" detached={false} />));
    expect(host.childElementCount).toBe(0);
    expect(page.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(page.querySelector("li")).toBe(item);
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    expect(item.textContent).toBe("first extended↩");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("#reference-one");
    await act(() => root.unmount());
    expect(document.querySelector("[data-stream-footnotes]")).toBeNull();
  });

  it("keeps displayed nodes when the Thinking host mounts later and when another footnote is appended", async () => {
    await act(() => root.render(<Body target={null} />));
    const widget = page.querySelector("[data-stream-footnotes]")!;
    const item = page.querySelector("li")!;
    await act(() => root.render(<Body />));
    expect(host.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(host.querySelector("li")).toBe(item);
    await act(() => root.render(<Body second />));
    expect(host.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(host.querySelector("li")).toBe(item);
    expect(host.querySelectorAll("li")).toHaveLength(2);
    await act(() => root.unmount());
    expect(host.childElementCount).toBe(0);
  });

  it("mounts footnotes immediately above Thinking through the shared host", async () => {
    function LinkedBody() {
      const target = use(StreamingFootnoteHostContext);
      return <Body target={target} />;
    }
    function Timeline() {
      const [thinking, setThinking] = useState(true);
      return (
        <StreamingFootnoteProvider>
          <LinkedBody />
          <StreamingFootnoteHost fallback />
          <button onClick={() => setThinking(false)}>Finish</button>
          {thinking ? (
            <>
              <StreamingFootnoteHost />
              <span>Thinking</span>
            </>
          ) : null}
        </StreamingFootnoteProvider>
      );
    }
    await act(() => root.render(<Timeline />));
    const sinks = page.querySelectorAll("[data-stream-footnote-host]");
    const sink = sinks[1]!;
    const widget = sink.querySelector("[data-stream-footnotes]")!;
    expect(sink.nextElementSibling?.textContent).toBe("Thinking");
    await act(() => page.querySelector<HTMLButtonElement>("button")!.click());
    expect(page.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(sinks[0]!.querySelector("[data-stream-footnotes]")).toBe(widget);
  });

  it("expands on reference navigation and preserves the same footnote content", async () => {
    await act(() => root.render(<Body autoCollapse detached={false} />));
    const widget = page.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    const item = widget.querySelector("li");
    expect(widget.dataset.markdownDetailsOpen).toBe("false");
    await act(() => widget.dispatchEvent(new Event("t3-expand-footnotes")));
    expect(widget.dataset.markdownDetailsOpen).toBe("true");
    expect(widget.querySelector("li")).toBe(item);
  });

  it("keeps completed message footnotes above Thinking until the activity ends", async () => {
    function LinkedBody({ streaming }: { streaming: boolean }) {
      const target = use(StreamingFootnoteHostContext);
      return <Body target={target} detached={streaming} />;
    }
    function Timeline({ streaming, thinking }: { streaming: boolean; thinking: boolean }) {
      return (
        <StreamingFootnoteProvider>
          <LinkedBody streaming={streaming} />
          <StreamingFootnoteHost fallback />
          {thinking ? (
            <>
              <StreamingFootnoteHost />
              <span>Thinking</span>
            </>
          ) : null}
        </StreamingFootnoteProvider>
      );
    }
    await act(() => root.render(<Timeline streaming thinking />));
    const liveHost = page.querySelectorAll("[data-stream-footnote-host]")[1]!;
    const widget = liveHost.querySelector("[data-stream-footnotes]")!;
    const item = widget.querySelector("li");
    await act(() => root.render(<Timeline streaming={false} thinking />));
    expect(liveHost.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(widget.querySelector("li")).toBe(item);
    await act(() => root.render(<Timeline streaming={false} thinking={false} />));
    expect(page.querySelector("[data-smooth-footnotes-inline]")?.contains(widget)).toBe(true);
    expect(widget.querySelector("li")).toBe(item);
    expect(widget.getAttribute("data-markdown-details-open")).toBe("true");
  });
});
