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
import type { SmoothTextResumeInput } from "../../lib/smoothTextPlayback";
import { registerSmoothTextLayoutScope } from "../../lib/smoothTextLayout";

class TestHighlight extends Set<AbstractRange> {}

let root: Root;
let page: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let clock: number;
let unregisterLayoutScope: (() => void) | undefined;
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
  let hiddenText = "";
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
      ) {
        reachedHiddenGlyph = true;
        hiddenText += node.data[offset];
      }
      if (!reachedHiddenGlyph) text += node.data[offset];
    }
  }
  return {
    text: nodes
      .map((node) => node.data)
      .join("")
      .trim(),
    visible: text.trim(),
    hiddenText: hiddenText.trim(),
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

function deferLayoutCommit() {
  const pending = new Set<() => void>();
  unregisterLayoutScope = registerSmoothTextLayoutScope(page, {
    frame(callback) {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    },
    afterCommit(_element, callback) {
      pending.add(callback);
      return () => pending.delete(callback);
    },
  });
  return {
    pending,
    async commit() {
      await act(() => {
        const callbacks = [...pending];
        pending.clear();
        for (const callback of callbacks) callback();
      });
    },
  };
}

async function closedGroup(id: string, text: string) {
  let beforeClose: string | undefined;
  for (let index = 0; index < 500; index++) {
    await step();
    const note = noteById(id);
    if (!note) continue;
    const state = noteState(note);
    if (!note.hidden && state.open && state.visible === text) beforeClose = visibleBody().visible;
    if (beforeClose !== undefined && note.hidden && !state.open) return beforeClose;
  }
  throw new Error(`Footnote ${id} did not play and close`);
}

async function render(
  text: string,
  isStreaming = true,
  smoothComplete = false,
  footnotesAutoCollapse = true,
  smoothTextResume?: SmoothTextResumeInput,
) {
  await act(() =>
    root.render(
      <ChatMarkdown
        cwd={undefined}
        smoothTextResume={smoothTextResume}
        claimInitialSmoothText={smoothTextResume ? () => true : undefined}
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
  unregisterLayoutScope = undefined;
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
  unregisterLayoutScope?.();
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

describe("footnote layout commit handoff", () => {
  it.each(["streaming", "EOF", "complete"])(
    "holds authored body for managed layout confirmation after closing (%s)",
    async (ending) => {
      const layout = deferLayoutCommit();
      const tail = "After commit the body continues through several words.";
      const source = "Before[^a].\n\n[^a]: First note.\n\n" + tail;
      await render(source);
      const beforeClose = await closedGroup("a", "First note.");
      if (ending !== "streaming") await render(source, ending !== "EOF", ending === "complete");
      await advance(80);
      expect(noteById("a")!.hidden).toBe(true);
      expect(visibleBody().visible).toBe(beforeClose);

      await layout.commit();
      const samples = [visibleBody().visible];
      for (let index = 0; index < 240; index++) {
        await step();
        samples.push(visibleBody().visible);
      }
      expect(samples.some((body) => body.includes("After") && !body.includes(tail))).toBe(true);
      expect(samples.at(-1)).toContain(tail);
    },
  );

  it("invalidates a superseded confirmation when the source handoff changes", async () => {
    const layout = deferLayoutCommit();
    const source = "Before[^a].\n\n[^a]: First note.\n\nAfter the old confirmation.";
    await render(source);
    const beforeClose = await closedGroup("a", "First note.");
    const obsolete = [...layout.pending];
    expect(obsolete).toHaveLength(1);

    const updated = source + " This arrived before the layout commit.";
    await render(updated);
    for (let index = 0; index < 80 && layout.pending.has(obsolete[0]!); index++) await step();
    expect(layout.pending.has(obsolete[0]!)).toBe(false);
    // 模拟确认已取出、但在 source 更新与 cleanup 之后才交付。
    await act(() => obsolete.forEach((callback) => callback()));
    await advance(80);
    expect(visibleBody().visible).toBe(beforeClose);

    await layout.commit();
    await advance(240);
    expect(visibleBody().visible).toContain("This arrived before the layout commit.");
  });

  it.each(["reference expansion", "disclosure reopen"])(
    "cancels confirmation on %s and protects the next source boundary",
    async (interaction) => {
      const layout = deferLayoutCommit();
      const source = "Before[^a].\n\n[^a]: First note.\n\nManually released body continues.";
      await render(source);
      await closedGroup("a", "First note.");
      const obsolete = [...layout.pending];
      expect(obsolete).toHaveLength(1);
      await act(() => {
        if (interaction === "reference expansion")
          page
            .querySelector<HTMLElement>("[data-stream-footnotes]")!
            .dispatchEvent(new Event("t3-expand-footnotes"));
        else page.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!.click();
      });
      expect(layout.pending.size).toBe(0);
      await advance(160);
      expect(visibleBody().visible).toContain("Manually released body continues.");
      await act(() =>
        page.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!.click(),
      );
      await advance(30);

      await render("Fresh[^b].\n\n[^b]: Second note.\n\nProtected later boundary.");
      const beforeClose = await closedGroup("b", "Second note.");
      await act(() => obsolete.forEach((callback) => callback()));
      await advance(80);
      expect(visibleBody().visible).toBe(beforeClose);
      await layout.commit();
      await advance(160);
      expect(visibleBody().visible).toContain("Protected later boundary.");
    },
  );

  it("cancels on unmount before another instance waits for its own confirmation", async () => {
    const layout = deferLayoutCommit();
    await render("Before[^a].\n\n[^a]: First note.\n\nOld body.");
    await closedGroup("a", "First note.");
    const obsolete = [...layout.pending];
    expect(obsolete).toHaveLength(1);
    await act(() => root.render(null));
    expect(layout.pending.size).toBe(0);

    await render("Fresh[^b].\n\n[^b]: Second note.\n\nOnly the new confirmation releases this.");
    const beforeClose = await closedGroup("b", "Second note.");
    await act(() => obsolete.forEach((callback) => callback()));
    await advance(80);
    expect(visibleBody().visible).toBe(beforeClose);
    await layout.commit();
    await advance(160);
    expect(visibleBody().visible).toContain("Only the new confirmation releases this.");
  });
});

describe("real markdown footnote source handoff", () => {
  it.each(["streaming", "EOF", "complete"])(
    "advances footnote groups separated by an unrendered link definition (%s)",
    async (ending) => {
      const source =
        "Before[^a] and [^b].\n\n[^a]: First note.\n\n" +
        "[unused]: https://example.invalid/\n\n[^b]: Second note.\n\nAfter body.";
      await render(source);
      const shown = new Set<string>();
      let ended = false;
      for (let index = 0; index < 600; index++) {
        await step();
        for (const id of ["a", "b"]) {
          const note = noteById(id);
          if (note && !note.hidden && noteState(note).open) shown.add(noteState(note).visible);
        }
        if (!ended && ending !== "streaming" && shown.has("First note.")) {
          ended = true;
          await render(source, ending !== "EOF", ending === "complete");
        }
      }
      expect(shown.has("First note.")).toBe(true);
      expect(shown.has("Second note.")).toBe(true);
      expect(visibleBody().visible).toContain("After body.");
      expect(frames.size).toBe(0);
      if (ending !== "streaming") expect(page.querySelector("[data-smooth-output]")).toBeNull();
    },
  );

  it.each(["streaming", "EOF", "complete"])(
    "paces repeated handoffs after late references resolve during reading (%s)",
    async (ending) => {
      const middle = "Middle body must continue through the glyph queue. ".repeat(8).trimEnd();
      const later = "Later body stays paced after another late reference. ".repeat(8).trimEnd();
      const tail = "Final body remains paced after the last note. ".repeat(8).trimEnd();
      const initial = "Before[^a], later[^b] and last[^c].\n\n[^a]: First note.\n\n" + middle;
      const bodies: string[] = [];
      const waitForReading = async (id: string, text: string) => {
        for (let index = 0; index < 500; index++) {
          await step();
          bodies.push(visibleBody().visible);
          const note = noteById(id);
          if (note && noteState(note).open && noteState(note).visible === text) return;
        }
        throw new Error(`Footnote ${id} did not reach its reading pause`);
      };
      await render(initial);
      await waitForReading("a", "First note.");
      const second = initial + "\n\n[^b]: Second note.\n\n" + later;
      await render(second);
      await waitForReading("b", "Second note.");
      await render(
        second + "\n\n[^c]: Third note.\n\n" + tail,
        ending !== "EOF",
        ending === "complete",
      );
      for (let index = 0; index < 700; index++) {
        await step();
        bodies.push(visibleBody().visible);
      }
      expect(bodies.at(-1)).toContain(tail);
      expect(bodies.find((body) => body.includes("Middle"))).not.toContain(middle);
      expect(bodies.find((body) => body.includes("Later"))).not.toContain(later);
      expect(bodies.find((body) => body.includes("Final"))).not.toContain(tail);
      expect(frames.size).toBe(0);
      if (ending !== "streaming") expect(page.querySelector("[data-smooth-output]")).toBeNull();
    },
  );

  it.each(
    (["synchronized", "forceShow"] as const).flatMap((recoveryMode) =>
      (["reading pause", "closing"] as const).map((phase) => ({ recoveryMode, phase })),
    ),
  )(
    "keeps outgoing notes visible through $recoveryMode recovery during $phase",
    async ({ recoveryMode, phase }) => {
      const source =
        "Before[^a] and[^b].\n\n[^a]: First note.\n\n[^b]: Second note.\n\nAfter body.";
      const resume = {
        key: `closing-recovery-${recoveryMode}-${phase}`,
        generation: 0,
        baselineText: "",
        mountText: "",
        synchronized: false,
      };
      await render(source, true, false, true, resume);
      let ready = false;
      for (let index = 0; index < 400; index++) {
        await step();
        if (
          notes().length === 2 &&
          notes().every((note) => !note.hidden) &&
          (phase === "closing"
            ? notes().every((note) => !noteState(note).open)
            : notes().every((note) => noteState(note).open) &&
              noteState(noteById("a")!).visible === "First note." &&
              noteState(noteById("b")!).visible === "Second note.")
        ) {
          ready = true;
          break;
        }
      }
      expect(ready).toBe(true);
      const panel = page.querySelector<HTMLElement>(
        "[data-stream-footnotes] [data-slot='collapsible-panel']",
      )!;
      const outgoing = notes();

      const recovered = {
        ...resume,
        generation: 1,
        baselineText: source,
        synchronized: true,
        ...(recoveryMode === "forceShow" ? { forceShow: true } : {}),
      };
      await render(source, false, true, true, recovered);

      expect(page.querySelector("[data-stream-footnotes] [data-slot='collapsible-panel']")).toBe(
        panel,
      );
      expect(notes()).toEqual(outgoing);
      expect(notes().map((note) => note.hidden)).toEqual([false, false]);
      expect(notes().map((note) => noteState(note).visible)).toEqual([
        "First note.",
        "Second note.",
      ]);
      expect(notes().every((note) => !noteState(note).open)).toBe(true);

      await act(() => {
        const end = new Event("transitionend", { bubbles: true });
        Object.defineProperty(end, "propertyName", { value: "height" });
        panel.dispatchEvent(end);
      });
      await advance(40);
      expect(notes().map((note) => note.hidden)).toEqual([true, true]);
      expect(visibleBody().visible).toContain("After body.");

      await render(
        source + "\n\nNew body[^c].\n\n[^c]: New note.\n\nFinal body.",
        true,
        false,
        true,
        { ...recovered, forceShow: false },
      );
      await closedGroup("c", "New note.");
      await advance(80);
      expect(visibleBody().visible).toContain("Final body.");
    },
  );

  it.each(
    ["fresh", "synchronized"].flatMap((resume) =>
      [
        { ending: "streaming", mountedBeforeEnd: false },
        { ending: "EOF", mountedBeforeEnd: false },
        { ending: "complete", mountedBeforeEnd: false },
        { ending: "EOF", mountedBeforeEnd: true },
        { ending: "complete", mountedBeforeEnd: true },
      ].map((scenario) => ({ resume, ...scenario })),
    ),
  )(
    "plays a new paused definition through $ending during closing ($resume, mountedBeforeEnd=$mountedBeforeEnd)",
    async ({ resume, ending, mountedBeforeEnd }) => {
      const recovery = {
        key: `late-footnote-${resume}-${ending}-${mountedBeforeEnd}`,
        baselineText: resume === "synchronized" ? "Before" : "",
        mountText: resume === "synchronized" ? "Before" : "",
        synchronized: resume === "synchronized",
      };
      const initial = "Before[^a] body.\n\n[^a]: Small complete note.\n\nAfter first body.";
      await render(initial, true, false, true, recovery);
      let closing = false;
      for (let index = 0; index < 400; index++) {
        await step();
        const first = noteById("a")!;
        if (!first.hidden && !noteState(first).open) {
          closing = true;
          break;
        }
      }
      expect(closing).toBe(true);

      const lateText = "LATE_NOTE_" + "new queued footnote words. ".repeat(8).trimEnd();
      const updated =
        initial + "\n\nLater body cites[^b].\n\n[^b]: " + lateText + "\n\nFinal body.";
      await render(
        updated,
        mountedBeforeEnd || ending !== "EOF",
        !mountedBeforeEnd && ending === "complete",
        true,
        recovery,
      );
      for (let index = 0; index < 80 && !noteById("b"); index++) await step();
      expect(noteById("b")).toBeDefined();
      if (mountedBeforeEnd)
        await render(updated, ending !== "EOF", ending === "complete", true, recovery);
      const paused = noteById("b")!;
      expect(paused.hidden).toBe(true);
      // 检查 authored 字符，避免只剩一个空格的 mask 被误判为尚未播放。
      expect(noteState(paused).hiddenText).toBe(lateText);
      expect(noteState(paused).visible).toBe("");

      const active: ReturnType<typeof noteState>[] = [];
      for (let index = 0; index < 450; index++) {
        const note = noteById("b")!;
        const state = noteState(note);
        if (!note.hidden && state.open) active.push(state);
        await step();
      }
      expect(active[0]).toMatchObject({ text: lateText, visible: "", hiddenText: lateText });
      expect(active.some((state) => state.visible.length > 0 && state.hiddenText.length > 0)).toBe(
        true,
      );
      expect(active.some((state) => state.visible === lateText)).toBe(true);
      expect(visibleBody().visible).toContain("Final body.");
    },
  );

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

  it.each(["synchronized", "forceShow"])(
    "keeps complete %s history immediate with its footnotes closed",
    async (kind) => {
      const source = "Before[^a].\n\n[^a]: Historical note.\n\nHistorical ending.";
      await render(source, true, false, true, {
        key: `history-footnote-${kind}`,
        baselineText: kind === "synchronized" ? source : "",
        mountText: source,
        synchronized: true,
        forceShow: kind === "forceShow",
      });
      expect(visibleBody().visible).toContain("Historical ending.");
      const first = noteById("a")!;
      expect(first.hidden).toBe(true);
      expect(noteState(first)).toMatchObject({
        visible: "Historical note.",
        hiddenText: "",
        open: false,
      });
      await advance(80);
      expect(first.hidden).toBe(true);
      expect(noteState(first).hiddenText).toBe("");
    },
  );

  it("shows a definition straddling synchronized history without replaying its prefix", async () => {
    const history = "Before[^a].\n\n[^a]: Historical prefix";
    await render(history + " with a new suffix.\n\nAfter body.", true, false, true, {
      key: "history-continuation-footnote",
      baselineText: history,
      mountText: history,
      synchronized: true,
    });
    expect(noteState(noteById("a")!)).toMatchObject({
      visible: "Historical prefix with a new suffix.",
      hiddenText: "",
    });
    await advance(300);
    expect(noteState(noteById("a")!).hiddenText).toBe("");
    expect(visibleBody().visible).toContain("After body.");
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
