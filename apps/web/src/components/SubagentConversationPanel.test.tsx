// @vitest-environment jsdom
import { act, useLayoutEffect, useMemo, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createInlineBufferPlugin } from "../markdown-streaming";
import { makeThreadProjectionFixture } from "../test-fixtures";

const v2Projection = makeThreadProjectionFixture();

const state = vi.hoisted(() => ({
  projection: null as
    | (Partial<OrchestrationV2ThreadProjection> & {
        text: string;
        streaming?: boolean;
      })
    | null,
  status: "synchronizing" as "cached" | "synchronizing" | "live" | "deleted",
  error: { _tag: "None" } as unknown,
  listHidden: false,
  codePending: false,
  codeOffscreen: false,
  activity: null as {
    isWorking: boolean;
    activeTurnInProgress: boolean;
    activeTurnStartedAt: string | null;
    runningRunId: RunId | null;
    liveFollowEnabled?: boolean;
    onManualNavigation?: (direction?: -1 | 1) => void;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
  } | null,
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({
    title: "Review child",
    projectId: "project-test",
    worktreePath: null,
    modelSelection: { instanceId: "codex", model: "gpt-6" },
    lineage: { relationshipToParent: null, parentThreadId: null },
  }),
  useThreadProjection: (ref: ScopedThreadRef | null) =>
    ref === null || state.projection === null
      ? null
      : { projection: { ...v2Projection, ...state.projection } },
  useThreadVisibleTurnItems: () => [],
  useProject: () => null,
}));

vi.mock("~/state/threads", () => ({
  useEnvironmentThread: () => ({
    status: state.status,
    error: state.error,
  }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    timestampFormat: "locale",
    responseStreamingMode: "smooth",
    conversationStructure: "restructured",
  }),
}));

vi.mock("~/session-logic", () => ({
  deriveTimelineEntriesFromVisibleTurnItemsWithState: () => ({
    entries: !state.projection?.text ? [] : [{ id: "entry", text: state.projection.text }],
  }),
}));

vi.mock("./chat/ComposerSurface", () => ({
  ComposerSurface: { Shell: "div" },
}));

vi.mock("~/components/ui/button", () => ({
  Button: (props: { children?: ReactNode; [key: string]: unknown }) => <button {...props} />,
}));

vi.mock("./SubagentModelInfo", () => ({
  resolveSubagentModelInfo: () => ({
    providerLabel: "Codex",
    modelLabel: "gpt-6",
    effortLabel: "medium",
    fast: true,
  }),
  SubagentModelInfo: () => <span>Codex · gpt-6</span>,
}));

vi.mock("./chat/MessagesTimeline", () => ({
  MessagesTimeline: function TestTimeline(props: {
    isWorking: boolean;
    activeTurnInProgress: boolean;
    activeTurnStartedAt: string | null;
    runningRunId: RunId | null;
    smoothStreaming: boolean;
    onInitialLayout?: () => void;
    timelineEntries?: Array<{ text?: string }>;
    listRef?: { current: { getScrollableNode: () => HTMLElement } | null };
  }) {
    state.activity = props;
    // Consume the real Markdown buffer with Timeline's native-message completion
    // condition. The activity derivation in the panel is not mocked.
    const buffer = useMemo(() => createInlineBufferPlugin(), []);
    const plugin = buffer.configure(
      props.smoothStreaming && Boolean(state.projection?.streaming) && props.isWorking,
    );
    useLayoutEffect(() => buffer.commit());
    return (
      <div
        data-testid="timeline"
        data-timeline-empty={props.timelineEntries?.length ? undefined : "true"}
      >
        <div
          data-testid="list-content"
          style={{ opacity: state.listHidden ? 0 : 1 }}
          ref={(element) => {
            if (props.listRef)
              props.listRef.current =
                element === null ? null : { getScrollableNode: () => element };
          }}
        >
          {props.timelineEntries?.length ? (
            <div data-timeline-root="true">
              <ReactMarkdown remarkPlugins={[remarkGfm, ...(plugin ? [plugin] : [])]}>
                {props.timelineEntries[0]?.text}
              </ReactMarkdown>
              {state.codePending ? (
                <pre
                  data-markdown-code-pending=""
                  data-offscreen={state.codeOffscreen || undefined}
                >
                  Pending code
                </pre>
              ) : null}
            </div>
          ) : (
            <span>Send a message to start the conversation.</span>
          )}
        </div>
        <button type="button" onClick={props.onInitialLayout}>
          Finish initial layout
        </button>
      </div>
    );
  },
}));

