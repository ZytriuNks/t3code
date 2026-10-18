// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "../ChatMarkdown";

class TestHighlight extends Set<AbstractRange> {}

let root: Root;
let page: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let clock: number;
let identities: WeakMap<Node, number>;
let nextIdentity: number;
let transitions: { at: number; node: number; attribute: string; previous: string | null }[];
let mutations: MutationObserver;
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const firstText = "Earlier complete note with a visible prefix.";
const secondText = "Later note that finishes after the first note.";

function identity(node: Node) {
  if (!identities.has(node)) identities.set(node, ++nextIdentity);
  return identities.get(node)!;
}

function authoredNodes(item: HTMLElement) {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("a[data-footnote-backref]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

// 记录隐藏高亮中的实际字符，而不以 textContent 或回调当作已经绘制的证据。
function snapshot(item: HTMLLIElement) {
  const nodes = authoredNodes(item);
  const masked = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
  let prefix = "";
  let reachedMask = false;
  for (const node of nodes) {
    for (let offset = 0; offset < node.length; offset++) {
      if (
        masked.some(
          (range) =>
            range.startContainer === node &&
            range.startOffset <= offset &&
            range.endOffset > offset,
        )
      )
        reachedMask = true;
      if (!reachedMask) prefix += node.data[offset];
    }
  }
  const content = item.querySelector<HTMLElement>(".flow-root")!;
  const fadeHighlights = [...CSS.highlights.entries()].filter(([name]) =>
    name.startsWith("t3-smooth-fade"),
  );
  return {
    at: clock,
    li: identity(item),
    content: identity(content),
    nodes: nodes.map(identity),
    text: nodes
      .map((node) => node.data)
      .join("")
      .trim(),
    prefix: prefix.trim(),
    fading: fadeHighlights.flatMap(([name, ranges]) =>
      [...ranges]
        .filter((range) => item.contains(range.startContainer))
        .map((range) => ({
          name,
          node: identity(range.startContainer),
          start: range.startOffset,
          end: range.endOffset,
        })),
    ),
    hidden: item.hidden,
    observer: content.hasAttribute("data-smooth-output"),
    started: content.hasAttribute("data-smooth-text-started"),
    style: content.getAttribute("style"),
    frameStyle: content.parentElement!.getAttribute("style"),
    widget: identity(item.closest("[data-stream-footnotes]")!),
  };
}

function notes() {
  return [...page.querySelectorAll<HTMLLIElement>("[data-footnotes] ol > li")];
}

async function step(ms = 16) {
  clock += ms;
  await act(async () => {
    vi.advanceTimersByTime(ms);
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(clock);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(text: string, streaming = true, complete = false) {
  await act(() =>
    root.render(
      <ChatMarkdown
        cwd={undefined}
        text={text}
        isStreaming={streaming}
        smoothComplete={complete}
        smoothStreaming
        footnotesAutoCollapse
        smoothOutputMode="character"
        smoothTextFadeDurationMs={200}
      />,
    ),
  );
}

// JSDOM 只补齐排版和浏览器 Highlight API；Markdown、FIFO、observer 和结束回调均为真实实现。
function rangeRects(range: Range) {
  const content = range.startContainer.parentElement?.closest<HTMLElement>(
    ".flow-root, [data-smooth-streaming]",
  );
  if (!content?.isConnected || content.closest("[hidden]") || !range.toString().trim()) return [];
  const before = document.createRange();
  before.setStart(content, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  before.setEnd(range.endContainer, range.endOffset);
  const end = before.toString().length;
  return Array.from(
    { length: Math.floor((end - 1) / 32) - Math.floor(start / 32) + 1 },
    (_, index) => new DOMRect(0, 100 + (Math.floor(start / 32) + index) * 20 + 3, 240, 14),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clock = 0;
  frames = new Map();
  identities = new WeakMap();
  nextIdentity = 0;
  transitions = [];
  let frameId = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map<string, TestHighlight>() });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      return rangeRects(this);
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      const rows = rangeRects(this);
      return rows.length
        ? new DOMRect(0, rows[0]!.top, 240, rows.at(-1)!.bottom - rows[0]!.top)
        : new DOMRect();
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.isConnected || this.closest("[hidden]")) return new DOMRect();
    const height = Math.ceil((this.textContent?.length ?? 0) / 32) * 20 + 20;
    return new DOMRect(
      0,
      100,
      256,
      this.matches("[data-smooth-text-frame]") && this.style.height
        ? Number.parseFloat(this.style.height)
        : height,
    );
  });
  page = document.createElement("div");
  document.body.append(page);
  root = createRoot(page);
  mutations = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== "attributes") continue;
      const target = record.target as HTMLElement;
      if (!target.closest("[data-footnotes]")) continue;
      transitions.push({
        at: clock,
        node: identity(target),
        attribute: record.attributeName!,
        previous: record.oldValue,
      });
    }
  });
  mutations.observe(page, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-smooth-output", "data-smooth-text-started", "hidden"],
  });
});

