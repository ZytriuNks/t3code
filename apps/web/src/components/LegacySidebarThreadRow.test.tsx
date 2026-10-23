import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { makeThreadFixture } from "../test-fixtures";
import { SidebarThreadRow } from "./LegacySidebar";

vi.mock("../i18n/I18nProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../i18n/I18nProvider")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("./ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui/sidebar")>()),
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (input: unknown) => input,
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/hooks/useSettings")>();
  return {
    ...actual,
    useClientSettings: (selector?: (settings: unknown) => unknown) =>
      selector
        ? selector({
            sidebarThreadSortOrder: "updated_at",
            sidebarProjectSortOrder: "updated_at",
            sidebarThreadPreviewCount: 5,
            legacySidebarThreadStatusDots: false,
            legacySidebarHideStatusLabels: false,
          })
        : {
            legacySidebarThreadStatusDots: false,
            legacySidebarHideStatusLabels: false,
          },
  };
});
vi.mock("./Sidebar.logic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Sidebar.logic")>()),
  useSidebarRowSubscriptionLease: () => ({ leaseLiveStatus: false, rowRef: { current: null } }),
}));
vi.mock("../uiStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../uiStateStore")>()),
  useUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({ threadLastVisitedAtById: {} }),
}));
vi.mock("../threadSelectionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadSelectionStore")>()),
  useThreadSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedThreadKeys: new Set() }),
}));
vi.mock("../state/terminalSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/terminalSessions")>()),
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("~/hooks/useMediaQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useMediaQuery")>()),
  useIsMobile: () => false,
}));
vi.mock("../portDiscoveryState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../portDiscoveryState")>()),
  useThreadDiscoveredPorts: () => [],
}));
vi.mock("../state/use-atom-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/use-atom-command")>()),
  useAtomCommand: () => vi.fn(),
}));
vi.mock("../state/preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/preview")>()),
  previewEnvironment: { open: {} },
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironment: () => null,
  usePrimaryEnvironmentId: () => "local",
}));
vi.mock("~/hooks/useSupportsMultiplePullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSupportsMultiplePullRequests")>()),
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../connection/desktopLocal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connection/desktopLocal")>()),
  isDesktopLocalConnectionTarget: () => false,
  isWslConnectionTarget: () => false,
}));
vi.mock("./ThreadStatusIndicators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadStatusIndicators")>()),
  useLinkedThreadPullRequest: () => null,
  ThreadStatusLabel: () => null,
  ThreadWorktreeIndicator: () => null,
  ThreadTerminalStatusButton: () => null,
  ChangeRequestStatusIcon: () => null,
  PrStatusTooltipContent: () => null,
}));
vi.mock("./EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("~/components/pullRequest/pullRequestIcons", () => ({
  PullRequestGlyph: { pullRequest: () => null },
}));
vi.mock("./chat/workspaceFileDrop", () => ({
  makeWorkspaceFileDropHandlers: () => ({}),
}));

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("pinned-thread");
const threadRef = scopeThreadRef(environmentId, threadId);

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function makeProps(thread: ReturnType<typeof makeThreadFixture>) {
  return {
    pinThread: async () => AsyncResult.success({ sequence: 1 }),
    confirmAndUnpinThread: async () => AsyncResult.success(undefined),
    thread,
    orderedProjectThreadKeys: [scopedThreadKey(threadRef)],
    isActive: false,
    openPullRequestsInRightPanel: false,
    jumpLabel: null,
    appSettingsConfirmThreadArchive: false,
    renamingThreadKey: null,
    renamingTitle: "",
    setRenamingTitle: vi.fn(),
    startThreadRename: vi.fn(),
    renamingInputRef: { current: null },
    renamingCommittedRef: { current: false },
    confirmingArchiveThreadKey: null,
    setConfirmingArchiveThreadKey: vi.fn(),
    confirmArchiveButtonRefs: { current: new Map() },
    handleThreadClick: vi.fn(),
    navigateToThread: vi.fn(),
    handleMultiSelectContextMenu: vi.fn(),
    handleThreadContextMenu: vi.fn(),
    clearSelection: vi.fn(),
    commitRename: vi.fn(),
    cancelRename: vi.fn(),
    attemptArchiveThread: vi.fn(),
    openPrLink: vi.fn(),
    onFileDropThreads: vi.fn(),
  };
}

describe("legacy sidebar pinned thread row", () => {
  it("shows the pin action only at the trailing end, never as a leading pin icon", async () => {
    const thread = makeThreadFixture({
      environmentId,
      projectId,
      id: threadId,
      title: "Pinned Thread",
      pinnedAt: "2026-01-01T00:00:00.000Z",
    });
    await act(() => {
      renderer = create(<SidebarThreadRow {...makeProps(thread)} />);
    });
    // The trailing pin button is the only pin control: no leading pin icon.
    expect(renderer!.root.findAllByProps({ "aria-label": "sidebar.pinned" })).toHaveLength(0);
    const pinButtons = renderer!.root.findAllByProps({
      "data-testid": `thread-pin-${threadId}`,
    });
    expect(pinButtons).toHaveLength(1);
    expect(pinButtons[0]!.props["aria-pressed"]).toBe(true);
  });
});
