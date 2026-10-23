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
  useEnvironmentScope: () => false,
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

type PairSample = {
  phase: string;
  first: ReturnType<typeof snapshot> | null;
  second: ReturnType<typeof snapshot> | null;
};

function observe(firstId = "one", secondId = "two") {
  const samples: PairSample[] = [];
  let phase = "initial";
  const sample = () => {
    const first = notes().find((item) => item.id.endsWith(`fn-${firstId}`));
    const second = notes().find((item) => item.id.endsWith(`fn-${secondId}`));
    samples.push({
      phase,
      first: first ? snapshot(first) : null,
      second: second ? snapshot(second) : null,
    });
  };
  return {
    samples,
    async render(source: string, label: string) {
      phase = label;
      await render(source);
      sample();
    },
    async advance(count: number) {
      for (let index = 0; index < count; index++) {
        await step();
        sample();
      }
    },
  };
}

function observeNotes() {
  const samples: {
    phase: string;
    at: number;
    visibleOrder: string[];
    notes: Record<string, ReturnType<typeof snapshot>>;
  }[] = [];
  let phase = "initial";
  const sample = () => {
    const entries = notes().map((item) => [item.id.split("fn-").at(-1)!, snapshot(item)] as const);
    samples.push({
      phase,
      at: clock,
      visibleOrder: entries.filter(([, item]) => item.visible).map(([id]) => id),
      notes: Object.fromEntries(entries),
    });
  };
  return {
    samples,
    async render(source: string, label: string) {
      phase = label;
      await render(source);
      sample();
    },
    async advance(count: number) {
      for (let index = 0; index < count; index++) {
        await step();
        sample();
      }
    },
  };
}

function assertGroup(
  samples: PairSample[],
  expectedFirst = firstText,
  expectedSecond = secondText,
) {
  const firstDone = samples.findIndex(
    (entry) =>
      entry.first?.visible &&
      entry.first.prefix.startsWith(expectedFirst) &&
      entry.first.fading.length === 0,
  );
  const secondDone = samples.findIndex(
    (entry, index) =>
      index > firstDone &&
      entry.second?.visible &&
      entry.second.prefix === expectedSecond &&
      entry.second.fading.length === 0,
  );
  const interval = samples.slice(firstDone, secondDone + 1);
  const afterFirst = samples.slice(firstDone + 1);
  const hidden = interval.find((entry) => !entry.first?.visible);
  const retreat = afterFirst.find((entry) => !entry.first?.prefix.startsWith(expectedFirst));
  // 按正文字符位置检查，即使 Text 节点被替换也能发现旧字形再次淡入。
  const refade = afterFirst.find((entry) =>
    entry.first?.fading.some((fade) => fade.glyphStart < expectedFirst.length),
  );
  const secondPlaying = samples.find(
    (entry) =>
      entry.second?.visible &&
      entry.second.prefix.length > 0 &&
      entry.second.prefix.length < expectedSecond.length &&
      entry.second.fading.length > 0,
  );
  const closed = transitions.filter(
    (entry) => entry.previous === "true" && entry.value === "false",
  );
  const changes = samples.filter((entry, index) => {
    const previous = samples[index - 1];
    return (
      !previous ||
      entry.phase !== previous.phase ||
      entry.first?.visible !== previous.first?.visible ||
      entry.second?.visible !== previous.second?.visible
    );
  });
  const compact = (entry: PairSample | undefined) =>
    entry && {
      phase: entry.phase,
      first: entry.first && {
        at: entry.first.at,
        li: entry.first.li,
        content: entry.first.content,
        prefix: entry.first.prefix,
        visible: entry.first.visible,
        fading: entry.first.fading,
      },
      second: entry.second && {
        at: entry.second.at,
        prefix: entry.second.prefix,
        visible: entry.second.visible,
        fading: entry.second.fading,
      },
    };
  const evidence = JSON.stringify({
    firstDone: compact(samples[firstDone]),
    secondDone: compact(samples[secondDone]),
    hidden: compact(hidden),
    retreat: compact(retreat),
    refade: compact(refade),
    closed,
    changes: changes.map(compact),
  });
  expect.soft(firstDone, evidence).toBeGreaterThanOrEqual(0);
  expect.soft(secondPlaying, evidence).toBeDefined();
  expect.soft(secondDone, evidence).toBeGreaterThan(firstDone);
  expect.soft(hidden, evidence).toBeUndefined();
  expect.soft(retreat, evidence).toBeUndefined();
  expect.soft(refade, evidence).toBeUndefined();
  expect.soft(closed, evidence).toHaveLength(1);
  expect.soft(closed[0]?.at, evidence).toBeGreaterThan(samples[secondDone]?.second?.at ?? Infinity);
  expect
    .soft(
      notes().every((item) => item.hidden),
      evidence,
    )
    .toBe(true);
}

