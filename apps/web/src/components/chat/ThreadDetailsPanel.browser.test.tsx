import { EnvironmentId, ProjectId, ThreadId, type T3ProjectFileScript } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { serverEnvironment } from "../../state/server";

const testState = vi.hoisted(() => ({ useT3ProjectFileScripts: vi.fn() }));
vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("./ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./ThreadRelationshipsControl", () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock("./OpenInPicker", () => ({
  OpenInPicker: ({ onExternalOpen }: { onExternalOpen?: () => void }) => (
    <button onClick={onExternalOpen}>Accepted external open</button>
  ),
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => ReactNode }) =>
    children("full"),
}));
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

function setup() {
  testState.useT3ProjectFileScripts.mockReset().mockReturnValue([]);
  const original = useRightPanelStore.getState().threadPanelVisibilityByThreadKey;
  const configSpy = vi.spyOn(serverEnvironment, "configValueAtom").mockReturnValue(Atom.make(null));
  const props = {
    environmentId: EnvironmentId.make("details-test"),
    threadId: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    worktreePath: null,
    isServerThread: true,
    anchor: { current: null },
    handle: PopoverCreateHandle(),
    onPresentationChange: vi.fn(),
    activeProjectName: undefined,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: ["vscode"],
    showOpenInPicker: true,
    openInShortcutEnabled: true,
    gitCwd: "/workspace",
    isGitRepo: false,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
    onUpdateProjectScript: vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
    onDeleteProjectScript: vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
  } satisfies ThreadDetailsPanelProps;
  return {
    props,
    [Symbol.dispose]() {
      configSpy.mockRestore();
      useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: original });
    },
  };
}

describe("ThreadDetailsPanel", () => {
  it("closes both presentations after a successful external workspace open", async () => {
    using fixture = setup();
    const { props } = fixture;
    const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
    const store = useRightPanelStore.getState();
    store.setThreadPanelOpen(threadRef, "inline", true);
    store.setThreadPanelOpen(threadRef, "popover", true);
    await using screen = await render(<ThreadDetailsPanel {...props} />);
    await screen.getByRole("button", { name: "Accepted external open" }).click();
    const visibility = useRightPanelStore.getState().threadPanelVisibilityByThreadKey;
    expect(selectThreadPanelOpen(visibility, threadRef, "inline")).toBe(false);
    expect(selectThreadPanelOpen(visibility, threadRef, "popover")).toBe(false);
  });

  it("imports checked-in t3.json scripts through the workspace actions menu", async () => {
    using fixture = setup();
    const { props } = fixture;
    const fileScripts = [
      { name: "Check project", command: "vp check", icon: "test" },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);
    await using screen = await render(<ThreadDetailsPanel {...props} activeProjectScripts={[]} />);
    await screen.getByRole("button", { name: "Choose project action" }).click();
    await page.getByRole("menuitem", { name: /Check project/ }).click();
    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(
      props.environmentId,
      props.gitCwd,
    );
    expect(props.onAddProjectScript).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Check project",
        command: "vp check",
        icon: "test",
      }),
    );
  });
});