afterEach(async () => {
  mutations.disconnect();
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

describe("real markdown footnote lifecycle investigation", () => {
  it("grows the first live footnote heading after resuming a body with no historical notes", async () => {
    const history = "Earlier synchronized body.";
    const resume = {
      key: "first-note-after-body-history",
      baselineText: history,
      mountText: history,
      synchronized: true,
    };
    const show = (text: string) =>
      act(() =>
        root.render(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            isStreaming
            smoothStreaming
            footnotesAutoCollapse
            smoothOutputMode="character"
            smoothTextResume={resume}
          />,
        ),
      );
    await show(history);
    expect(notes()).toHaveLength(0);
    await show(`${history}\n\nLive body[^one].\n\n[^one]: ${firstText}\n\nBoundary.`);
    const heights: number[] = [];
    for (let index = 0; index < 300; index++) {
      const heading = page.querySelector<HTMLElement>("[data-smooth-footnote-heading]");
      heights.push(heading?.getBoundingClientRect().height ?? 0);
      await step();
    }
    const fullHeight = heights.at(-1)!;
    expect(fullHeight).toBeGreaterThan(0);
    expect(heights.filter((height) => height > 0 && height < fullHeight).length).toBeGreaterThan(2);
    expect(heights.find((height) => height > 0)).toBeLessThan(fullHeight / 2);
    expect(snapshot(notes()[0]!).prefix).toBe(firstText);
  });

  it.each([false, true])(
    "does not reclaim old glyphs after close/play-second/reopen (source complete before close: %s)",
    async (completeBeforeClose) => {
      let source = `One[^one] and two[^two].\n\n[^one]: ${firstText}`;
      await render(source);
      for (let index = 0; index < 180; index++) await step();
      const first = notes()[0]!;
      // 字形已播放到尾并不代表源定义封口。对照组先封口，区别仅为 close 与 complete 的顺序。
      if (completeBeforeClose) {
        source += "\n\nFirst boundary.";
        await render(source);
        for (let index = 0; index < 17; index++) await step();
      }
      const before = snapshot(first);
      expect(before.hidden).toBe(false);
      expect(before.prefix).toBe(firstText);
      expect(before.fading).toEqual([]);
      await act(() =>
        page.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!.click(),
      );
      for (let index = 0; index < 30; index++) await step();
      expect(first.hidden).toBe(true);
      await render(`${source}\n\n[^two]: ${secondText}\n\nBoundary.`);
      let secondPlayed = false;
      for (let index = 0; index < 400; index++) {
        await step();
        const second = notes()[1];
        if (second) {
          const sample = snapshot(second);
          if (!sample.hidden && sample.prefix === secondText && sample.fading.length === 0)
            secondPlayed = true;
        }
      }
      expect(secondPlayed, "第二条必须实际完成字形播放，不能只证明它曾入队").toBe(true);
      const beforeReopen = snapshot(notes()[0]!);
      expect(beforeReopen.hidden).toBe(true);
      expect(beforeReopen.prefix).toBe(firstText);
      expect(notes().every((item) => item.hidden)).toBe(true);
      await act(() =>
        page.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!.click(),
      );
      const samples = [snapshot(notes()[0]!)];
      for (let index = 0; index < 180; index++) {
        await step();
        samples.push(snapshot(notes()[0]!));
      }
      const retreat = samples.find((sample) => sample.prefix !== firstText);
      const refade = samples.find((sample) =>
        sample.fading.some((fade) => before.nodes.includes(fade.node)),
      );
      const evidence = JSON.stringify({
        before,
        beforeReopen,
        retreat,
        refade,
        final: samples.at(-1),
        transitions,
      });
      expect(
        new Set([before.li, beforeReopen.li, ...samples.map((sample) => sample.li)]).size,
        evidence,
      ).toBe(1);
      expect(
        new Set([before.content, beforeReopen.content, ...samples.map((sample) => sample.content)])
          .size,
        evidence,
      ).toBe(1);
      expect(
        samples.every((sample) => sample.nodes.join() === before.nodes.join()),
        evidence,
      ).toBe(true);
      expect(retreat, evidence).toBeUndefined();
      expect(refade, evidence).toBeUndefined();
    },
  );

  it.each([
    { label: "plain", first: firstText, second: secondText },
    {
      label: "paragraphs",
      first: `${firstText}\n\n    Another settled paragraph.`,
      second: `${secondText}\n\n    Another later paragraph.`,
    },
    {
      label: "lists",
      first: `${firstText}\n\n    - First settled list item.\n    - Second settled list item.`,
      second: `${secondText}\n\n    - Later list item.`,
    },
    {
      label: "inline html",
      first: `${firstText} <em>Settled HTML</em>.`,
      second: `${secondText} <em>Later HTML</em>.`,
    },
    {
      label: "details",
      first: `${firstText}\n\n    <details><summary>More</summary>\n\n    Settled details body.\n\n    </details>`,
      second: secondText,
    },
  ])(
    "retains old glyphs during progressive $label definitions",
    async ({ first, second, label }) => {
      const body = "One[^one] and two[^two].\n\n";
      let source = `${body}[^one]: `;
      await render(source);
      const samples: ReturnType<typeof snapshot>[] = [];
      let secondPlayed = false;
      const sample = () => {
        const item = notes().find((entry) => entry.id.endsWith("fn-one"));
        if (item) samples.push(snapshot(item));
        const second = notes().find((entry) => entry.id.endsWith("fn-two"));
        if (second) {
          const current = snapshot(second);
          if (
            !current.hidden &&
            current.prefix.startsWith(secondText) &&
            current.fading.length === 0
          )
            secondPlayed = true;
        }
      };
      for (let offset = 0; offset < first.length; offset += 5) {
        source += first.slice(offset, offset + 5);
        await render(source);
        for (let index = 0; index < 5; index++) {
          await step();
          sample();
        }
      }
      for (let index = 0; index < 180; index++) {
        await step();
        sample();
      }
      const before = snapshot(notes()[0]!);
      expect(before.prefix.startsWith(firstText), JSON.stringify({ label, before })).toBe(true);
      source += "\n\n[^two]: ";
      await render(source);
      for (let offset = 0; offset < second.length; offset += 3) {
        source += second.slice(offset, offset + 3);
        await render(source);
        for (let index = 0; index < 7; index++) {
          await step();
          sample();
        }
      }
      for (const ending of [
        "\n\nBoundary.",
        "\n\n<section>\n\nLater authored section.",
        "\n\n</section>",
      ]) {
        source += ending;
        await render(source);
        for (let index = 0; index < 110; index++) {
          await step();
          sample();
        }
      }
      await render(source, false);
      for (let index = 0; index < 120; index++) {
        await step();
        sample();
      }
      await render(source, false, true);
      for (let index = 0; index < 120; index++) {
        await step();
        sample();
      }
      const completedIndex = samples.findIndex(
        (entry) => entry.prefix.startsWith(firstText) && entry.fading.length === 0,
      );
      const after = samples.slice(completedIndex + 1);
      const retreat = after.find((entry) => !entry.prefix.startsWith(firstText));
      const firstTextNodes = new Set(before.nodes);
      const refade = after.find((entry) =>
        entry.fading.some((fade) => firstTextNodes.has(fade.node) && fade.start < firstText.length),
      );
      const evidence = JSON.stringify({
        label,
        before,
        retreat,
        refade,
        changes: after.filter(
          (entry, index) =>
            index === 0 ||
            entry.prefix !== after[index - 1]!.prefix ||
            entry.li !== after[index - 1]!.li ||
            entry.hidden !== after[index - 1]!.hidden ||
            entry.frameStyle !== after[index - 1]!.frameStyle,
        ),
      });
      expect(completedIndex, evidence).toBeGreaterThanOrEqual(0);
      expect(secondPlayed, evidence).toBe(true);
      expect(retreat, evidence).toBeUndefined();
      expect(refade, evidence).toBeUndefined();
      expect(new Set(after.map((entry) => entry.li)).size, evidence).toBe(1);
    },
  );
});
