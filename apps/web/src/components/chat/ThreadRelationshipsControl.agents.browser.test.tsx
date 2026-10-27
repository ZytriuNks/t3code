import {
  EnvironmentId,
  ThreadId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type OrchestrationV2ContextTransfer,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useNavigate } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import "~/index.css";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  navigate: vi.fn(),
  shells: [] as unknown[],
  archived: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  command: vi.fn(),
  workflowCommand: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@tanstack/react-router", { spy: true });
vi.mock("../../state/entities", () => ({
  useThreadProjection: (ref: { threadId: string } | null) => {
    const projection = state.projection as { thread: { id: string } } | null;
    return { projection: ref && projection?.thread.id === ref.threadId ? projection : null };
  },
  useThreadRelationshipShells: (ref: { environmentId: string }) =>
    (state.shells as { environmentId: string; source: unknown }[])
      .filter((shell) => shell.environmentId === ref.environmentId)
      .map((shell) => shell.source),
  useProjects: () => state.projects,
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () =>
    new Map(
      [...state.configs].map(([id, value]) => [id, (value as { providers: unknown[] }).providers]),
    ),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: state.archived }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "stop-workflow" ? state.workflowCommand : state.command,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    mergeBack: { label: "merge" },
    stopSession: { label: "detach" },
    interruptTurn: { label: "interrupt" },
  },
}));
vi.mock("../../state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  return {
    orchestrationEnvironment: {
      stopWorkflow: { label: "stop-workflow", permissionAtom: () => granted },
    },
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
function setup() {
  vi.mocked(useNavigate).mockReturnValue(state.navigate);
  state.projection = null;
  state.shells = [];
  state.archived = [];
  state.projects = [];
  state.configs.clear();
  state.navigate.mockReset();
  state.command.mockReset().mockResolvedValue({ _tag: "Success" });
  state.workflowCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockReset();
}
const panel = (
  thread = "parent",
  environment = "test",
  onOpenThread?: (threadId: ThreadId) => void,
) => (
  <ThreadRelationshipsPanel
    environmentId={EnvironmentId.make(environment)}
    threadId={ThreadId.make(thread)}
    onOpenThread={onOpenThread}
  />
);

it("opens child previews while retaining the parent conversation route", async () => {
  setup();
  const environmentId = EnvironmentId.make("remote");
  const parent = {
    id: ThreadId.make("parent"),
    title: "Parent",
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const child = {
    id: ThreadId.make("child"),
    title: "Worker",
    lineage: { parentThreadId: parent.id, relationshipToParent: "subagent" },
  };
  state.shells = [parent, child].map((source) => ({ environmentId, source }));
  state.projection = {
    thread: parent,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "agent",
        childThreadId: child.id,
        threadId: parent.id,
        title: "Worker",
        prompt: "Review",
        status: "running",
        driver: "codex",
        origin: "provider_native",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-10-16T01:00:00Z"),
      },
    ],
  };
  const open = vi.fn();

  await using screen = await render(panel("parent", "remote", open));
  await screen.getByRole("button", { name: /Worker/ }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith(child.id);
  expect(state.navigate).not.toHaveBeenCalled();
  state.projection = {
    thread: child,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  await screen.rerender(panel("child", "remote"));
  await screen.getByRole("button", { name: /Parent/ }).click();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: parent.id },
  });
});

