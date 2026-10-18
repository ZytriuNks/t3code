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
let transitions: { at: number; node: number; previous: string | null; value: string | null }[];
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
          glyphStart:
            nodes
              .slice(0, nodes.indexOf(range.startContainer as Text))
              .reduce((length, node) => length + node.length, 0) + range.startOffset,
        })),
    ),
    hidden: item.hidden,
    visible:
      !item.hidden &&
      !item.closest("[hidden]") &&
      item.closest("[data-stream-footnotes]")?.getAttribute("data-markdown-details-open") ===
        "true",
    observer: content.hasAttribute("data-smooth-output"),
    started: content.hasAttribute("data-smooth-text-started"),
    style: content.getAttribute("style"),
    frameStyle: content.parentElement!.getAttribute("style"),
    widget: identity(item.closest("[data-stream-footnotes]")!),
    number: item.value,
    references: item.querySelectorAll("a[data-footnote-ref]").length,
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
    for (const [index, record] of records.entries()) {
      if (record.type !== "attributes") continue;
      const target = record.target as HTMLElement;
      if (!target.matches("[data-stream-footnotes]")) continue;
      const next = records
        .slice(index + 1)
        .find((entry) => entry.target === target && entry.attributeName === record.attributeName);
      transitions.push({
        at: clock,
        node: identity(target),
        previous: record.oldValue,
        value: next ? next.oldValue : target.getAttribute(record.attributeName!),
      });
    }
  });
  mutations.observe(page, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-markdown-details-open"],
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

// 合成夹具保留实际问题的结构：先引用 one/two，定义按 two/one 到达，正文均为纯文本。
function capture() {
  const entries = notes().map((item) => [item.id.split("fn-").at(-1)!, snapshot(item)] as const);
  return {
    at: clock,
    visibleOrder: entries.filter(([, item]) => item.visible).map(([id]) => id),
    notes: Object.fromEntries(entries),
    refs: [...page.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]")].map((link) => ({
      target: link.hash.split("fn-").at(-1),
      number: link.textContent,
    })),
  };
}

type Sample = ReturnType<typeof capture>;

function observe() {
  const samples: Sample[] = [];
  const sample = () => {
    const entry = capture();
    samples.push(entry);
    return entry;
  };
  const advance = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await step();
      sample();
    }
  };
  return {
    samples,
    sample,
    advance,
    async render(source: string, streaming = true, complete = false) {
      await render(source, streaming, complete);
      return sample();
    },
    async until(predicate: (entry: Sample) => boolean, label: string) {
      for (let index = 0; index < 1200; index++) {
        const entry = samples.at(-1) ?? sample();
        if (predicate(entry)) return entry;
        await advance(1);
      }
      throw new Error(`${label}: ${JSON.stringify(samples.at(-1))}`);
    },
  };
}

function done(entry: Sample, id: string, text: string) {
  const note = entry.notes[id];
  return !!note?.visible && note.prefix === text && note.fading.length === 0;
}

function closed() {
  return transitions.filter((entry) => entry.previous === "true" && entry.value === "false");
}

function assertRetained(samples: Sample[], id: string, initial: Sample["notes"][string]) {
  const changedOwner = samples.find((entry) => {
    const note = entry.notes[id];
    return (
      !note ||
      note.li !== initial.li ||
      note.content !== initial.content ||
      note.widget !== initial.widget
    );
  });
  expect(changedOwner, JSON.stringify(changedOwner)).toBeUndefined();
}

