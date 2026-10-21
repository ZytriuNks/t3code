// @vitest-environment jsdom
import { act, createRef, StrictMode, type ReactNode } from "react";
import { CheckpointRef, EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const settledGlyphs = vi.hoisted(() => [] as { id: string; at: number }[]);
vi.mock("../hooks/useSmoothText", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSmoothText")>();
  return {
    ...actual,
    useSmoothText(...[ref, options]: Parameters<typeof actual.useSmoothText>) {
      return actual.useSmoothText(ref, {
        ...options,
        onSettled: () => {
          const note = ref.current?.closest("[data-footnotes] li[id]");
          if (note) settledGlyphs.push({ id: note.id, at: performance.now() });
          options.onSettled?.();
        },
      });
    },
  };
});

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    renderItem: (input: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={item.id}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShell: () => null,
  useProject: () => null,
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
  useOpenPrLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { createTimelineSendMotion, TimelineSendMotionContext } from "./chat/timelineSendMotion";
import { smoothTextPlaybackStore } from "../lib/smoothTextPlayback";

class TestHighlight extends Set<AbstractRange> {}

let root: Root;
let page: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let clock: number;
let reducedMotion = false;
let physicalRows = false;
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

function rects(range: Range) {
  if (physicalRows) {
    const parent = range.startContainer.parentElement;
    const content = parent?.closest<HTMLElement>(
      parent.closest("[data-footnotes]") ? ".flow-root" : "[data-smooth-streaming]",
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
      (_, index) => new DOMRect(0, 103 + (Math.floor(start / 32) + index) * 20, 240, 14),
    );
  }
  const text = range.toString();
  return text ? [new DOMRect(0, 100, 240, Math.max(20, Math.ceil(text.length / 32) * 20))] : [];
}

function playbackState() {
  const hidden = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
  const body = page.querySelector<HTMLElement>("[data-smooth-streaming]")!;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[data-footnotes], a[data-footnote-backref]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const hiddenBody = hidden.reduce((sum, range) => sum + range.toString().length, 0);
  const note = page.querySelector<HTMLElement>("[data-footnotes] li");
  const hiddenNote = note
    ? hidden.reduce(
        (sum, range) => sum + (note.contains(range.startContainer) ? range.toString().length : 0),
        0,
      )
    : 0;
  return { source: nodes.map((node) => node.data).join(""), hiddenBody, hiddenNote };
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clock = 0;
  reducedMotion = false;
  physicalRows = false;
  settledGlyphs.length = 0;
  frames = new Map();
  let id = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frameId: number) => frames.delete(frameId));
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map<string, TestHighlight>() });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: function (this: Range) {
      return rects(this);
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function (this: Range) {
      const rows = rects(this);
      return rows.length
        ? new DOMRect(rows[0]!.x, rows[0]!.top, rows[0]!.width, rows.at(-1)!.bottom - rows[0]!.top)
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

const listRef = createRef<LegendListRef | null>();
function entry(text: string, streaming: boolean, id = "answer", run = "run-1") {
  return {
    id,
    kind: "message" as const,
    createdAt: "2026-10-18T10:00:00.000Z",
    message: {
      id: MessageId.make(id),
      runId: RunId.make(run),
      role: "assistant" as const,
      text,
      streaming,
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    },
  };
}
async function renderTimeline(
  text: string,
  working: boolean,
  options: {
    structure?: "default" | "restructured";
    smooth?: boolean;
    thread?: string;
    status?: "running" | "completed" | "interrupted";
    streaming?: boolean;
    run?: string;
    older?: boolean;
    recovery?: boolean;
    strict?: boolean;
    autoCollapse?: boolean;
    diff?: boolean;
    user?: boolean;
    motion?: ReturnType<typeof createTimelineSendMotion>;
  } = {},
) {
  const run = options.run ?? "run-1";
  const content = (
    <MessagesTimeline
      textPlayback={
        options.recovery
          ? {
              generation: 1,
              phase: "synchronized",
              baselineByItemId: new Map(),
              legacyRunIds: new Set(),
            }
          : null
      }
      isWorking={working}
      activeTurnInProgress={working}
      timelineEntries={[
        ...(options.user
          ? [
              {
                ...entry("A newly sent question.", false, "user", run),
                message: {
                  ...entry("A newly sent question.", false, "user", run).message,
                  role: "user" as const,
                },
              },
            ]
          : []),
        ...(options.older
          ? [entry("Older historical page.", false, "older-answer", "older-run")]
          : []),
        ...(text ? [entry(text, options.streaming ?? working, "answer", run)] : []),
      ]}
      latestRun={{
        runId: RunId.make(run),
        status: options.status ?? (working ? "running" : "completed"),
        startedAt: "2026-10-18T10:00:00.000Z",
        completedAt: working ? null : "2026-10-18T10:00:01.000Z",
      }}
      conversationStructure={options.structure ?? "default"}
      smoothStreaming={options.smooth ?? true}
      smoothOutputMode="auto"
      smoothOutputLineMode="adaptive"
      smoothTextFadeDurationMs={500}
      smoothTextYieldDurationMs={200}
      footnotesAutoCollapse={options.autoCollapse ?? true}
      listRef={listRef}
      turnDiffSummaries={
        options.diff
          ? [
              {
                runId: RunId.make(run),
                assistantMessageId: MessageId.make("answer"),
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.make("checkpoint"),
                completedAt: "2026-10-18T10:00:01.000Z",
                status: "ready",
                files: [{ path: "answer.ts", kind: "modified", additions: 1, deletions: 0 }],
              },
            ]
          : []
      }
      providerStatuses={[]}
      runs={[]}
      routeThreadKey={options.thread ?? "completion-thread"}
      onOpenTurnDiff={() => {}}
      onOpenThread={() => {}}
      onForkFromRun={async () => {}}
      onRollbackCheckpoint={() => {}}
      supportsConversationRollback={false}
      onRevertToTurnCount={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      activeThreadEnvironmentId={EnvironmentId.make("local")}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={() => {}}
      onAnchorSizeChanged={() => {}}
      contentInsetEndAdjustment={0}
      liveFollowEnabled
      onIsAtEndChange={() => {}}
      onManualNavigation={() => {}}
    />
  );
  await act(() =>
    root.render(
      <TimelineSendMotionContext value={options.motion ?? null}>
        {options.strict ? <StrictMode>{content}</StrictMode> : content}
      </TimelineSendMotionContext>,
    ),
  );
}
function thinking() {
  return page.querySelector('[data-timeline-status-height$=":thinking"]');
}
function fading() {
  return [...CSS.highlights.entries()]
    .filter(([name]) => name !== "t3-smooth-hidden")
    .reduce((sum, [, ranges]) => sum + ranges.size, 0);
}
function noteSettled(note: HTMLElement | undefined) {
  return (
    !!note &&
    !note.hidden &&
    ![...CSS.highlights.values()].some((ranges) =>
      [...ranges].some((range) => note.contains(range.startContainer)),
    ) &&
    !note.querySelector("[data-smooth-footnote-backref]")
  );
}
async function finishTimeline() {
  for (let index = 0; index < 2000 && playbackBusy(); index++) await step(16);
  expect(thinking()).toBeNull();
  expect(playbackState().hiddenBody + playbackState().hiddenNote).toBe(0);
  expect(fading()).toBe(0);
  expect(page.querySelector("[data-smooth-footnote-backref]")).toBeNull();
  expect(frames.size).toBe(0);
}

function playbackBusy() {
  return (
    frames.size > 0 ||
    vi.getTimerCount() > 0 ||
    playbackState().hiddenBody + playbackState().hiddenNote + fading() > 0
  );
}

describe("source completion versus visible completion in the production timeline", () => {
  it.each(["default", "restructured"] as const)(
    "attaches %s live send motion to the real user content without moving its measured row",
    async (structure) => {
      const motion = createTimelineSendMotion();
      const finished = vi.fn();
      motion.begin({
        threadKey: "completion-thread",
        messageId: "user",
        fromTop: 600,
        // The mocked page measures only its text; give the entrance a real
        // viewport so its keep-inside-viewport clamp leaves room to travel.
        viewport: () =>
          ({ getBoundingClientRect: () => new DOMRect(0, 0, 256, 800) }) as HTMLElement,
        reducedMotion: false,
      });
      await renderTimeline("", true, { structure, user: true, motion });
      const row = page.querySelector<HTMLElement>('[data-message-id="user"]')!;
      const content = row.querySelector<HTMLElement>(".group.flex.flex-col.items-end")!;
      expect(content).not.toBeNull();
      expect(Number.parseFloat(content.style.translate.split(" ")[1]!)).toBeGreaterThan(0);
      expect(row.style.translate).toBe("");
      const height = row.getBoundingClientRect().height;
      await act(async () => {
        motion.position("user", () => {}, finished);
        await Promise.resolve();
      });
      const offsets: number[] = [];
      for (let frame = 0; frame < 80 && motion.isPending(); frame++) {
        await step();
        offsets.push(Number.parseFloat(content.style.translate.split(" ")[1] ?? "0"));
        expect(row.getBoundingClientRect().height).toBe(height);
        expect(row.style.translate).toBe("");
      }
      expect(offsets.some((offset) => offset > 0)).toBe(true);
      expect(offsets.every((offset, index) => index === 0 || offset <= offsets[index - 1]!)).toBe(
        true,
      );
      expect(content.style.translate).toBe("");
      expect(finished).toHaveBeenCalledOnce();
      expect(motion.isPending()).toBe(false);
      expect(thinking()).not.toBeNull();
    },
  );
  it.each(["default", "restructured"] as const)(
    "shows %s Thinking for real work even without pending text, and withholds current diff controls",
    async (structure) => {
      await renderTimeline("", true, { structure });
      expect(thinking()).not.toBeNull();
      await renderTimeline("A".repeat(300), true, { structure, diff: true });
      expect(thinking()).not.toBeNull();
      expect(page.querySelector('[aria-label="Open diff"]')).toBeNull();
      await step();
      await renderTimeline("A".repeat(300), false, { structure, diff: true });
      expect(thinking()).toBeNull();
      expect(playbackState().hiddenBody + fading()).toBeGreaterThan(0);
      expect(page.querySelector('[aria-label="Open diff"]')).not.toBeNull();
      await finishTimeline();
    },
  );
  it.each(["default", "restructured"] as const)(
    "ends %s Thinking at work completion while a restored bounded tail keeps playing",
    async (structure) => {
      const source = "History tail";
      const key = JSON.stringify(["local", "completion-thread", "run-1", "answer", "body"]);
      smoothTextPlaybackStore.set(key, {
        visibleText: "History ",
        sourceText: source,
        intervalMs: 10,
        recordedAt: Date.now(),
      });
      try {
        await renderTimeline(source, true, { structure, recovery: true });
        expect(playbackState().hiddenBody).toBeGreaterThan(0);
        await renderTimeline(source, false, { structure, recovery: true });
        expect(playbackState().hiddenBody + fading()).toBeGreaterThan(0);
        expect(thinking()).toBeNull();
        await finishTimeline();
      } finally {
        smoothTextPlaybackStore.delete(key);
      }
    },
  );

  it("keeps restored playback ownership across StrictMode effects", async () => {
    const source = "History tail";
    const key = JSON.stringify(["local", "completion-thread", "run-1", "answer", "body"]);
    smoothTextPlaybackStore.set(key, {
      visibleText: "History ",
      sourceText: source,
      intervalMs: 10,
      recordedAt: Date.now(),
    });
    try {
      await renderTimeline(source, true, { recovery: true, strict: true });
      await renderTimeline(source, false, { recovery: true, strict: true });
      expect(playbackState().hiddenBody + fading()).toBeGreaterThan(0);
      expect(thinking()).toBeNull();
      await finishTimeline();
    } finally {
      smoothTextPlaybackStore.delete(key);
    }
  });

  it.each(["ended tail", "no tail", "reduced motion"])(
    "does not acquire phantom playback from a %s recovery",
    async (kind) => {
      const source = "History tail";
      const key = JSON.stringify(["local", "completion-thread", "run-1", "answer", "body"]);
      smoothTextPlaybackStore.set(key, {
        visibleText: kind === "no tail" ? source : "History ",
        sourceText: source,
        intervalMs: 10,
        recordedAt: Date.now(),
      });
      reducedMotion = kind === "reduced motion";
      const mounts: Element[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('[data-timeline-status-height$=":thinking"]')) mounts.push(node);
            mounts.push(...node.querySelectorAll('[data-timeline-status-height$=":thinking"]'));
          }
      });
      observer.observe(page, { childList: true, subtree: true });
      try {
        await renderTimeline(source, kind !== "ended tail", { recovery: true, strict: true });
        if (kind !== "ended tail") mounts.length = 0;
        await renderTimeline(source, false, { recovery: true, strict: true });
        await step();
        expect(playbackState().hiddenBody + fading()).toBe(0);
        expect(thinking()).toBeNull();
        expect(mounts).toEqual([]);
      } finally {
        observer.disconnect();
        smoothTextPlaybackStore.delete(key);
      }
    },
  );

  it.each(["default", "restructured"] as const)(
    "drains %s real EOF across two retained body boundaries without bypassing glyph or fade clocks",
    async (structure) => {
      physicalRows = true;
      const source = `${"A".repeat(1200)}[^a][^b]\n\n[^a]: First note.\n\n${"B".repeat(1200)}\n\n[^b]: Second note.\n\nFinal suffix.`;
      await renderTimeline("", true, { structure });
      await renderTimeline(source, true, { structure });
      await step();
      await renderTimeline(source, false, { structure });
      expect(playbackState().hiddenBody).toBeGreaterThan(128);
      expect(playbackState().source).not.toContain("BBBB");
      let firstNote = false;
      let firstClosed = false;
      let firstPlayed = false;
      let secondBody = false;
      let secondNote = false;
      let secondClosed = false;
      let secondPlayed = false;
      let finalBody = false;
      let finalFade = false;
      let previousVisible = 0;
      let maxGrowth = 0;
      let elapsed = 0;
      const checkedGlyphs = new WeakMap<Text, Set<number>>();
      for (let i = 0; i < 2000 && playbackBusy(); i++) {
        await step();
        elapsed += 16;
        const body = page.querySelector<HTMLElement>("[data-smooth-streaming]")!;
        const hidden = [...(CSS.highlights.get("t3-smooth-hidden") ?? [])];
        let visible = "";
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.parentElement?.closest("[data-footnotes], a[data-footnote-backref]")
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        });
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          for (let offset = 0; offset < node.length; offset++) {
            if (
              hidden.some(
                (range) =>
                  range.startContainer === node &&
                  range.startOffset <= offset &&
                  range.endOffset > offset,
              )
            )
              continue;
            visible += node.data[offset];
            let checked = checkedGlyphs.get(node);
            if (!checked) checkedGlyphs.set(node, (checked = new Set()));
            if (checked.has(offset)) continue;
            checked.add(offset);
            const glyph = document.createRange();
            glyph.setStart(node, offset);
            glyph.setEnd(node, offset + 1);
            const bounds = glyph.getBoundingClientRect();
            if (bounds.height > 0)
              expect(
                bounds.bottom,
                JSON.stringify({
                  elapsed,
                  offset,
                  length: node.length,
                  visible: visible.length,
                  height: body.parentElement!.style.height,
                  hidden: hidden.map((range) => ({
                    node: range.startContainer === node,
                    start: range.startOffset,
                    end: range.endOffset,
                  })),
                }),
              ).toBeLessThanOrEqual(body.parentElement!.getBoundingClientRect().bottom + 0.5);
          }
        }
        maxGrowth = Math.max(maxGrowth, visible.length - previousVisible);
        previousVisible = visible.length;
        const notes = [...page.querySelectorAll<HTMLElement>("[data-footnotes] li")];
        const one = notes.find((note) => note.id.endsWith("fn-a"));
        const two = notes.find((note) => note.id.endsWith("fn-b"));
        if (one && !one.hidden) firstNote = true;
        if (noteSettled(one)) firstPlayed = true;
        if (firstNote && one?.hidden) firstClosed = true;
        if (visible.includes("BBBB")) {
          expect(firstPlayed).toBe(true);
          secondBody = true;
        }
        if (two && !two.hidden) {
          expect(secondBody).toBe(true);
          secondNote = true;
        }
        if (secondNote && two?.hidden) secondClosed = true;
        if (noteSettled(two)) secondPlayed = true;
        if (visible.includes("Final suffix.")) {
          expect(secondPlayed).toBe(true);
          finalBody = true;
          if (fading() > 0) {
            finalFade = true;
            expect(thinking()).toBeNull();
          }
        }
      }
      expect(
        { firstNote, firstClosed, secondBody, secondNote, secondClosed, finalBody, finalFade },
        JSON.stringify({ elapsed, maxGrowth, previousVisible }),
      ).toEqual({
        firstNote: true,
        firstClosed: true,
        secondBody: true,
        secondNote: true,
        secondClosed: true,
        finalBody: true,
        finalFade: true,
      });
      expect(maxGrowth).toBeLessThanOrEqual(64);
      await finishTimeline();
    },
  );

  it.each(["default", "restructured"] as const)(
    "preserves %s bounded playback for 96-character arrivals every 300ms through EOF",
    async (structure) => {
      physicalRows = true;
      const source = `${"A".repeat(1200)}[^a][^b]\n\n[^a]: First note.\n\n${"B".repeat(1200)}\n\n[^b]: Second note.\n\nFinal suffix.`;
      await renderTimeline("", true, { structure });
      for (let end = 96; end < source.length + 96; end += 96) {
        await renderTimeline(source.slice(0, end), true, { structure });
        for (let frame = 0; frame < 18; frame++) await step();
        await step(12);
      }
      await renderTimeline(source, false, { structure });
      const hiddenAtEOF = playbackState().hiddenBody;
      let previousHidden = hiddenAtEOF;
      let maxRelease = 0;
      for (let index = 0; index < 2000 && playbackBusy(); index++) {
        await step();
        const hidden = playbackState().hiddenBody;
        maxRelease = Math.max(maxRelease, previousHidden - hidden);
        previousHidden = hidden;
      }
      expect(maxRelease).toBeLessThanOrEqual(64);
      await finishTimeline();
    },
  );

  it.each(["default", "restructured"] as const)(
    "does not resurrect %s Thinking when manually closing already settled notes",
    async (structure) => {
      const source = "Answer[^n].\n\n[^n]: Final note.";
      await renderTimeline("", true, { structure });
      await renderTimeline(source, true, { structure });
      await step();
      await renderTimeline(source, false, { structure });
      await finishTimeline();
      const trigger = page.querySelector<HTMLButtonElement>(
        ".streaming-markdown-footnotes-heading button",
      )!;
      expect(trigger).not.toBeNull();
      await act(() => trigger.click());
      for (let i = 0; i < 20; i++) await step();
      expect(thinking()).toBeNull();
      await act(() => trigger.click());
      expect(playbackState().hiddenBody + fading()).toBe(0);
      expect(thinking()).toBeNull();
    },
  );

  it.each(["default", "restructured"] as const)(
    "does not resurrect %s Thinking when auto-collapse settings close or reopen settled notes",
    async (structure) => {
      const source = "Answer[^n].\n\n[^n]: Final note.";
      const options = { structure, autoCollapse: false };
      await renderTimeline("", true, options);
      await renderTimeline(source, true, options);
      await step();
      await renderTimeline(source, false, options);
      await finishTimeline();
      const widget = page.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      expect(widget.getAttribute("data-markdown-details-open")).toBe("true");
      const mounts: Element[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('[data-timeline-status-height$=":thinking"]')) mounts.push(node);
            mounts.push(...node.querySelectorAll('[data-timeline-status-height$=":thinking"]'));
          }
      });
      observer.observe(page, { childList: true, subtree: true });
      try {
        for (const autoCollapse of [true, false, true, false]) {
          await renderTimeline(source, false, { structure, autoCollapse });
          expect(widget.getAttribute("data-markdown-details-open")).toBe(String(!autoCollapse));
          expect(playbackState().hiddenBody + fading()).toBe(0);
          expect(thinking()).toBeNull();
          for (let index = 0; index < 20; index++) {
            await step();
            expect(thinking()).toBeNull();
          }
        }
        expect(mounts).toEqual([]);
      } finally {
        observer.disconnect();
      }
    },
  );

  it.each(
    (["default", "restructured"] as const).flatMap((structure) =>
      [false, true].map((autoCollapse) => ({ structure, autoCollapse })),
    ),
  )(
    "keeps $structure Thinking off when setting auto-collapse to $autoCollapse during unfinished notes",
    async ({ structure, autoCollapse }) => {
      const source = `Answer[^n][^m].\n\n[^n]: ${"N".repeat(180)}\n\n[^m]: ${"M".repeat(180)}`;
      const initial = { structure, autoCollapse: !autoCollapse };
      await renderTimeline("", true, initial);
      await renderTimeline(source, true, initial);
      await step();
      await renderTimeline(source, false, initial);
      const notePlaying = () =>
        page.querySelector<HTMLLIElement>('[data-footnotes] li[id$="fn-n"]')?.hidden === false &&
        playbackState().hiddenNote > 0;
      for (let index = 0; index < 300 && !notePlaying(); index++) await step();
      expect(notePlaying()).toBe(true);
      expect(playbackState().hiddenNote).toBeGreaterThan(0);
      expect(thinking()).toBeNull();
      await renderTimeline(source, false, { structure, autoCollapse });
      expect(thinking()).toBeNull();
      const second = [...page.querySelectorAll<HTMLLIElement>("[data-footnotes] li")].find((note) =>
        note.id.endsWith("fn-m"),
      );
      expect(second?.hidden).toBe(autoCollapse);
      await finishTimeline();
    },
  );

  it.each(["default", "restructured"] as const)(
    "ends %s Thinking at EOF while preserving body, notes and fades",
    async (structure) => {
      const source = `${"A".repeat(180)}[^n]\n\n[^n]: ${"N".repeat(24)}\n\nFinal body suffix.`;
      await renderTimeline("", true, { structure });
      await renderTimeline(source, true, { structure });
      await step();
      await renderTimeline(source, false, { structure });
      expect(playbackState().hiddenBody + playbackState().hiddenNote).toBeGreaterThan(0);
      expect(thinking()).toBeNull();
      await finishTimeline();
      expect(playbackState().source).toContain("Final body suffix.");
    },
  );

  it.each(["default", "restructured"] as const)(
    "keeps playing %s notes in their message host when Thinking unmounts mid-note",
    async (structure) => {
      const source = `Body[^n].\n\n[^n]: ${"N".repeat(180)}\n\nFinal suffix.`;
      await renderTimeline("", true, { structure });
      await renderTimeline(source, true, { structure });
      const playing = () =>
        page.querySelector<HTMLLIElement>('[data-footnotes] li[id$="fn-n"]')?.hidden === false &&
        playbackState().hiddenNote > 0;
      for (let i = 0; i < 500 && !playing(); i++) await step();
      expect(playing()).toBe(true);
      expect(thinking()).not.toBeNull();
      const widget = page.querySelector<HTMLElement>("[data-stream-footnotes]")!;
      const localHost = widget.closest("[data-stream-footnote-local-host]");
      expect(localHost).not.toBeNull();
      expect(playbackState().source).not.toContain("Final suffix.");
      await renderTimeline(source, false, { structure });
      expect(thinking()).toBeNull();
      expect(page.querySelector("[data-stream-footnotes]")).toBe(widget);
      expect(widget.closest("[data-stream-footnote-local-host]")).toBe(localHost);
      expect(playbackState().hiddenNote).toBeGreaterThan(0);
      let sawClose = false;
      let lastGlyphAt: number | null = null;
      let navigationReadyAt: number | null = null;
      let closeStartedAt: number | null = null;
      let sawFinalFade = false;
      for (let i = 0; i < 2000 && playbackBusy(); i++) {
        await step();
        expect(thinking()).toBeNull();
        expect(widget.isConnected).toBe(true);
        const note = widget.querySelector<HTMLLIElement>('[id$="fn-n"]');
        const link = note?.querySelector<HTMLAnchorElement>("a[data-footnote-backref]");
        if (note && !note.hidden && playbackState().hiddenNote === 0) {
          lastGlyphAt ??= clock;
          if (
            [...CSS.highlights.entries()].some(
              ([name, ranges]) =>
                name.startsWith("t3-smooth-fade-") &&
                [...ranges].some((range) => note.contains(range.startContainer)),
            )
          ) {
            sawFinalFade = true;
            expect(widget.dataset.markdownDetailsOpen).toBe("true");
            expect(playbackState().source).not.toContain("Final suffix.");
          }
          if (
            link &&
            !link.hasAttribute("data-smooth-footnote-backref") &&
            link.style.visibility !== "hidden"
          )
            navigationReadyAt ??= clock;
        }
        if (widget.dataset.markdownDetailsOpen === "false") closeStartedAt ??= clock;
        if (note?.hidden) sawClose = true;
        if (playbackState().source.includes("Final suffix.")) {
          expect(navigationReadyAt).not.toBeNull();
          expect(closeStartedAt).not.toBeNull();
        }
      }
      expect(sawClose).toBe(true);
      expect(sawFinalFade).toBe(true);
      expect(lastGlyphAt).not.toBeNull();
      expect(navigationReadyAt).not.toBeNull();
      expect(closeStartedAt).not.toBeNull();
      expect(navigationReadyAt! - lastGlyphAt!).toBeGreaterThanOrEqual(500);
      // The actual glyph/navigation tail now starts close and source handoff together.
      const settledAt = settledGlyphs.find((event) => event.id.endsWith("fn-n"))?.at;
      expect(settledAt).toBeDefined();
      expect(closeStartedAt!).toBeGreaterThanOrEqual(navigationReadyAt!);
      expect(closeStartedAt!).toBeLessThanOrEqual(navigationReadyAt! + 16);
      expect(playbackState().source).toContain("Final suffix.");
      await finishTimeline();
    },
  );

  it("drains a cancelled source whose streaming flag has not caught up", async () => {
    const source = `${"B".repeat(120)}[^n]\n\n[^n]: Cancelled tail.`;
    await renderTimeline("", true);
    await renderTimeline(source, true);
    await step();
    await renderTimeline(source, false, { status: "interrupted", streaming: true });
    expect(thinking()).toBeNull();
    await finishTimeline();
  });

  it("clears old pending playback on a thread switch", async () => {
    await renderTimeline("", true);
    await renderTimeline("A".repeat(400), true);
    await step();
    await renderTimeline("Settled history.", false, { thread: "other-thread", run: "other-run" });
    await step();
    expect(thinking()).toBeNull();
    expect(playbackState().hiddenBody).toBe(0);
  });

  it("ends Thinking immediately when smooth output is disabled", async () => {
    await renderTimeline("", true, { smooth: false });
    await renderTimeline("Plain complete response.", true, { smooth: false });
    await renderTimeline("Plain complete response.", false, { smooth: false });
    expect(thinking()).toBeNull();
    expect(page.textContent).toContain("Plain complete response.");
  });

  it.each(["default", "restructured"] as const)(
    "never mounts ghost %s Thinking for history, paging or disclosure remounts",
    async (structure) => {
      const mounts: Element[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('[data-timeline-status-height$=":thinking"]')) mounts.push(node);
            mounts.push(...node.querySelectorAll('[data-timeline-status-height$=":thinking"]'));
          }
      });
      observer.observe(page, { childList: true, subtree: true });
      try {
        const source = "Historical answer[^n].\n\n[^n]: Historical footnote.";
        await renderTimeline(source, false, { structure });
        await renderTimeline(source, false, { structure, older: true });
        await renderTimeline("", false, { structure });
        await renderTimeline(source, false, { structure });
        await step();
        expect(thinking()).toBeNull();
        expect(mounts).toEqual([]);
      } finally {
        observer.disconnect();
      }
    },
  );

  it("does not wait for the final body fade to end Thinking", async () => {
    const source = "Final body fade.";
    await renderTimeline("", true);
    await renderTimeline(source, true);
    await step();
    await renderTimeline(source, false);
    for (let index = 0; index < 500 && playbackState().hiddenBody; index++) await step();
    expect(playbackState().hiddenBody).toBe(0);
    expect(fading()).toBeGreaterThan(0);
    expect(thinking()).toBeNull();
    await finishTimeline();
  });

  it.each(["default", "restructured"] as const)(
    "keeps a live %s sixteen-character EOF tail fading after real work ends",
    async (structure) => {
      const source = "1234567890123456";
      const options = { structure, recovery: true, thread: `short-EOF-${structure}` };
      await renderTimeline("", true, options);
      await renderTimeline(source, true, options);
      await step();
      await renderTimeline(source, false, { ...options, streaming: true });
      expect(thinking()).toBeNull();
      expect(playbackState().hiddenBody + fading()).toBeGreaterThan(0);
      for (let index = 0; index < 300 && playbackState().hiddenBody; index++) await step();
      expect(fading()).toBeGreaterThan(0);
      await step(250);
      expect(fading()).toBeGreaterThan(0);
      await finishTimeline();
      expect(playbackState().source).toContain(source);
    },
  );

  it("clears live pending when smooth output is switched off", async () => {
    const source = "A".repeat(400);
    await renderTimeline("", true);
    await renderTimeline(source, true);
    await step();
    await renderTimeline(source, false, { smooth: false });
    expect(thinking()).toBeNull();
  });

  it("does not retain a previous run's pending playback after a new run takes over", async () => {
    await renderTimeline("", true);
    await renderTimeline("A".repeat(400), true);
    await step();
    await renderTimeline("", true, { run: "run-2" });
    await renderTimeline("", false, { run: "run-2" });
    expect(thinking()).toBeNull();
  });

  it("settles reduced-motion playback immediately after source EOF", async () => {
    reducedMotion = true;
    await renderTimeline("", true);
    await renderTimeline("Reduced motion response.", true);
    await renderTimeline("Reduced motion response.", false);
    await step();
    expect(thinking()).toBeNull();
  });

  it("shows a forceShow recovery without hidden glyphs or fades", async () => {
    await act(() =>
      root.render(
        <ChatMarkdown
          cwd={undefined}
          text="Recovered history."
          isStreaming
          smoothStreaming
          smoothTextResume={{
            key: "forced",
            baselineText: "",
            synchronized: true,
            forceShow: true,
          }}
        />,
      ),
    );
    expect(playbackState().hiddenBody + fading()).toBe(0);
    expect(page.textContent).toContain("Recovered history.");
  });

  it("eventually drains the reported 2719 body and 74 note shape after EOF", async () => {
    const source = `${"A".repeat(2719)}[^n]\n\n[^n]: ${"N".repeat(74)}`;
    await act(() =>
      root.render(
        <ChatMarkdown
          cwd={undefined}
          text={source}
          isStreaming
          smoothStreaming
          footnotesAutoCollapse
          smoothTextFadeDurationMs={200}
          claimInitialSmoothText={() => true}
        />,
      ),
    );
    await step();
    await act(() =>
      root.render(
        <ChatMarkdown
          cwd={undefined}
          text={source}
          smoothComplete
          smoothStreaming
          footnotesAutoCollapse
          smoothTextFadeDurationMs={200}
          claimInitialSmoothText={() => true}
        />,
      ),
    );
    for (let index = 0; index < 1950; index++) await step(16);
    expect(playbackState().hiddenBody + playbackState().hiddenNote).toBe(0);
  });
});
