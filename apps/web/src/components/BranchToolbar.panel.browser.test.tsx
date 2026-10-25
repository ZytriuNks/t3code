import { ensureLocalApi } from "../localApi";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  language: "en",
  worktreePath: "/tmp/worktree" as string | null,
  showContextMenu: vi.fn().mockResolvedValue("copy-path"),
  writeTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("../hooks/useSettings", async (original) => {
  const actual = await original<typeof import("../hooks/useSettings")>();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  return {
    ...actual,
    useClientSettings: <T,>(select: (settings: Settings) => T) =>
      select({ ...actual.getClientSettings(), language: state.language as Settings["language"] }),
  };
});

vi.mock("../hooks/useCopyToClipboard", async (original) => ({
  ...(await original<typeof import("../hooks/useCopyToClipboard")>()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock("./BranchToolbarBranchSelector", () => ({ BranchToolbarBranchSelector: () => null }));

vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useThreadShell: () => ({
    environmentId: "local",
    projectId: "project",
    worktreePath: state.worktreePath,
  }),
  useProject: () => ({ workspaceRoot: "/tmp/project" }),
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock("../hooks/useAddProjectTargets", () => ({ useAddProjectTargets: () => [] }));

import { BranchToolbar } from "./BranchToolbar";
import { I18nProvider } from "../i18n/I18nProvider";

it("switches the current combined workspace menu language and keeps workspace selection", async () => {
  state.worktreePath = null;
  const container = document.createElement("div");
  document.body.append(container);
  using _menu = vi
    .spyOn(ensureLocalApi().contextMenu, "show")
    .mockImplementation(state.showContextMenu);
  await using root = await render(null, { container });
  state.language = "en";
  const onChange = vi.fn();
  const show = () =>
    act(() =>
      root.rerender(
        <I18nProvider>
          <BranchToolbar
            layout="panel"
            panelSection="workspace"
            environmentId={EnvironmentId.make("local")}
            threadId={ThreadId.make("thread")}
            projectId={ProjectId.make("project")}
            worktreePath={state.worktreePath}
            isServerThread={false}
            showGitControls
            envMode="local"
            envLocked={false}
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onEnvModeChange={onChange}
          />
        </I18nProvider>,
      ),
    );
  try {
    await show();
    await act(() => container.querySelector("button")!.click());
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Workspace");
    state.language = "zh-CN";
    await show();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("工作区");
    const worktree = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent === "新工作树",
    );
    expect(worktree).toBeDefined();
    await act(() => worktree!.click());
    expect(onChange).toHaveBeenCalledWith("worktree");
  } finally {
    await act(() => root.unmount());
    container.remove();
    state.language = "en";
    state.worktreePath = "/tmp/worktree";
  }
});

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  using _menu = vi
    .spyOn(ensureLocalApi().contextMenu, "show")
    .mockImplementation(state.showContextMenu);
  await using root = await render(null, { container });
  state.language = "en";
  const onEnvironmentChange = vi.fn();
  try {
    await act(async () => {
      await root.rerender(
        <BranchToolbar
          layout="panel"
          panelSection="workspace"
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          projectId={ProjectId.make("project")}
          worktreePath={state.worktreePath}
          isServerThread={true}
          showGitControls
          envMode="local"
          envLocked={false}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
          onEnvironmentChange={onEnvironmentChange}
          availableEnvironments={["local", "remote"].map((id) => ({
            environmentId: EnvironmentId.make(id),
            projectId: ProjectId.make("project"),
            label: id,
            isPrimary: id === "local",
            machine: "server",
          }))}
        />,
      );
    });
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe("local");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => trigger.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(
      items.find((item) => item.textContent === "New worktree")?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => items.find((item) => item.textContent === "remote")!.click());
    expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    state.worktreePath = worktreePath;
    state.showContextMenu.mockClear();
    state.writeTextToClipboard.mockClear();
    const container = document.createElement("div");
    document.body.append(container);
    using _menu = vi
      .spyOn(ensureLocalApi().contextMenu, "show")
      .mockImplementation(state.showContextMenu);
    await using root = await render(null, { container });
    state.language = "en";
    try {
      await act(async () => {
        await root.rerender(
          <BranchToolbar
            layout="panel"
            panelSection="workspace"
            environmentId={EnvironmentId.make("local")}
            threadId={ThreadId.make("thread")}
            projectId={ProjectId.make("project")}
            worktreePath={state.worktreePath}
            isServerThread={false}
            showGitControls
            envMode={envMode}
            envLocked={false}
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onEnvModeChange={vi.fn()}
          />,
        );
      });
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => {
        container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(copiedPath !== null);
      if (copiedPath === null) {
        expect(state.showContextMenu).not.toHaveBeenCalled();
        expect(state.writeTextToClipboard).not.toHaveBeenCalled();
      } else {
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.worktreePath = "/tmp/worktree";
    }
  },
);