function assertPlayback(samples: Sample[], id: string, text: string, number: number) {
  const visible = samples.filter((entry) => entry.notes[id]?.visible);
  expect(visible.length).toBeGreaterThan(0);
  const wrongNumber = visible.find((entry) => entry.notes[id]!.number !== number);
  expect(wrongNumber, JSON.stringify(wrongNumber)).toBeUndefined();
  const playing = visible.find((entry) => {
    const note = entry.notes[id]!;
    return note.prefix.length > 0 && note.prefix.length < text.length && note.fading.length > 0;
  });
  expect(playing, `${id} must actually animate`).toBeDefined();
  const retreat = samples.find((entry, index) => {
    const previous = samples[index - 1]?.notes[id];
    return previous?.visible && !entry.notes[id]?.prefix.startsWith(previous.prefix);
  });
  expect(retreat, JSON.stringify(retreat)).toBeUndefined();
  const completed = samples.findIndex((entry) => done(entry, id, text));
  expect(completed).toBeGreaterThanOrEqual(0);
  const after = samples.slice(completed);
  const refade = after.find((entry) =>
    entry.notes[id]?.fading.some((fade) => fade.glyphStart < text.length),
  );
  expect(refade, JSON.stringify(refade)).toBeUndefined();
  const lostPrefix = after.find((entry) => entry.notes[id]?.prefix !== text);
  expect(lostPrefix, JSON.stringify(lostPrefix)).toBeUndefined();
  const changedTextNodes = after.find(
    (entry) =>
      JSON.stringify(entry.notes[id]?.nodes) !==
      JSON.stringify(samples[completed]!.notes[id]!.nodes),
  );
  expect(changedTextNodes, JSON.stringify(changedTextNodes)).toBeUndefined();
  assertRetained(
    samples.slice(samples.findIndex((entry) => !!entry.notes[id])),
    id,
    visible[0]!.notes[id]!,
  );
}

async function finish(record: ReturnType<typeof observe>) {
  await record.until(
    (entry) => closed().length > 0 && Object.values(entry.notes).every((note) => note.hidden),
    "automatic group must finish closing",
  );
  await record.advance(60);
  expect(closed()).toHaveLength(1);
}