it("opens an archived child and disables a deleted child despite a stale archive snapshot", async () => {
  setup();
  const parent = {
    id: "parent",
    title: "Archived parent",
    archivedAt: DateTime.makeUnsafe("2026-10-26"),
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const child = {
    ...parent,
    id: "child",
    title: "Archived worker",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  state.archived = [{ environmentId: "remote", snapshot: { threads: [parent, child] } }];
  state.projection = {
    thread: parent,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "stale",
        threadId: "parent",
        childThreadId: "child",
        title: "Archived worker",
        status: "running",
        origin: "app_owned",
        driver: "codex",
        startedAt: DateTime.makeUnsafe("2026-10-26"),
        updatedAt: DateTime.makeUnsafe("2026-10-26"),
        completedAt: null,
      },
    ],
  };
  const open = vi.fn();
  await using screen = await render(panel("parent", "remote", open));
  await screen.getByRole("button", { name: /Archived worker/ }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith("child");
  state.shells = [
    { environmentId: "remote", source: { ...child, deletedAt: DateTime.makeUnsafe("2026-10-27") } },
  ];
  await screen.rerender(panel("parent", "remote", open));
  await expect.element(screen.getByRole("button", { name: /Archived worker/ })).toBeDisabled();
  await screen.getByRole("button", { name: /Archived worker/ }).hover();
  await expect
    .element(page.getByText("This related thread is unavailable", { exact: true }))
    .toBeVisible();
  expect(
    screen.getByRole("button", { name: /Stop|Archive|Unarchive|Delete/ }).elements(),
  ).toHaveLength(0);
  expect(open).toHaveBeenCalledTimes(1);
});

it("does not turn a fork's inherited subagent history into live child controls", async () => {
  setup();
  state.projection = {
    thread: { id: "fork", lineage: { parentThreadId: "source", relationshipToParent: "fork" } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "inherited",
        threadId: "source",
        childThreadId: "child",
        title: "Inherited worker",
        status: "running",
        origin: "app_owned",
        driver: "codex",
        startedAt: DateTime.makeUnsafe("2026-10-26"),
        updatedAt: DateTime.makeUnsafe("2026-10-26"),
        completedAt: null,
      },
    ],
  };
  state.shells = [
    {
      environmentId: "remote",
      source: {
        id: "child",
        title: "Inherited worker",
        lineage: { parentThreadId: "source", relationshipToParent: "subagent" },
      },
    },
  ];
  await using screen = await render(panel("fork", "remote"));
  expect(screen.getByRole("button", { name: /Inherited worker|Stop/ }).elements()).toHaveLength(0);
  expect(state.command).not.toHaveBeenCalled();
});

