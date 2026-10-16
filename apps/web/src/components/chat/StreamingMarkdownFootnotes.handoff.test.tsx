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
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

function notes() {
  return [...page.querySelectorAll<HTMLLIElement>("[data-footnotes] ol > li")];
}

function noteById(id: string) {
  return notes().find((note) => note.id.endsWith(`fn-${id}`));
}

function authoredTextNodes(element: HTMLElement, excludeFootnotes = true) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(
        `${excludeFootnotes ? "[data-footnotes], " : ""}a[data-footnote-backref]`,
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

// 以真实隐藏字形高亮计算已绘制正文；未挂载的后续正文自然不会被计入。
function visibleBody() {
  const body = page.querySelector<HTMLElement>("[data-smooth-streaming]")!;
  const hidden = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
  let visible = "";
  let reachedHiddenGlyph = false;
  for (const node of authoredTextNodes(body)) {
    for (let offset = 0; offset < node.length; offset++) {
      if (
        hidden.some(
          (range) =>
            range.startContainer === node &&
            range.startOffset <= offset &&
            range.endOffset > offset,
        )
      )
        reachedHiddenGlyph = true;
      if (!reachedHiddenGlyph) visible += node.data[offset];
    }
  }
  return {
    source: authoredTextNodes(body)
      .map((node) => node.data)
      .join(""),
    visible,
  };
}

function noteState(note: HTMLLIElement) {
  const nodes = authoredTextNodes(note, false);
  const hidden = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
  let text = "";
  let reachedHiddenGlyph = false;
  for (const node of nodes) {
    for (let offset = 0; offset < node.length; offset++) {
      if (
        hidden.some(
          (range) =>
            range.startContainer === node &&
            range.startOffset <= offset &&
            range.endOffset > offset,
        )
      )
        reachedHiddenGlyph = true;
      if (!reachedHiddenGlyph) text += node.data[offset];
    }
  }
  return {
    text: nodes
      .map((node) => node.data)
      .join("")
      .trim(),
    visible: text.trim(),
    open:
      note.closest("[data-stream-footnotes]")?.getAttribute("data-markdown-details-open") ===
      "true",
  };
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

async function advance(count: number) {
  for (let index = 0; index < count; index++) await step();
}

async function render(
  text: string,
  isStreaming = true,
  smoothComplete = false,
  footnotesAutoCollapse = true,
) {
  await act(() =>
    root.render(
      <ChatMarkdown
        cwd={undefined}
        text={text}
        isStreaming={isStreaming}
        smoothComplete={smoothComplete}
        smoothStreaming
        footnotesAutoCollapse={footnotesAutoCollapse}
        smoothOutputMode="character"
        smoothTextFadeDurationMs={200}
      />,
    ),
  );
}

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

describe("real markdown footnote source handoff", () => {
  it("plays through a definition in source order before revealing the body after it", async () => {
    const source = "Before[^a] body.\n\n[^a]: The note plays here.\n\nAfter body continues.";
    const samples: { body: string; note: ReturnType<typeof noteState> | null }[] = [];
    await render(source);
    for (let index = 0; index < 500; index++) {
      await step();
      const note = notes()[0];
      samples.push({ body: visibleBody().visible, note: note ? noteState(note) : null });
    }

    const completedNote = samples.findIndex(
      ({ note }) => note?.open && note.visible.includes("The note plays here."),
    );
    const noteCloses = samples.findIndex(
      ({ note }, index) => index > completedNote && note?.open === false,
    );
    const laterBodyAppears = samples.findIndex(
      ({ body }, index) => index > noteCloses && body.includes("After body"),
    );
    const notePlaying = samples.findIndex(
      ({ note }) => note?.open && note.visible.length > 0 && note.visible.length < note.text.length,
    );
    const evidence = JSON.stringify({
      notePlaying,
      completedNote,
      noteCloses,
      laterBodyAppears,
      samples: samples.filter((_, i) => i % 20 === 0),
    });
    expect(visibleBody().source, evidence).toContain("Before");
    expect(notes(), evidence).toHaveLength(1);
    expect(
      page.querySelector("[data-smooth-streaming] a[data-footnote-ref]"),
      evidence,
    ).not.toBeNull();
    expect(notes()[0]!.querySelector("a[data-footnote-backref]"), evidence).not.toBeNull();
    expect(noteState(notes()[0]!).text, evidence).toContain("The note plays here.");
    expect(notePlaying, evidence).toBeGreaterThanOrEqual(0);
    expect(completedNote, evidence).toBeGreaterThanOrEqual(0);
    expect(
      samples.slice(0, noteCloses).every(({ body }) => !body.includes("After")),
      evidence,
    ).toBe(true);
    expect(noteCloses, evidence).toBeGreaterThan(completedNote);
    expect(laterBodyAppears, evidence).toBeGreaterThan(noteCloses);
    expect(
      samples.slice(laterBodyAppears).some(({ body }) => body.includes("After body continues.")),
      evidence,
    ).toBe(true);
  });

  it("hands off bodyA, notes1, bodyB, notes2, then bodyC for separated groups", async () => {
    const source =
      "Body A[^a].\n\n[^a]: note one plays.\n\nBody B[^b].\n\n[^b]: note two plays.\n\nBody C.";
    const samples: { body: string; notes: ReturnType<typeof noteState>[] }[] = [];
    await render(source);
    for (let index = 0; index < 800; index++) {
      await step();
      samples.push({ body: visibleBody().visible, notes: notes().map(noteState) });
    }
    const oneDone = samples.findIndex(({ notes: states }) =>
      states[0]?.visible.includes("note one plays."),
    );
    const twoDone = samples.findIndex(
      ({ notes: states }, index) =>
        index > oneDone && states[1]?.visible.includes("note two plays."),
    );
    const closeOne = samples.findIndex(
      ({ notes: states }, index) => index > oneDone && states[0]?.open === false,
    );
    const bodyB = samples.findIndex(
      ({ body }, index) => index > closeOne && body.includes("Body B"),
    );
    const closeTwo = samples.findIndex(
      ({ notes: states }, index) => index > twoDone && states[1]?.open === false,
    );
    const bodyC = samples.findIndex(
      ({ body }, index) => index > closeTwo && body.includes("Body C"),
    );
    const evidence = JSON.stringify({
      oneDone,
      closeOne,
      bodyB,
      twoDone,
      closeTwo,
      bodyC,
      samples: samples.filter((_, i) => i % 40 === 0),
    });
    expect(
      page.querySelectorAll("[data-smooth-streaming] a[data-footnote-ref]"),
      evidence,
    ).toHaveLength(2);
    expect(
      notes().every((note) => note.querySelector("a[data-footnote-backref]")),
      evidence,
    ).toBe(true);
    expect(
      notes().map((note) => noteState(note).text),
      evidence,
    ).toEqual(["note one plays.", "note two plays."]);
    expect(oneDone, evidence).toBeGreaterThanOrEqual(0);
    expect(closeOne, evidence).toBeGreaterThan(oneDone);
    expect(bodyB, evidence).toBeGreaterThan(closeOne);
    expect(twoDone, evidence).toBeGreaterThan(bodyB);
    expect(closeTwo, evidence).toBeGreaterThan(twoDone);
    expect(bodyC, evidence).toBeGreaterThan(closeTwo);
    expect(
      samples.slice(0, closeOne).every(({ body }) => !body.includes("Body B")),
      evidence,
    ).toBe(true);
    expect(
      samples.slice(bodyB, closeTwo).every(({ body }) => !body.includes("Body C")),
      evidence,
    ).toBe(true);
  });

  it("keeps a source location and group handoff when the definition arrives in chunks", async () => {
    let source = "Start[^a].\n\n[^a]: Chunked note";
    const samples: { body: string; note: ReturnType<typeof noteState> | null }[] = [];
    await render(source);
    await advance(80);
    for (const chunk of [" arrives", " in", " pieces.", "\n\n", "End of body."]) {
      source += chunk;
      await render(source);
      for (let index = 0; index < 80; index++) {
        await step();
        samples.push({
          body: visibleBody().visible,
          note: notes()[0] ? noteState(notes()[0]!) : null,
        });
      }
    }
    const noteDone = samples.findIndex(
      ({ note }) => note?.open && note.visible.includes("Chunked note arrives in pieces."),
    );
    const endStarts = samples.findIndex(
      ({ body }, index) => index > noteDone && body.includes("End"),
    );
    const evidence = JSON.stringify({
      noteDone,
      endStarts,
      samples: samples.filter((_, i) => i % 30 === 0),
    });
    expect(
      page.querySelector("[data-smooth-streaming] a[data-footnote-ref]"),
      evidence,
    ).not.toBeNull();
    expect(notes()[0]!.querySelector("a[data-footnote-backref]"), evidence).not.toBeNull();
    expect(noteDone, evidence).toBeGreaterThanOrEqual(0);
    expect(
      samples.slice(0, endStarts).every(({ body }) => !body.includes("End")),
      evidence,
    ).toBe(true);
    expect(endStarts, evidence).toBeGreaterThan(noteDone);
    expect(
      samples.slice(endStarts).some(({ body }) => body.includes("End of body.")),
      evidence,
    ).toBe(true);
  });

  it.each([
    {
      label: "blockquote",
      source:
        "> Before quote[^a].\n>\n> [^a]: Nested note plays first.\n>\n> Later inside quote.\n\nOuter ending.",
      later: "Later inside quote.",
    },
    {
      label: "HTML section",
      source:
        "<section>\n\nBefore HTML[^a].\n\n[^a]: Nested note plays first.\n\nLater inside HTML.\n\n</section>\n\nOuter ending.",
      later: "Later inside HTML.",
    },
    {
      label: "list",
      source:
        "- Before list[^a].\n\n  [^a]: Nested note plays first.\n\n  Later inside list.\n\nOuter ending.",
      later: "Later inside list.",
    },
  ])(
    "holds nested body inside a $label until its definition group closes",
    async ({ source, later }) => {
      await render(source);
      const samples: { body: string; note: ReturnType<typeof noteState> | null }[] = [];
      for (let index = 0; index < 500; index++) {
        await step();
        samples.push({
          body: visibleBody().visible,
          note: notes()[0] ? noteState(notes()[0]!) : null,
        });
      }
      const noteDone = samples.findIndex(
        ({ note }) => note?.open && note.visible.includes("Nested note plays first."),
      );
      const noteClosed = samples.findIndex(
        ({ note }, index) => index > noteDone && note?.open === false,
      );
      const nestedStarts = samples.findIndex(({ body }) => body.includes(later.slice(0, 12)));
      const evidence = JSON.stringify({ noteDone, noteClosed, nestedStarts });
      expect(noteDone, evidence).toBeGreaterThanOrEqual(0);
      expect(nestedStarts, evidence).toBeGreaterThan(noteClosed);
      expect(
        samples.slice(0, noteClosed).every(({ body }) => !body.includes(later)),
        evidence,
      ).toBe(true);
      expect(samples.at(-1)!.body, evidence).toContain(later);
      expect(samples.at(-1)!.body, evidence).toContain("Outer ending.");
    },
  );

  it.each(["streaming", "EOF", "complete"])(
    "finishes a group whose active last member is removed (%s)",
    async (ending) => {
      const prefix = "Before[^a] and [^b].\n\n[^a]: First note.\n\n";
      await render(prefix + "[^b]: Second note still streaming.");
      await advance(220);
      expect(noteById("a")!.hidden).toBe(false);
      expect(noteById("b")!.hidden).toBe(false);
      const source = prefix + "After body.";
      await render(source);
      if (ending !== "streaming") await render(source, ending !== "EOF", ending === "complete");
      await advance(600);
      expect(visibleBody().visible).toContain("After body.");
    },
  );

  it.each(["streaming", "EOF", "complete"])(
    "does not retract released body when automatic collapse is toggled (%s)",
    async (ending) => {
      const source = "Before[^a].\n\n[^a]: Note one continues with more words.\n\nAfter body.";
      await render(source);
      await advance(60);
      await render(source, true, false, false);
      await advance(50);
      const released = visibleBody().visible;
      await render(source);
      if (ending !== "streaming") await render(source, ending !== "EOF", ending === "complete");
      await advance(600);
      expect(released).toContain("After body.");
      expect(visibleBody().visible).toContain("After body.");
    },
  );

  it.each(["streaming", "EOF", "complete"])(
    "advances a finished head after a late reference joins during closing (%s)",
    async (ending) => {
      const source = "Before[^a].\n\n[^a]: First note.\n\n[^b]: Second note.\n\nAfter body.";
      await render(source);
      let closing = false;
      for (let index = 0; index < 500; index++) {
        await step();
        const note = noteById("a")!;
        if (!noteState(note).open && !note.hidden) {
          closing = true;
          break;
        }
      }
      expect(closing).toBe(true);
      const updated = source + " Late reference[^b].";
      await render(updated);
      if (ending !== "streaming") await render(updated, ending !== "EOF", ending === "complete");
      let secondPlayed = false;
      for (let index = 0; index < 650; index++) {
        await step();
        const note = noteById("b");
        secondPlayed ||= !!note && !note.hidden && noteState(note).visible.includes("Second note.");
      }
      expect(secondPlayed).toBe(true);
      expect(visibleBody().visible).toContain("After body.");
    },
  );

  it("advances after an adjacent definition and reference are inserted during closing", async () => {
    const source = "Before[^a].\n\n[^a]: First note.\n\nAfter body.";
    await render(source);
    let closing = false;
    for (let index = 0; index < 500; index++) {
      await step();
      const note = noteById("a")!;
      if (!noteState(note).open && !note.hidden) {
        closing = true;
        break;
      }
    }
    expect(closing).toBe(true);
    await render("Before[^a].\n\n[^a]: First note.\n\n[^b]: Second note.\n\nAfter body cites[^b].");
    await advance(650);
    expect(visibleBody().visible).toContain("After body cites");
  });

  it.each(["streaming", "EOF", "complete"])(
    "waits for retained body edits received during group closing (%s)",
    async (ending) => {
      const source =
        "Before[^a] and [^b].\n\n[^a]: First note.\n\n[^b]: Second note.\n\nAfter body.";
      await render(source);
      let closing = false;
      for (let index = 0; index < 550; index++) {
        await step();
        const tail = noteById("b")!;
        if (!noteState(tail).open && !tail.hidden) {
          closing = true;
          break;
        }
      }
      expect(closing).toBe(true);
      const updated = source.replace("First note.", "First note updated during closing.");
      await render(updated);
      if (ending !== "streaming") await render(updated, ending !== "EOF", ending === "complete");
      await advance(550);
      expect(visibleBody().visible).toContain("After body.");
      expect(noteState(noteById("a")!).visible).toContain("First note updated during closing.");
    },
  );

  it("settles a retained note that resolves a late reference while its group is closing", async () => {
    const source =
      "Before[^a] and [^b].\n\n[^a]: First note cites[^c].\n\n[^b]: Second note.\n\nAfter body.";
    await render(source);
    let closing = false;
    for (let index = 0; index < 550; index++) {
      await step();
      const tail = noteById("b")!;
      if (!noteState(tail).open && !tail.hidden) {
        closing = true;
        break;
      }
    }
    expect(closing).toBe(true);
    await render(source + "\n\n[^c]: Late note.\n\nFinal body.");
    await advance(800);
    expect(visibleBody().visible).toContain("After body.");
    expect(visibleBody().visible).toContain("Final body.");
  });

  it.each(["streaming", "EOF", "complete"])(
    "reopens an automatic closing group when a backref arrives during closing (%s)",
    async (ending) => {
      const source = "Before[^a].\n\n[^a]: First note.\n\nAfter body.";
      await render(source);
      let closing = false;
      for (let index = 0; index < 450; index++) {
        await step();
        const note = noteById("a")!;
        if (!noteState(note).open && !note.hidden) {
          closing = true;
          break;
        }
      }
      expect(closing).toBe(true);
      const updated = source + " Another reference[^a].";
      await render(updated);
      if (ending !== "streaming") await render(updated, ending !== "EOF", ending === "complete");
      let closedWhilePending = false;
      for (let index = 0; index < 450; index++) {
        await step();
        const note = noteById("a")!;
        closedWhilePending ||=
          !noteState(note).open &&
          note.querySelectorAll("a[data-smooth-footnote-backref]").length > 0;
      }
      expect(closedWhilePending).toBe(false);
      expect(visibleBody().visible).toContain("After body.");
    },
  );

  it("finishes closing when a backref is removed during the closing window", async () => {
    const source = "Before[^a].\n\n[^a]: First note.\n\nAfter body also cites[^a].";
    await render(source);
    let closing = false;
    for (let index = 0; index < 450; index++) {
      await step();
      const note = noteById("a")!;
      if (!noteState(note).open && !note.hidden) {
        closing = true;
        break;
      }
    }
    expect(closing).toBe(true);
    await render("Before[^a].\n\n[^a]: First note.\n\nAfter body.");
    await advance(450);
    expect(visibleBody().visible).toContain("After body.");
  });

  it("refreshes completion when a retained link changes its reference number without a new DOM link", async () => {
    await render("Before[^a] and [^b].\n\n[^a]: First note.\n\n[^b]: Second note still streaming.");
    await advance(220);
    const source =
      "Before[^b] and [^a].\n\n[^a]: First note.\n\n[^b]: Second note still streaming.\n\nAfter body.";
    await render(source);
    await advance(650);
    expect(visibleBody().visible).toContain("After body.");
  });

  it.each(["streaming", "EOF", "complete"])(
    "waits for new navigation on a retained item when the active tail is removed (%s)",
    async (ending) => {
      await render(
        "Before[^a] and [^b].\n\n[^a]: First note.\n\n[^b]: Second note still streaming.",
      );
      await advance(220);
      const source = "Before[^a] and [^b].\n\n[^a]: First note.\n\nAfter body also cites[^a].";
      await render(source);
      if (ending !== "streaming") await render(source, ending !== "EOF", ending === "complete");
      let sawPending = false;
      let closedBeforeNavigation = false;
      for (let index = 0; index < 300; index++) {
        await step();
        const note = noteById("a")!;
        const pending = note.querySelectorAll("a[data-smooth-footnote-backref]").length > 0;
        sawPending ||= pending;
        closedBeforeNavigation ||= pending && !noteState(note).open;
      }
      expect(sawPending).toBe(true);
      expect(closedBeforeNavigation).toBe(false);
      expect(visibleBody().visible).toContain("After body also cites");
    },
  );

  it.each(["streaming", "EOF", "complete"])(
    "releases a late reference to an adjacent definition at %s",
    async (ending) => {
      const prefix =
        "Before[^a].\n\n[^a]: First note.\n\n[^b]: Second note waiting for a reference.\n\n";
      await render(prefix);
      await advance(300);
      expect(noteState(notes()[0]!).open).toBe(false);
      const source = prefix + "After body cites[^b] and continues.";
      await render(source);
      if (ending !== "streaming") await render(source, ending !== "EOF", ending === "complete");
      let secondPlayed = false;
      for (let index = 0; index < 650; index++) {
        await step();
        const second = noteById("b");
        if (second && !second.hidden && noteState(second).visible.includes("Second note waiting"))
          secondPlayed = true;
      }
      expect(secondPlayed).toBe(true);
      expect(visibleBody().visible).toContain("After body cites");
    },
  );

  it.each(["streaming", "EOF"])(
    "reorders an active queue when a rewrite retains its old definition ID (%s)",
    async (ending) => {
      const note = "Old note with a stable definition identity.";
      await render("Old body[^a].\n\n[^a]: " + note);
      await advance(200);
      expect(noteState(notes()[0]!).open).toBe(true);
      const source =
        "Fresh body[^b] and a[^a].\n\n[^b]: New first note.\n\nMiddle body.\n\n[^a]: " +
        note +
        "\n\nEnd body.";
      await render(source);
      if (ending === "EOF") await render(source, false);
      await advance(700);
      expect(visibleBody().visible).toContain("Middle body.");
      expect(visibleBody().visible).toContain("End body.");
      expect(notes().every((note) => note.hidden)).toBe(true);
    },
  );

  it("lets a manual footnote open take over and releases the waiting body", async () => {
    const source = "Before[^a].\n\n[^a]: A note that is still playing.\n\nAfter body continues.";
    const samples: string[] = [];
    await render(source);
    let noteWasPlaying = false;
    for (let index = 0; index < 500; index++) {
      await step();
      const note = notes()[0];
      if (
        note &&
        noteState(note).visible.length > 0 &&
        noteState(note).visible.length < noteState(note).text.length
      ) {
        noteWasPlaying = true;
        break;
      }
    }
    const beforeTakeover = visibleBody().visible;
    const widget = page.querySelector<HTMLElement>("[data-stream-footnotes]")!;
    await act(() => widget.dispatchEvent(new Event("t3-expand-footnotes")));
    for (let index = 0; index < 240; index++) {
      await step();
      samples.push(visibleBody().visible);
    }
    const afterStarts = samples.findIndex((body) => body.includes("After"));
    const afterFinishes = samples.findIndex(
      (body, index) => index > afterStarts && body.includes("After body continues."),
    );
    const evidence = JSON.stringify({
      noteWasPlaying,
      beforeTakeover,
      afterStarts,
      afterFinishes,
      samples: samples.filter((_, index) => index % 20 === 0),
    });
    expect(widget, evidence).not.toBeNull();
    expect(noteWasPlaying, evidence).toBe(true);
    expect(beforeTakeover, evidence).not.toContain("After");
    expect(afterStarts, evidence).toBeGreaterThanOrEqual(0);
    expect(afterFinishes, evidence).toBeGreaterThan(afterStarts);
    expect(
      samples
        .slice(afterStarts, afterFinishes)
        .some((body) => body.includes("After") && !body.includes("After body continues.")),
      evidence,
    ).toBe(true);
  });

  it.each(["rewrite", "clear then append"] as const)(
    "does not carry an old source handoff through a %s",
    async (transition) => {
      const oldSource = "Old start[^old].\n\n[^old]: Old note.\n\nOld ending.";
      await render(oldSource);
      await advance(300);
      if (transition === "clear then append") {
        await render("");
        await advance(4);
      }

      let source = "Fresh start[^new].\n\n[^new]: Fresh note arrives.\n\nFresh ending continues.";
      await render(source);
      const samples: { body: string; note: ReturnType<typeof noteState> | null }[] = [];
      for (let index = 0; index < 500; index++) {
        await step();
        samples.push({
          body: visibleBody().visible,
          note: noteById("new") ? noteState(noteById("new")!) : null,
        });
      }
      const noteDone = samples.findIndex(
        ({ note }) => note?.open && note.visible.includes("Fresh note arrives."),
      );
      const noteCloses = samples.findIndex(
        ({ note }, index) => index > noteDone && note?.open === false,
      );
      const afterStarts = samples.findIndex(
        ({ body }, index) => index > noteCloses && body.includes("Fresh ending"),
      );
      const afterFinishes = samples.findIndex(
        ({ body }, index) => index > afterStarts && body.includes("Fresh ending continues."),
      );
      const evidence = JSON.stringify({
        transition,
        noteDone,
        noteCloses,
        afterStarts,
        afterFinishes,
        samples: samples.filter((_, index) => index % 30 === 0),
      });
      expect(
        page.querySelector("[data-smooth-streaming] a[data-footnote-ref][href$='fn-new']"),
        evidence,
      ).not.toBeNull();
      expect(noteById("new"), evidence).toBeDefined();
      expect(noteById("new")?.querySelector("a[data-footnote-backref]"), evidence).not.toBeNull();
      expect(noteDone, evidence).toBeGreaterThanOrEqual(0);
      expect(
        samples.slice(0, noteCloses).every(({ body }) => !body.includes("Fresh ending")),
        evidence,
      ).toBe(true);
      expect(noteCloses, evidence).toBeGreaterThan(noteDone);
      expect(afterStarts, evidence).toBeGreaterThan(noteCloses);
      expect(afterFinishes, evidence).toBeGreaterThan(afterStarts);
      expect(
        samples
          .slice(afterStarts, afterFinishes)
          .some(
            ({ body }) =>
              body.includes("Fresh ending") && !body.includes("Fresh ending continues."),
          ),
        evidence,
      ).toBe(true);
    },
  );

  it("hands off a definition appended after an earlier footnote-free body has finished, without EOF", async () => {
    await render("Earlier body already finished.");
    await advance(320);
    expect(visibleBody().visible).toContain("Earlier body already finished.");

    const source =
      "Earlier body[^late] already finished.\n\n[^late]: Late note plays.\n\nLater body continues.";
    const samples: { body: string; note: ReturnType<typeof noteState> | null }[] = [];
    await render(source);
    for (let index = 0; index < 420; index++) {
      await step();
      samples.push({
        body: visibleBody().visible,
        note: notes()[0] ? noteState(notes()[0]!) : null,
      });
    }
    const noteStarts = samples.findIndex(({ note }) => note?.open && note.visible.length > 0);
    const noteDone = samples.findIndex(
      ({ note }) => note?.open && note.visible.includes("Late note plays."),
    );
    const noteCloses = samples.findIndex(
      ({ note }, index) => index > noteDone && note?.open === false,
    );
    const laterStarts = samples.findIndex(
      ({ body }, index) => index > noteCloses && body.includes("Later"),
    );
    const laterFinishes = samples.findIndex(
      ({ body }, index) => index > laterStarts && body.includes("Later body continues."),
    );
    const evidence = JSON.stringify({
      noteStarts,
      noteDone,
      noteCloses,
      laterStarts,
      laterFinishes,
      samples: samples.filter((_, index) => index % 25 === 0),
    });
    expect(notes(), evidence).toHaveLength(1);
    expect(noteStarts, evidence).toBeGreaterThanOrEqual(0);
    expect(noteDone, evidence).toBeGreaterThan(noteStarts);
    expect(
      samples.slice(0, noteCloses).every(({ body }) => !body.includes("Later")),
      evidence,
    ).toBe(true);
    expect(laterStarts, evidence).toBeGreaterThan(noteCloses);
    expect(laterFinishes, evidence).toBeGreaterThan(laterStarts);
    expect(
      samples
        .slice(laterStarts, laterFinishes)
        .some(({ body }) => body.includes("Later") && !body.includes("Later body continues.")),
      evidence,
    ).toBe(true);
  });

  it("keeps source-position handoffs when definition order reverses reference order", async () => {
    const source =
      "One[^one] is cited before two[^two].\n\n[^two]: Source-first note two.\n\nMiddle body follows the first source group.\n\n[^one]: Source-second note one.\n\nFinal body follows both groups.";
    const samples: {
      body: string;
      one: ReturnType<typeof noteState> | null;
      two: ReturnType<typeof noteState> | null;
    }[] = [];
    await render(source);
    for (let index = 0; index < 900; index++) {
      await step();
      samples.push({
        body: visibleBody().visible,
        one: noteById("one") ? noteState(noteById("one")!) : null,
        two: noteById("two") ? noteState(noteById("two")!) : null,
      });
    }
    const twoDone = samples.findIndex(({ two }) => two?.visible.includes("Source-first note two."));
    const firstClose = samples.findIndex(
      ({ two }, index) => index > twoDone && two?.open === false,
    );
    const middleStarts = samples.findIndex(
      ({ body }, index) => index > firstClose && body.includes("Middle body"),
    );
    const oneDone = samples.findIndex(
      ({ one }, index) => index > middleStarts && one?.visible.includes("Source-second note one."),
    );
    const secondClose = samples.findIndex(
      ({ one }, index) => index > oneDone && one?.open === false,
    );
    const finalStarts = samples.findIndex(
      ({ body }, index) => index > secondClose && body.includes("Final body"),
    );
    const middleGradual = samples.some(
      ({ body }) =>
        body.includes("Middle body") &&
        !body.includes("Middle body follows the first source group."),
    );
    const finalGradual = samples.some(
      ({ body }) =>
        body.includes("Final body") && !body.includes("Final body follows both groups."),
    );
    const evidence = JSON.stringify({
      twoDone,
      firstClose,
      middleStarts,
      oneDone,
      secondClose,
      finalStarts,
      middleGradual,
      finalGradual,
      handoffSamples: samples.slice(firstClose - 2, oneDone + 3),
      finalSamples: samples.slice(secondClose - 2, finalStarts + 6),
    });
    expect(
      page.querySelectorAll("[data-smooth-streaming] a[data-footnote-ref]"),
      evidence,
    ).toHaveLength(2);
    expect(noteById("one"), evidence).toBeDefined();
    expect(noteById("two"), evidence).toBeDefined();
    expect(noteById("one")?.value, evidence).toBe(1);
    expect(noteById("two")?.value, evidence).toBe(2);
    expect(twoDone, evidence).toBeGreaterThanOrEqual(0);
    expect(firstClose, evidence).toBeGreaterThan(twoDone);
    expect(middleStarts, evidence).toBeGreaterThan(firstClose);
    expect(oneDone, evidence).toBeGreaterThan(middleStarts);
    expect(secondClose, evidence).toBeGreaterThan(oneDone);
    expect(finalStarts, evidence).toBeGreaterThan(secondClose);
    expect(
      samples.slice(0, firstClose).every(({ body }) => !body.includes("Middle body")),
      evidence,
    ).toBe(true);
    expect(
      samples.slice(middleStarts, secondClose).every(({ body }) => !body.includes("Final body")),
      evidence,
    ).toBe(true);
    expect(middleGradual, evidence).toBe(true);
    expect(finalGradual, evidence).toBe(true);
  });

  it.each([
    { label: "completed provider response", isStreaming: false, smoothComplete: false },
    { label: "provider completion signal", isStreaming: true, smoothComplete: true },
  ])("does not animate source handoffs for a $label", async ({ isStreaming, smoothComplete }) => {
    const source = "Before[^a].\n\n[^a]: Finished note.\n\nAfter body.";
    await render(source, isStreaming, smoothComplete);
    const body = visibleBody();
    expect(body.visible, JSON.stringify(body)).toContain("Before");
    expect(body.visible, JSON.stringify(body)).toContain("After body.");
    expect(notes(), JSON.stringify(body)).toHaveLength(1);
    expect(noteState(notes()[0]!), JSON.stringify(body)).toMatchObject({
      text: expect.stringContaining("Finished note."),
      visible: expect.stringContaining("Finished note."),
    });
  });
});
