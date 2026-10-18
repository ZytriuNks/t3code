import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import { LegacySidebarDraftRow } from "./LegacySidebarDraftRow";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  releaseUploads: vi.fn(),
  toast: vi.fn(),
  readThreads: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../state/entities", () => ({ readThreadShells: mocks.readThreads }));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: mocks.releaseUploads,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../i18n/I18nProvider", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./ui/sidebar", () => ({
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));

const environmentId = EnvironmentId.make("local");
const draftId = DraftId.make("draft-to-close");
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.navigate.mockResolvedValue(undefined);
  mocks.readThreads.mockReturnValue([makeThreadFixture({ environmentId })]);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(environmentId, ProjectId.make("project")),
    draftId,
    { threadId: ThreadId.make("draft-thread") },
  );
  store.setPrompt(draftId, "Unsent text");
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function closeRow(isActive: boolean) {
  await act(() => {
    renderer = create(<LegacySidebarDraftRow draftId={draftId} isActive={isActive} />);
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "sidebar.closeDraft" }).props.onClick();
  });
}

describe("legacy draft close action", () => {
  it("discards an inactive draft and releases uploads without changing the current conversation", async () => {
    await closeRow(false);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBeNull();
    expect(mocks.releaseUploads).toHaveBeenCalledWith(draftId);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("leaves the active draft intact until navigation to an existing thread succeeds", async () => {
    let finishNavigation!: () => void;
    mocks.navigate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    await closeRow(true);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("Unsent text");
    expect(mocks.releaseUploads).not.toHaveBeenCalled();
    await act(async () => {
      finishNavigation();
    });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(mocks.releaseUploads).toHaveBeenCalledWith(draftId);
  });

  it("preserves content and attachments when navigation fails", async () => {
    mocks.navigate.mockRejectedValue(new Error("Navigation failed"));
    await closeRow(true);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("Unsent text");
    expect(mocks.releaseUploads).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({ type: "error", title: "sidebar.closeDraftFailed" });
  });
});