it("waits for workflow stop acknowledgement and reports a rejected stop", async () => {
  setup();
  const coordinator = {
    id: "workflow",
    threadId: "parent",
    origin: "provider_native",
    driver: "claudeAgent",
    providerInstanceId: "claude-work",
    childThreadId: "workflow-chat",
    title: "Checkout review",
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    workflow: {
      name: "Checkout review",
      phases: [{ index: 0, title: "Inspect" }],
      agents: [{ index: 0, label: "Checker", state: "running", phaseIndex: 0 }],
    },
  };
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      coordinator,
      {
        ...coordinator,
        id: "worker",
        childThreadId: "worker-chat",
        origin: "app_owned",
        title: "Worker",
        workflow: undefined,
      },
    ],
  };
  state.shells = [
    {
      environmentId: "remote",
      source: {
        id: "workflow-chat",
        title: "Coordinator chat",
        lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
        activityRunStatus: "waiting",
      },
    },
  ];

  await using screen = await render(panel("parent", "remote"));
  await screen.getByRole("button", { name: "Expand Checkout review", exact: true }).click();
  const stop = screen.getByRole("button", { name: "Stop workflow Checkout review", exact: true });
  let acknowledge!: (result: { _tag: string }) => void;
  state.workflowCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  await stop.click();
  expect(state.workflowCommand).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: { threadId: "parent", subagentId: "workflow" },
  });
  await expect.element(stop).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Stop subagent Worker", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("heading", { name: "Lineage · 2 running", exact: true }))
    .toBeVisible();
  await act(() => acknowledge({ _tag: "Success" }));
  await expect.element(stop).toBeEnabled();
  await expect
    .element(screen.getByRole("heading", { name: "Lineage · 2 running", exact: true }))
    .toBeVisible();
  state.workflowCommand.mockResolvedValueOnce({ _tag: "Failure" });
  await stop.click();
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not stop workflow",
    }),
  );
  await expect.element(stop).toBeEnabled();
  expect(state.command).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each([
  ["claudeAgent", "provider_native", "completed"],
  ["claudeAgent", "provider_native", "failed"],
  ["claudeAgent", "provider_native", "interrupted"],
  ["claudeAgent", "provider_native", "waiting"],
  ["codex", "provider_native", "running"],
  ["claudeAgent", "app_owned", "running"],
])("does not offer workflow stop for %s %s %s", async (driver, origin, status) => {
  setup();
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "workflow",
        threadId: "parent",
        driver,
        origin,
        status,
        providerInstanceId: "claude-work",
        childThreadId: "workflow-chat",
        title: "Checkout review",
        startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        workflow: { name: "Checkout review", phases: [], agents: [] },
      },
    ],
  };

  state.shells = [
    {
      environmentId: "remote",
      source: {
        id: "workflow-chat",
        title: "Coordinator chat",
        lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
      },
    },
  ];
  await using screen = await render(panel("parent", "remote"));
  const previous = screen.getByRole("button", { name: /Previous agents/ });
  if (previous.elements().length) await previous.click();
  await expect
    .element(screen.getByRole("button", { name: "Expand Checkout review", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Stop workflow Checkout review", exact: true }))
    .not.toBeInTheDocument();
  expect(state.workflowCommand).not.toHaveBeenCalled();
});

it("opens every workflow member in the correct environment and keeps manual phase expansion", async () => {
  setup();
  state.configs.set("remote", {
    providers: [
      {
        instanceId: "claude-personal",
        driver: "claudeAgent",
        displayName: "Personal account",
        models: [],
      },
      {
        instanceId: "claude-work",
        driver: "claudeAgent",
        displayName: "Work account",
        models: [{ slug: "claude-sonnet-4-6", name: "Sonnet" }],
      },
    ],
  });
  const phases = ["Inspect", "Improve", "Verify"].map((title, index) => ({ index, title }));
  const agents = Array.from({ length: 7 }, (_, index) => ({
    index,
    label: `Member ${index}`,
    state:
      index === 2 ? "cancelled" : index === 4 ? "failed" : index === 5 ? "running" : "completed",
    ...(index < 6 ? { phaseIndex: Math.floor(index / 2) } : {}),
    childThreadId: `member-chat-${index}`,
    model: "claude-sonnet-4-6",
    result: `Result ${index}`,
    totalTokens: 1200,
    // Staggered starts, so a phase spans longer than either member's own run.
    startedAt: 1_700_000_000_000 + index * 1000,
    durationMs: 5000,
  }));
  const project = (members: typeof agents) => ({
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "workflow",
        threadId: "parent",
        driver: "claudeAgent",
        providerInstanceId: "claude-work",
        childThreadId: "workflow-chat",
        title: "Checkout review",
        status: "running",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        workflow: { name: "Checkout review", phases, agents: members },
      },
    ],
  });
  state.projection = project(agents);
  // Matching IDs from another environment cannot make these chats available.
  const memberShells = agents.map((agent) => ({
    id: agent.childThreadId,
    title: agent.label,
    lineage: { parentThreadId: "workflow-chat", relationshipToParent: "subagent" },
    status: "completed",
    activityRunStatus: null,
  }));
  const coordinatorShell = {
    environmentId: "remote",
    source: {
      id: "workflow-chat",
      title: "Coordinator chat",
      lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    },
  };
  state.shells = [
    coordinatorShell,
    ...memberShells.map((source) => ({ environmentId: "other", source })),
  ];
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />
  );

  await using screen = await render(panel);
  await screen.getByRole("button", { name: "Expand Checkout review", exact: true }).click();
  const members = screen.getByRole("button", { name: /^Open Member/ });
  expect(members.elements()).toHaveLength(3);
  await screen.getByRole("button", { name: "Expand Inspect phase, done", exact: true }).click();
  await screen.getByRole("button", { name: "Expand Improve phase, stopped", exact: true }).click();
  expect(members.elements()).toHaveLength(7);
  for (const member of members.elements())
    expect((member as HTMLButtonElement).disabled).toBe(true);
  state.shells = [
    coordinatorShell,
    ...memberShells.map((source) => ({ environmentId: "remote", source })),
  ];
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />,
  );
  for (const agent of agents) {
    const button = screen.getByRole("button", { name: `Open ${agent.label} chat`, exact: true });
    await expect.element(button).toBeEnabled();
    await button.click();
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "remote", threadId: agent.childThreadId },
    });
  }
  expect(screen.container.textContent).toContain("6s");
  await screen.getByRole("button", { name: "Collapse Inspect phase, done", exact: true }).click();
  expect(members.elements()).toHaveLength(5);
  state.projection = project(
    agents.map((agent) => (agent.index === 0 ? { ...agent, state: "running" } : agent)),
  );
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />,
  );
  expect(members.elements()).toHaveLength(5);
  state.projection = project(agents);
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />,
  );
  expect(members.elements()).toHaveLength(5);
  await screen.getByRole("button", { name: "Collapse Checkout review", exact: true }).click();
  expect(members.elements()).toHaveLength(0);
  expect(state.navigate).toHaveBeenCalledTimes(7);
});

