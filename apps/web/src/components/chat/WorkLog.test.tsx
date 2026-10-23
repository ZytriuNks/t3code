// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkLogDetails } from "./WorkLog";

// jsdom has no layout, so the scroller's geometry is simulated: a 384px
// viewport over content whose height the test grows like a streamed trace.
const VIEWPORT = 384;
let contentHeight = 0;
let scrollTop = 0;
const resizeCallbacks = new Set<() => void>();

let root: Root;
let host: HTMLDivElement;

function render(followLive: boolean, text: string) {
  act(() => {
    root.render(
      <WorkLogDetails followLive={followLive}>
        <p>{text}</p>
      </WorkLogDetails>,
    );
  });
}

function scroller() {
  const element = host.querySelector("p")?.parentElement;
  if (!(element instanceof HTMLDivElement)) throw new Error("missing scroller");
  return element;
}

function stream(followLive: boolean, text: string) {
  contentHeight += 200;
  render(followLive, text);
  act(() => resizeCallbacks.forEach((callback) => callback()));
}

function readerScrollsTo(top: number) {
  scroller().scrollTop = top;
  act(() => {
    scroller().dispatchEvent(new Event("scroll"));
  });
}

const maxScrollTop = () => contentHeight - VIEWPORT;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  contentHeight = 1000;
  scrollTop = 0;
  Object.defineProperties(HTMLDivElement.prototype, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollHeight: { configurable: true, get: () => contentHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, maxScrollTop()));
      },
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const key of ["clientHeight", "scrollHeight", "scrollTop"]) {
    Reflect.deleteProperty(HTMLDivElement.prototype, key);
  }
  resizeCallbacks.clear();
  vi.unstubAllGlobals();
});

describe("WorkLogDetails followLive", () => {
  it("navigates the same streamed text viewport with the compact scrollbar", () => {
    render(true, "a");
    const viewport = scroller();
    const lane = host.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
    expect(lane).not.toBeNull();
    viewport.scrollTo = (options: ScrollToOptions | number = {}, y: number = 0) => {
      viewport.scrollTop = typeof options === "number" ? y : (options.top ?? 0);
      viewport.dispatchEvent(new Event("scroll"));
    };
    act(() => lane!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(scrollTop).toBe(0);
    stream(true, "ab");
    expect(scrollTop).toBe(0);
    act(() => lane!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(scrollTop).toBe(maxScrollTop());
    stream(true, "abc");
    expect(scrollTop).toBe(maxScrollTop());
  });

  it("keeps the newest streamed text in view", () => {
    render(true, "a");
    expect(scrollTop).toBe(maxScrollTop());

    stream(true, "ab");
    stream(true, "abc");
    expect(scrollTop).toBe(maxScrollTop());
  });

  it("stops following when the reader scrolls up and resumes at the end", () => {
    render(true, "a");
    readerScrollsTo(100);

    stream(true, "ab");
    expect(scrollTop).toBe(100);

    readerScrollsTo(maxScrollTop());
    stream(true, "abc");
    expect(scrollTop).toBe(maxScrollTop());
  });

  it("does not move a trace that is not streaming", () => {
    render(false, "a");
    stream(false, "ab");
    expect(scrollTop).toBe(0);
  });
});
