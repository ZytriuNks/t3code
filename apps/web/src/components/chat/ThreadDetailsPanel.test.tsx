import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/reactivity";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./OpenInPicker", () => ({
  OpenInPicker: ({ onExternalOpen }: { onExternalOpen?: () => void }) => (
    <button onClick={onExternalOpen}>Accepted external open</button>
  ),
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
  });

  it("closes both presentations after a successful external workspace open", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const threadRef = {
      environmentId: "environment:external-open" as EnvironmentId,
      threadId: "thread:external-open" as ThreadId,
    };
    const store = useRightPanelStore.getState();
    store.setThreadPanelOpen(threadRef, "inline", true);
    store.setThreadPanelOpen(threadRef, "popover", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ThreadDetailsPanel
            {...threadRef}
            anchor={{ current: null }}
            handle={PopoverCreateHandle()}
            onPresentationChange={vi.fn()}
            activeProjectName={undefined}
            activeProjectScripts={undefined}
            preferredScriptId={null}
            keybindings={[]}
            availableEditors={["vscode"]}
            showOpenInPicker
            gitCwd="/workspace"
            isGitRepo={false}
            envLocked={false}
            availableEnvironments={[]}
            onEnvironmentChange={vi.fn()}
            onEnvModeChange={vi.fn()}
            envMode="local"
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onComposerFocusRequest={vi.fn()}
            onRunProjectScript={vi.fn()}
            onAddProjectScript={async () => AsyncResult.success(undefined)}
            onUpdateProjectScript={async () => AsyncResult.success(undefined)}
            onDeleteProjectScript={async () => AsyncResult.success(undefined)}
          />,
        );
      });
      await act(async () => renderer!.root.findByType("button").props.onClick?.());
      const visibility = useRightPanelStore.getState().threadPanelVisibilityByThreadKey;
      expect(selectThreadPanelOpen(visibility, threadRef, "inline")).toBe(false);
      expect(selectThreadPanelOpen(visibility, threadRef, "popover")).toBe(false);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
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
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });
});