describe("real markdown automatic footnote groups", () => {
  it.each([
    { label: "single newline", separator: "\n", secondId: "two" },
    { label: "blank line", separator: "\n\n", secondId: "two" },
    { label: "long identifier", separator: "\n", secondId: "a-long-second-footnote-identifier" },
  ])(
    "keeps the first note through fragmented $label definitions and closes only at group end",
    async ({ separator, secondId }) => {
      const record = observe("one", secondId);
      let source = `One[^one] and two[^${secondId}].\n\n[^one]: ${firstText}`;
      await record.render(source, "first definition");
      await record.advance(180);
      const initial = record.samples.at(-1)!.first!;
      expect(initial.visible).toBe(true);
      expect(initial.prefix).toBe(firstText);
      expect(initial.fading).toEqual([]);
      // 每个中间前缀停留 800ms，跨越真实的 650ms 阅读暂停；不手动触发 finish。
      const chunks = [separator + "[", "^", `${secondId}]`, ":", ` ${secondText}`, "\n\nBoundary."];
      for (const [index, chunk] of chunks.entries()) {
        source += chunk;
        await record.render(source, `chunk ${index}: ${JSON.stringify(chunk)}`);
        await record.advance(index === chunks.length - 1 ? 240 : 50);
      }
      assertGroup(record.samples);
    },
  );

  it("retains the first note when a blank line plus an unfinished next marker outlasts the reading pause", async () => {
    const record = observe();
    let source = `One[^one] and two[^two].\n\n[^one]: ${firstText}`;
    await record.render(source, "first definition");
    await record.advance(180);
    source += "\n\n[^";
    await record.render(source, "unfinished second marker");
    await record.advance(50);
    source += `two]: ${secondText}\n\nBoundary.`;
    await record.render(source, "second definition and group boundary");
    await record.advance(240);
    assertGroup(record.samples);
  });

  it("retains the first note when the same unfinished marker arrives as separate bracket and caret chunks", async () => {
    const record = observe();
    let source = `One[^one] and two[^two].\n\n[^one]: ${firstText}`;
    await record.render(source, "first definition");
    await record.advance(180);
    for (const chunk of ["\n\n[", "^"]) {
      source += chunk;
      await record.render(source, `unfinished marker chunk: ${JSON.stringify(chunk)}`);
      await record.advance(50);
    }
    source += `two]: ${secondText}\n\nBoundary.`;
    await record.render(source, "second definition and group boundary");
    await record.advance(240);
    assertGroup(record.samples);
  });

  it.each([false, true])(
    "closes a complete consecutive snapshot once (reverse references: %s)",
    async (reverseReferences) => {
      const record = reverseReferences ? observe("two", "one") : observe();
      const body = reverseReferences ? "Two[^two] then one[^one]." : "One[^one] then two[^two].";
      await record.render(
        `${body}\n\n[^one]: ${firstText}\n[^two]: ${secondText}\n\nBoundary.`,
        "complete snapshot",
      );
      await record.advance(500);
      assertGroup(
        record.samples,
        reverseReferences ? secondText : firstText,
        reverseReferences ? firstText : secondText,
      );
    },
  );

  it("keeps a three-note source run together while playing in reference order three, one, two", async () => {
    const record = observeNotes();
    const thirdText = "Third source definition, referenced before the other notes.";
    await record.render(
      `Three[^three], one[^one], two[^two].\n\n[^one]: ${firstText}\n[^two]: ${secondText}\n[^three]: ${thirdText}\n\nBoundary.`,
      "three-note run",
    );
    await record.advance(600);
    const order = [
      { id: "three", text: thirdText, number: 1 },
      { id: "one", text: firstText, number: 2 },
      { id: "two", text: secondText, number: 3 },
    ];
    const played = order.map(({ id, text }) =>
      record.samples.findIndex(
        (entry) =>
          entry.notes[id]?.visible &&
          entry.notes[id].prefix === text &&
          entry.notes[id].fading.length === 0,
      ),
    );
    const lost = order.flatMap(({ id }, index) =>
      record.samples
        .slice(played[index], played.at(-1)! + 1)
        .filter((entry) => !entry.notes[id]?.visible),
    );
    const closed = transitions.filter(
      (entry) => entry.previous === "true" && entry.value === "false",
    );
    const evidence = JSON.stringify({ played, lost: lost[0], closed });
    for (const [index, item] of order.entries()) {
      expect(played[index]!, evidence).toBeGreaterThanOrEqual(0);
      if (index > 0) expect(played[index]!, evidence).toBeGreaterThan(played[index - 1]!);
      expect(record.samples[played[index]!]!.notes[item.id]!.number, evidence).toBe(item.number);
      expect(
        record.samples.some((entry) => {
          const note = entry.notes[item.id];
          return (
            note?.visible &&
            note.prefix.length > 0 &&
            note.prefix.length < item.text.length &&
            note.fading.length > 0
          );
        }),
        evidence,
      ).toBe(true);
    }
    expect(lost, evidence).toEqual([]);
    expect(closed, evidence).toHaveLength(1);
    expect(closed[0]!.at, evidence).toBeGreaterThan(record.samples[played.at(-1)!]!.at);
    expect(
      notes().every((item) => item.hidden),
      evidence,
    ).toBe(true);
  });

  it("plays and closes source-adjacent A and C as one batch before the separate B group", async () => {
    const record = observeNotes();
    const thirdText = "Source-adjacent C plays before the independent B group.";
    await record.render(
      `A[^a], B[^b], C[^c].\n\n[^a]: ${firstText}\n[^c]: ${thirdText}\n\nAuthored body separates groups.\n\n[^b]: ${secondText}\n\nBoundary.`,
      "interleaved reference numbers",
    );
    await record.advance(600);
    const played = [
      { id: "a", text: firstText },
      { id: "c", text: thirdText },
      { id: "b", text: secondText },
    ].map(({ id, text }) =>
      record.samples.findIndex(
        (entry) =>
          entry.notes[id]?.visible &&
          entry.notes[id].prefix === text &&
          entry.notes[id].fading.length === 0,
      ),
    );
    const closed = transitions.filter(
      (entry) => entry.previous === "true" && entry.value === "false",
    );
    const firstB = record.samples.find(
      (entry) => entry.notes.b?.visible && entry.notes.b.prefix.length > 0,
    );
    const lostA = record.samples
      .slice(played[0]!, played[1]! + 1)
      .find((entry) => !entry.notes.a?.visible);
    const evidence = JSON.stringify({ played, closed, firstB, lostA });
    for (const index of played) expect(index, evidence).toBeGreaterThanOrEqual(0);
    expect(played[1]!, evidence).toBeGreaterThan(played[0]!);
    expect(played[2]!, evidence).toBeGreaterThan(played[1]!);
    expect(lostA, evidence).toBeUndefined();
    expect(closed, evidence).toHaveLength(2);
    expect(closed[0]!.at, evidence).toBeGreaterThan(record.samples[played[1]!]!.at);
    expect(closed[0]!.at, evidence).toBeLessThan(firstB!.at);
    expect(firstB!.notes.a!.visible, evidence).toBe(false);
    expect(firstB!.notes.c!.visible, evidence).toBe(false);
    expect(closed[1]!.at, evidence).toBeGreaterThan(record.samples[played[2]!]!.at);
    expect(
      ["a", "b", "c"].map((id) => record.samples.at(-1)!.notes[id]!.number),
      evidence,
    ).toEqual([1, 2, 3]);
    expect(
      notes().every((item) => item.hidden),
      evidence,
    ).toBe(true);
  });

  it("settles the group after a retained first note resolves a late footnote reference without replaying its old prefix", async () => {
    const record = observeNotes();
    const oldPrefix = `${firstText} See the later reference`;
    const thirdText = "The late definition resolves the reference in the retained first note.";
    let source = `One[^one], two[^two], three[^three].\n\n[^one]: ${oldPrefix}[^three].\n[^two]: ${secondText}`;
    await record.render(source, "first two definitions");
    await record.advance(180);
    const retained = record.samples.at(-1)!;
    expect(retained.notes.one!.visible).toBe(true);
    expect(retained.notes.one!.prefix, JSON.stringify(retained)).toBe(retained.notes.one!.text);
    expect(retained.notes.one!.prefix.startsWith(oldPrefix)).toBe(true);
    expect(retained.notes.one!.fading).toEqual([]);
    expect(retained.notes.one!.references).toBe(0);
    expect(retained.notes.two!.visible).toBe(true);
    expect(retained.notes.two!.prefix).toBe(secondText);
    expect(
      transitions.filter((entry) => entry.previous === "true" && entry.value === "false"),
    ).toEqual([]);
    const arrival = record.samples.length;
    source += `\n[^three]: ${thirdText}\n\nBoundary.`;
    await record.render(source, "late third definition resolves first-note reference");
    await record.advance(500);
    const after = record.samples.slice(arrival);
    const refreshed = after.find(
      (entry) =>
        entry.notes.one!.references > 0 && entry.notes.one!.text !== retained.notes.one!.text,
    );
    const retreat = after.find((entry) => !entry.notes.one?.prefix.startsWith(oldPrefix));
    const refade = after.find((entry) =>
      entry.notes.one?.fading.some((fade) => fade.glyphStart < oldPrefix.length),
    );
    const thirdPlayed = after.find(
      (entry) =>
        entry.notes.three?.visible &&
        entry.notes.three.prefix === thirdText &&
        entry.notes.three.fading.length === 0,
    );
    const lostFirst =
      thirdPlayed && after.find((entry) => entry.at <= thirdPlayed.at && !entry.notes.one?.visible);
    const closed = transitions.filter(
      (entry) => entry.previous === "true" && entry.value === "false",
    );
    const evidence = JSON.stringify({
      retained,
      refreshed,
      retreat,
      refade,
      thirdPlayed,
      lostFirst,
      closed,
    });
    expect(refreshed, evidence).toBeDefined();
    expect(retreat, evidence).toBeUndefined();
    expect(refade, evidence).toBeUndefined();
    expect(thirdPlayed, evidence).toBeDefined();
    expect(lostFirst, evidence).toBeUndefined();
    expect(closed, evidence).toHaveLength(1);
    expect(closed[0]!.at, evidence).toBeGreaterThan(thirdPlayed!.at);
    expect(
      notes().every((item) => item.hidden),
      evidence,
    ).toBe(true);
  });

  it("waits for the earlier unknown one, then plays the source run in canonical one/two order", async () => {
    const record = observeNotes();
    let source = `One[^one] then two[^two].\n\n[^two]: ${secondText}`;
    await record.render(source, "two definition is blocked by unknown one");
    await record.advance(100);
    const before = record.samples.at(-1)!;
    expect(before.notes.two).toBeDefined();
    expect(record.samples.some((entry) => entry.notes.two?.visible)).toBe(false);
    const arrival = record.samples.length;
    source += `\n[^one]: ${firstText}\n\nBoundary.`;
    await record.render(source, "one definition releases the canonical source run");
    for (let index = 0; index < 1200; index++) {
      const last = record.samples.at(-1)!;
      if (
        transitions.some((entry) => entry.previous === "true" && entry.value === "false") &&
        Object.values(last.notes).every((note) => note.hidden)
      )
        break;
      await record.advance(1);
    }
    const after = record.samples.slice(arrival);
    const oneDone = after.find(
      (entry) =>
        entry.notes.one?.visible &&
        entry.notes.one.prefix === firstText &&
        entry.notes.one.fading.length === 0,
    );
    const twoPlaying = after.find(
      (entry) =>
        entry.notes.two?.visible &&
        entry.notes.two.prefix.length > 0 &&
        entry.notes.two.prefix.length < secondText.length &&
        entry.notes.two.fading.length > 0,
    );
    const twoDone = after.find(
      (entry) =>
        entry.notes.two?.visible &&
        entry.notes.two.prefix === secondText &&
        entry.notes.two.fading.length === 0,
    );
    const prematureTwo = after.find(
      (entry) =>
        entry.notes.two?.visible &&
        entry.notes.two.prefix.length > 0 &&
        (!oneDone || entry.at < oneDone.at),
    );
    const lostOne =
      oneDone &&
      twoDone &&
      after.find(
        (entry) => entry.at >= oneDone.at && entry.at <= twoDone.at && !entry.notes.one?.visible,
      );
    const wrongOrder = after.find(
      (entry) => entry.notes.two?.visible && entry.visibleOrder.join() !== "one,two",
    );
    const changedOwner = record.samples.find(
      (entry) =>
        entry.notes.two?.li !== before.notes.two!.li ||
        entry.notes.two?.content !== before.notes.two!.content,
    );
    const wrongNumber = after.find(
      (entry) =>
        (entry.notes.one?.visible && entry.notes.one.number !== 1) ||
        (entry.notes.two?.visible && entry.notes.two.number !== 2),
    );
    const closed = transitions.filter(
      (entry) => entry.previous === "true" && entry.value === "false",
    );
    const evidence = JSON.stringify({
      before,
      oneDone,
      twoPlaying,
      twoDone,
      prematureTwo,
      lostOne,
      wrongOrder,
      changedOwner,
      wrongNumber,
      closed,
      last: after.at(-1),
    });
    expect(oneDone, evidence).toBeDefined();
    expect(twoPlaying, evidence).toBeDefined();
    expect(twoDone, evidence).toBeDefined();
    expect(prematureTwo, evidence).toBeUndefined();
    expect(lostOne, evidence).toBeUndefined();
    expect(wrongOrder, evidence).toBeUndefined();
    expect(changedOwner, evidence).toBeUndefined();
    expect(wrongNumber, evidence).toBeUndefined();
    for (const [id, text] of [
      ["one", firstText],
      ["two", secondText],
    ] as const) {
      const done = after.findIndex(
        (entry) =>
          entry.notes[id]?.visible &&
          entry.notes[id].prefix === text &&
          entry.notes[id].fading.length === 0,
      );
      const replay = after
        .slice(done)
        .find(
          (entry) =>
            !entry.notes[id]?.prefix.startsWith(text) ||
            entry.notes[id]?.fading.some((fade) => fade.glyphStart < text.length),
        );
      expect(replay, evidence).toBeUndefined();
    }
    expect(closed, evidence).toHaveLength(1);
    expect(closed[0]!.at, evidence).toBeGreaterThan(twoDone!.at);
    expect(
      notes().map((item) => item.id.split("fn-").at(-1)),
      evidence,
    ).toEqual(["one", "two"]);
    expect(
      notes().every((item) => item.hidden),
      evidence,
    ).toBe(true);
  });

  it("closes each group independently when authored body text separates definitions", async () => {
    const record = observe();
    await record.render(
      `One[^one] and two[^two].\n\n[^one]: ${firstText}\n\nAuthored body separates groups.\n\n[^two]: ${secondText}\n\nBoundary.`,
      "separate groups",
    );
    await record.advance(500);
    const firstPlayed = record.samples.find(
      (entry) =>
        entry.first?.visible && entry.first.prefix === firstText && entry.first.fading.length === 0,
    );
    const secondPlayed = record.samples.find(
      (entry) =>
        entry.second?.visible &&
        entry.second.prefix === secondText &&
        entry.second.fading.length === 0,
    );
    const closed = transitions.filter(
      (entry) => entry.previous === "true" && entry.value === "false",
    );
    const evidence = JSON.stringify({ firstPlayed, secondPlayed, closed });
    expect(firstPlayed, evidence).toBeDefined();
    expect(secondPlayed, evidence).toBeDefined();
    expect(secondPlayed?.first?.visible, evidence).toBe(false);
    expect(closed, evidence).toHaveLength(2);
    expect(closed[0]!.at, evidence).toBeGreaterThan(firstPlayed!.first!.at);
    expect(closed[0]!.at, evidence).toBeLessThan(secondPlayed!.second!.at);
    expect(closed[1]!.at, evidence).toBeGreaterThan(secondPlayed!.second!.at);
    expect(
      notes().every((item) => item.hidden),
      evidence,
    ).toBe(true);
  });
});