it("groups and counts workflows by the workflow status rather than coordinator activity", async () => {
  setup();
  const coordinator = {
    id: "workflow",
    threadId: "parent",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: "workflow-chat",
    title: "Checkout review",
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    progress: "Inspecting the checkout workflow",
    result: "Workflow checks complete",
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    workflow: {
      name: "Checkout review",
      phases: [{ index: 0, title: "Inspect" }],
      agents: [{ index: 0, label: "Checker", state: "running", phaseIndex: 0 }],
    },
  };
  const projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [coordinator],
  };
  const child = {
    id: "workflow-chat",
    title: "Coordinator chat",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "completed",
    activityRunStatus: null,
  };
  state.projection = projection;
  state.shells = [{ environmentId: "test", source: child }];
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );

  await using screen = await render(panel);
  await expect
    .element(screen.getByRole("heading", { name: "Lineage · 1 running", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Expand Checkout review", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Open Checker chat", exact: true }))
    .toBeInTheDocument();
  state.shells = [{ environmentId: "test", source: { ...child, activityRunStatus: "waiting" } }];
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  await expect
    .element(screen.getByRole("heading", { name: "Lineage · 1 running", exact: true }))
    .toBeVisible();
  state.projection = {
    ...projection,
    subagents: [
      {
        ...coordinator,
        status: "completed",
        completedAt: DateTime.makeUnsafe("2026-09-21T12:10:00Z"),
      },
    ],
  };
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  await expect.element(screen.getByRole("heading", { name: "Lineage", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open Checker chat", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const workflow = screen.getByRole("button", { name: /^Checkout review/ });
  await workflow.hover();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toContain(
      "Workflow checks complete",
    ),
  );
  expect(screen.container.textContent).toContain("10m");
});

it.each([
  { driver: "codex", origin: "app_owned", runId: null, canStop: true },
  { driver: "claudeAgent", origin: "app_owned", runId: null, canStop: true },
  { driver: "claudeAgent", origin: "provider_native", runId: "run-1", canStop: true },
  { driver: "claudeAgent", origin: "provider_native", runId: null, canStop: false },
])(
  "offers individual Stop for supported $origin $driver subagents with run $runId",
  async ({ driver, origin, runId, canStop }) => {
    setup();
    const parent = {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    };
    const child = {
      id: "child",
      title: "Worker",
      lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    };
    const agent = {
      id: "agent",
      childThreadId: "child",
      origin,
      threadId: "parent",
      runId,
      nativeTaskRef: { driver, nativeId: "claude-task", strength: "strong" },
      driver,
      providerInstanceId: "codex",
      title: "Worker",
      prompt: "Check the change",
      model: "gpt-5.4",
      status: "running",
      progress: null,
      result: null,
      startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    };
    state.shells = [{ environmentId: "test", source: child }];
    const projection = {
      thread: parent,
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
      subagents: [agent],
    };
    state.projection = projection;

    await using screen = await render(panel());
    const stop = screen.getByRole("button", { name: "Stop subagent Worker", exact: true });
    if (!canStop) {
      await expect.element(stop).not.toBeInTheDocument();
      return;
    }
    await screen.getByRole("button", { name: /^Worker/ }).hover();
    await stop.click();
    expect(state.command).toHaveBeenCalledWith({
      environmentId: "test",
      input: { threadId: "parent", subagentId: "agent" },
    });
    expect(state.navigate).not.toHaveBeenCalled();
    for (const status of ["completed", "failed", "interrupted"]) {
      state.projection = { ...projection, subagents: [{ ...agent, status }] };
      await screen.rerender(panel());
      await expect.element(stop).not.toBeInTheDocument();
    }
    state.projection = { ...projection, subagents: [{ ...agent, startedAt: null }] };
    await screen.rerender(panel());
    await expect.element(stop).not.toBeInTheDocument();
    state.projection = {
      ...projection,
      subagents: [{ ...agent, origin: "provider_native", driver: "codex" }],
    };
    await screen.rerender(panel());
    await expect.element(stop).not.toBeInTheDocument();
  },
);