describe("脚注入队等待与定义身份", () => {
  it.each([false, true])(
    "等待更早 one 定义，随后按稳定编号 1、2 播放连续组（分片=%s）",
    async (fragmented) => {
      const record = observe();
      let source = `One[^one] then two[^two].\n\n[^two]: ${secondText}`;
      const initial = await record.render(source);
      expect(initial.notes.two).toBeDefined();
      await record.advance(100);
      const pending = record.samples.slice();
      expect(pending.find((entry) => entry.notes.two?.visible)).toBeUndefined();
      expect(pending.find((entry) => entry.notes.two?.fading.length)).toBeUndefined();
      expect(closed()).toEqual([]);
      assertRetained(pending, "two", initial.notes.two!);

      const chunks = fragmented
        ? ["\n\n[", "^", "one]", ":", ` ${firstText}\n\nBoundary.`]
        : [`\n[^one]: ${firstText}\n\nBoundary.`];
      for (const [index, chunk] of chunks.entries()) {
        source += chunk;
        await record.render(source);
        if (index < chunks.length - 1) {
          await record.advance(50);
          expect
            .soft(
              record.samples.at(-1)!.notes.two!.visible,
              JSON.stringify({ chunk, sample: record.samples.at(-1) }),
            )
            .toBe(false);
        }
      }
      const oneDone = await record.until(
        (entry) => done(entry, "one", firstText),
        "one must finish first",
      );
      const twoDone = await record.until(
        (entry) => done(entry, "two", secondText),
        "two must follow one",
      );
      const twoFirstGlyph = record.samples.find(
        (entry) => entry.notes.two?.visible && entry.notes.two.prefix.length > 0,
      );
      expect(twoFirstGlyph!.at).toBeGreaterThanOrEqual(oneDone.at);
      expect(twoDone.at).toBeGreaterThan(oneDone.at);
      const retainedOne = record.samples.filter(
        (entry) => entry.at >= oneDone.at && entry.at <= twoDone.at,
      );
      expect(retainedOne.find((entry) => !entry.notes.one?.visible)).toBeUndefined();
      expect(
        retainedOne.find(
          (entry) => entry.visibleOrder.join() !== "one,two" && entry.notes.two?.visible,
        ),
      ).toBeUndefined();
      await finish(record);
      await record.render(source, false);
      await record.advance(60);
      await record.render(source, false, true);
      await record.advance(60);
      assertRetained(record.samples, "two", initial.notes.two!);
      assertPlayback(record.samples, "one", firstText, 1);
      assertPlayback(record.samples, "two", secondText, 2);
      expect(closed()).toHaveLength(1);
      expect(closed()[0]!.at).toBeGreaterThan(twoDone.at);
      expect(notes().map((note) => note.id.split("fn-").at(-1))).toEqual(["one", "two"]);
    },
  );

  it.each([false, true])(
    "EOF 未定义 one 时释放同一 two，并恢复未匹配引用 literal（smoothComplete=%s）",
    async (complete) => {
      const record = observe();
      const source = `Unknown[^one] then two[^two].\n\n[^two]: ${secondText}`;
      const initial = await record.render(source);
      await record.advance(100);
      expect(record.samples.find((entry) => entry.notes.two?.visible)).toBeUndefined();
      const releasedAt = record.samples.length;
      await record.render(source, complete, complete);
      const twoDone = await record.until(
        (entry) => done(entry, "two", secondText),
        "EOF must release two",
      );
      await finish(record);
      assertRetained(record.samples, "two", initial.notes.two!);
      assertPlayback(record.samples.slice(releasedAt), "two", secondText, 1);
      expect(closed()[0]!.at).toBeGreaterThan(twoDone.at);
      expect(page.querySelector("[data-smooth-streaming]")?.textContent).toContain("Unknown[^one]");
      expect(record.sample().refs).toEqual([{ target: "two", number: "1" }]);
      expect(notes()).toHaveLength(1);
    },
  );

  it("空正文 marker 在流内等待实际内容，补齐后按 1、2 播放", async () => {
    const record = observe();
    let source = `One[^one] then two[^two].\n\n[^two]: ${secondText}\n[^one]:`;
    const initial = await record.render(source);
    await record.advance(100);
    const premature = record.samples.find(
      (entry) => entry.notes.one?.visible || entry.notes.two?.visible,
    );
    expect.soft(premature, JSON.stringify(premature)).toBeUndefined();
    expect(closed()).toEqual([]);
    source += ` ${firstText}\n\nBoundary.`;
    await record.render(source);
    const oneDone = await record.until(
      (entry) => done(entry, "one", firstText),
      "filled one must play",
    );
    await record.until((entry) => done(entry, "two", secondText), "two must play after filled one");
    const twoFirstGlyph = record.samples.find(
      (entry) => entry.notes.two?.visible && entry.notes.two.prefix.length > 0,
    );
    expect(twoFirstGlyph!.at).toBeGreaterThanOrEqual(oneDone.at);
    await finish(record);
    assertRetained(record.samples, "one", initial.notes.one!);
    assertRetained(record.samples, "two", initial.notes.two!);
    assertPlayback(record.samples, "one", firstText, 1);
    assertPlayback(record.samples, "two", secondText, 2);
  });

  it("合法空定义在 EOF 完成后不会卡住同组 two 或整组收起", async () => {
    const record = observe();
    const source = `One[^one] then two[^two].\n\n[^two]: ${secondText}\n[^one]:`;
    const initial = await record.render(source);
    await record.advance(100);
    const premature = record.samples.find(
      (entry) => entry.notes.one?.visible || entry.notes.two?.visible,
    );
    expect.soft(premature, JSON.stringify(premature)).toBeUndefined();
    const releasedAt = record.samples.length;
    await record.render(source, false);
    const twoDone = await record.until(
      (entry) => done(entry, "two", secondText),
      "empty completed one must not stall FIFO",
    );
    await finish(record);
    assertRetained(record.samples, "one", initial.notes.one!);
    assertRetained(record.samples, "two", initial.notes.two!);
    assertPlayback(record.samples.slice(releasedAt), "two", secondText, 2);
    expect(closed()[0]!.at).toBeGreaterThan(twoDone.at);
    expect(notes().map((note) => note.id.split("fn-").at(-1))).toEqual(["one", "two"]);
  });
});
