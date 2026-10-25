import { useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { act, render } from "../../test/render";
import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as entities from "~/state/entities";
import { useEnvironmentThread } from "~/state/threads";
import { useEnvironment, useEnvironments, useEnvironmentProviders } from "~/state/environments";
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
import { PopoverCreateHandle as createPopoverHandle } from "./ui/popover";
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

vi.mock("~/state/entities", { spy: true });

vi.mock("@tanstack/react-router", { spy: true });
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

vi.mock("~/state/threads", { spy: true });
vi.mock("~/state/environments", { spy: true });
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
    const [buffer] = useState(createInlineBufferPlugin);
    const plugin = buffer.configure(
      props.smoothStreaming && Boolean(state.projection?.streaming) && props.isWorking,
    );
    useLayoutEffect(() => buffer.commit());
    return (
      <div
        data-testid="timeline"
        data-timeline-empty={props.timelineEntries?.length ? undefined : "true"}
        style={{ height: "100%" }}
      >
        <div
          data-testid="list-content"
          style={{ opacity: state.listHidden ? 0 : 1, height: "100%", overflow: "auto" }}
          ref={(element) => {
            if (props.listRef)
              props.listRef.current =
                element === null ? null : { getScrollableNode: () => element };
          }}
        >
          {props.timelineEntries?.length ? (
            <div data-timeline-root="true" style={{ minHeight: 1200 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm, ...(plugin ? [plugin] : [])]}>
                {props.timelineEntries[0]?.text}
              </ReactMarkdown>
              {state.codePending ? (
                <pre
                  data-markdown-code-pending=""
                  style={{ marginTop: state.codeOffscreen ? 900 : undefined }}
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

import { SubagentConversationPanel } from "./SubagentConversationPanel";
function setup() {
  const entityMocks = {
    useThreadShells: () => state.shells,
    useThreadRelationshipShells: (ref: ScopedThreadRef) =>
      state.shells
        .filter((shell) => shell.environmentId === ref.environmentId)
        .map((shell) => shell.source),
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
  };
  for (const key of Object.keys(entityMocks) as Array<keyof typeof entityMocks>) {
    vi.mocked(entities[key]).mockImplementation(entityMocks[key] as never);
  }

  vi.mocked(useEnvironmentThread).mockImplementation(
    () => ({ status: state.status, error: state.error }) as never,
  );
  vi.mocked(useEnvironment).mockReturnValue(null);
  vi.mocked(useEnvironments).mockReturnValue({ environments: [] } as never);
  vi.mocked(useEnvironmentProviders).mockImplementation(() => new Map());
  state.projection = null;
  state.shells = [];
  state.parentProjection = null;
  state.status = "synchronizing";
  state.error = Option.none();
  state.listHidden = false;
  state.codePending = false;
  state.codeOffscreen = false;
  state.activity = null;
  const panels = useRightPanelStore.getState().byThreadKey;
  return {
    [Symbol.dispose]() {
      useRightPanelStore.setState({ byThreadKey: panels });
    },
  };
}
function sizedContainer() {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;width:360px;height:500px;position:relative";
  return container;
}

const environmentId = EnvironmentId.make("environment-test");
function threadRef(id: string): ScopedThreadRef {
  return { environmentId, threadId: ThreadId.make(id) };
}

type Props = ComponentProps<typeof SubagentConversationPanel>;
async function renderPanel(mode: "overlay" | "sidebar", props: Partial<Props> = {}) {
  await using stack = new AsyncDisposableStack();
  const node = (next: Partial<Props> = {}) => (
    <SubagentConversationPanel
      threadRef={threadRef("child-1")}
      mode={mode}
      onClose={() => undefined}
      {...props}
      {...next}
    />
  );
  const screen = stack.use(await render(node(), { container: sizedContainer() }));
  const owned = stack.move();
  return {
    ...screen,
    update: (next: Partial<Props> = {}) => screen.rerender(node(next)),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
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
}
async function expectReady(container: HTMLElement) {
  await vi.waitFor(() => expect(isReady(container)).toBe(true));
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
      using _fixture = setup();
      state.status = "live";
      state.projection = nativeProjection([rootTurn({ status: "pending", startedAt: null })]);
      await using view = await renderPanel("sidebar");
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
      using _fixture = setup();
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
      await using view = await renderPanel("overlay");
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
      using _fixture = setup();
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
      await using view = await renderPanel("sidebar");
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
      using _fixture = setup();
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
      await using view = await renderPanel("sidebar");
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
    using _fixture = setup();
    state.projection = nativeProjection();
    await using view = await renderPanel("sidebar");
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
    using _fixture = setup();
    state.projection = nativeProjection();
    await using view = await renderPanel("sidebar");
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
    using _fixture = setup();
    state.projection = {
      ...nativeProjection(),
      thread: { ...nativeProjection().thread, lineage: v2Projection.thread.lineage },
    };
    await using view = await renderPanel("sidebar");
    expect(markdownBody(view.container)).toBe(partialLink);
    expect(state.activity).toMatchObject({ isWorking: false, runlessWorkActive: false });
  });

  it("keeps provider-native waiting work active without inventing an app run", async () => {
    using _fixture = setup();
    state.projection = nativeProjection([rootTurn({ status: "waiting" })]);
    await using view = await renderPanel("sidebar");
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
      using _fixture = setup();
      state.projection = {
        ...nativeProjection(),
        thread: { ...nativeProjection().thread, creationSource },
      };
      await using view = await renderPanel("sidebar");
      expect(markdownBody(view.container)).toBe(partialLink);
      expect(state.activity).toMatchObject({ isWorking: false, runlessWorkActive: false });
    },
  );
});

describe("subagent live follow", () => {
  it("re-arms when the first scroll after detaching reaches the end", async () => {
    using _fixture = setup();
    state.status = "live";
    state.projection = nativeProjection();
    await using view = await renderPanel("sidebar");
    const scroller = findElement(view.container, "[data-testid='list-content']");
    scroller.scrollTop = 100;
    await act(() => state.activity?.onManualNavigation?.(-1));
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event("scroll"));
    await act(() => state.activity?.onIsAtEndChange?.(true));
    expect(state.activity?.liveFollowEnabled).toBe(true);
  });

  it("does not re-arm when only an embedded code scroller moves down", async () => {
    using _fixture = setup();
    state.status = "live";
    state.projection = nativeProjection();
    await using view = await renderPanel("sidebar");
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
    using _fixture = setup();
    state.status = "live";
    state.projection = nativeProjection();
    await using view = await renderPanel("sidebar");
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
      using _fixture = setup();
      await using view = await renderPanel(mode);
      expect(isReady(view.container)).toBe(false);
      expect(view.container.querySelector('[data-testid="timeline"]')).toBeNull();
      state.projection = { text: "first response" };
      state.status = "cached";
      await view.update();
      expect(isReady(view.container)).toBe(false);
      await finishLayout(view.container);
      await expectReady(view.container);
      expect(view.container.textContent).toContain("first response");
    },
  );

  it.each(["overlay", "sidebar"] as const)(
    "waits for the %s list's opacity gate to open after layout",
    async (mode) => {
      using _fixture = setup();
      state.projection = { text: "cold response" };
      state.status = "cached";
      state.listHidden = true;
      await using view = await renderPanel(mode);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(false);
      await act(() => {
        findElement(view.container, '[data-testid="list-content"]').style.opacity = "1";
      });
      await expectReady(view.container);
      expect(view.container.textContent).toContain("cold response");
    },
  );

  it.each(["overlay", "sidebar"] as const)(
    "waits for visible code in the %s pane but does not hide later streaming updates",
    async (mode) => {
      using _fixture = setup();
      state.projection = { text: "response with code" };
      state.status = "cached";
      state.codePending = true;
      await using view = await renderPanel(mode);
      await finishLayout(view.container);
      expect(isReady(view.container)).toBe(false);
      await act(() => {
        findElement(view.container, "[data-markdown-code-pending]").remove();
      });
      await expectReady(view.container);
      await act(() => {
        const pending = document.createElement("pre");
        pending.setAttribute("data-markdown-code-pending", "");
        findElement(view.container, "[data-timeline-root]").append(pending);
      });
      await expectReady(view.container);
    },
  );

  it("does not wait for code below the first viewport", async () => {
    using _fixture = setup();
    state.projection = { text: "visible paragraph" };
    state.status = "cached";
    state.codePending = true;
    state.codeOffscreen = true;
    await using view = await renderPanel("sidebar");
    await finishLayout(view.container);
    await expectReady(view.container);
  });

  it("waits for a populated list to commit its first row after onLoad", async () => {
    using _fixture = setup();
    state.projection = { text: "first row" };
    state.status = "cached";
    await using view = await renderPanel("sidebar");
    const content = findElement(view.container, '[data-testid="list-content"]');
    const row = findElement(content, "[data-timeline-root]");
    await act(() => row.remove());
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    await act(() => {
      content.append(row);
    });
    await expectReady(view.container);
  });

  it("does not treat an empty cached snapshot as a finished first load", async () => {
    using _fixture = setup();
    state.projection = { text: "" };
    state.status = "cached";
    await using view = await renderPanel("sidebar");
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    state.status = "live";
    await view.update();
    await expectReady(view.container);
    expect(view.container.textContent).toContain("Send a message to start the conversation.");
  });

  it.each(["overlay", "sidebar"] as const)(
    "keeps a ready %s pane visible during streaming and resets for a new child",
    async (mode) => {
      using _fixture = setup();
      state.projection = { text: "first response" };
      state.status = "cached";
      await using view = await renderPanel(mode);
      await finishLayout(view.container);
      await expectReady(view.container);
      state.projection = { text: "streamed response" };
      await view.update();
      await expectReady(view.container);
      expect(view.container.textContent).toContain("streamed response");
      await view.update({ threadRef: threadRef("child-2") });
      expect(isReady(view.container)).toBe(false);
      await finishLayout(view.container);
      await expectReady(view.container);
    },
  );

  it("disconnects the old content observer when switching children during the first load", async () => {
    using _fixture = setup();
    state.projection = { text: "first response" };
    state.status = "cached";
    state.listHidden = true;
    await using view = await renderPanel("sidebar");
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
    await expectReady(view.container);
  });

  it("reveals after pending code and its content resize have settled", async () => {
    using _fixture = setup();
    state.projection = { text: "response with code" };
    state.status = "cached";
    state.codePending = true;
    await using view = await renderPanel("sidebar");
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    await act(() => {
      findElement(view.container, "[data-markdown-code-pending]").remove();
      findElement(view.container, "[data-timeline-root]").style.minHeight = "1400px";
      findElement(view.container, '[data-testid="list-content"]').scrollTop = 100;
    });
    await expectReady(view.container);
  });

  it("resumes readiness when a hidden viewport receives its initial size", async () => {
    using _fixture = setup();
    state.projection = { text: "response" };
    state.status = "cached";
    await using view = await renderPanel("sidebar");
    const viewport = findElement(view.container, '[data-testid="timeline"]').parentElement!;
    viewport.style.display = "none";
    await finishLayout(view.container);
    expect(isReady(view.container)).toBe(false);
    await act(() => {
      viewport.style.display = "";
    });
    await expectReady(view.container);
  });

  it("does not report readiness after unmounting a panel with pending content", async () => {
    using _fixture = setup();
    state.projection = { text: "child response" };
    state.status = "cached";
    state.codePending = true;
    const onReadyChange = vi.fn();
    await using view = await renderPanel("sidebar", { onReadyChange });
    await finishLayout(view.container);
    const pending = findElement(view.container, "[data-markdown-code-pending]");
    await view.unmount();
    await act(() => pending.remove());
    expect(onReadyChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps the overlay mounted until its exit animation completes", async () => {
    using _fixture = setup();
    state.projection = { text: "child response" };
    state.status = "cached";
    const onClosed = vi.fn();
    await using view = await renderPanel("overlay", { onClosed });
    await finishLayout(view.container);
    await view.update({ closing: true });
    expect(isReady(view.container)).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
    const event = new AnimationEvent("animationend", {
      bubbles: true,
      animationName: "subagent-conversation-exit",
    });
    await act(() => {
      findElement(view.container, "[data-subagent-overlay-content]").dispatchEvent(event);
    });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("makes a load failure ready so the sidebar can show the error and back action", async () => {
    using _fixture = setup();
    const onReadyChange = vi.fn();
    await using view = await renderPanel("sidebar", { onReadyChange, onBack: () => undefined });
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    state.error = Option.some("Could not load this conversation.");
    await view.update();
    expect(onReadyChange).toHaveBeenLastCalledWith(true);
    await expectReady(view.container);
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
  await using stack = new AsyncDisposableStack();
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
          handle={createPopoverHandle()}
          onPresentationChange={() => {}}
          environmentId={environmentId}
          threadId={threadRef(ownerId).threadId}
          projectId={v2Projection.thread.projectId}
          worktreePath={null}
          isServerThread
          openInShortcutEnabled={false}
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
  const screen = stack.use(
    await render(<Entry ownerId="parent" />, { container: sizedContainer() }),
  );
  const { container } = screen;
  const update = (ownerId = "parent") => screen.rerender(<Entry ownerId={ownerId} />);
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
  const owned = stack.move();
  return { container, update, open, onNavigate, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

describe("subagent entry integration with the real conversation panel", () => {
  it("opens direct children as a preview, waits for real readiness, and closes after the exit", async () => {
    using _fixture = setup();
    prepareChild();
    await using view = await renderOverlayEntry();
    await view.open();
    expect(view.onNavigate).not.toHaveBeenCalled();
    expect(isReady(view.container)).toBe(false);
    expect(markdownBody(view.container)).toBe("Read label");
    await finishLayout(view.container);
    await expectReady(view.container);
    await act(() =>
      findElement(view.container, '[aria-label="Close subagent conversation"]').click(),
    );
    expect(isReady(view.container)).toBe(false);
    expect(
      findElement(view.container, "[data-subagent-conversation-panel]").getAttribute(
        "data-subagent-panel-closing",
      ),
    ).toBe("true");
    const event = new AnimationEvent("animationend", {
      bubbles: true,
      animationName: "subagent-conversation-exit",
    });
    await act(() =>
      findElement(view.container, "[data-subagent-overlay-content]").dispatchEvent(event),
    );
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
  });

  it("maximizes the preview to the exact environment-scoped child route", async () => {
    using _fixture = setup();
    prepareChild();
    await using view = await renderOverlayEntry();
    await view.open();
    await finishLayout(view.container);
    await act(() =>
      findElement(view.container, '[aria-label="Open subagent conversation"]').click(),
    );
    expect(view.onNavigate).toHaveBeenCalledExactlyOnceWith(threadRef("child-1"));
    expect(view.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
  });

  it("keeps parent navigation a full route and clears preview state on owner switches", async () => {
    using _fixture = setup();
    prepareChild();
    await using view = await renderOverlayEntry();
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
    using _fixture = setup();
    prepareChild();
    await using view = await renderOverlayEntry();
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
    using _fixture = setup();
    const parent = prepareChild();
    const onOpenThread = vi.fn();
    await using screen = await render(
      <ThreadAgentsPanel
        environmentId={environmentId}
        threadId={parent.id}
        projection={parentProjection()}
        shell={parent}
        onOpenThread={onOpenThread}
      />,
      { container: sizedContainer() },
    );
    const { container } = screen;
    const roster = findElement(container, "[aria-busy]").lastElementChild as HTMLElement;
    const open = () => findElement(roster, "button").click();
    await act(open);
    expect(roster.hidden).toBe(false);
    expect(markdownBody(container)).toBe("Read label");
    await finishLayout(container);
    await expectReady(container);
    expect(roster.hidden).toBe(true);
    await act(() => findElement(container, '[aria-label="Back to agents"]').click());
    expect(roster.hidden).toBe(false);
    expect(container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    await act(open);
    await finishLayout(container);
    await expectReady(container);
    await act(() => findElement(container, '[aria-label="Open subagent conversation"]').click());
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(threadRef("child-1"));
  });

  it("launches the actual Agents surface, opens its real child panel, and closes back to the launcher", async () => {
    using _fixture = setup();
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
    await using screen = await render(<Entry />, { container: sizedContainer() });
    const { container } = screen;
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
    await expectReady(container);
    expect(roster.hidden).toBe(true);
    await act(() => findElement(container, 'button[aria-label="Close Agents"]').click());
    expect(container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
    expect(container.textContent).toContain("Open a surface");
  });
});