it("refreshes settled child details and pages previous agents without losing the failure count", async () => {
  setup();
  const agent = {
    id: "agent-1",
    threadId: "parent",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: "child-1",
    title: "Checker",
    prompt: "Check the change",
    model: "gpt-5.4",
    status: "running",
    progress: "Running checks",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  };
  const projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      { ...agent, id: "unlinked", childThreadId: null, title: "Unlinked agent" },
      agent,
      { ...agent, id: "agent-2", childThreadId: "child-2", title: "Worker", model: "gpt-5.3" },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );

  await using screen = await render(panel);
  const text = () => screen.container.textContent!.replace(/\s+/g, " ");
  expect(text()).toContain("Lineage · 3 running");
  expect(text()).toContain("Checker");
  expect(text()).not.toContain("Unlinked agent");
  expect(text()).not.toContain("gpt-5.4");
  state.projection = {
    ...projection,
    subagents: [
      {
        ...agent,
        status: "completed",
        progress: undefined,
        result: "All checks passed",
        completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
      },
    ],
  };
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  await expect.element(screen.getByRole("button", { name: /Previous agents/ })).toBeVisible();
  expect(text()).not.toContain("Checker");
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  expect(text()).toContain("Checker");
  expect(text()).toContain("2m");
  expect(text()).not.toContain("Worker");
  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `old-agent-${index}`,
      childThreadId: `old-child-${index}`,
      status: index === 7 ? "failed" : "completed",
      title: `Old agent ${index}`,
      result: index === 7 ? "Earlier build failed" : "Done",
      completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
    })),
  };
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  expect(text()).toContain("1 failed");
  expect(text()).not.toContain("Old agent 7");
  await screen.getByRole("button", { name: "Show 2 more", exact: true }).click();
  expect(text()).toContain("Old agent 7");
});

