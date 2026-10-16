// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  StreamingMarkdownFootnoteItem,
  StreamingMarkdownFootnotes,
} from "./StreamingMarkdownFootnotes";

class TestHighlight extends Set<AbstractRange> {}
let page: HTMLDivElement;
let root: Root;
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
async function render({ blocked = false, streaming = true, complete = false } = {}) {
  await act(() =>
    root.render(
      <StreamingMarkdownFootnotes
        host={page}
        inlineHost={page}
        detached={streaming}
        streaming={streaming}
        smooth
        autoCollapse
        mode="character"
        lineMode="adaptive"
        fadeDurationMs={200}
        items={[{ id: "note", text: "Footnote body", complete, blocked }]}
      >
        <ol>
          <StreamingMarkdownFootnoteItem id="note">
            <p>Footnote body</p>
          </StreamingMarkdownFootnoteItem>
        </ol>
      </StreamingMarkdownFootnotes>,
    ),
  );
}
function occupied() {
  const widget = page.querySelector<HTMLElement>(".streaming-markdown-footnotes");
  if (!widget || widget.hidden) return 0;
  const heading = page.querySelector<HTMLElement>("[data-smooth-footnote-heading]");
  const body = page.querySelector<HTMLElement>("li > [data-smooth-text-frame]");
  const explicit = Number.parseFloat(heading?.style.height ?? "");
  return (
    (Number.isFinite(explicit) ? explicit : headingHeight) +
    (body?.closest("[hidden]") ? 0 : Number.parseFloat(body?.style.height ?? "") || 0)
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  now = 0;
  reduced = false;
  let next = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
  page = document.createElement("div");
  document.body.append(page);
  root = createRoot(page);
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
});
afterEach(async () => {
  await act(() => root.unmount());
  page.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalBounds)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
});

it("gives the entire first heading space before exposing the footnote body", async () => {
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
  await render({ blocked: true });
  for (let index = 0; index < 80; index++) await step();
  expect(occupied()).toBe(0);
  await render();
  expect(occupied()).toBe(0);
  for (let index = 0; index < 160; index++) await step();
  expect(occupied()).toBeGreaterThanOrEqual(headingHeight);
});

it.each(["history", "reduced"])("does not delay %s headings", async (mode) => {
  reduced = mode === "reduced";
  await render({ streaming: mode !== "history" });
  expect(occupied()).toBeGreaterThanOrEqual(headingHeight);
});

it("does not leave panel padding visible after the group closes", async () => {
  await render({ complete: true });
  for (let index = 0; index < 220; index++) await step();
  expect(
    page.querySelector("[data-stream-footnotes]")?.getAttribute("data-markdown-details-open"),
  ).toBe("false");
  expect(page.querySelector<HTMLElement>("[data-slot=collapsible-panel]")?.hidden).toBe(true);
});
