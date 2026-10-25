import { Fragment, StrictMode } from "react";
import { act, fakeTimers, render as renderScreen, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";
import { smoothTextPlaybackStore } from "../lib/smoothTextPlayback";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  class TestHighlight extends Set<AbstractRange> {}
  let page: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let clock: number;
  let strictMode = false;
  let claimInitialText: () => boolean;
  let reviewResume:
    | {
        key: string;
        baselineText: string;
        mountText: string;
        synchronized: boolean;
        generation?: number;
        forceShow?: boolean;
      }
    | undefined;
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
  function visibleBody() {
    const body = page.querySelector<HTMLElement>("[data-smooth-streaming]")!;
    const hidden = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
    let visible = "";
    let reachedHiddenGlyph = false;
    let hiddenGlyphs = 0;
    for (const node of authoredTextNodes(body)) {
      for (let offset = 0; offset < node.length; offset++) {
        const isHidden = hidden.some(
          (range) =>
            range.startContainer === node &&
            range.startOffset <= offset &&
            range.endOffset > offset,
        );
        if (isHidden) {
          hiddenGlyphs++;
          reachedHiddenGlyph = true;
        }
        if (!reachedHiddenGlyph) visible += node.data[offset];
      }
    }
    return {
      source: authoredTextNodes(body)
        .map((node) => node.data)
        .join(""),
      visible,
      hiddenGlyphs,
    };
  }
  function noteState(note: HTMLLIElement) {
    const nodes = authoredTextNodes(note, false);
    const hidden = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
    let text = "";
    let reachedHiddenGlyph = false;
    let hiddenGlyphs = 0;
    for (const node of nodes) {
      for (let offset = 0; offset < node.length; offset++) {
        const isHidden = hidden.some(
          (range) =>
            range.startContainer === node &&
            range.startOffset <= offset &&
            range.endOffset > offset,
        );
        if (isHidden) {
          hiddenGlyphs++;
          reachedHiddenGlyph = true;
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
      hidden: note.hidden,
      hiddenGlyphs,
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
    const Wrapper = strictMode ? StrictMode : Fragment;
    await act(() =>
      screen.rerender(
        <Wrapper>
          <ChatMarkdown
            cwd={undefined}
            text={text}
            isStreaming={isStreaming}
            smoothComplete={smoothComplete}
            smoothStreaming
            smoothTextResume={reviewResume}
            claimInitialSmoothText={claimInitialText}
            footnotesAutoCollapse={footnotesAutoCollapse}
            smoothOutputMode="character"
            smoothTextFadeDurationMs={200}
          />
        </Wrapper>,
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

  stack.defer(() => {
    if (reviewResume) smoothTextPlaybackStore.delete(reviewResume.key);
    page.remove();
    vi.restoreAllMocks();
    if (originalBounds)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  resources.use(fakeTimers({ now: 1_800_000_000_000 }));
  clock = 0;
  strictMode = false;
  claimInitialText = () => true;
  reviewResume = undefined;
  frames = new Map();
  let frameId = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  resources.use(
    stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  resources.use(stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id)));
  resources.use(stubGlobal("Highlight", TestHighlight));
  resources.use(
    stubGlobal(
      "CSS",
      Object.create(CSS, { highlights: { value: new Map<string, TestHighlight>() } }),
    ),
  );
  resources.use(
    stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
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

  resources.use(
    stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    ),
  );
  // 夹具自行推进播放时钟；这里验证独立内容生命周期，不需要路由调度。
  const screen = stack.use(await renderScreen(null, { container: page, router: false }));
  const owned = stack.move();
  return {
    TestHighlight,
    page,
    frames,
    originalBounds,
    originalRects,
    notes,
    noteById,
    authoredTextNodes,
    visibleBody,
    noteState,
    step,
    advance,
    render,
    rangeRects,
    screen,
    get clock() {
      return clock;
    },
    set clock(value: typeof clock) {
      clock = value;
    },
    get strictMode() {
      return strictMode;
    },
    set strictMode(value: typeof strictMode) {
      strictMode = value;
    },
    get claimInitialText() {
      return claimInitialText;
    },
    set claimInitialText(value: typeof claimInitialText) {
      claimInitialText = value;
    },
    get reviewResume() {
      return reviewResume;
    },
    set reviewResume(value: typeof reviewResume) {
      reviewResume = value;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
describe("resumed Markdown completion and footnote handoff", () => {
  const source =
    "Before body cites[^a] and [^b].\n\n" +
    "[^a]: Paper boat waits at the first grid.\n\n" +
    "[^b]: Lamp lights up the second scale.\n\n" +
    "After body must follow both notes.";

  it.each([
    { state: "complete ends streaming", isStreaming: false },
    { state: "complete arrives while streaming", isStreaming: true },
  ])("plays pending notes before the tail when $state", async ({ isStreaming }) => {
    await using fixture = await setup();
    const { noteById, visibleBody, noteState, step, advance, render } = fixture;
    fixture.reviewResume = {
      key: `eof-handoff-${isStreaming}`,
      baselineText: "",
      mountText: "",
      synchronized: false,
    };
    await render("");
    await render(source);
    await advance(3);

    await render(source, isStreaming, true);
    let firstPlayed = -1;
    let secondPlayed = -1;
    let tailAt = -1;
    for (let index = 0; index < 750; index++) {
      await step();
      const first = noteById("a");
      const second = noteById("b");
      if (
        first &&
        noteState(first).open &&
        noteState(first).visible.includes("Paper boat waits at the first grid.")
      )
        firstPlayed = firstPlayed < 0 ? fixture.clock : firstPlayed;
      if (
        second &&
        noteState(second).open &&
        noteState(second).visible.includes("Lamp lights up the second scale.")
      )
        secondPlayed = secondPlayed < 0 ? fixture.clock : secondPlayed;
      if (visibleBody().visible.includes("After body"))
        tailAt = tailAt < 0 ? fixture.clock : tailAt;
    }

    const evidence = JSON.stringify({ firstPlayed, secondPlayed, tailAt, body: visibleBody() });
    expect(firstPlayed, evidence).toBeGreaterThan(0);
    expect(secondPlayed, evidence).toBeGreaterThan(firstPlayed);
    expect(tailAt, evidence).toBeGreaterThan(secondPlayed);
    expect(noteState(noteById("a")!).text).toContain("Paper boat waits at the first grid.");
    expect(noteState(noteById("b")!).text).toContain("Lamp lights up the second scale.");
  });

  it.each([
    { state: "complete on first mount", complete: true, strict: false },
    { state: "streaming ends on first mount", complete: false, strict: false },
    { state: "complete on first StrictMode mount", complete: true, strict: true },
  ])(
    "plays an initially claimed snapshot through the footnote FIFO when $state",
    async ({ complete, strict }) => {
      await using fixture = await setup();
      const { frames, noteById, visibleBody, noteState, step, render } = fixture;
      const firstMountSource =
        "BODY_A.[^a] and [^b]\n\n" +
        "[^a]: NOTE_A_PENDING.\n\n" +
        "[^b]: NOTE_B_PENDING.\n\n" +
        "BODY_AFTER.";
      const claim = vi.fn(() => true);
      fixture.strictMode = strict;
      fixture.claimInitialText = claim;
      fixture.reviewResume = {
        key: `first-mount-${complete}-${strict}`,
        baselineText: "",
        mountText: "",
        synchronized: false,
        generation: 1,
      };

      await render(firstMountSource, false, complete);

      const initial = { body: visibleBody(), raf: frames.size };
      expect(initial.body.source).toContain("BODY_A.");
      expect(initial.body.visible).not.toContain("BODY_AFTER.");
      expect(initial.body.hiddenGlyphs).toBeGreaterThan(0);
      expect(initial.raf).toBeGreaterThan(0);

      let firstPlayed = -1;
      let secondPlayed = -1;
      let tailAt = -1;
      let firstHadHiddenGlyphs = false;
      let secondHadHiddenGlyphs = false;
      for (let index = 0; index < 375; index++) {
        await step();
        const first = noteById("a");
        const second = noteById("b");
        if (first && !noteState(first).hidden && noteState(first).hiddenGlyphs > 0)
          firstHadHiddenGlyphs = true;
        if (second && !noteState(second).hidden && noteState(second).hiddenGlyphs > 0)
          secondHadHiddenGlyphs = true;
        if (
          first &&
          !noteState(first).hidden &&
          noteState(first).open &&
          noteState(first).visible.includes("NOTE_A_PENDING.")
        )
          firstPlayed = firstPlayed < 0 ? fixture.clock : firstPlayed;
        if (
          second &&
          !noteState(second).hidden &&
          noteState(second).open &&
          noteState(second).visible.includes("NOTE_B_PENDING.")
        )
          secondPlayed = secondPlayed < 0 ? fixture.clock : secondPlayed;
        if (visibleBody().visible.includes("BODY_AFTER."))
          tailAt = tailAt < 0 ? fixture.clock : tailAt;
      }

      const evidence = JSON.stringify({
        state: { complete, strict },
        initial,
        firstPlayed,
        secondPlayed,
        tailAt,
        firstHadHiddenGlyphs,
        secondHadHiddenGlyphs,
        finalBody: visibleBody(),
        raf: frames.size,
        claimCalls: claim.mock.calls.length,
      });
      expect(firstPlayed, evidence).toBeGreaterThan(0);
      expect(secondPlayed, evidence).toBeGreaterThan(firstPlayed);
      expect(tailAt, evidence).toBeGreaterThan(secondPlayed);
      expect(firstHadHiddenGlyphs, evidence).toBe(true);
      expect(secondHadHiddenGlyphs, evidence).toBe(true);
      expect(visibleBody().visible, evidence).toContain("BODY_AFTER.");
      expect(frames.size, evidence).toBe(0);
      expect(claim, evidence).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      state: "first complete",
      isStreaming: false,
      complete: true,
      strict: false,
      blankLines: false,
    },
    {
      state: "first stream-ended",
      isStreaming: false,
      complete: false,
      strict: false,
      blankLines: false,
    },
    {
      state: "first complete in StrictMode",
      isStreaming: false,
      complete: true,
      strict: true,
      blankLines: false,
    },
    {
      state: "complete while streaming",
      isStreaming: true,
      complete: true,
      strict: false,
      blankLines: false,
    },
    {
      state: "first complete with trailing blank lines",
      isStreaming: false,
      complete: true,
      strict: false,
      blankLines: true,
    },
  ])(
    "drains the EOF-only final note group for $state",
    async ({ state, isStreaming, complete, strict, blankLines }) => {
      await using fixture = await setup();
      const { frames, notes, noteById, visibleBody, noteState, step, render } = fixture;
      const finalDefinitions =
        "BODY.[^a] and [^b]\n\n[^a]: NOTE_A_DONE.\n\n[^b]: NOTE_B_DONE." +
        (blankLines ? "\n\n" : "");
      const claim = vi.fn(() => true);
      fixture.strictMode = strict;
      fixture.claimInitialText = claim;
      fixture.reviewResume = {
        key: `eof-only-final-notes-${state}`,
        baselineText: "",
        mountText: "",
        synchronized: false,
        generation: 1,
      };

      await render(finalDefinitions, isStreaming, complete);
      const initial = { body: visibleBody(), notes: notes().map(noteState), raf: frames.size };
      const times: [number, number] = [-1, -1];
      const masks = [false, false];
      for (let index = 0; index < 375; index++) {
        await step();
        for (const [noteIndex, id] of [
          [0, "a"],
          [1, "b"],
        ] as const) {
          const note = noteById(id);
          if (!note) continue;
          const current = noteState(note);
          if (!current.hidden && current.open && current.hiddenGlyphs > 0) masks[noteIndex] = true;
          const authored = noteIndex === 0 ? "NOTE_A_DONE." : "NOTE_B_DONE.";
          if (
            !current.hidden &&
            current.open &&
            current.visible.includes(authored) &&
            times[noteIndex] < 0
          )
            times[noteIndex] = fixture.clock;
        }
      }

      const drained = {
        body: visibleBody(),
        notes: notes().map(noteState),
        times,
        masks,
        raf: frames.size,
        claimCalls: claim.mock.calls.length,
      };
      await render(
        `${finalDefinitions}\n\nLATE_BODY.[^c]\n\n[^c]: NOTE_C_LATE.`,
        isStreaming,
        complete,
      );
      let lateMask = false;
      let latePlayedAt = -1;
      for (let index = 0; index < 125; index++) {
        await step();
        const note = noteById("c");
        if (!note) continue;
        const current = noteState(note);
        if (!current.hidden && current.open && current.hiddenGlyphs > 0) lateMask = true;
        if (
          !current.hidden &&
          current.open &&
          current.visible.includes("NOTE_C_LATE.") &&
          latePlayedAt < 0
        )
          latePlayedAt = fixture.clock;
      }
      const lateNote = noteById("c");
      const afterLateAppend = {
        body: visibleBody(),
        note: lateNote ? noteState(lateNote) : null,
        lateMask,
        latePlayedAt,
        raf: frames.size,
        claimCalls: claim.mock.calls.length,
      };
      const evidence = JSON.stringify({ state, initial, drained, afterLateAppend });

      expect(initial.body.hiddenGlyphs, evidence).toBeGreaterThan(0);
      expect(initial.raf, evidence).toBeGreaterThan(0);
      expect(masks, evidence).toEqual([true, true]);
      expect(times[0], evidence).toBeGreaterThan(0);
      expect(times[1], evidence).toBeGreaterThan(times[0]);
      expect(
        drained.notes.map((note) => note.hidden),
        evidence,
      ).toEqual([true, true]);
      expect(
        drained.notes.map((note) => note.open),
        evidence,
      ).toEqual([false, false]);
      expect(drained.raf, evidence).toBe(0);
      expect(afterLateAppend.body.source, evidence).toContain("LATE_BODY.");
      expect(afterLateAppend.body.visible, evidence).toContain("LATE_BODY.");
      expect(afterLateAppend.note, evidence).not.toBeNull();
      expect(afterLateAppend.note?.hidden, evidence).toBe(true);
      expect(afterLateAppend.note?.open, evidence).toBe(false);
      expect(afterLateAppend.lateMask, evidence).toBe(true);
      expect(afterLateAppend.latePlayedAt, evidence).toBeGreaterThan(times[1]);
      expect(afterLateAppend.raf, evidence).toBe(0);
      expect(afterLateAppend.claimCalls, evidence).toBe(1);
    },
  );

  it("keeps an EOF-only final note group live until the source ends", async () => {
    await using fixture = await setup();
    const { frames, notes, noteById, noteState, step, advance, render } = fixture;
    const finalDefinitions = "BODY.[^a] and [^b]\n\n[^a]: NOTE_A_DONE.\n\n[^b]: NOTE_B_DONE.";
    fixture.reviewResume = {
      key: "eof-only-final-notes-still-streaming",
      baselineText: "",
      mountText: "",
      synchronized: false,
      generation: 1,
    };

    await render(finalDefinitions, true, false);
    let firstHadHiddenGlyphs = false;
    let secondHadHiddenGlyphs = false;
    for (let index = 0; index < 375; index++) {
      await step();
      const first = noteById("a");
      const second = noteById("b");
      if (first && !noteState(first).hidden && noteState(first).hiddenGlyphs > 0)
        firstHadHiddenGlyphs = true;
      if (second && !noteState(second).hidden && noteState(second).hiddenGlyphs > 0)
        secondHadHiddenGlyphs = true;
    }
    const whileStreaming = {
      notes: notes().map(noteState),
      firstHadHiddenGlyphs,
      secondHadHiddenGlyphs,
      raf: frames.size,
    };

    await render(finalDefinitions, false, true);
    await advance(125);
    const afterEnd = { notes: notes().map(noteState), raf: frames.size };
    const evidence = JSON.stringify({ whileStreaming, afterEnd });
    expect(firstHadHiddenGlyphs, evidence).toBe(true);
    expect(secondHadHiddenGlyphs, evidence).toBe(true);
    expect(
      whileStreaming.notes.map((note) => note.open),
      evidence,
    ).toEqual([true, true]);
    expect(
      whileStreaming.notes.map((note) => note.hidden),
      evidence,
    ).toEqual([false, false]);
    expect(
      afterEnd.notes.map((note) => note.open),
      evidence,
    ).toEqual([false, false]);
    expect(
      afterEnd.notes.map((note) => note.hidden),
      evidence,
    ).toEqual([true, true]);
    expect(afterEnd.raf, evidence).toBe(0);
  });

  it("keeps an unclaimed first snapshot as static history", async () => {
    await using fixture = await setup();
    const { frames, noteById, visibleBody, noteState, render } = fixture;
    const claim = vi.fn(() => false);
    fixture.claimInitialText = claim;
    fixture.reviewResume = {
      key: "unclaimed-first-snapshot-history",
      baselineText: "",
      mountText: "",
      synchronized: false,
    };

    await render(source, false, true);

    expect(visibleBody().visible).toContain("After body must follow both notes.");
    expect(noteState(noteById("a")!).visible).toContain("Paper boat waits at the first grid.");
    expect(noteState(noteById("b")!).visible).toContain("Lamp lights up the second scale.");
    expect(frames.size).toBe(0);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("keeps a fully checkpointed first snapshot static after a successful claim", async () => {
    await using fixture = await setup();
    const { frames, noteById, visibleBody, noteState, advance, render } = fixture;
    const key = "checkpointed-first-snapshot-history";
    const claim = vi.fn(() => true);
    smoothTextPlaybackStore.set(key, {
      visibleText: source,
      sourceText: source,
      intervalMs: null,
      recordedAt: 1_800_000_000_000,
    });
    fixture.claimInitialText = claim;
    fixture.reviewResume = {
      key,
      baselineText: "",
      mountText: "",
      synchronized: false,
      generation: 1,
    };

    await render(source, false, true);

    expect(visibleBody().visible).toContain("After body must follow both notes.");
    expect(noteState(noteById("a")!).open).toBe(false);
    expect(noteState(noteById("b")!).open).toBe(false);
    await advance(2);
    expect(visibleBody().visible).toContain("After body must follow both notes.");
    expect(frames.size).toBe(0);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("keeps a painted resume prefix static while pending groups and the tail follow it", async () => {
    await using fixture = await setup();
    const { noteById, visibleBody, noteState, step, advance, render } = fixture;
    const prefix = "Earlier content is already visible.\n\n";
    const resumedSource =
      prefix +
      "Body cites[^a] and [^b].\n\n" +
      "[^a]: Paper boat waits at the first grid.\n\n" +
      "[^b]: Lamp lights up the second scale.\n\n" +
      "After body must follow both notes.";
    fixture.reviewResume = {
      key: "painted-prefix-eof-handoff",
      baselineText: prefix,
      mountText: prefix,
      synchronized: true,
    };
    await render(prefix);
    expect(visibleBody().visible).toContain("Earlier content is already visible.");
    await render(resumedSource);
    await advance(3);
    await render(resumedSource, false, true);

    let firstPlayed = -1;
    let secondPlayed = -1;
    let tailAt = -1;
    for (let index = 0; index < 750; index++) {
      await step();
      const first = noteById("a");
      const second = noteById("b");
      if (
        first &&
        noteState(first).open &&
        noteState(first).visible.includes("Paper boat waits at the first grid.")
      )
        firstPlayed = firstPlayed < 0 ? fixture.clock : firstPlayed;
      if (
        second &&
        noteState(second).open &&
        noteState(second).visible.includes("Lamp lights up the second scale.")
      )
        secondPlayed = secondPlayed < 0 ? fixture.clock : secondPlayed;
      if (visibleBody().visible.includes("After body"))
        tailAt = tailAt < 0 ? fixture.clock : tailAt;
    }

    expect(visibleBody().visible).toContain("Earlier content is already visible.");
    const evidence = JSON.stringify({ firstPlayed, secondPlayed, tailAt, body: visibleBody() });
    expect(firstPlayed, evidence).toBeGreaterThan(0);
    expect(secondPlayed, evidence).toBeGreaterThan(firstPlayed);
    expect(tailAt, evidence).toBeGreaterThan(secondPlayed);
  });

  it("does not replay fully synchronized completed history", async () => {
    await using fixture = await setup();
    const { frames, noteById, visibleBody, noteState, advance, render } = fixture;
    fixture.reviewResume = {
      key: "completed-history",
      baselineText: source,
      mountText: source,
      synchronized: true,
    };
    await render(source, false, true, false);

    expect(visibleBody().visible).toContain("After body must follow both notes.");
    expect(noteState(noteById("a")!).visible).toContain("Paper boat waits at the first grid.");
    expect(noteState(noteById("b")!).visible).toContain("Lamp lights up the second scale.");
    await advance(1);
    expect(frames.size).toBe(0);
  });

  it("keeps forceShow static", async () => {
    await using fixture = await setup();
    const { frames, noteById, visibleBody, noteState, render } = fixture;
    fixture.reviewResume = {
      key: "force-show-history",
      baselineText: "",
      mountText: "",
      synchronized: false,
      forceShow: true,
    };
    await render(source, false, true);

    expect(visibleBody().visible).toContain("After body must follow both notes.");
    expect(noteState(noteById("a")!).visible).toContain("Paper boat waits at the first grid.");
    expect(noteState(noteById("b")!).visible).toContain("Lamp lights up the second scale.");
    expect(frames.size).toBe(0);
  });

  it("keeps the notes expanded when automatic collapse is disabled", async () => {
    await using fixture = await setup();
    const { page, noteById, noteState, render } = fixture;
    fixture.reviewResume = {
      key: "expanded-notes-setting",
      baselineText: "",
      mountText: "",
      synchronized: false,
    };
    await render("");
    await render(source, true, false, false);
    await render(source, false, true, false);

    expect(
      page
        .querySelector("[data-markdown-details-open]")
        ?.getAttribute("data-markdown-details-open"),
    ).toBe("true");
    expect(noteState(noteById("a")!).visible).toContain("Paper boat waits at the first grid.");
    expect(noteState(noteById("b")!).visible).toContain("Lamp lights up the second scale.");
  });

  it("lets manual expansion take over an active resumed message", async () => {
    await using fixture = await setup();
    const { page, noteById, visibleBody, noteState, advance, render } = fixture;
    fixture.reviewResume = {
      key: "manual-eof-takeover",
      baselineText: "",
      mountText: "",
      synchronized: false,
    };
    await render("");
    await render(source);
    await advance(3);
    await render(source, false, true);

    await act(() =>
      page
        .querySelector<HTMLElement>("[data-stream-footnotes]")!
        .dispatchEvent(new Event("t3-expand-footnotes")),
    );
    await advance(400);

    expect(noteState(noteById("a")!).open).toBe(true);
    expect(noteState(noteById("b")!).open).toBe(true);
    expect(noteState(noteById("a")!).visible).toContain("Paper boat waits at the first grid.");
    expect(noteState(noteById("b")!).visible).toContain("Lamp lights up the second scale.");
    expect(visibleBody().visible).toContain("After body must follow both notes.");
  });
});
