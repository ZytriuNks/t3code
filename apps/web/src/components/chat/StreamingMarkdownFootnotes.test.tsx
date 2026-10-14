// @vitest-environment jsdom
import { act, useState } from "react";
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page = document.createElement("div");
  host = document.createElement("div");
  document.body.append(page, host);
  root = createRoot(page);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
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