it("shows model, effort, speed and workspace details without inventing missing native metadata", async () => {
  setup();
  const parent = {
    id: "parent",
    projectId: "main",
    worktreePath: null,
    lineage: {},
    activeProviderThreadId: null,
  };
  const child = {
    id: "child",
    projectId: "main",
    worktreePath: null as string | null,
    branch: null as string | null,
    title: "Worker",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }] as ModelSelection["options"],
    },
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  state.projects = [
    { id: "main", environmentId: "test", title: "Main", workspaceRoot: "/main" },
    {
      id: "other",
      environmentId: "elsewhere",
      title: "Wrong environment",
      workspaceRoot: "/wrong",
    },
    { id: "other", environmentId: "test", title: "Other project", workspaceRoot: "/other" },
  ];
  state.shells = [{ environmentId: "test", source: child }];
  state.configs.set("test", {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        models: [
          { slug: "gpt-5.4", name: "My GPT model", shortName: "My GPT", aliases: ["model-alias"] },
        ],
      },
    ],
  });
  const projection = {
    thread: parent,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "agent",
        threadId: "parent",
        childThreadId: "child",
        origin: "app_owned",
        driver: "codex",
        providerInstanceId: "codex",
        title: "Worker",
        prompt: "Check",
        model: "gpt-5.4",
        status: "pending",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      },
    ],
  };
  state.projection = projection;

  const tooltip = () => {
    const current = state.projection as typeof projection;
    const agent = current.subagents[0]!;
    const source = (state.shells[0] as { source: typeof child } | undefined)?.source;
    const providers = (
      state.configs.get("test") as { providers: Array<{ instanceId: string }> } | undefined
    )?.providers;
    const props = {
      ...agent,
      elapsed: null,
      parentThread: parent,
      childThread: source,
      parentProject: { workspaceRoot: "/main" },
      childProject: source
        ? state.projects.find(
            (project) =>
              (project as { id: string; environmentId: string }).id === source.projectId &&
              (project as { environmentId: string }).environmentId === "test",
          )
        : undefined,
      providers,
      provider: providers?.find((provider) => provider.instanceId === agent.providerInstanceId),
    };
    return (
      <SubagentTooltipContent
        {...(props as unknown as Parameters<typeof SubagentTooltipContent>[0])}
      />
    );
  };
  await using screen = await render(tooltip());
  const text = (visibleOnly = false) => {
    if (!visibleOnly) return screen.container.textContent!;
    const read = (node: Node): string => {
      if (
        node instanceof Element &&
        (node.classList.contains("sr-only") || node.getAttribute("aria-hidden") === "true")
      )
        return "";
      return node.nodeType === Node.TEXT_NODE
        ? node.textContent!
        : [...node.childNodes].map(read).join("");
    };
    return read(screen.container);
  };
  const rerender = async (source = child) => {
    state.shells = [{ environmentId: "test", source: structuredClone(source) }];
    await screen.rerender(tooltip());
  };
  const nativeProjection = {
    ...projection,
    subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
  };
  expect(text()).toContain("My GPT · high");
  state.projection = nativeProjection;
  await screen.rerender(tooltip());
  expect(text()).toContain("My GPT");
  expect(text()).not.toContain("My GPT · high");
  state.projection = projection;
  await screen.rerender(tooltip());
  expect(text()).not.toContain("Tokens");
  expect(text()).not.toContain("Open subagent");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("Workspace");

  for (const [model, expected] of [
    [null, "Not reported"],
    ["", "Not reported"],
    ["   ", "Not reported"],
    ["model-alias", "My GPT"],
    ["gpt-5.5", "GPT-5.5"],
    ["custom/model-v1", "custom/model-v1"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    await screen.rerender(tooltip());
    expect(text()).toContain(expected);
    if (!model?.trim() || model === "gpt-5.5" || model === "custom/model-v1") {
      expect(text()).not.toContain(" · high");
    } else {
      expect(text()).toContain(`${expected} · high`);
    }
    expect(text()).not.toContain("Unknown");
    if (!model?.trim()) expect(text()).not.toContain("My GPT");
  }

  for (const driver of [
    "codex",
    "claudeAgent",
    "cursor",
    "opencode",
    "grok",
    "antigravity",
    "pi",
    "acpRegistry",
  ]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model: null }],
    };
    await screen.rerender(tooltip());
    expect(text()).toContain("Not reported");
    expect(text()).not.toContain("My GPT");
  }

  state.projection = projection;
  for (const [options, expected] of [
    [[{ id: "effort", value: "max" }], " · max"],
    [[{ id: "reasoning", value: "low" }], " · low"],
    [[{ id: "variant", value: "high" }], " · high"],
    [[{ id: "reasoningEffort", value: "none" }], " · none"],
    [[{ id: "reasoningEffort", value: true }], ""],
    [[{ id: "serviceTier", value: "fast" }], ""],
    [[], ""],
    [undefined, ""],
  ] as const) {
    child.modelSelection.options = options;
    await rerender();
    expect(text()).toContain(`My GPT${expected}`);
    if (!expected) expect(text()).not.toContain("My GPT ·");
  }
  const speedConfig = state.configs.get("test");
  const serviceTier: ProviderOptionDescriptor = {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    currentValue: "priority",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
  };
  const fastMode: ProviderOptionDescriptor = {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
    currentValue: true,
  };
  for (const [driver, descriptor, value, iconLabel] of [
    ["codex", serviceTier, "default", ""],
    ["codex", serviceTier, "priority", "Fast mode on"],
    ["codex", serviceTier, "ultrafast", "Ultrafast mode on"],
    ["codex", serviceTier, "flex", ""],
    ["codex", serviceTier, "unknown", ""],
    [
      "codex",
      { ...serviceTier, options: serviceTier.options.filter(({ id }) => id !== "ultrafast") },
      "ultrafast",
      "",
    ],
    ["codex", serviceTier, true, ""],
    ["codex", serviceTier, undefined, ""],
    ["claudeAgent", fastMode, true, "Fast mode on"],
    ["claudeAgent", fastMode, false, ""],
    ["cursor", fastMode, true, "Fast mode on"],
    ["cursor", fastMode, false, ""],
    ["opencode", fastMode, true, "Fast mode on"],
    ["cursor", fastMode, "true", ""],
    ["cursor", serviceTier, "priority", ""],
  ] as const) {
    state.configs.set("test", {
      providers: [
        {
          instanceId: "codex",
          driver,
          models: [
            {
              slug: "gpt-5.4",
              name: "My GPT",
              capabilities: { optionDescriptors: [descriptor] },
            },
          ],
        },
      ],
    });
    child.modelSelection.options = [
      { id: "reasoningEffort", value: "high" },
      ...(value === undefined ? [] : [{ id: descriptor.id, value }]),
    ];
    await rerender();
    expect(text(true)).toContain("My GPT · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    expect(text()).toContain(`My GPT · ${iconLabel}high`);
    if (!iconLabel) expect(text()).not.toContain("mode on");
    child.modelSelection.options = child.modelSelection.options.filter(
      ({ id }) => id !== "reasoningEffort",
    );
    await rerender();
    expect(text()).not.toContain(" · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    if (iconLabel) expect(text()).toContain(iconLabel);
    else expect(text()).not.toContain("mode on");
  }
  state.configs.set("test", {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Work account",
        models: [
          {
            slug: "gpt-5.4",
            name: "My GPT",
            capabilities: { optionDescriptors: [serviceTier] },
          },
        ],
      },
      {
        instanceId: "codex_personal",
        driver: "codex",
        displayName: "Personal account",
        models: [],
      },
    ],
  });
  child.modelSelection.options = [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ];
  await rerender();
  expect(text(true)).toContain("My GPT · Work account · high");
  expect(text()).toContain("My GPT · Work account · Fast mode onhigh");
  expect(text()).not.toContain("Personal account");
  state.projection = nativeProjection;
  await screen.rerender(tooltip());
  expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
  state.projection = projection;
  for (const modelSelection of [
    { ...child.modelSelection, instanceId: "other" },
    { ...child.modelSelection, model: "gpt-5.5" },
  ]) {
    await rerender({ ...child, modelSelection });
    expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
  }
  state.shells = [];
  for (const status of ["running", "completed", "failed"] as const) {
    state.projection = {
      ...projection,
      subagents: [
        {
          ...projection.subagents[0],
          origin: "provider_native",
          status,
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "low" },
              { id: "serviceTier", value: "ultrafast" },
            ],
          },
        },
      ],
    };
    await screen.rerender(tooltip());
    expect(text()).toContain("My GPT · Work account · Ultrafast mode onlow");
    expect(text()).not.toContain(" · high");
  }
  state.projection = projection;
  state.configs.set("test", speedConfig);
  child.modelSelection.options = [{ id: "reasoningEffort", value: "high" }];
  await rerender({ ...child, modelSelection: { ...child.modelSelection, instanceId: "other" } });
  expect(text()).not.toContain("My GPT ·");
  const config = state.configs.get("test");
  state.configs.clear();
  await screen.rerender(tooltip());
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  await rerender();
  expect(text()).toContain("GPT-5.4 · high");
  state.configs.set("test", config);
  for (const model of ["custom/model-v1", "custom/model-v2"]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    await rerender({
      ...child,
      modelSelection: { ...child.modelSelection, model: "custom/model-v1" },
    });
    expect(text().includes(`${model} · high`)).toBe(model === "custom/model-v1");
  }

  state.projection = {
    ...projection,
    subagents: [
      {
        ...projection.subagents[0],
        progress: "Checking the latest changes",
        result: "Old intermediate result",
      },
    ],
  };
  await screen.rerender(tooltip());
  expect(text()).toContain("Checking the latest changes");
  expect(text()).not.toContain("Old intermediate result");
  const result = "Final checks passed. " + "More detail. ".repeat(50) + "Hidden tail";
  state.projection = {
    ...projection,
    subagents: [
      { ...projection.subagents[0], status: "failed", progress: "Stale progress", result },
    ],
  };
  await screen.rerender(tooltip());
  expect(text()).toContain("Final checks passed.");
  expect(text()).not.toContain("Stale progress");
  expect(text()).not.toContain("Hidden tail");
  expect(text()).not.toContain(result);
  state.projection = projection;

  child.worktreePath = "/main/worktrees/checker";
  await rerender();
  expect(text()).toContain("Worktree");
  expect(text()).toContain("checker");
  expect(text()).not.toContain("/main/worktrees");
  expect(text()).not.toContain("Project");

  child.branch = "fix/checker";
  await rerender();
  expect(text()).toContain("Branch");
  expect(text()).toContain("fix/checker");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("/main/worktrees");

  child.projectId = "other";
  child.worktreePath = null;
  child.branch = null;
  await rerender();
  expect(text()).toContain("Other project");
  expect(text()).toContain("Workspace");
  expect(text()).toContain("other");
  expect(text()).not.toContain("/other");
  expect(text()).not.toContain("Wrong environment");
  expect(text()).not.toContain("Worktree");

  state.shells = [];
  state.configs.clear();
  await screen.rerender(tooltip());
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Workspace");

  for (const [driver, model, expected] of [
    ["codex", "gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
    ["codex", "custom/model-v2", "custom/model-v2"],
    ["claudeAgent", "gpt-5.4", "GPT-5.4"],
    ["claudeAgent", "claude-opus-4-6", "Claude Opus 4.6"],
    ["cursor", "composer-2", "Composer 2"],
    ["grok", "grok-4-fast", "Grok 4 Fast"],
    ["antigravity", "gemini-3.8-flash-high", "Gemini 3.8 Flash High"],
    ["opencode", "anthropic/claude-sonnet-4-6", "anthropic/Claude Sonnet 4.6"],
    ["codex", null, "Not reported"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model }],
    };
    await screen.rerender(tooltip());
    expect(text()).toContain(expected);
  }
});