vi.mock("@legendapp/list/react", () => ({
  // The panel only needs a stable ref type in this test; the list itself is mocked above.
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeProjectRef: (environmentId: EnvironmentId, projectId: string) => ({
    environmentId,
    projectId,
  }),
  scopeThreadRef: (environmentId: EnvironmentId, threadId: ThreadId) => ({
    environmentId,
    threadId,
  }),
  scopedThreadKey: (threadRef: ScopedThreadRef) =>
    `${threadRef.environmentId}:${threadRef.threadId}`,
}));

let SubagentConversationPanel: typeof import("./SubagentConversationPanel").SubagentConversationPanel;
const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
const frames = new Map<number, FrameRequestCallback>();
const resizeChecks = new Set<() => void>();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projection = null;
  state.status = "synchronizing";
  state.error = Option.none();
  state.listHidden = false;
  state.codePending = false;
  state.codeOffscreen = false;
  state.activity = null;
  frames.clear();
  resizeChecks.clear();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizeChecks.add(this.callback);
      }
      disconnect() {
        resizeChecks.delete(this.callback);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.hasAttribute("data-offscreen") ? 900 : 0;
    const height = this.hasAttribute("data-zero-height") ? 0 : 400;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 500,
      width: 500,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
  ({ SubagentConversationPanel } = await import("./SubagentConversationPanel"));
});

