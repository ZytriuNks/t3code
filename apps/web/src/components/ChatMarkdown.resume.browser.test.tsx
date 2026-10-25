import { useStableCallback } from "../hooks/useStableCallback";
import {
  StrictMode,
  createRef,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { act, fakeTimers, render as renderScreen, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
const virtualRows = vi.hoisted(() => {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    get visible() {
      return visible;
    },
    set visible(value: boolean) {
      visible = value;
      listeners.forEach((listener) => listener());
    },
    snapshot: () => visible,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
const subagentPanelState = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  yieldDurationMs: 200,
  footnotesAutoCollapse: false,
}));
const shikiDelay = vi.hoisted(() => ({
  promise: null as ReturnType<
    typeof import("../lib/syntaxHighlighting").getSyntaxHighlighterPromise
  > | null,
}));
vi.mock("../lib/syntaxHighlighting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/syntaxHighlighting")>();
  return {
    PREFERRED_HIGHLIGHTER: actual.PREFERRED_HIGHLIGHTER,
    getSyntaxHighlighterPromise: (language: string) =>
      shikiDelay.promise ?? actual.getSyntaxHighlighterPromise(language),
  };
});
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
    useEnvironmentSettings: () => ({
      ...settings,
      responseStreamingMode: "smooth",
      conversationStructure: "restructured",
      smoothMarkdownPreload: true,
      smoothTextYieldDurationMs: subagentPanelState.yieldDurationMs,
      footnotesAutoCollapse: subagentPanelState.footnotesAutoCollapse,
    }),
  };
});
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShell: (ref: ScopedThreadRef | null) =>
    ref === null ? null : (subagentPanelState.projection?.thread ?? null),
  useThreadProjection: (ref: ScopedThreadRef | null) =>
    ref === null || subagentPanelState.projection === null
      ? null
      : { projection: subagentPanelState.projection },
  useThreadVisibleTurnItems: () => subagentPanelState.projection?.visibleTurnItems ?? [],
  useProject: () => null,
  useThreadTextPlayback: () => null,
}));
vi.mock("../state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/threads")>()),
  useEnvironmentThread: () => ({ status: "live", error: Option.none() }),
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    keyExtractor,
    ListFooterComponent,
    onLoad,
  }: {
    data: { id: string }[];
    renderItem: (input: { item: { id: string } }) => ReactNode;
    keyExtractor: (item: { id: string }) => string;
    ListFooterComponent?: ReactNode;
    onLoad?: () => void;
  }) => {
    const visible = useSyncExternalStore(virtualRows.subscribe, virtualRows.snapshot);
    useLayoutEffect(() => {
      onLoad?.();
    }, []);
    return (
      <div>
        {(visible ? data : []).map((item) => (
          <div key={keyExtractor(item)}>{renderItem({ item })}</div>
        ))}
        {ListFooterComponent}
      </div>
    );
  },
}));
import ChatMarkdown from "./ChatMarkdown";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { SubagentConversationPanel } from "./SubagentConversationPanel";
import { rememberTimelinePosition } from "./chat/timelineScrollAnchoring";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TurnItemId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { makeThreadProjectionFixture } from "../test-fixtures";
import type { LegendListRef } from "@legendapp/list/react";
import type { SmoothScrollHandle } from "../hooks/useSmoothScroll";
import type { ThreadTextPlaybackState } from "@t3tools/client-runtime/state/threads";
import { smoothTextPlaybackStore } from "../lib/smoothTextPlayback";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  // 此套件控制本地 Shiki 完成时机；worker 交接由独立套件覆盖。
  resources.use(stubGlobal("Worker", undefined));
  const { captureThreadTextPlayback } = await vi.importActual<{
    captureThreadTextPlayback: (
      projection: OrchestrationV2ThreadProjection,
      generation: number,
      phase: ThreadTextPlaybackState["phase"],
    ) => ThreadTextPlaybackState;
  }>("../../../../packages/client-runtime/src/state/threadTextPlayback.ts");
  class TestHighlight extends Set<AbstractRange> {}
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
  const runId = RunId.make("resume-dom-run");
  const itemId = TurnItemId.make("resume-dom-item");
  const createdAt = "2026-10-10T12:00:00.000Z";
  function timelineEntry(text: string, surface: "body" | "reasoning" = "body") {
    const message = {
      id: "resume-dom-row",
      kind: "message" as const,
      createdAt,
      message: {
        id: MessageId.make("resume-dom-message"),
        role: "assistant" as const,
        text,
        runId,
        createdAt,
        updatedAt: createdAt,
        streaming: true,
      },
      projectedItem: {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: ThreadId.make("resume-thread"),
        sourceItemId: itemId,
        item: {
          id: itemId,
          type: "assistant_message" as const,
          runId,
          text,
          updatedAt: DateTime.makeUnsafe(createdAt),
          messageId: MessageId.make("resume-dom-message"),
          status: "running" as const,
          threadId: ThreadId.make("resume-thread"),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          title: null,
          streaming: true,
          startedAt: DateTime.makeUnsafe(createdAt),
          completedAt: null,
        },
      },
    };
    if (surface === "body") return message;
    const projectedItem = {
      ...message.projectedItem,
      item: { ...message.projectedItem.item, type: "reasoning" as const },
    };
    return {
      id: message.id,
      kind: "work" as const,
      createdAt,
      projectedItem,
      entry: {
        id: message.id,
        createdAt,
        runId,
        label: "Thinking",
        detail: text,
        tone: "thinking" as const,
        itemType: "reasoning" as const,
        toolLifecycleStatus: "inProgress" as const,
        projectedItem,
      },
    };
  }
  function playback(
    text: string | null,
    generation = 1,
    phase: "pending" | "synchronized" | "legacy" = "synchronized",
  ) {
    // Exercise the runtime's actual boundary capture, then its actual Web consumer.
    return captureThreadTextPlayback(
      {
        turnItems: text === null ? [] : [timelineEntry(text).projectedItem.item],
        visibleTurnItems: [],
        runs: [],
      } as unknown as OrchestrationV2ThreadProjection,
      generation,
      phase,
    );
  }
  function timelineProps(identity: string) {
    const listRef = createRef<LegendListRef | null>();
    listRef.current = {
      getScrollableNode: () => page,
      setItemSize() {},
      getState: () => ({
        contentLength: page.scrollHeight,
        scrollLength: page.clientHeight,
        scroll: page.scrollTop,
        sizes: new Map(),
        data: [{ id: "resume-dom-row" }],
        positionAtIndex: () => 0,
        sizeAtIndex: () => page.scrollHeight,
        indexByKey: () => 0,
        elementAtIndex: () => page.querySelector("[data-timeline-row-id=resume-dom-row]"),
      }),
      scrollToEnd: async () => {
        page.scrollTop = page.scrollHeight - page.clientHeight;
      },
      scrollToOffset: async ({ offset }: { offset: number }) => {
        page.scrollTop = offset;
      },
      scrollToIndex: async () => {},
    } as unknown as LegendListRef;
    return {
      isWorking: true,
      activeTurnInProgress: true,
      listRef,
      latestRun: { runId, status: "running" as const, startedAt: createdAt, completedAt: null },
      turnDiffSummaries: [],
      emptyPlaceholderInset: 0,
      runs: [],
      routeThreadKey: identity,
      onOpenTurnDiff() {},
      onOpenThread() {},
      onForkFromRun: async () => {},
      onRollbackCheckpoint() {},
      supportsConversationRollback: false,
      onRevertToTurnCount() {},
      isRevertingCheckpoint: false,
      openingVideoAttachmentId: null,
      onImageExpand() {},
      activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
      markdownCwd: undefined,
      resolvedTheme: "light" as const,
      timestampFormat: "locale" as const,
      workspaceRoot: undefined,
      anchorMessageId: null,
      onAnchorReady() {},
      onAnchorSizeChanged() {},
      contentInsetEndAdjustment: 0,
      liveFollowEnabled: true,
      onIsAtEndChange() {},
      onManualNavigation() {},
      smoothStreaming: true,
    };
  }
  function hiddenText() {
    return [...(CSS.highlights.get("t3-smooth-hidden") ?? [])]
      .map((range) => {
        const copy = document.createRange();
        copy.setStart(range.startContainer, range.startOffset);
        copy.setEnd(range.endContainer, range.endOffset);
        return copy.toString();
      })
      .join("");
  }
  async function headingTravel() {
    let startedAt: number | null = null;
    const heights: number[] = [];
    for (let index = 0; index < 500; index++) {
      await step();
      const heading = page.querySelector<HTMLElement>("[data-smooth-footnote-heading]");
      if (!heading || heading.closest("[hidden]")) continue;
      const height = heading.getBoundingClientRect().height;
      const fullHeight = heading.firstElementChild!.getBoundingClientRect().height;
      if (startedAt === null && height > 0) startedAt = clock - 16;
      if (startedAt !== null) heights.push(height);
      if (startedAt !== null && height >= fullHeight - 0.01)
        return { elapsed: clock - startedAt, heights };
    }
    throw new Error(`The footnote heading did not finish: ${JSON.stringify(heights)}`);
  }
  const yieldFootnoteSource = "Body[^first].\n\n[^first]: Footnote.\n\nBoundary.";

  type RunStatus = OrchestrationV2ThreadProjection["runs"][number]["status"];
  type TurnStatus = OrchestrationV2ThreadProjection["providerTurns"][number]["status"];

  function projection(
    text: string,
    history: boolean,
    appStatus: RunStatus | null = null,
    turnStatus: TurnStatus = "running",
  ): OrchestrationV2ThreadProjection {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("reasoning-native-thread");
    const providerTurnId = ProviderTurnId.make("reasoning-native-turn");
    const now = DateTime.makeUnsafe("2026-10-16T03:00:00.000Z");
    const before = DateTime.makeUnsafe("2026-10-16T02:00:00.000Z");
    const appRunId = RunId.make("reasoning-app-run");
    const appAttemptId = RunAttemptId.make("reasoning-app-attempt");
    const nodeId = NodeId.make("reasoning-native-root");
    const item = {
      ...timelineEntry(text, "reasoning").projectedItem.item,
      threadId: base.thread.id,
      runId: appStatus === null ? null : appRunId,
      nodeId,
      providerThreadId,
      providerTurnId,
      startedAt: now,
      updatedAt: now,
    };
    const hasRun = history || appStatus !== null;
    return {
      ...base,
      thread: {
        ...base.thread,
        activeProviderThreadId: providerThreadId,
        ...(appStatus === null
          ? {
              creationSource: "provider" as const,
              lineage: {
                ...base.thread.lineage,
                parentThreadId: ThreadId.make("native-parent"),
                relationshipToParent: "subagent" as const,
              },
            }
          : {}),
      },
      nodes: [
        {
          id: nodeId,
          threadId: base.thread.id,
          runId: appStatus === null ? null : appRunId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status: turnStatus,
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: turnStatus === "running" ? null : now,
        },
      ],
      runs: hasRun
        ? [
            {
              id: appRunId,
              threadId: base.thread.id,
              ordinal: 1,
              providerInstanceId: base.thread.providerInstanceId,
              modelSelection: base.thread.modelSelection,
              providerThreadId,
              userMessageId: MessageId.make("reasoning-app-prompt"),
              rootNodeId: null,
              activeAttemptId: appStatus === null ? null : appAttemptId,
              status: appStatus ?? "completed",
              requestedAt: before,
              startedAt: before,
              completedAt: appStatus === null || appStatus === "completed" ? before : null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ]
        : [],
      providerTurns: [
        {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: appStatus === null ? null : appAttemptId,
          nativeTurnRef: null,
          ordinal: 2,
          status: turnStatus,
          startedAt: now,
          completedAt: turnStatus === "running" ? null : now,
        },
      ],
      turnItems: [item],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: base.thread.id,
          sourceItemId: item.id,
          item,
        },
      ],
    };
  }

  async function show(next: OrchestrationV2ThreadProjection) {
    subagentPanelState.projection = next;
    await act(() =>
      screen.rerender(
        <SubagentConversationPanel
          threadRef={{
            environmentId: EnvironmentId.make("reasoning-panel-env"),
            threadId: next.thread.id,
          }}
          mode="sidebar"
        />,
      ),
    );
    for (let i = 0; i < 2; i++)
      await act(() =>
        page
          .querySelector<HTMLElement>(
            "[data-timeline-row-kind] [aria-expanded=false], [data-timeline-live-row-kind] [aria-expanded=false]",
          )
          ?.click(),
      );
    // Advance the existing virtual RAF/clock so ChatMarkdown consumes each
    // received source. The panel, session projection and consumers are real.
    await advance(20);
  }

  function reasoningText() {
    const paragraph = page.querySelector("[data-smooth-streaming] p");
    expect(paragraph, page.innerHTML).not.toBeNull();
    return paragraph!.textContent;
  }

  stack.defer(() => {
    page.remove();
    vi.restoreAllMocks();
    if (originalBounds)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  subagentPanelState.projection = null;
  subagentPanelState.yieldDurationMs = 200;
  subagentPanelState.footnotesAutoCollapse = false;
  virtualRows.visible = true;
  shikiDelay.promise = null;
  resources.use(fakeTimers());
  resources.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    ),
  );
  clock = 0;
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
    const height =
      Math.ceil((this.textContent?.length ?? 0) / 32) * 20 +
      20 +
      [...this.querySelectorAll("img")].reduce((total, img) => total + img.height, 0);
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
  let screen = stack.use(await renderScreen(null, { container: page }));
  const owned = stack.move();
  const remount = async () => {
    screen = owned.use(await renderScreen(null, { container: page }));
    return screen;
  };
  return {
    projection,
    show,
    reasoningText,
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
    rangeRects,
    runId,
    itemId,
    createdAt,
    timelineEntry,
    playback,
    timelineProps,
    hiddenText,
    headingTravel,
    yieldFootnoteSource,
    screen,
    remount,
    captureThreadTextPlayback,
    get clock() {
      return clock;
    },
    set clock(value: typeof clock) {
      clock = value;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
describe("historical footnote resume", () => {
  it("must render the full historical body immediately without playing historical footnote groups", async () => {
    await using fixture = await setup();
    const { page, visibleBody, screen } = fixture;
    const source = "Before[^a] body.\n\n[^a]: The historical note.\n\nAfter historical body.";
    await act(() =>
      screen.rerender(
        <ChatMarkdown
          cwd={undefined}
          text={source}
          isStreaming
          smoothStreaming
          footnotesAutoCollapse
          smoothTextResume={{
            key: "astra/history-notes",
            baselineText: source,
            synchronized: true,
          }}
        />,
      ),
    );
    const body = visibleBody();
    expect(body.source).toContain("After historical body.");
    expect(page.querySelector("[data-smooth-footnote-reveal]")).toBeNull();
  });
  it("must not start a historical footnote expand/collapse after the body handoff", async () => {
    await using fixture = await setup();
    const { page, visibleBody, step, screen } = fixture;
    const source = "Before[^a] body.\n\n[^a]: The historical note.\n\nAfter historical body.";
    await act(() =>
      screen.rerender(
        <ChatMarkdown
          cwd={undefined}
          text={source}
          isStreaming
          smoothStreaming
          footnotesAutoCollapse
          smoothTextResume={{
            key: "astra/history-notes-frames",
            baselineText: source,
            synchronized: true,
          }}
        />,
      ),
    );
    const samples = [];
    for (let index = 0; index < 8; index++) {
      await step();
      samples.push({
        body: visibleBody().source,
        expanded: page
          .querySelector("[data-stream-footnotes]")
          ?.getAttribute("data-markdown-details-open"),
      });
    }
    expect(
      samples.some((sample) => sample.expanded === "true"),
      JSON.stringify(samples),
    ).toBe(false);
  });
});
describe("runtime boundary through MessagesTimeline and ChatMarkdown", () => {
  it("preserves marker-after live text when the first loaded snapshot arrives after navigation", async () => {
    await using fixture = await setup();
    const { timelineEntry, playback, timelineProps, hiddenText, screen } = fixture;
    const props = timelineProps("environment-local:cold-first-marker");
    await act(() =>
      screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[]}
          textPlayback={null}
          citationHistoryLoading
        />,
      ),
    );
    const history = "A" + "b".repeat(100);
    await act(() =>
      screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[timelineEntry(history + "LIVE")]}
          textPlayback={playback(history)}
          citationHistoryLoading={false}
        />,
      ),
    );
    expect(hiddenText()).toBe("LIVE");
  });

  it.each([true, false])(
    "shows replay and queues only live text (pending commit: %s)",
    async (pendingCommit) => {
      await using fixture = await setup();
      const { page, timelineEntry, playback, timelineProps, hiddenText, screen } = fixture;
      const props = timelineProps(`environment-local:batched-${pendingCommit}`);
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry("A")]}
            textPlayback={playback("A")}
          />,
        ),
      );
      const history = "A" + "b".repeat(100);
      if (pendingCommit)
        await act(() =>
          screen.rerender(
            <MessagesTimeline
              {...props}
              timelineEntries={[timelineEntry(history)]}
              textPlayback={playback("A", 2, "pending")}
            />,
          ),
        );
      expect(hiddenText()).toBe("");
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry(history + "LIVE")]}
            textPlayback={playback(history, 2)}
          />,
        ),
      );
      expect(hiddenText(), page.innerHTML).toBe("LIVE");
    },
  );

  it.each([
    ["keepalive", "body"],
    ["resubscribe", "body"],
    ["keepalive", "reasoning"],
    ["resubscribe", "reasoning"],
  ] as const)(
    "saves a new live item's position and resumes it after %s (%s)",
    async (connection, surface) => {
      await using fixture = await setup();
      let {
        page,
        advance,
        runId,
        itemId,
        timelineEntry,
        playback,
        timelineProps,
        hiddenText,
        screen,
      } = fixture;
      const props = timelineProps(`environment-local:new-item-${connection}-${surface}`);
      const expandReasoning = async () => {
        if (surface !== "reasoning") return;
        for (let i = 0; i < 2; i++)
          await act(() => {
            page
              .querySelector<HTMLElement>("[data-timeline-row-kind] [aria-expanded=false]")
              ?.click();
          });
      };
      const initial = playback(null);
      await act(() =>
        screen.rerender(
          <MessagesTimeline {...props} timelineEntries={[]} textPlayback={initial} />,
        ),
      );
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry("A", surface)]}
            textPlayback={initial}
          />,
        ),
      );
      await expandReasoning();
      await advance(20);
      const text = "ABCDE";
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry(text, surface)]}
            textPlayback={initial}
          />,
        ),
      );
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      const before = hiddenText();
      expect(before, page.innerHTML).toBe("BCDE");
      await act(() => screen.unmount());
      const key = JSON.stringify([
        "environment-local",
        `new-item-${connection}-${surface}`,
        runId,
        itemId,
        surface,
      ]);
      expect(smoothTextPlaybackStore.get(key)?.visibleText).toBe("A");
      screen = await fixture.remount();
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry(text, surface)]}
            textPlayback={connection === "keepalive" ? initial : playback(text, 2)}
          />,
        ),
      );
      await expandReasoning();
      expect(hiddenText(), JSON.stringify(smoothTextPlaybackStore.get(key))).toBe(before);
      await advance(60);
      expect(hiddenText()).toBe("");
    },
  );
});
describe("resumed Markdown DOM and live footnote handoff", () => {
  it("keeps history closed while new consecutive notes play FIFO in the same portal", async () => {
    await using fixture = await setup();
    const { page, noteById, visibleBody, noteState, step, advance, hiddenText, screen } = fixture;
    const history = "History[^old].\n\n[^old]: Old note.\n\nAfter history.";
    const resume = {
      key: "history-then-live-notes",
      baselineText: history,
      mountText: history,
      synchronized: true,
    };
    const show = (text: string) =>
      act(() =>
        screen.rerender(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            isStreaming
            smoothStreaming
            footnotesAutoCollapse
            smoothTextResume={resume}
          />,
        ),
      );
    await show(history);
    const widget = page.querySelector("[data-stream-footnotes]")!;
    const portal = widget.parentElement;
    expect(visibleBody().visible).toContain("After history.");
    expect(hiddenText()).toBe("");
    expect(page.querySelector("[data-smooth-footnote-reveal]")).toBeNull();
    await advance(8);
    const source =
      history +
      "\n\nLive body[^b][^c].\n\n[^b]: First live note.\n\n[^c]: Second live note.\n\nAfter live.";
    await show(source);
    const samples: {
      body: string;
      first: ReturnType<typeof noteState>;
      second: ReturnType<typeof noteState>;
      oldHidden: boolean;
    }[] = [];
    for (let index = 0; index < 600; index++) {
      await step();
      if (!noteById("b") || !noteById("c")) continue;
      samples.push({
        body: visibleBody().visible,
        first: noteState(noteById("b")!),
        second: noteState(noteById("c")!),
        oldHidden: noteById("old")!.hidden === true,
      });
    }
    const firstDone = samples.findIndex((sample) => sample.first.visible === "First live note.");
    const secondStarts = samples.findIndex((sample) => sample.second.visible.length > 0);
    const secondDone = samples.findIndex((sample) => sample.second.visible === "Second live note.");
    const collapsed = samples.findIndex((sample, i) => i > secondDone && !sample.second.open);
    const tail = samples.findIndex((sample) => sample.body.includes("After live."));
    const evidence = JSON.stringify({
      firstDone,
      secondStarts,
      secondDone,
      collapsed,
      tail,
      samples: samples.filter((_, i) => i % 60 === 0),
    });
    expect(firstDone, evidence).toBeGreaterThanOrEqual(0);
    expect(secondStarts, evidence).toBeGreaterThanOrEqual(firstDone);
    expect(secondDone, evidence).toBeGreaterThanOrEqual(secondStarts);
    expect(
      samples.slice(firstDone, secondDone + 1).every((sample) => sample.first.open),
      evidence,
    ).toBe(true);
    expect(collapsed, evidence).toBeGreaterThan(secondDone);
    expect(tail, evidence).toBeGreaterThan(collapsed);
    expect(
      samples.every((sample) => sample.oldHidden),
      evidence,
    ).toBe(true);
    expect(page.querySelector("[data-stream-footnotes]")).toBe(widget);
    expect(widget.parentElement).toBe(portal);
    expect(page.querySelector("[data-stream-footnote-local-host]")?.contains(widget)).toBe(true);
  });
});
it("retains history through real delayed Shiki token DOM and media size, then smooths live text", async () => {
  await using fixture = await setup();
  const { page, visibleBody, hiddenText, screen } = fixture;
  const syntax = await vi.importActual<typeof import("../lib/syntaxHighlighting")>(
    "../lib/syntaxHighlighting",
  );
  const highlighter = await syntax.getSyntaxHighlighterPromise("typescript");
  let finishHighlight!: (value: typeof highlighter) => void;
  shikiDelay.promise = new Promise((resolve) => {
    finishHighlight = resolve;
  });
  const source = `Before[^a].\n\n[^a]: Historical note.\n\n\`\`\`typescript\nconst history = 42;\n\`\`\`\n\n![History](${location.origin}/favicon-32x32.png)\n\nAfter history.`;
  const resume = {
    key: "real-shiki-history",
    baselineText: source,
    mountText: source,
    synchronized: true,
  };
  const show = (text: string) =>
    act(() =>
      screen.rerender(
        <ChatMarkdown
          cwd={undefined}
          text={text}
          isStreaming
          smoothStreaming
          footnotesAutoCollapse
          smoothTextResume={resume}
        />,
      ),
    );
  await show(source);
  expect(page.querySelector(".chat-markdown-shiki")).toBeNull();
  expect(visibleBody().visible).toContain("After history.");
  expect(hiddenText()).toBe("");
  await act(async () => {
    finishHighlight(highlighter);
    await shikiDelay.promise;
  });
  expect(page.querySelector(".chat-markdown-shiki")?.textContent).toContain("const history = 42;");
  expect(hiddenText()).toBe("");
  const image = page.querySelector("img")!;
  expect(image).not.toBeNull();
  await act(() => {
    image.height = 240;
    image.dispatchEvent(new Event("load", { bubbles: true }));
  });
  const body = page.querySelector<HTMLElement>("[data-smooth-streaming]")!;
  expect(Number.parseFloat(body.parentElement!.style.height)).toBe(
    body.getBoundingClientRect().height,
  );
  expect(hiddenText()).toBe("");
  expect(page.querySelector("[data-smooth-footnote-reveal]")).toBeNull();
  await show(source + " LIVE");
  await act(() => {
    fixture.clock += 32;
    vi.advanceTimersByTime(32);
  });
  expect(hiddenText()).toContain("LIVE");
  expect(hiddenText()).not.toContain("const history");
});
describe("navigation destination with recovered Markdown layout", () => {
  it.each(["bottom", "reading", "wheel", "touchmove", "pointerdown", "keyboard"] as const)(
    "preserves %s ownership while history and media commit",
    async (destination) => {
      await using fixture = await setup();
      const {
        page,
        visibleBody,
        advance,
        timelineEntry,
        playback,
        timelineProps,
        hiddenText,
        screen,
      } = fixture;
      const props = timelineProps(`environment-local:resume-layout-${destination}`);
      let nativeHeight = 1600;
      let scrollOffset = 0;
      Object.defineProperties(page, {
        scrollTop: {
          configurable: true,
          get: () => scrollOffset,
          set: (value: number) => {
            scrollOffset = value;
          },
        },
        scrollHeight: { configurable: true, get: () => nativeHeight },
        clientHeight: { configurable: true, value: 300 },
      });
      const bounds = vi
        .mocked(HTMLElement.prototype.getBoundingClientRect)
        .getMockImplementation()!;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const rect = bounds.call(this);
        return this === page
          ? new DOMRect(0, 100, 256, 300)
          : this.dataset.timelineRowId === "resume-dom-row"
            ? new DOMRect(0, 100 - page.scrollTop, rect.width, rect.height)
            : rect;
      });
      page.scrollTop = destination === "reading" ? 300 : 1300;
      rememberTimelinePosition(
        props.routeThreadKey,
        {
          rowId: "resume-dom-row",
          offsetWithinRow: destination === "reading" ? 300 : 0,
          scrollOffset: page.scrollTop,
          atEnd: destination !== "reading",
        },
        false,
      );
      const control = createRef<SmoothScrollHandle | null>();
      function TimelineProbe({
        source,
        metadata,
      }: {
        source: string;
        metadata: ThreadTextPlaybackState;
      }) {
        const [follow, setFollow] = useState(true);
        const cancel = useStableCallback(() => setFollow(false));
        return (
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry(source)]}
            textPlayback={metadata}
            footnotesAutoCollapse
            smoothScrollRef={control}
            liveFollowEnabled={follow}
            onManualNavigation={cancel}
          />
        );
      }
      await act(() => screen.rerender(<TimelineProbe source="A" metadata={playback("A")} />));
      // 等初始列表定位完成，再验证已建立的底部跟随或历史阅读位置。
      await advance(8);
      expect(control.current?.isFollowing() ?? false).toBe(destination !== "reading");
      const initialRowHeight = page
        .querySelector<HTMLElement>("[data-timeline-row-id=resume-dom-row]")!
        .getBoundingClientRect().height;
      const sizes = new Map<string, number>();
      props.listRef.current!.setItemSize = (id, size) => {
        sizes.set(id, Math.round(size.height!));
        if (id === "resume-dom-row")
          nativeHeight = 1600 + Math.round(size.height!) - initialRowHeight;
      };
      const state = props.listRef.current!.getState.bind(props.listRef.current);
      props.listRef.current!.getState = () => ({ ...state(), sizes });
      const history =
        "Before[^a].\n\n[^a]: History note.\n\n" +
        "Restored body. ".repeat(80) +
        `\n\n![History](${location.origin}/favicon-32x32.png)\n\nAfter history.`;
      await act(async () => {
        await screen.rerender(<TimelineProbe source={history} metadata={playback(history, 2)} />);
        if (destination !== "bottom" && destination !== "reading") {
          page.scrollTop = 211;
          if (destination === "keyboard")
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
          else page.dispatchEvent(new Event(destination, { bubbles: true }));
        }
      });
      expect(visibleBody().visible).toContain("After history.");
      expect(hiddenText()).toBe("");
      expect(page.querySelector("[data-smooth-footnote-reveal]")).toBeNull();
      await advance(8);
      expect(page.scrollTop).toBe(
        destination === "bottom" ? nativeHeight - 300 : destination === "reading" ? 300 : 211,
      );
      expect(control.current?.isFollowing() ?? false).toBe(destination === "bottom");
      await act(() => {
        const image = page.querySelector("img")!;
        image.height = 200;
        image.dispatchEvent(new Event("load", { bubbles: true }));
      });
      await advance(4);
      expect(page.scrollTop).toBe(
        destination === "bottom" ? nativeHeight - 300 : destination === "reading" ? 300 : 211,
      );
      expect(control.current?.isFollowing() ?? false).toBe(destination === "bottom");
      expect(visibleBody().visible).toContain("After history.");
    },
  );
});
describe("round 2 independent boundaries", () => {
  it.each([
    ["expired", "body"],
    ["offscreen-growth", "body"],
    ["strict-expired", "body"],
    ["strict-offscreen-growth", "body"],
    ["expired", "reasoning"],
    ["offscreen-growth", "reasoning"],
    ["strict-expired", "reasoning"],
    ["strict-offscreen-growth", "reasoning"],
  ] as const)(
    "virtual row remount keeps its current history (%s, %s)",
    async (scenario, surface) => {
      await using fixture = await setup();
      const {
        page,
        visibleBody,
        advance,
        runId,
        itemId,
        timelineEntry,
        playback,
        timelineProps,
        hiddenText,
        screen,
      } = fixture;
      const props = timelineProps(`environment-local:r2-virtual-${scenario}-${surface}`);
      const metadata = playback("A");
      const show = async (text: string) => {
        const timeline = (
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry(text, surface)]}
            textPlayback={metadata}
          />
        );
        await act(() =>
          screen.rerender(
            scenario.startsWith("strict-") ? <StrictMode>{timeline}</StrictMode> : timeline,
          ),
        );
        if (surface === "reasoning")
          for (let i = 0; i < 2; i++)
            await act(() =>
              page
                .querySelector<HTMLElement>("[data-timeline-row-kind] [aria-expanded=false]")
                ?.click(),
            );
      };
      await show("A");
      let source = "A" + "b".repeat(40);
      await show(source);
      await advance(500);
      expect(hiddenText()).toBe("");
      virtualRows.visible = false;
      await show(source);
      expect(page.querySelector("[data-smooth-streaming]")).toBeNull();
      const key = JSON.stringify([
        "environment-local",
        `r2-virtual-${scenario}-${surface}`,
        runId,
        itemId,
        surface,
      ]);
      expect(smoothTextPlaybackStore.get(key)?.visibleText).toBe(source);
      if (scenario.endsWith("expired")) {
        const recordedAt = smoothTextPlaybackStore.get(key)!.recordedAt;
        expect(smoothTextPlaybackStore.get(key, recordedAt + 300_001)).toBeNull();
      } else {
        source += "c".repeat(100);
        await show(source);
      }
      virtualRows.visible = true;
      await show(source);
      expect(
        hiddenText(),
        JSON.stringify({ scenario, hidden: hiddenText(), visible: visibleBody().visible }),
      ).toBe("");
      expect(visibleBody().visible).toContain(source);
      await show(source + "LIVE");
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      expect(hiddenText()).toBe("LIVE");
    },
  );

  it.each(["body", "reasoning"] as const)(
    "resumes small offscreen backlog without replaying visible text (%s)",
    async (surface) => {
      await using fixture = await setup();
      const {
        page,
        advance,
        runId,
        itemId,
        timelineEntry,
        playback,
        timelineProps,
        hiddenText,
        screen,
      } = fixture;
      const props = timelineProps(`environment-local:r2-small-virtual-${surface}`);
      const metadata = playback("A");
      const show = async (text: string) => {
        await act(() =>
          screen.rerender(
            <MessagesTimeline
              {...props}
              timelineEntries={[timelineEntry(text, surface)]}
              textPlayback={metadata}
            />,
          ),
        );
        if (surface === "reasoning")
          for (let i = 0; i < 2; i++)
            await act(() =>
              page
                .querySelector<HTMLElement>("[data-timeline-row-kind] [aria-expanded=false]")
                ?.click(),
            );
      };
      await show("A");
      await advance(20);
      await show("ABCDE");
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      expect(hiddenText()).toBe("BCDE");
      virtualRows.visible = false;
      await show("ABCDE");
      const key = JSON.stringify([
        "environment-local",
        `r2-small-virtual-${surface}`,
        runId,
        itemId,
        surface,
      ]);
      expect(smoothTextPlaybackStore.get(key)?.visibleText).toBe("A");
      await show("ABCDEF");
      virtualRows.visible = true;
      await show("ABCDEF");
      expect(hiddenText()).toBe("BCDEF");
      await advance(60);
      expect(hiddenText()).toBe("");
    },
  );

  it("an extending historical footnote still admits its new live suffix to FIFO", async () => {
    await using fixture = await setup();
    const {
      noteById,
      visibleBody,
      noteState,
      step,
      timelineEntry,
      playback,
      timelineProps,
      hiddenText,
      screen,
    } = fixture;
    const history = "Before[^a].\n\n[^a]: Historical note";
    const props = timelineProps("environment-local:r2-growing-note");
    const metadata = playback(history);
    const show = (text: string) =>
      act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[timelineEntry(text)]}
            textPlayback={metadata}
            footnotesAutoCollapse
          />,
        ),
      );
    await show(history);
    expect(hiddenText()).toBe("");
    expect(noteById("a")!.hidden).toBe(true);
    await show(
      history +
        " LIVE tail.\n\nAfter live[^b][^c].\n\n[^b]: First new note.\n\n[^c]: Second new note.\n\nAfter new notes.",
    );
    const samples: {
      hidden: string;
      note: ReturnType<typeof noteState>;
      liHidden: boolean;
      body: string;
      first: ReturnType<typeof noteState>;
      second: ReturnType<typeof noteState>;
    }[] = [];
    for (let i = 0; i < 600; i++) {
      await step();
      const note = noteById("a")!;
      samples.push({
        hidden: hiddenText(),
        note: noteState(note),
        liHidden: note.hidden === true,
        body: visibleBody().visible,
        first: noteById("b") ? noteState(noteById("b")!) : { text: "", visible: "", open: false },
        second: noteById("c") ? noteState(noteById("c")!) : { text: "", visible: "", open: false },
      });
    }
    const evidence = JSON.stringify(samples.filter((_, i) => i % 30 === 0));
    const tail = samples.findIndex(
      (sample) =>
        !sample.liHidden && sample.note.open && sample.note.visible.includes("LIVE tail."),
    );
    const collapse = samples.findIndex((sample, i) => i > tail && !sample.note.open);
    const after = samples.findIndex((sample) => sample.body.includes("After live"));
    const first = samples.findIndex(
      (sample) => sample.first.open && sample.first.visible === "First new note.",
    );
    const secondStart = samples.findIndex((sample) => sample.second.visible.length > 0);
    const second = samples.findIndex(
      (sample) => sample.second.open && sample.second.visible === "Second new note.",
    );
    expect(tail, evidence).toBeGreaterThanOrEqual(0);
    expect(samples[tail]!.note.visible, evidence).toBe("Historical note LIVE tail.");
    expect(collapse, evidence).toBeGreaterThan(tail);
    expect(after, evidence).toBeGreaterThan(collapse);
    expect(first, evidence).toBeGreaterThan(after);
    expect(secondStart, evidence).toBeGreaterThanOrEqual(first);
    expect(second, evidence).toBeGreaterThanOrEqual(secondStart);
    expect(
      samples.slice(first, second + 1).every((sample) => sample.first.open),
      evidence,
    ).toBe(true);
    expect(visibleBody().visible).toContain("After new notes.");
  });

  it("rewritten history with footnotes is complete in the recovery commit", async () => {
    await using fixture = await setup();
    const {
      noteById,
      visibleBody,
      advance,
      timelineEntry,
      playback,
      timelineProps,
      hiddenText,
      screen,
    } = fixture;
    const history = "Before[^a].\n\n[^a]: Historical note.\n\nAfter history.";
    const props = timelineProps("environment-local:r2-rewrite-notes");
    await act(() =>
      screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[timelineEntry("OLD SOURCE")]}
          textPlayback={playback("OLD SOURCE")}
          footnotesAutoCollapse
        />,
      ),
    );
    await act(() =>
      screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[timelineEntry(history)]}
          textPlayback={playback("OLD MARKER", 2)}
          footnotesAutoCollapse
        />,
      ),
    );
    expect(visibleBody().source).toContain("After history.");
    expect(visibleBody().visible).toContain("After history.");
    expect(hiddenText()).toBe("");
    expect(noteById("a")!.hidden).toBe(true);
    await advance(8);
    expect(hiddenText()).toBe("");
    await act(() =>
      screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[timelineEntry(history + "\n\nLIVE")]}
          textPlayback={playback("OLD MARKER", 2)}
          footnotesAutoCollapse
        />,
      ),
    );
    await act(() => {
      fixture.clock += 32;
      vi.advanceTimersByTime(32);
    });
    expect(hiddenText()).toContain("LIVE");
    expect(hiddenText()).not.toContain("history");
    expect(visibleBody().visible).toContain("After history.");
    await advance(100);
    expect(hiddenText()).toBe("");
  });

  it("partial historical code remains visible if Shiki resolves after a live source append", async () => {
    await using fixture = await setup();
    const { page, hiddenText, screen } = fixture;
    const syntax = await vi.importActual<typeof import("../lib/syntaxHighlighting")>(
      "../lib/syntaxHighlighting",
    );
    const highlighter = await syntax.getSyntaxHighlighterPromise("typescript");
    let finish!: (value: typeof highlighter) => void;
    shikiDelay.promise = new Promise((resolve) => {
      finish = resolve;
    });
    const history = "```typescript\nconst historicalCode = 42;\n";
    const resume = {
      key: "r2-partial-code",
      baselineText: history,
      mountText: history,
      synchronized: true,
    };
    const show = (text: string) =>
      act(() =>
        screen.rerender(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            isStreaming
            smoothStreaming
            smoothTextResume={resume}
          />,
        ),
      );
    await show(history);
    expect(hiddenText()).toBe("");
    await show(history + "const liveCode = 43;\n```");
    await act(() => {
      fixture.clock += 32;
      vi.advanceTimersByTime(32);
    });
    await act(async () => {
      finish(highlighter);
      await shikiDelay.promise;
    });
    expect(page.querySelector(".chat-markdown-shiki")?.textContent).toContain("historicalCode");
    expect(hiddenText()).not.toContain("historicalCode");
  });
});
describe("round 3 first source commits", () => {
  it.each(
    (["navigation", "new-live", "collapsed-reasoning"] as const).flatMap((origin) =>
      (["body", "reasoning"] as const).flatMap((surface) =>
        origin === "collapsed-reasoning" && surface === "body"
          ? []
          : ([false, true] as const).flatMap((strict) =>
              (surface === "body" ? [false, true] : [false]).map(
                (liveAtMount) => [origin, surface, strict, liveAtMount] as const,
              ),
            ),
      ),
    ),
  )(
    "shows committed offscreen history on its first appearance (%s, %s, strict=%s, live=%s)",
    async (origin, surface, strict, liveAtMount) => {
      await using fixture = await setup();
      const {
        page,
        visibleBody,
        advance,
        timelineEntry,
        playback,
        timelineProps,
        hiddenText,
        screen,
      } = fixture;
      const props = timelineProps(
        `environment-local:r3-first-${origin}-${surface}-${strict}-${liveAtMount}`,
      );
      const metadata = playback(origin === "new-live" ? null : "A");
      const show = async (text: string | null, expand = false) => {
        const entries = text === null ? [] : [timelineEntry(text, surface)];
        const timeline = (
          <MessagesTimeline
            {...props}
            textPlaybackNavigation={{ threadKey: props.routeThreadKey, entries }}
            timelineEntries={entries}
            textPlayback={metadata}
          />
        );
        await act(() => screen.rerender(strict ? <StrictMode>{timeline}</StrictMode> : timeline));
        if (surface === "reasoning" && expand)
          for (let i = 0; i < 2; i++)
            await act(() =>
              page
                .querySelector<HTMLElement>("[data-timeline-row-kind] [aria-expanded=false]")
                ?.click(),
            );
      };
      virtualRows.visible = origin === "collapsed-reasoning";
      if (origin === "new-live") await show(null);
      await show("A");
      expect(page.querySelector("[data-smooth-streaming]")).toBeNull();
      let source = "A";
      for (let i = 0; i < 4; i++) {
        source += "b".repeat(25);
        await show(source);
        expect(page.querySelector("[data-smooth-streaming]")).toBeNull();
      }
      virtualRows.visible = true;
      const mountedSource = source + (liveAtMount ? "LIVE" : "");
      await show(mountedSource, true);
      expect(hiddenText()).toBe(liveAtMount ? "LIVE" : "");
      expect(visibleBody().visible).toContain(source);
      await advance(100);
      await show(mountedSource + "NEXT", true);
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      expect(hiddenText()).toBe("NEXT");
      expect(visibleBody().visible).toContain(source);
      await advance(100);
      expect(hiddenText()).toBe("");
    },
  );

  it.each(
    (["body", "reasoning"] as const).flatMap((surface) =>
      ([false, true] as const).map((strict) => [surface, strict] as const),
    ),
  )("plays a new live source on its first commit (%s, strict=%s)", async (surface, strict) => {
    await using fixture = await setup();
    const {
      page,
      visibleBody,
      advance,
      timelineEntry,
      playback,
      timelineProps,
      hiddenText,
      screen,
    } = fixture;
    const props = timelineProps(`environment-local:r3-immediate-${surface}-${strict}`);
    const metadata = playback(null);
    if (surface === "reasoning") {
      // 使用真实披露缓存，让新推理 source 首次提交时就挂载到已展开的表面。
      rememberTimelinePosition(
        props.routeThreadKey,
        {
          rowId: "resume-dom-row",
          offsetWithinRow: 0,
          scrollOffset: 0,
          atEnd: true,
          disclosures: {
            runs: new Set(),
            workGroups: new Set(["work-group:resume-dom-row"]),
            attempts: new Set(),
            workGroupState: { scrollPositions: new Map(), expandedEntries: new Set() },
          },
        },
        false,
      );
    }
    const show = (text: string | null) => {
      const entries = text === null ? [] : [timelineEntry(text, surface)];
      const timeline = (
        <MessagesTimeline
          {...props}
          textPlaybackNavigation={{ threadKey: props.routeThreadKey, entries }}
          timelineEntries={entries}
          textPlayback={metadata}
        />
      );
      return act(() => screen.rerender(strict ? <StrictMode>{timeline}</StrictMode> : timeline));
    };
    await show(null);
    const source = "A" + "b".repeat(100);
    await show(source);
    expect(page.querySelector("[data-smooth-streaming]")).not.toBeNull();
    await act(() => {
      fixture.clock += 32;
      vi.advanceTimersByTime(32);
    });
    expect(hiddenText(), page.innerHTML).toContain("b".repeat(100));
    await advance(500);
    expect(hiddenText()).toBe("");
    expect(visibleBody().visible).toContain(source);
  });
});
describe("committed history version at first appearance", () => {
  it.each(
    (["plain", "footnotes"] as const).flatMap((format) =>
      (["body", "reasoning"] as const).flatMap((surface) =>
        ([false, true] as const).map((strict) => [format, surface, strict] as const),
      ),
    ),
  )(
    "shows a single correction without replaying received history (%s, %s, strict=%s)",
    async (format, surface, strict) => {
      await using fixture = await setup();
      const {
        noteById,
        visibleBody,
        noteState,
        step,
        advance,
        timelineEntry,
        playback,
        timelineProps,
        hiddenText,
        screen,
      } = fixture;
      const props = timelineProps(`environment-local:r4-correction-${format}-${surface}-${strict}`);
      if (surface === "reasoning")
        rememberTimelinePosition(
          props.routeThreadKey,
          {
            rowId: "resume-dom-row",
            offsetWithinRow: 0,
            scrollOffset: 0,
            atEnd: true,
            disclosures: {
              runs: new Set(),
              workGroups: new Set(["work-group:resume-dom-row"]),
              attempts: new Set(),
              workGroupState: { scrollPositions: new Map(), expandedEntries: new Set() },
            },
          },
          false,
        );
      const metadata = playback("A");
      const show = (text: string) => {
        const entries = [timelineEntry(text, surface)];
        const timeline = (
          <MessagesTimeline
            {...props}
            timelineEntries={entries}
            textPlaybackNavigation={{ threadKey: props.routeThreadKey, entries }}
            textPlayback={metadata}
            footnotesAutoCollapse
          />
        );
        return act(() => screen.rerender(strict ? <StrictMode>{timeline}</StrictMode> : timeline));
      };
      const notes =
        format === "footnotes" ? "\n\nBefore[^a].\n\n[^a]: Historical note.\n\nAfter history." : "";
      virtualRows.visible = false;
      await show("A");
      await show("A" + "b".repeat(100) + notes);
      virtualRows.visible = true;
      const rewrittenPrefix = "A" + "b".repeat(50) + "X" + "b".repeat(49);
      const rewritten = rewrittenPrefix + notes;
      await show(rewritten);
      expect(hiddenText()).toBe("");
      expect(visibleBody().visible).toContain(rewrittenPrefix);
      if (format === "footnotes") {
        expect(visibleBody().source).toContain("After history.");
        expect(visibleBody().visible).toContain("After history.");
        expect(noteById("a")!.hidden).toBe(true);
        expect(noteState(noteById("a")!).open).toBe(false);
      }
      await advance(8);
      expect(hiddenText()).toBe("");
      await show(rewritten + "NEXT");
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      expect(hiddenText()).toBe("NEXT");
      expect(visibleBody().visible).toContain(rewrittenPrefix);
      await advance(100);
      expect(hiddenText()).toBe("");
      if (format !== "footnotes") return;

      await show(
        rewritten +
          "NEXT\n\nNew live[^b][^c].\n\n[^b]: First new note.\n\n[^c]: Second new note.\n\nAfter new notes.",
      );
      const samples: {
        body: string;
        first: ReturnType<typeof noteState>;
        second: ReturnType<typeof noteState>;
      }[] = [];
      for (let i = 0; i < 400; i++) {
        await step();
        samples.push({
          body: visibleBody().visible,
          first: noteById("b") ? noteState(noteById("b")!) : { text: "", visible: "", open: false },
          second: noteById("c")
            ? noteState(noteById("c")!)
            : { text: "", visible: "", open: false },
        });
        expect(visibleBody().visible).toContain("After history.");
        expect(noteById("a")!.hidden).toBe(true);
      }
      const evidence = JSON.stringify(samples.filter((_, i) => i % 20 === 0));
      const first = samples.findIndex(
        (sample) => sample.first.open && sample.first.visible === "First new note.",
      );
      const secondStart = samples.findIndex((sample) => sample.second.visible.length > 0);
      const second = samples.findIndex(
        (sample) => sample.second.open && sample.second.visible === "Second new note.",
      );
      const collapsed = samples.findIndex((sample, i) => i > second && !sample.first.open);
      const after = samples.findIndex((sample) => sample.body.includes("After new notes."));
      expect(first, evidence).toBeGreaterThanOrEqual(0);
      expect(secondStart, evidence).toBeGreaterThanOrEqual(first);
      expect(second, evidence).toBeGreaterThanOrEqual(secondStart);
      expect(
        samples.slice(first, second + 1).every((sample) => sample.first.open),
        evidence,
      ).toBe(true);
      expect(collapsed, evidence).toBeGreaterThan(second);
      expect(after, evidence).toBeGreaterThanOrEqual(collapsed);
      expect(visibleBody().visible).toContain("After new notes.");
      expect(noteState(noteById("b")!).open).toBe(false);
      expect(noteState(noteById("c")!).open).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps the fallback snapshot fixed when later live text reaches the old mount version (strict=%s)",
    async (strict) => {
      await using fixture = await setup();
      const { visibleBody, advance, timelineEntry, playback, timelineProps, hiddenText, screen } =
        fixture;
      const props = timelineProps(`environment-local:r4-truncated-${strict}`);
      const metadata = playback("A");
      const show = (text: string) => {
        const entries = [timelineEntry(text)];
        const timeline = (
          <MessagesTimeline
            {...props}
            timelineEntries={entries}
            textPlaybackNavigation={{ threadKey: props.routeThreadKey, entries }}
            textPlayback={metadata}
          />
        );
        return act(() => screen.rerender(strict ? <StrictMode>{timeline}</StrictMode> : timeline));
      };
      virtualRows.visible = false;
      await show("A");
      const received = "A" + "b".repeat(100);
      await show(received);
      virtualRows.visible = true;
      const truncated = "A" + "b".repeat(50);
      await show(truncated);
      expect(hiddenText()).toBe("");
      expect(visibleBody().visible).toContain(truncated);
      await show(received + "LIVE");
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      expect(hiddenText()).toBe("b".repeat(50) + "LIVE");
      expect(visibleBody().visible).toContain(truncated);
      await advance(300);
      expect(hiddenText()).toBe("");
      await show(received + "LIVENEXT");
      await act(() => {
        fixture.clock += 32;
        vi.advanceTimersByTime(32);
      });
      expect(hiddenText()).toBe("NEXT");
    },
  );
});
describe("yield duration through real timeline consumers", () => {
  it.each(
    (["body", "reasoning"] as const).flatMap((surface) =>
      ([80, 1000] as const).map((duration) => [surface, duration] as const),
    ),
  )(
    "applies %s height travel duration %sms to a new footnote heading",
    async (surface, duration) => {
      await using fixture = await setup();
      const { timelineEntry, playback, timelineProps, headingTravel, yieldFootnoteSource, screen } =
        fixture;
      const props = timelineProps(`environment-local:yield-${surface}-${duration}`);
      if (surface === "reasoning")
        rememberTimelinePosition(
          props.routeThreadKey,
          {
            rowId: "resume-dom-row",
            offsetWithinRow: 0,
            scrollOffset: 0,
            atEnd: true,
            disclosures: {
              runs: new Set(),
              workGroups: new Set(["work-group:resume-dom-row"]),
              attempts: new Set(),
              workGroupState: { scrollPositions: new Map(), expandedEntries: new Set() },
            },
          },
          false,
        );
      const metadata = playback(null);
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[]}
            textPlaybackNavigation={{ threadKey: props.routeThreadKey, entries: [] }}
            textPlayback={metadata}
            footnotesAutoCollapse
            smoothTextYieldDurationMs={duration}
          />,
        ),
      );
      const entries = [timelineEntry(yieldFootnoteSource, surface)];
      await act(() =>
        screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={entries}
            textPlaybackNavigation={{ threadKey: props.routeThreadKey, entries }}
            textPlayback={metadata}
            footnotesAutoCollapse
            smoothTextYieldDurationMs={duration}
          />,
        ),
      );
      const travel = await headingTravel();
      expect(travel.heights.length).toBeGreaterThan(2);
      expect(
        travel.heights.every(
          (height, index) => index === 0 || height >= travel.heights[index - 1]!,
        ),
      ).toBe(true);
      if (duration === 80) expect(travel.elapsed).toBeLessThanOrEqual(128);
      else expect(travel.elapsed).toBeGreaterThanOrEqual(800);
    },
  );
});
describe("subagent panel reasoning", () => {
  const partialLink = "Read [label](https://exa";
  it.each([80, 1000] as const)(
    "uses the environment's %sms yield duration through the real native reasoning panel",
    async (duration) => {
      await using fixture = await setup();
      const { projection } = fixture;
      const { page, headingTravel, yieldFootnoteSource, screen } = fixture;
      subagentPanelState.yieldDurationMs = duration;
      subagentPanelState.footnotesAutoCollapse = true;
      const next = projection(yieldFootnoteSource, false);
      subagentPanelState.projection = next;
      await act(() =>
        screen.rerender(
          <SubagentConversationPanel
            threadRef={{
              environmentId: EnvironmentId.make(`yield-panel-${duration}`),
              threadId: next.thread.id,
            }}
            mode="sidebar"
          />,
        ),
      );
      for (let index = 0; index < 2; index++)
        await act(() =>
          [
            ...page.querySelectorAll<HTMLElement>(
              "[data-timeline-row-kind] [aria-expanded=false], [data-timeline-live-row-kind] [aria-expanded=false]",
            ),
          ]
            .find((element) => !element.closest("[data-stream-footnotes]"))
            ?.click(),
        );
      const travel = await headingTravel();
      expect(travel.heights.length).toBeGreaterThan(2);
      if (duration === 80) expect(travel.elapsed).toBeLessThanOrEqual(128);
      else expect(travel.elapsed).toBeGreaterThanOrEqual(800);
    },
  );

  it.each(
    ([false, true] as const).flatMap((history) =>
      (["completed", "interrupted", "failed", "cancelled"] as const).map(
        (terminal) => [history, terminal] as const,
      ),
    ),
  )("preloads consecutive native fragments and releases on %s / %s", async (history, terminal) => {
    await using fixture = await setup();
    const { projection, show, reasoningText } = fixture;

    for (const fragment of [partialLink, `${partialLink}mple`, `${partialLink}mple.com`]) {
      await show(projection(fragment, history));
      expect(reasoningText()).toBe("Read label");
    }
    // The provider terminal arrives while the projected reasoning item still
    // says running, proving activity identity also settles the real consumer.
    const received = `${partialLink}mple.com`;
    await show(projection(received, history, null, terminal));
    expect(reasoningText()).toBe(received);
    const settled = projection(received, history, null, terminal);
    await show({
      ...settled,
      turnItems: settled.turnItems.map((item) => ({ ...item, status: terminal })),
      visibleTurnItems: settled.visibleTurnItems.map((row) => ({
        ...row,
        item: { ...row.item, status: terminal },
      })),
    });
    expect(reasoningText()).toBe(received);
  });

  it.each(["preparing", "starting", "running", "waiting", "completed"] as const)(
    "preserves ordinary app-run reasoning in %s",
    async (status) => {
      await using fixture = await setup();
      const { projection, show, reasoningText } = fixture;

      const working = status === "preparing" || status === "starting" || status === "running";
      for (const fragment of [partialLink, `${partialLink}mple`]) {
        await show(projection(fragment, true, status));
        expect(reasoningText()).toBe(working ? "Read label" : fragment);
      }
      await show(projection(`${partialLink}mple`, true, "completed", "completed"));
      expect(reasoningText()).toBe(`${partialLink}mple`);
    },
  );
});
describe("round 2 thread display handoff", () => {
  it.each([false, true])(
    "shows only the target thread during cold navigation and preserves its live boundary (strict=%s)",
    async (strict) => {
      await using fixture = await setup();
      const { page, timelineEntry, playback, timelineProps, hiddenText, screen } = fixture;
      const { resolveThreadSwitchTimeline, isPaintOnlyThreadTimeline } =
        await import("./ChatView.logic");
      const firstKey = "environment-local:r2-held-first";
      const nextKey = "environment-local:r2-held-next";
      const firstEntries = [timelineEntry("OLD THREAD")];
      const base = timelineProps(firstKey);
      const show = (
        activeKey: string,
        entries: ReturnType<typeof timelineEntry>[],
        loading: boolean,
        metadata: ThreadTextPlaybackState,
      ) => {
        const displayed = resolveThreadSwitchTimeline({
          loading,
          activeThreadKey: activeKey,
          nextEntries: entries,
          rememberedForActive: [],
          lastReady: { threadKey: firstKey, entries: firstEntries },
        });
        const paintOnly = isPaintOnlyThreadTimeline(displayed.displayThreadKey, activeKey);
        const timeline = (
          <MessagesTimeline
            {...base}
            textPlaybackNavigation={{ threadKey: activeKey, entries }}
            routeThreadKey={displayed.displayThreadKey!}
            displayThreadKey={displayed.displayThreadKey!}
            timelineEntries={displayed.entries}
            textPlayback={metadata}
            paintOnly={paintOnly}
            smoothStreaming={!paintOnly}
            isWorking={!paintOnly}
            activeTurnInProgress={!paintOnly}
            citationHistoryLoading={loading}
          />
        );
        return act(() => screen.rerender(strict ? <StrictMode>{timeline}</StrictMode> : timeline));
      };
      await show(firstKey, firstEntries, false, playback("OLD THREAD"));
      await show(nextKey, [], true, playback(null, 1, "pending"));
      expect(page.textContent).not.toContain("OLD THREAD");
      const history = "A" + "b".repeat(100);
      await show(nextKey, [timelineEntry(history + "LIVE")], false, playback(history));
      expect(hiddenText()).toBe("LIVE");
    },
  );
});
