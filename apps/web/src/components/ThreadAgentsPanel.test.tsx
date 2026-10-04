// @vitest-environment jsdom
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ThreadId,
  NodeId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "~/test-fixtures";

import { ThreadAgentsPanel } from "./ThreadAgentsPanel";
import { SubagentConversationPanel } from "./SubagentConversationPanel";

const state = vi.hoisted(() => ({ shells: [] as ReadonlyArray<EnvironmentThreadShell> }));

vi.mock("~/state/entities", () => ({
  useThreadShells: () => state.shells,
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => null,
}));

vi.mock("./SubagentConversationPanel", () => ({
  SubagentConversationPanel: (props: { onBack?: () => void }) => (
    <div data-subagent-conversation-panel="sidebar">
      <button type="button" onClick={props.onBack}>
        Back
      </button>
    </div>
  ),
}));

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("thread-parent");
const childThreadId = ThreadId.make("thread-child");

function projectionWithSubagent(
  overrides: Record<string, unknown> = {},
): OrchestrationV2ThreadProjection {
  return {
    subagents: [
      {
        id: "agent-1",
        childThreadId,
        title: "Subagent: review",
        prompt: "Review the changes",
        status: "running",
        model: "gpt-6",
        driver: "codex",
        ...overrides,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function shellWithTasks(
  pendingBackgroundTasks: ReadonlyArray<{ taskId: string; description?: string }>,
): EnvironmentThreadShell {
  return { pendingBackgroundTasks } as unknown as EnvironmentThreadShell;
}

function renderPanel(props: ComponentProps<typeof ThreadAgentsPanel>) {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ThreadAgentsPanel {...props} />);
  });
  return renderer!;
}

function roster(renderer: ReturnType<typeof create>) {
  return renderer.root.find((node) => node.type === "div" && "hidden" in node.props);
}

function finishConversationLayout(renderer: ReturnType<typeof create>) {
  act(() => renderer.root.findByType(SubagentConversationPanel).props.onReadyChange(true));
}

describe("ThreadAgentsPanel", () => {
  beforeEach(() => {
    state.shells = [];
  });

  it("renders subagents and pending background tasks, and opens a child in the panel", () => {
    state.shells = [
      {
        id: childThreadId,
        environmentId,
        title: "Review child",
      } as EnvironmentThreadShell,
    ];
    const onOpenThread = vi.fn();
    const renderer = renderPanel({
      environmentId,
      threadId,
      projection: projectionWithSubagent(),
      shell: shellWithTasks([{ taskId: "bg-1", description: "Run tests" }]),
      onOpenThread,
    });

    expect(renderer.root.findAllByType("button")).toHaveLength(2);
    expect(renderer.root.findAll((node) => node.children.includes("Subagents"))).not.toHaveLength(
      0,
    );
    expect(
      renderer.root.findAll((node) => node.children.includes("Background tasks")),
    ).not.toHaveLength(0);

    act(() => renderer.root.findAllByType("button")[0]?.props.onClick());
    expect(
      renderer.root.findAllByProps({ "data-subagent-conversation-panel": "sidebar" }),
    ).toHaveLength(1);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it.each(["subagent", "background"] as const)(
    "keeps the list visible until the %s conversation is ready, then switches the whole pane",
    (kind) => {
      state.shells = [
        { id: childThreadId, environmentId, title: "Review child" } as EnvironmentThreadShell,
      ];
      const renderer = renderPanel({
        environmentId,
        threadId,
        projection: kind === "subagent" ? projectionWithSubagent() : null,
        shell: shellWithTasks(kind === "background" ? [{ taskId: "bg-1" }] : []),
        onOpenThread: () => undefined,
      });
      const originalRoster = roster(renderer);
      act(() => renderer.root.findByType("button").props.onClick());

      expect(roster(renderer)).toBe(originalRoster);
      expect(originalRoster.props.hidden).toBe(false);
      expect(renderer.root.findByProps({ "aria-busy": true })).toBeDefined();
      const pendingPane = renderer.root.findByType(SubagentConversationPanel).parent!;
      const layer = kind === "background" ? pendingPane.parent! : pendingPane;
      expect(layer.props["aria-hidden"]).toBe(true);
      expect(layer.props.inert).toBe(true);

      finishConversationLayout(renderer);
      expect(originalRoster.props.hidden).toBe(true);
      expect(layer.props["aria-hidden"]).toBe(false);
      expect(layer.props.inert).toBe(false);
      expect(renderer.root.findByProps({ "aria-busy": false })).toBeDefined();

      act(() => renderer.root.findByType(SubagentConversationPanel).props.onBack());
      expect(roster(renderer)).toBe(originalRoster);
      expect(originalRoster.props.hidden).toBe(false);
      expect(renderer.root.findAllByType(SubagentConversationPanel)).toHaveLength(0);

      act(() => renderer.root.findByType("button").props.onClick());
      expect(originalRoster.props.hidden).toBe(false);
    },
  );

  it("ignores readiness from a replaced selection while the next child is loading", () => {
    const secondChildId = ThreadId.make("thread-child-2");
    state.shells = [
      { id: childThreadId, environmentId, title: "Review child" } as EnvironmentThreadShell,
      { id: secondChildId, environmentId, title: "Second child" } as EnvironmentThreadShell,
    ];
    const projection = projectionWithSubagent();
    const renderer = renderPanel({
      environmentId,
      threadId,
      projection: {
        ...projection,
        subagents: [
          ...projection.subagents,
          { ...projection.subagents[0]!, id: NodeId.make("agent-2"), childThreadId: secondChildId },
        ],
      },
      shell: shellWithTasks([]),
      onOpenThread: () => undefined,
    });
    act(() => roster(renderer).findAllByType("button")[0]!.props.onClick());
    const firstReadyChange =
      renderer.root.findByType(SubagentConversationPanel).props.onReadyChange;
    act(() => roster(renderer).findAllByType("button")[1]!.props.onClick());
    expect(renderer.root.findByType(SubagentConversationPanel).props.threadRef.threadId).toBe(
      secondChildId,
    );

    act(() => firstReadyChange(true));
    expect(roster(renderer).props.hidden).toBe(false);
    finishConversationLayout(renderer);
    expect(roster(renderer).props.hidden).toBe(true);
    act(() => firstReadyChange(false));
    expect(roster(renderer).props.hidden).toBe(true);
  });

  it("keeps a subagent row disabled when its child shell is missing", () => {
    const renderer = renderPanel({
      environmentId,
      threadId,
      projection: projectionWithSubagent(),
      shell: shellWithTasks([]),
      onOpenThread: () => undefined,
    });

    expect(renderer.root.findAllByProps({ "aria-disabled": "true" })).toHaveLength(1);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("updates the displayed traits from the child selection without inheriting the parent model", () => {
    const child = makeThreadFixture({
      id: childThreadId,
      environmentId,
      title: "Review child",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
    });
    state.shells = [child];
    const props = {
      environmentId,
      threadId,
      projection: projectionWithSubagent(),
      shell: shellWithTasks([]),
      onOpenThread: () => undefined,
    };
    const renderer = renderPanel(props);
    expect(
      renderer.root.findAll((node) => node.children.includes("Codex · gpt-6.1-sol")),
    ).not.toHaveLength(0);
    expect(renderer.root.findAll((node) => node.children.includes("high"))).not.toHaveLength(0);
    expect(renderer.root.findAll((node) => node.children.includes("Fast"))).not.toHaveLength(0);
    expect(
      renderer.root.findAll(
        (node) => node.type === "span" && node.children.join("") === "· Working",
      ),
    ).toHaveLength(1);

    state.shells = [
      {
        ...child,
        modelSelection: {
          ...child.modelSelection,
          options: [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "default" },
          ],
        },
      },
    ];
    act(() => renderer.update(<ThreadAgentsPanel {...props} />));
    expect(renderer.root.findAll((node) => node.children.includes("low"))).not.toHaveLength(0);
    expect(renderer.root.findAll((node) => node.children.includes("Fast"))).toHaveLength(0);
  });

  it("does not show a subagent twice when its native task is in the background roster", () => {
    state.shells = [
      { id: childThreadId, environmentId, title: "Review child" } as EnvironmentThreadShell,
    ];
    const projection = {
      ...projectionWithSubagent({ nativeTaskRef: { nativeId: "native-agent" } }),
      turnItems: [
        {
          type: "subagent",
          id: "item-agent",
          nativeItemRef: { nativeId: "native-agent" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const renderer = renderPanel({
      environmentId,
      threadId,
      projection,
      shell: shellWithTasks([
        { taskId: "native-agent", description: "Duplicate agent" },
        { taskId: "command-1", description: "Run command" },
      ]),
      onOpenThread: () => undefined,
    });

    expect(renderer.root.findAllByType("button")).toHaveLength(2);
    expect(renderer.root.findAll((node) => node.children.includes("Run command"))).not.toHaveLength(
      0,
    );
    expect(renderer.root.findAll((node) => node.children.includes("Duplicate agent"))).toHaveLength(
      0,
    );
  });

  it("opens background work in the panel and returns to the list", () => {
    const onOpenThread = vi.fn();
    const renderer = renderPanel({
      environmentId,
      threadId,
      projection: null,
      shell: shellWithTasks([{ taskId: "command-1", description: "Run command" }]),
      onOpenThread,
    });

    act(() => renderer.root.findByType("button").props.onClick());
    expect(
      renderer.root.findAll((node) => node.children.includes("Background task · Working")),
    ).not.toHaveLength(0);
    expect(onOpenThread).not.toHaveBeenCalled();

    act(() => renderer.root.findByProps({ "aria-label": "Back to agents" }).props.onClick());
    expect(
      renderer.root.findAll((node) => node.children.includes("Background tasks")),
    ).not.toHaveLength(0);
  });

  it("shows a stable empty state when no work is present", () => {
    const renderer = renderPanel({
      environmentId,
      threadId,
      projection: null,
      shell: shellWithTasks([]),
      onOpenThread: () => undefined,
    });

    expect(
      renderer.root.findAll((node) => node.children.includes("No agents or background tasks")),
    ).not.toHaveLength(0);
  });
});
