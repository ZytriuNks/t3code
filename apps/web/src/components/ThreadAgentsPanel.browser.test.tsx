import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ThreadId,
  NodeId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { act, render } from "../../test/render";
import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "~/test-fixtures";

import { ThreadAgentsPanel } from "./ThreadAgentsPanel";

const state = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<EnvironmentThreadShell>,
  readiness: new Map<string, (ready: boolean) => void>(),
}));

vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useThreadShells: () => state.shells,
}));

vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironmentProviders: () => new Map(),
}));

vi.mock("./SubagentConversationPanel", () => ({
  SubagentConversationPanel: (props: {
    threadRef: { threadId: string };
    onBack?: () => void;
    onReadyChange?: (ready: boolean) => void;
  }) => {
    if (props.onReadyChange) state.readiness.set(props.threadRef.threadId, props.onReadyChange);
    return (
      <div data-subagent-conversation-panel="sidebar">
        <p>Conversation {props.threadRef.threadId}</p>
        <button onClick={props.onBack}>Back</button>
      </div>
    );
  },
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

function setup() {
  state.shells = [];
  state.readiness.clear();
  return {
    environmentId,
    threadId,
    projection: projectionWithSubagent(),
    shell: shellWithTasks([]),
    onOpenThread: vi.fn(),
  };
}
const childShell = (id = childThreadId) =>
  makeThreadFixture({ id, environmentId, title: "Review child" });
const roster = (container: HTMLElement) =>
  container.querySelector<HTMLDivElement>("[hidden], [aria-busy] > div:last-child")!;
const ready = async (id: string) => act(() => state.readiness.get(id)!(true));

describe("ThreadAgentsPanel", () => {
  it("renders subagents and pending background tasks and opens a child in the panel", async () => {
    const props = setup();
    state.shells = [childShell()];
    await using screen = await render(
      <ThreadAgentsPanel
        {...props}
        shell={shellWithTasks([{ taskId: "bg-1", description: "Run tests" }])}
      />,
    );
    await expect.element(screen.getByRole("heading", { name: "Subagents" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Background tasks" })).toBeVisible();
    expect(screen.container.querySelectorAll("button")).toHaveLength(2);
    await screen.getByRole("button", { name: /review/ }).click();
    expect(screen.container.querySelector("[data-subagent-conversation-panel]")).not.toBeNull();
    expect(props.onOpenThread).not.toHaveBeenCalled();
  });
  it.each(["subagent", "background"] as const)(
    "keeps the list visible until the %s conversation is ready, then switches the pane",
    async (kind) => {
      const props = setup();
      state.shells = [childShell()];
      await using screen = await render(
        <ThreadAgentsPanel
          {...props}
          projection={kind === "subagent" ? props.projection : null}
          shell={shellWithTasks(kind === "background" ? [{ taskId: "bg-1" }] : [])}
        />,
      );
      const originalRoster = roster(screen.container);
      await screen.getByRole("button").click();
      expect(roster(screen.container)).toBe(originalRoster);
      expect(originalRoster.hidden).toBe(false);
      const layer = screen.container.querySelector<HTMLDivElement>("[aria-hidden][inert]")!;
      expect(layer.getAttribute("aria-hidden")).toBe("true");
      expect(screen.container.querySelector("[aria-busy=true]")).not.toBeNull();
      await ready(kind === "subagent" ? childThreadId : threadId);
      expect(originalRoster.hidden).toBe(true);
      expect(layer.getAttribute("aria-hidden")).toBe("false");
      expect(layer.inert).toBe(false);
      expect(screen.container.querySelector("[aria-busy=false]")).not.toBeNull();
      await screen.getByRole("button", { name: "Back", exact: true }).click();
      expect(roster(screen.container)).toBe(originalRoster);
      expect(originalRoster.hidden).toBe(false);
      expect(screen.container.querySelector("[data-subagent-conversation-panel]")).toBeNull();
      await screen.getByRole("button").click();
      expect(originalRoster.hidden).toBe(false);
    },
  );
  it("ignores readiness from a replaced selection while the next child is loading", async () => {
    const props = setup();
    const secondChildId = ThreadId.make("thread-child-2");
    state.shells = [childShell(), childShell(secondChildId)];
    const projection = {
      ...props.projection,
      subagents: [
        ...props.projection.subagents,
        {
          ...props.projection.subagents[0]!,
          id: NodeId.make("agent-2"),
          title: "Second",
          childThreadId: secondChildId,
        },
      ],
    };
    await using screen = await render(<ThreadAgentsPanel {...props} projection={projection} />);
    await screen.getByRole("button", { name: /review/ }).click();
    const firstReady = state.readiness.get(childThreadId)!;
    await screen.getByRole("button", { name: /Second/ }).click();
    expect(
      screen.container.querySelector("[data-subagent-conversation-panel]")?.textContent,
    ).toContain(secondChildId);
    await act(() => firstReady(true));
    expect(roster(screen.container).hidden).toBe(false);
    await ready(secondChildId);
    expect(roster(screen.container).hidden).toBe(true);
    await act(() => firstReady(false));
    expect(roster(screen.container).hidden).toBe(true);
  });
  it("keeps a subagent row disabled when its child shell is missing", async () => {
    const props = setup();
    await using screen = await render(<ThreadAgentsPanel {...props} />);
    expect(screen.container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(1);
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  });
  it("updates child model traits without inheriting the parent model", async () => {
    const props = setup();
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
    await using screen = await render(<ThreadAgentsPanel {...props} />);
    expect(screen.getByRole("button", { name: /review/ }).element().textContent).toMatch(
      /Codex · gpt-6.1-sol.*Fast.*high.*Working/,
    );
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
    await screen.rerender(<ThreadAgentsPanel {...props} />);
    expect(screen.getByRole("button", { name: /review/ }).element().textContent).toContain("low");
    expect(screen.container.textContent).not.toContain("Fast");
  });
  it("does not duplicate a subagent's native task in the background roster", async () => {
    const props = setup();
    state.shells = [childShell()];
    const projection = {
      ...projectionWithSubagent({ nativeTaskRef: { nativeId: "native-agent" } }),
      turnItems: [
        { type: "subagent", id: "item-agent", nativeItemRef: { nativeId: "native-agent" } },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    await using screen = await render(
      <ThreadAgentsPanel
        {...props}
        projection={projection}
        shell={shellWithTasks([
          { taskId: "native-agent", description: "Duplicate agent" },
          { taskId: "command-1", description: "Run command" },
        ])}
      />,
    );
    expect(screen.container.querySelectorAll("button")).toHaveLength(2);
    await expect.element(screen.getByRole("button", { name: /Run command/ })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Duplicate agent");
  });
  it("opens background work in the panel and returns to the list", async () => {
    const props = setup();
    await using screen = await render(
      <ThreadAgentsPanel
        {...props}
        projection={null}
        shell={shellWithTasks([{ taskId: "command-1", description: "Run command" }])}
      />,
    );
    await screen.getByRole("button").click();
    await ready(threadId);
    await expect
      .element(screen.getByText("Background task · Working", { exact: true }))
      .toBeVisible();
    expect(props.onOpenThread).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Back to agents" }).click();
    await expect.element(screen.getByRole("heading", { name: "Background tasks" })).toBeVisible();
  });
  it("shows a stable empty state when no work is present", async () => {
    const props = setup();
    await using screen = await render(<ThreadAgentsPanel {...props} projection={null} />);
    await expect
      .element(screen.getByText("No agents or background tasks", { exact: true }))
      .toBeVisible();
  });
});
