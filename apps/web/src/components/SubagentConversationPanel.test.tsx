// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  projection: null as { text: string } | null,
  status: "synchronizing" as "cached" | "synchronizing" | "live" | "deleted",
  error: { _tag: "None" } as unknown,
  listHidden: false,
  codePending: false,
  codeOffscreen: false,
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
    ref === null || state.projection === null ? null : { projection: state.projection },
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
  useEnvironmentSettings: () => ({ timestampFormat: "locale" }),
}));

vi.mock("@t3tools/client-runtime/state/thread-execution", () => ({
  deriveThreadActivityRun: () => null,
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
  MessagesTimeline: (props: {
    onInitialLayout?: () => void;
    timelineEntries?: Array<{ text?: string }>;
    listRef?: { current: { getScrollableNode: () => HTMLElement } | null };
  }) => (
    <div
      data-testid="timeline"
      data-timeline-empty={props.timelineEntries?.length ? undefined : "true"}
    >
      <div
        data-testid="list-content"
        style={{ opacity: state.listHidden ? 0 : 1 }}
        ref={(element) => {
          if (props.listRef)
            props.listRef.current = element === null ? null : { getScrollableNode: () => element };
        }}
      >
        {props.timelineEntries?.length ? (
          <div data-timeline-root="true">
            <span>{props.timelineEntries[0]?.text}</span>
            {state.codePending ? (
              <pre data-markdown-code-pending="" data-offscreen={state.codeOffscreen || undefined}>
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
  ),
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