it("shows the parent's own status as parent and child activity change", async () => {
  setup();
  const environmentId = EnvironmentId.make("test");
  const parent = {
    id: "parent",
    title: "Parent conversation",
    status: "completed",
    activityRunStatus: "running",
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const child = {
    id: "child",
    title: "Current fork",
    status: "completed",
    lineage: { parentThreadId: "parent", relationshipToParent: "fork" },
  };
  state.projection = {
    thread: { ...child, activeProviderThreadId: null },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  const shells = (parentSource: typeof parent, childSource: typeof child) => [
    { environmentId, source: parentSource },
    { environmentId, source: childSource },
  ];
  state.shells = shells(parent, child);
  const panel = (
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={ThreadId.make("child")} />
  );

  await using screen = await render(panel);
  await expect
    .element(screen.getByRole("button", { name: "Parent conversation Running", exact: true }))
    .toBeVisible();
  state.shells = shells(
    { ...parent, activityRunStatus: "completed" },
    { ...child, status: "running" },
  );
  await screen.rerender(
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={ThreadId.make("child")} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Parent conversation Done", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Parent conversation Running", exact: true }))
    .not.toBeInTheDocument();
});

it.each(["source", "target"])(
  "shows transfer lifecycle states when viewing the %s thread",
  async (currentThreadId) => {
    setup();
    const environmentId = EnvironmentId.make("test");
    const threads = ["source", "target"].map((id) => ({
      id,
      title: `${id} conversation`,
      status: "running",
      activityRunStatus: "running",
      lineage: { parentThreadId: null, relationshipToParent: null },
    }));
    state.shells = threads.map((source) => ({ environmentId, source }));
    const labels: Record<OrchestrationV2ContextTransfer["status"], string> = {
      pending: "Queued",
      resolved_native: "Resolved (native)",
      resolved_portable: "Resolved (portable)",
      failed: "Failed",
      consumed: "Consumed",
      superseded: "Superseded",
    };
    const _panel = (
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={ThreadId.make(currentThreadId)}
      />
    );

    await using screen = await render(<div />);
    for (const [status, label] of Object.entries(labels)) {
      state.projection = {
        thread: {
          ...threads.find((thread) => thread.id === currentThreadId),
          activeProviderThreadId: null,
        },
        runs: [],
        providerThreads: [],
        providerSessions: [],
        subagents: [],
        contextTransfers: [{ sourceThreadId: "source", targetThreadId: "target", status }],
      };
      await screen.rerender(
        <ThreadRelationshipsPanel
          environmentId={environmentId}
          threadId={ThreadId.make(currentThreadId)}
        />,
      );
      const text = screen.container.textContent!;
      expect(text).toContain(
        currentThreadId === "source" ? "target conversation" : "source conversation",
      );
      expect(text).toContain(label);
      expect(text).not.toContain("Unknown");
      expect(text).not.toContain("Running");
    }
  },
);