afterEach(async () => {
  await act(() =>
    mountedRoots.splice(0).forEach(({ root, container }) => {
      root.unmount();
      container.remove();
    }),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const environmentId = EnvironmentId.make("environment-test");
function threadRef(id: string): ScopedThreadRef {
  return { environmentId, threadId: ThreadId.make(id) };
}

type Props = ComponentProps<typeof SubagentConversationPanel>;
async function renderPanel(mode: "overlay" | "sidebar", props: Partial<Props> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  const update = async (next: Partial<Props> = {}) => {
    await act(() =>
      root.render(
        <SubagentConversationPanel
          threadRef={threadRef("child-1")}
          mode={mode}
          onClose={() => undefined}
          {...props}
          {...next}
        />,
      ),
    );
  };
  await update();
  return { container, update };
}

function findElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
function isReady(container: HTMLElement) {
  return (
    findElement(container, "[data-subagent-conversation-panel]").getAttribute("aria-hidden") ===
    "false"
  );
}
async function finishLayout(container: HTMLElement) {
  await act(() => findElement(container, '[data-testid="timeline"] button').click());
  await flushContentFrames();
}
async function flushFrame() {
  await act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}
async function flushContentFrames() {
  await flushFrame();
  await flushFrame();
}

const nativeStartedAt = DateTime.makeUnsafe("2026-10-16T01:00:00.000Z");
const partialLink = "Read [label](https://exa";
type ProviderTurn = OrchestrationV2ThreadProjection["providerTurns"][number];

function providerTurn(overrides: Partial<ProviderTurn> = {}): ProviderTurn {
  return {
    id: ProviderTurnId.make("native-turn"),
    providerThreadId: ProviderThreadId.make("native-child"),
    nodeId: NodeId.make("native-root"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: nativeStartedAt,
    completedAt: null,
    ...overrides,
  };
}

function nativeProjection(turns: readonly ProviderTurn[] = [providerTurn()]) {
  return {
    text: partialLink,
    streaming: true,
    thread: {
      ...v2Projection.thread,
      activeProviderThreadId: ProviderThreadId.make("native-child"),
    },
    providerTurns: turns,
    messages: [
      {
        id: MessageId.make("native-message"),
        threadId: v2Projection.thread.id,
        runId: null,
        nodeId: NodeId.make("native-root"),
        role: "assistant" as const,
        text: partialLink,
        attachments: [],
        streaming: true,
        createdAt: nativeStartedAt,
        updatedAt: nativeStartedAt,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
      },
    ],
  };
}

function markdownBody(container: HTMLElement) {
  return findElement(container, "[data-timeline-root] p").textContent;
}

describe("native subagent streaming activity", () => {
  it.each(["completed", "interrupted", "failed", "cancelled"] as const)(
    "buffers consecutive native fragments until the turn is %s, then releases the suffix",
    async (terminalStatus) => {
      state.status = "live";
      state.projection = nativeProjection([providerTurn({ status: "pending", startedAt: null })]);
      const view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe("Read label");
      expect(state.activity).toMatchObject({
        isWorking: true,
        activeTurnInProgress: true,
        activeTurnStartedAt: null,
        runningRunId: null,
      });

      for (const text of [partialLink, `${partialLink}mple`, `${partialLink}mple.com`]) {
        state.projection = { ...nativeProjection(), text };
        await view.update();
        expect(markdownBody(view.container)).toBe("Read label");
        expect(state.activity).toMatchObject({
          isWorking: true,
          activeTurnInProgress: true,
          activeTurnStartedAt: DateTime.formatIso(nativeStartedAt),
          runningRunId: null,
        });
      }

      // The turn terminal can arrive before the last message clears streaming.
      state.projection = {
        ...state.projection,
        providerTurns: [providerTurn({ status: terminalStatus, completedAt: nativeStartedAt })],
      };
      await view.update();
      expect(markdownBody(view.container)).toBe(`${partialLink}mple.com`);
      expect(state.activity).toMatchObject({
        isWorking: false,
        activeTurnInProgress: false,
        activeTurnStartedAt: null,
        runningRunId: null,
      });
      state.projection = { ...state.projection, streaming: false };
      await view.update();
      expect(markdownBody(view.container)).toBe(`${partialLink}mple.com`);
    },
  );

  it.each(["preparing", "starting", "running", "waiting", "completed"] as const)(
    "preserves the ordinary application run's %s behavior and identity",
    async (status) => {
      const runId = RunId.make("app-run");
      const startedAt = DateTime.makeUnsafe("2026-10-16T02:00:00.000Z");
      state.projection = {
        ...nativeProjection(),
        runs: [
          {
            id: runId,
            threadId: v2Projection.thread.id,
            ordinal: 1,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: ProviderThreadId.make("native-child"),
            userMessageId: MessageId.make("user-message"),
            rootNodeId: null,
            activeAttemptId: RunAttemptId.make("app-attempt"),
            status,
            requestedAt: startedAt,
            startedAt,
            completedAt: status === "completed" ? startedAt : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        providerTurns: [providerTurn({ runAttemptId: RunAttemptId.make("app-attempt") })],
      };
      const view = await renderPanel("overlay");
      const working = status === "preparing" || status === "starting" || status === "running";
      expect(markdownBody(view.container)).toBe(working ? "Read label" : partialLink);
      expect(state.activity).toMatchObject({
        isWorking: working,
        activeTurnInProgress: working,
        activeTurnStartedAt: DateTime.formatIso(startedAt),
        runningRunId: working ? runId : null,
      });
      // A historical application run must not hide subsequent native work,
      // while an application run waiting for input must retain its behavior.
      if (status === "waiting" || status === "completed") {
        const nextStartedAt = DateTime.makeUnsafe("2026-10-16T03:00:00.000Z");
        state.projection = {
          ...state.projection,
          providerTurns: [providerTurn({ ordinal: 2, startedAt: nextStartedAt })],
        };
        await view.update();
        expect(markdownBody(view.container)).toBe(
          status === "completed" ? "Read label" : partialLink,
        );
        expect(state.activity).toMatchObject({
          isWorking: status === "completed",
          activeTurnStartedAt: DateTime.formatIso(
            status === "completed" ? nextStartedAt : startedAt,
          ),
          runningRunId: null,
        });
      }
    },
  );

  it.each([false, true])(
    "uses only the latest turn of the current provider thread, regardless of array order (%s)",
    async (reverse) => {
      const turns = [
        providerTurn({ ordinal: 1 }),
        providerTurn({ id: ProviderTurnId.make("newer-turn"), ordinal: 2, status: "completed" }),
        providerTurn({
          id: ProviderTurnId.make("unrelated-turn"),
          providerThreadId: ProviderThreadId.make("unrelated-thread"),
          ordinal: 99,
        }),
      ];
      state.projection = nativeProjection(reverse ? turns.toReversed() : turns);
      const view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe(partialLink);
      state.projection = {
        ...state.projection,
        providerTurns: [
          ...turns,
          providerTurn({ id: ProviderTurnId.make("current-turn"), ordinal: 3 }),
        ],
      };
      await view.update();
      expect(markdownBody(view.container)).toBe("Read label");
      state.projection = {
        ...state.projection,
        thread: { ...v2Projection.thread, activeProviderThreadId: null },
      };
      await view.update();
      expect(markdownBody(view.container)).toBe(partialLink);
    },
  );

  it("does not revive an old native turn when the current provider thread changes", async () => {
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe("Read label");
    state.projection = {
      ...state.projection,
      thread: {
        ...v2Projection.thread,
        activeProviderThreadId: ProviderThreadId.make("new-provider-thread"),
      },
    };
    await view.update();
    expect(markdownBody(view.container)).toBe(partialLink);
  });

  it("settles a turn with a completion timestamp even if its status still says running", async () => {
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe("Read label");
    state.projection = nativeProjection([providerTurn({ completedAt: nativeStartedAt })]);
    await view.update();
    expect(markdownBody(view.container)).toBe(partialLink);
  });
});

describe("subagent live follow", () => {
  it("re-arms when the first scroll after detaching reaches the end", async () => {
    state.status = "live";
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    const scroller = findElement(view.container, "[data-testid='list-content']");
    scroller.scrollTop = 100;
    await act(() => state.activity?.onManualNavigation?.(-1));
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event("scroll"));
    await act(() => state.activity?.onIsAtEndChange?.(true));
    expect(state.activity?.liveFollowEnabled).toBe(true);
  });

  it("does not re-arm when only an embedded code scroller moves down", async () => {
    state.status = "live";
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    const scroller = findElement(view.container, "[data-testid='list-content']");
    const code = document.createElement("pre");
    scroller.append(code);
    await act(() => state.activity?.onManualNavigation?.(-1));
    code.scrollTop = 10;
    code.dispatchEvent(new Event("scroll"));
    code.scrollTop = 100;
    code.dispatchEvent(new Event("scroll"));
    await act(() => state.activity?.onIsAtEndChange?.(true));
    expect(state.activity?.liveFollowEnabled).toBe(false);
  });

  it("leaves follow on reader navigation and re-arms only after scrolling back down to the end", async () => {
    state.status = "live";
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    expect(state.activity?.liveFollowEnabled).toBe(true);
    await act(() => state.activity?.onManualNavigation?.(-1));
    expect(state.activity?.liveFollowEnabled).toBe(false);
    // An estimated end report without a downward move does not steal the viewport.
    await act(() => state.activity?.onIsAtEndChange?.(true));
    expect(state.activity?.liveFollowEnabled).toBe(false);
    const scroller = findElement(view.container, "[data-testid='list-content']");
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event("scroll"));
    await act(() => state.activity?.onIsAtEndChange?.(true));
    expect(state.activity?.liveFollowEnabled).toBe(true);
  });
});

describe("SubagentConversationPanel", () => {
  it.each(["overlay", "sidebar"] as const)(
    "reveals the %s pane together with the first rendered child content",
    async (mode) => {
      const view = await renderPanel(mode);
      expect(isReady(view.container)).toBe(false);
      expect(view.container.querySelector('[data-testid="timeline"]')).toBeNull();
      state.projection = { text: "first response" };
      state.status = "cached";
      await view.update();
      expect(isReady(view.container)).toBe(false);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(true);
      expect(view.container.textContent).toContain("first response");
    },
  );

  it.each(["overlay", "sidebar"] as const)(
    "waits for the %s list's opacity gate to open after layout",
    async (mode) => {
      state.projection = { text: "cold response" };
      state.status = "cached";
      state.listHidden = true;
      const view = await renderPanel(mode);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(false);
      await act(() => {
        findElement(view.container, '[data-testid="list-content"]').style.opacity = "1";
      });
      await flushContentFrames();
      expect(isReady(view.container)).toBe(true);
      expect(view.container.textContent).toContain("cold response");
    },
  );

  it.each(["overlay", "sidebar"] as const)(
    "waits for visible code in the %s pane but does not hide later streaming updates",
    async (mode) => {
      state.projection = { text: "response with code" };
      state.status = "cached";
      state.codePending = true;
      const view = await renderPanel(mode);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(false);
      await act(() => {
        findElement(view.container, "[data-markdown-code-pending]").remove();
      });
      await flushContentFrames();
      expect(isReady(view.container)).toBe(true);
      await act(() => {
        const pending = document.createElement("pre");
        pending.setAttribute("data-markdown-code-pending", "");
        findElement(view.container, "[data-timeline-root]").append(pending);
      });
      expect(isReady(view.container)).toBe(true);
    },
  );

  it("does not wait for code below the first viewport", async () => {
    state.projection = { text: "visible paragraph" };
    state.status = "cached";
    state.codePending = true;
    state.codeOffscreen = true;
    const view = await renderPanel("sidebar");
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(true);
  });

  it("waits for a populated list to commit its first row after onLoad", async () => {
    state.projection = { text: "first row" };
    state.status = "cached";
    const view = await renderPanel("sidebar");
    const content = findElement(view.container, '[data-testid="list-content"]');
    const row = findElement(content, "[data-timeline-root]");
    await act(() => row.remove());
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    await act(() => {
      content.append(row);
    });
    await flushContentFrames();
    expect(isReady(view.container)).toBe(true);
  });

  it("does not treat an empty cached snapshot as a finished first load", async () => {
    state.projection = { text: "" };
    state.status = "cached";
    const view = await renderPanel("sidebar");
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    state.status = "live";
    await view.update();
    await flushContentFrames();
    expect(isReady(view.container)).toBe(true);
    expect(view.container.textContent).toContain("Send a message to start the conversation.");
  });

  it.each(["overlay", "sidebar"] as const)(
    "keeps a ready %s pane visible during streaming and resets for a new child",
    async (mode) => {
      state.projection = { text: "first response" };
      state.status = "cached";
      const view = await renderPanel(mode);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(true);
      state.projection = { text: "streamed response" };
      await view.update();
      expect(isReady(view.container)).toBe(true);
      expect(view.container.textContent).toContain("streamed response");
      await view.update({ threadRef: threadRef("child-2") });
      expect(isReady(view.container)).toBe(false);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(true);
    },
  );

  it("disconnects the old content observer when switching children during the first load", async () => {
    state.projection = { text: "first response" };
    state.status = "cached";
    state.listHidden = true;
    const view = await renderPanel("sidebar");
    const oldContent = findElement(view.container, '[data-testid="list-content"]');
    await finishLayout(view.container);
    await view.update({ threadRef: threadRef("child-2") });
    await finishLayout(view.container);
    await act(() => {
      oldContent.style.opacity = "1";
    });
    expect(isReady(view.container)).toBe(false);
    await act(() => {
      findElement(view.container, '[data-testid="list-content"]').style.opacity = "1";
    });
    await flushContentFrames();
    expect(isReady(view.container)).toBe(true);
  });

  it("waits for a content resize and scroll adjustment to settle before revealing", async () => {
    state.projection = { text: "response with code" };
    state.status = "cached";
    state.codePending = true;
    const view = await renderPanel("sidebar");
    const scroller = findElement(view.container, '[data-testid="list-content"]');
    let contentHeight = 800;
    Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight });
    await finishLayout(view.container);
    await act(() => {
      findElement(view.container, "[data-markdown-code-pending]").remove();
    });
    await flushFrame();
    expect(isReady(view.container)).toBe(false);
    contentHeight = 900;
    scroller.scrollTop = 100;
    await flushFrame();
    expect(isReady(view.container)).toBe(false);
    await flushFrame();
    expect(isReady(view.container)).toBe(true);
    expect(resizeChecks.size).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("resumes the readiness check when the viewport receives its initial size", async () => {
    state.projection = { text: "response" };
    state.status = "cached";
    const view = await renderPanel("sidebar");
    const viewport = findElement(view.container, '[data-testid="timeline"]').parentElement!;
    viewport.setAttribute("data-zero-height", "");
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    viewport.removeAttribute("data-zero-height");
    await act(() => resizeChecks.forEach((callback) => callback()));
    await flushContentFrames();
    expect(isReady(view.container)).toBe(true);
  });

  it("keeps the overlay mounted until its exit animation completes", async () => {
    state.projection = { text: "child response" };
    state.status = "cached";
    const onClosed = vi.fn();
    const view = await renderPanel("overlay", { onClosed });
    await finishLayout(view.container);
    await view.update({ closing: true });
    expect(isReady(view.container)).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
    const event = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: "subagent-conversation-exit" });
    await act(() => {
      findElement(view.container, ".subagent-conversation-overlay-content").dispatchEvent(event);
    });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("makes a load failure ready so the sidebar can show the error and back action", async () => {
    const onReadyChange = vi.fn();
    const view = await renderPanel("sidebar", { onReadyChange, onBack: () => undefined });
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    state.error = Option.some("Could not load this conversation.");
    await view.update();
    expect(onReadyChange).toHaveBeenLastCalledWith(true);
    expect(isReady(view.container)).toBe(true);
    expect(findElement(view.container, '[role="status"]').textContent).toContain(
      "Could not load this conversation.",
    );
    expect(view.container.querySelector('[aria-label="Back to agents"]')).not.toBeNull();
  });
});
