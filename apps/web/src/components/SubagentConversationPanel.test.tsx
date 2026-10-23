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
  ProviderDriverKind,
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
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import {
  SubagentConversationOverlay,
  useSubagentConversation,
} from "./SubagentConversationOverlay";
import { ThreadAgentsPanel } from "./ThreadAgentsPanel";
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./chat/ThreadDetailsPanel";
import { PopoverCreateHandle } from "./ui/popover";
import { RightPanelTabs } from "./RightPanelTabs";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

const v2Projection = makeThreadProjectionFixture();

const state = vi.hoisted(() => ({
  shells: [] as ReturnType<typeof makeThreadFixture>[],
  parentProjection: null as OrchestrationV2ThreadProjection | null,
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
    runlessWorkActive: boolean;
    latestRun: { runId: RunId } | null;
    liveFollowEnabled?: boolean;
    onManualNavigation?: (direction?: -1 | 1) => void;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
  } | null,
}));

vi.mock("~/state/entities", () => ({
  useThreadShells: () => state.shells,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShell: (ref: ScopedThreadRef | null) =>
    state.shells.find((shell) => shell.id === ref?.threadId) ?? {
      title: "Review child",
      projectId: "project-test",
      worktreePath: null,
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      lineage: { relationshipToParent: null, parentThreadId: null },
    },
  useThreadProjection: (ref: ScopedThreadRef | null) =>
    ref?.threadId === "parent" && state.parentProjection !== null
      ? { projection: state.parentProjection }
      : ref === null || state.projection === null
        ? null
        : { projection: { ...v2Projection, ...state.projection } },
  useThreadVisibleTurnItems: () => [],
  useThreadTextPlayback: () => null,
  useProject: () => null,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("./BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("./GitActionsControl", () => ({ default: () => null }));
vi.mock("./ProjectScriptsControl", () => ({ default: () => null }));
vi.mock("./chat/ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./chat/ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => ReactNode }) =>
    children("full"),
}));
vi.mock("~/lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("~/state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  return { orchestrationEnvironment: { stopWorkflow: { permissionAtom: () => granted } } };
});

vi.mock("~/state/threads", () => ({
  threadEnvironment: { mergeBack: {}, stopSession: {}, interruptTurn: {} },
  useEnvironmentThread: () => ({
    status: state.status,
    error: state.error,
  }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => null,
  useEnvironments: () => ({ environments: [] }),
}));

vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));

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
    runlessWorkActive: boolean;
    latestRun: { runId: RunId } | null;
    smoothStreaming: boolean;
    onInitialLayout?: () => void;
    onOpenThread?: (threadId: ThreadId) => void;
    parentThreadLink?: { threadId: ThreadId; title: string } | null;
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
        {props.parentThreadLink ? (
          <button
            data-parent-thread
            type="button"
            onClick={() => props.onOpenThread?.(props.parentThreadLink!.threadId)}
          >
            {props.parentThreadLink.title}
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock("@legendapp/list/react", () => ({
  // The panel only needs a stable ref type in this test; the list itself is mocked above.
}));

let SubagentConversationPanel: typeof import("./SubagentConversationPanel").SubagentConversationPanel;
const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
const frames = new Map<number, FrameRequestCallback>();
const resizeChecks = new Set<() => void>();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  state.projection = null;
  state.shells = [];
  state.parentProjection = null;
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
      private targets = new Set<Element>();
      private check = () =>
        this.callback(
          [...this.targets].map((target) => ({
            target,
            contentRect: target.getBoundingClientRect(),
          })) as ResizeObserverEntry[],
        );
      constructor(private callback: (entries: ResizeObserverEntry[]) => void) {}
      observe(target: Element) {
        this.targets.add(target);
        resizeChecks.add(this.check);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        if (this.targets.size === 0) resizeChecks.delete(this.check);
      }
      disconnect() {
        this.targets.clear();
        resizeChecks.delete(this.check);
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
type ExecutionNode = OrchestrationV2ThreadProjection["nodes"][number];

function rootTurn(overrides: Partial<ExecutionNode> = {}): ExecutionNode {
  return {
    id: NodeId.make("native-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("native-root"),
    kind: "root_turn",
    status: "running",
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: nativeStartedAt,
    completedAt: null,
    ...overrides,
  };
}

function nativeProjection(nodes: readonly ExecutionNode[] = [rootTurn()]) {
  return {
    text: partialLink,
    streaming: true,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("native-parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("native-parent"),
      },
      activeProviderThreadId: ProviderThreadId.make("native-child"),
    },
    nodes,
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
  it.each(["completed", "interrupted", "failed", "cancelled", "rolled_back", "idle"] as const)(
    "buffers consecutive native fragments until the turn is %s, then releases the suffix",
    async (terminalStatus) => {
      state.status = "live";
      state.projection = nativeProjection([rootTurn({ status: "pending", startedAt: null })]);
      const view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe("Read label");
      expect(state.activity).toMatchObject({
        isWorking: true,
        activeTurnInProgress: true,
        activeTurnStartedAt: null,
        runningRunId: null,
        runlessWorkActive: true,
        latestRun: null,
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
        nodes: [rootTurn({ status: terminalStatus, completedAt: nativeStartedAt })],
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
        ...nativeProjection([rootTurn({ runId })]),
        thread: v2Projection.thread,
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
      // An unrelated runless node must not turn an ordinary waiting or
      // completed app thread into provider-native work.
      if (status === "waiting" || status === "completed") {
        state.projection = { ...state.projection, nodes: [rootTurn()] };
        await view.update();
        expect(markdownBody(view.container)).toBe(partialLink);
        expect(state.activity).toMatchObject({
          isWorking: false,
          activeTurnStartedAt: DateTime.formatIso(startedAt),
          runningRunId: null,
          runlessWorkActive: false,
          latestRun: { runId },
        });
      }
    },
  );

  it.each(["pending", "running"] as const)(
    "restores %s native work without borrowing a historical app run's identity or time",
    async (status) => {
      const historicalRunId = RunId.make("historical-run");
      const before = DateTime.makeUnsafe("2026-10-16T00:00:00.000Z");
      state.projection = {
        ...nativeProjection([
          rootTurn({ status, startedAt: status === "pending" ? null : nativeStartedAt }),
        ]),
        runs: [
          {
            id: historicalRunId,
            threadId: v2Projection.thread.id,
            ordinal: 1,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("historical-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: before,
            startedAt: before,
            completedAt: before,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      };
      const view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe("Read label");
      expect(state.activity).toMatchObject({
        isWorking: true,
        activeTurnInProgress: true,
        activeTurnStartedAt: status === "pending" ? null : DateTime.formatIso(nativeStartedAt),
        runlessWorkActive: true,
        latestRun: null,
        runningRunId: null,
      });
      state.projection = {
        ...state.projection,
        nodes: [rootTurn({ status: "completed", completedAt: nativeStartedAt })],
      };
      await view.update();
      expect(markdownBody(view.container)).toBe(partialLink);
      expect(state.activity).toMatchObject({
        isWorking: false,
        runlessWorkActive: false,
        latestRun: { runId: historicalRunId },
        runningRunId: null,
      });
    },
  );

  it.each([false, true])(
    "uses the latest runless root and ignores app-owned or nested work (%s)",
    async (reverse) => {
      const unrelated = [
        rootTurn({ id: NodeId.make("app-root"), runId: RunId.make("app-run") }),
        rootTurn({
          id: NodeId.make("nested-tool"),
          kind: "tool_call",
          parentNodeId: NodeId.make("native-root"),
        }),
      ];
      const nodes = [
        rootTurn({ id: NodeId.make("older-root") }),
        rootTurn({ status: "completed", completedAt: nativeStartedAt }),
        ...(reverse ? unrelated.toReversed() : unrelated),
      ];
      state.projection = nativeProjection(nodes);
      const view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe(partialLink);
      state.projection = nativeProjection([
        ...nodes,
        rootTurn({ id: NodeId.make("current-root") }),
      ]);
      await view.update();
      expect(markdownBody(view.container)).toBe("Read label");
      // Runless root identity survives provider-session handoff or restoration.
      state.projection = {
        ...state.projection,
        thread: { ...nativeProjection().thread, activeProviderThreadId: null },
      };
      await view.update();
      expect(markdownBody(view.container)).toBe("Read label");
    },
  );

  it("does not revive a previous child's activity when switching to settled history", async () => {
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe("Read label");
    const restored = nativeProjection([
      rootTurn({ status: "completed", completedAt: nativeStartedAt }),
    ]);
    state.projection = {
      ...restored,
      thread: { ...restored.thread, id: ThreadId.make("child-2") },
      nodes: restored.nodes.map((node) => ({ ...node, threadId: ThreadId.make("child-2") })),
    };
    await view.update({ threadRef: threadRef("child-2") });
    expect(markdownBody(view.container)).toBe(partialLink);
    expect(state.activity).toMatchObject({ isWorking: false, runlessWorkActive: false });
    state.projection = nativeProjection();
    await view.update({ threadRef: threadRef("child-1") });
    expect(markdownBody(view.container)).toBe("Read label");
  });

  it("settles from the root status even when a stale provider turn still says running", async () => {
    state.projection = nativeProjection();
    const view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe("Read label");
    state.projection = {
      ...nativeProjection([rootTurn({ status: "completed", completedAt: nativeStartedAt })]),
      providerTurns: [
        {
          id: ProviderTurnId.make("stale-turn"),
          providerThreadId: ProviderThreadId.make("native-child"),
          nodeId: NodeId.make("native-root"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: nativeStartedAt,
          completedAt: null,
        },
      ],
    };
    await view.update();
    expect(markdownBody(view.container)).toBe(partialLink);
    expect(state.activity).toMatchObject({ isWorking: false, runlessWorkActive: false });
  });

  it("does not treat provider-created ordinary threads as native subagents", async () => {
    state.projection = {
      ...nativeProjection(),
      thread: { ...nativeProjection().thread, lineage: v2Projection.thread.lineage },
    };
    const view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe(partialLink);
    expect(state.activity).toMatchObject({ isWorking: false, runlessWorkActive: false });
  });

  it("keeps provider-native waiting work active without inventing an app run", async () => {
    state.projection = nativeProjection([rootTurn({ status: "waiting" })]);
    const view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe("Read label");
    expect(state.activity).toMatchObject({
      isWorking: true,
      runlessWorkActive: true,
      activeTurnStartedAt: DateTime.formatIso(nativeStartedAt),
      runningRunId: null,
      latestRun: null,
    });
  });

  it.each(["web", "mcp"] as const)(
    "does not treat %s-created threads as provider-native work",
    async (creationSource) => {
      state.projection = {
        ...nativeProjection(),
        thread: { ...nativeProjection().thread, creationSource },
      };
      const view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe(partialLink);
      expect(state.activity).toMatchObject({ isWorking: false, runlessWorkActive: false });
    },
  );
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

  it("cancels pending readiness work and resize observation on unmount", async () => {
    state.projection = { text: "child response" };
    state.status = "cached";
    const onReadyChange = vi.fn();
    const view = await renderPanel("sidebar", { onReadyChange });
    await act(() => findElement(view.container, '[data-testid="timeline"] button').click());
    expect(frames.size).toBeGreaterThan(0);
    expect(resizeChecks.size).toBeGreaterThan(0);
    const mounted = mountedRoots.pop()!;
    await act(() => mounted.root.unmount());
    mounted.container.remove();
    expect(frames.size).toBe(0);
    expect(resizeChecks.size).toBe(0);
    await flushContentFrames();
    expect(onReadyChange).toHaveBeenCalledTimes(1);
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
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
      findElement(view.container, "[data-subagent-overlay-content]").dispatchEvent(event);
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

function parentProjection(): OrchestrationV2ThreadProjection {
  return {
    ...v2Projection,
    thread: { ...v2Projection.thread, id: threadRef("parent").threadId },
    subagents: [
      {
        id: NodeId.make("child-task"),
        threadId: threadRef("parent").threadId,
        runId: null,
        parentNodeId: NodeId.make("parent-root"),
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: v2Projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: threadRef("child-1").threadId,
        nativeTaskRef: null,
        prompt: "Review",
        title: "Review child",
        model: null,
        status: "running",
        result: null,
        startedAt: nativeStartedAt,
        completedAt: null,
        updatedAt: nativeStartedAt,
      },
    ],
  };
}

function prepareChild() {
  const parent = makeThreadFixture({
    id: threadRef("parent").threadId,
    environmentId,
    title: "Parent",
  });
  const child = makeThreadFixture({
    id: threadRef("child-1").threadId,
    environmentId,
    title: "Review child",
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
    },
  });
  state.shells = [parent, child];
  state.parentProjection = parentProjection();
  state.projection = nativeProjection([rootTurn({ status: "pending", startedAt: null })]);
  state.status = "live";
  return parent;
}

async function renderOverlayEntry(onNavigate = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  function Entry({ ownerId }: { ownerId: string }) {
    const conversation = useSubagentConversation({
      owner: threadRef(ownerId),
      projection: parentProjection(),
      onNavigate,
    });
    return (
      <>
        <ThreadDetailsPanel
          anchor={{ current: null }}
          handle={PopoverCreateHandle()}
          onPresentationChange={() => {}}
          environmentId={environmentId}
          threadId={threadRef(ownerId).threadId}
          activeProjectName={undefined}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={[]}
          showOpenInPicker={false}
          gitCwd={null}
          isGitRepo={false}
          envLocked={false}
          availableEnvironments={[]}
          onEnvironmentChange={() => {}}
          onEnvModeChange={() => {}}
          envMode="local"
          startFromOrigin={false}
          onStartFromOriginChange={() => {}}
          onComposerFocusRequest={() => {}}
          onRunProjectScript={() => {}}
          onAddProjectScript={vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"]}
          onUpdateProjectScript={vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"]}
          onDeleteProjectScript={vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"]}
          onOpenThread={conversation.openRelatedThread}
        />
        <SubagentConversationOverlay conversation={conversation} composerElement={null} />
      </>
    );
  }
  const update = async (ownerId = "parent") => {
    await act(() => root.render(<Entry ownerId={ownerId} />));
  };
  await update();
  const open = async () =>
    act(() => {
      const row = [
        ...container.querySelectorAll<HTMLButtonElement>(
          "[data-thread-relationships-panel] button",
        ),
      ].find((button) => button.textContent?.includes("Review"));
      if (!row) throw new Error("Missing child lineage entry");
      row.click();
    });
  return { container, update, open, onNavigate };
}

describe("subagent entry integration with the real conversation panel", () => {
  it("opens direct children as a preview, waits for real readiness, and closes after the exit", async () => {
    prepareChild();
    const view = await renderOverlayEntry();
    // The parent lineage scrollbar stays mounted when its child preview closes.
    const parentResizeChecks = new Set(resizeChecks);
    await view.open();
    expect(view.onNavigate).not.toHaveBeenCalled();
    expect(isReady(view.container)).toBe(false);
    expect(markdownBody(view.container)).toBe("Read label");
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(true);
    await act(() =>
      findElement(view.container, '[aria-label="Close subagent conversation"]').click(),
    );
    expect(isReady(view.container)).toBe(false);
    expect(
      findElement(view.container, "[data-subagent-conversation-panel]").getAttribute(
        "data-subagent-panel-closing",
      ),
    ).toBe("true");
    const event = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: "subagent-conversation-exit" });
    await act(() =>
      findElement(view.container, "[data-subagent-overlay-content]").dispatchEvent(event),
    );
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    expect(frames.size).toBe(0);
    expect(resizeChecks).toEqual(parentResizeChecks);
  });

  it("maximizes the preview to the exact environment-scoped child route", async () => {
    prepareChild();
    const view = await renderOverlayEntry();
    await view.open();
    await finishLayout(view.container);
    await act(() =>
      findElement(view.container, '[aria-label="Open subagent conversation"]').click(),
    );
    expect(view.onNavigate).toHaveBeenCalledExactlyOnceWith(threadRef("child-1"));
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
  });

  it("keeps parent navigation a full route and clears preview state on owner switches", async () => {
    prepareChild();
    const view = await renderOverlayEntry();
    await view.open();
    await finishLayout(view.container);
    await act(() => findElement(view.container, "[data-parent-thread]").click());
    expect(view.onNavigate).toHaveBeenLastCalledWith(threadRef("parent"));
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    await view.open();
    await view.update("other-parent");
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    await view.update("parent");
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
  });

  it("closes by Escape without navigating away from the parent", async () => {
    prepareChild();
    const view = await renderOverlayEntry();
    await view.open();
    await finishLayout(view.container);
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(
      findElement(view.container, "[data-subagent-conversation-panel]").getAttribute(
        "data-subagent-panel-closing",
      ),
    ).toBe("true");
    expect(view.onNavigate).not.toHaveBeenCalled();
  });

  it("opens and returns from an Agents sidebar using real child readiness and maximization", async () => {
    const parent = prepareChild();
    const onOpenThread = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(() =>
      root.render(
        <ThreadAgentsPanel
          environmentId={environmentId}
          threadId={parent.id}
          projection={parentProjection()}
          shell={parent}
          onOpenThread={onOpenThread}
        />,
      ),
    );
    const roster = findElement(container, "[aria-busy]").lastElementChild as HTMLElement;
    const open = () => findElement(roster, "button").click();
    await act(open);
    expect(roster.hidden).toBe(false);
    expect(markdownBody(container)).toBe("Read label");
    await finishLayout(container);
    expect(roster.hidden).toBe(true);
    await act(() => findElement(container, '[aria-label="Back to agents"]').click());
    expect(roster.hidden).toBe(false);
    expect(container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    await act(open);
    await finishLayout(container);
    await act(() => findElement(container, '[aria-label="Open subagent conversation"]').click());
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(threadRef("child-1"));
  });

  it("launches the actual Agents surface, opens its real child panel, and closes back to the launcher", async () => {
    const parent = prepareChild();
    const ref = threadRef("parent");
    useRightPanelStore.setState({ byThreadKey: {} });
    function Entry() {
      const panel = useRightPanelStore((store) =>
        selectThreadRightPanelState(store.byThreadKey, ref),
      );
      const active = panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId);
      const noop = () => {};
      return (
        <RightPanelTabs
          mode="inline"
          open
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          })}
          environmentId={environmentId}
          surfaces={panel.surfaces}
          activeSurfaceId={panel.activeSurfaceId}
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map()}
          onActivate={(surface) => useRightPanelStore.getState().activateSurface(ref, surface.id)}
          onCloseSurface={(surface) => useRightPanelStore.getState().closeSurface(ref, surface.id)}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddBrowser={noop}
          onAddBrowserInProfile={noop}
          onAddTerminal={noop}
          onAddDiff={noop}
          onAddFiles={noop}
          onAddPullRequest={noop}
          onAddPullRequests={noop}
          onAddDevice={noop}
          onAddAgents={() => useRightPanelStore.getState().open(ref, "agents")}
          agentsAvailable
          browserAvailable={false}
          terminalAvailable={false}
          diffAvailable={false}
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
        >
          {active?.kind === "agents" ? (
            <ThreadAgentsPanel
              environmentId={environmentId}
              threadId={parent.id}
              projection={parentProjection()}
              shell={parent}
              onOpenThread={noop}
            />
          ) : null}
        </RightPanelTabs>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(() => root.render(<Entry />));
    const launch = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Agents"),
    );
    expect(launch).toBeDefined();
    await act(() => launch!.click());
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("agents");
    const roster = findElement(container, "[aria-busy]").lastElementChild as HTMLElement;
    await act(() => findElement(roster, "button").click());
    expect(markdownBody(container)).toBe("Read label");
    expect(isReady(container)).toBe(false);
    await finishLayout(container);
    expect(isReady(container)).toBe(true);
    expect(roster.hidden).toBe(true);
    await act(() => findElement(container, 'button[aria-label="Close Agents"]').click());
    expect(container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    expect(container.textContent).toContain("Open a surface");
  });
});
