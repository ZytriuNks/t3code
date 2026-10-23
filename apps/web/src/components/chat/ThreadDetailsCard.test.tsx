import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, createContext, useContext, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const preference = vi.hoisted(() => ({ autoExpandThreadDetailsPanel: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
    selector({ ...DEFAULT_CLIENT_SETTINGS, ...preference }),
}));
// Keep the DOM-only primitives out of this state and placement regression.
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/popover", () => {
  const OpenContext = createContext(false);
  return {
    Popover: ({ open, children }: { open: boolean; children: ReactNode }) => (
      <OpenContext value={open}>{children}</OpenContext>
    ),
    PopoverPopup: ({ children }: { children: ReactNode }) =>
      useContext(OpenContext) ? children : null,
    PopoverCreateHandle: () => ({}),
  };
});

import { useRightPanelStore } from "../../rightPanelStore";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { PopoverCreateHandle } from "../ui/popover";

const threadRef = {
  environmentId: EnvironmentId.make("card-test"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1600, height: 900 };
const lane = { padding: 48, minChatWidth: 640 };
const onPresentationChange = vi.fn();
const canvas = {
  container,
  lane,
  layout: resolveChatCanvasLayout({ container, ...lane, preview: null }),
  previewKey: null,
  reportPreview: vi.fn(),
  clearPreview: vi.fn(),
  registerTimeline: vi.fn(),
  reportDetailsCard: vi.fn(),
  detailsCardTopInset: 0,
};
let renderer: ReactTestRenderer | undefined;
function view() {
  return (
    <ChatCanvasContext value={canvas}>
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={{ current: null }}
        handle={PopoverCreateHandle()}
        onPresentationChange={onPresentationChange}
      >
        {() => <p>Workspace controls</p>}
      </ThreadDetailsCard>
    </ChatCanvasContext>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preference.autoExpandThreadDetailsPanel = true;
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("workspace card preference", () => {
  it("keeps manual opening available when automatic expansion is disabled", async () => {
    preference.autoExpandThreadDetailsPanel = false;
    await act(() => {
      renderer = create(view());
    });
    expect(renderer!.root.findAllByType("p")).toHaveLength(0);
    expect(onPresentationChange).toHaveBeenLastCalledWith("popover");

    await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true));
    expect(renderer!.root.findByType("p").children).toEqual(["Workspace controls"]);
    await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false));
    expect(renderer!.root.findAllByType("p")).toHaveLength(0);
  });

  it("applies preference changes while the thread is open", async () => {
    await act(() => {
      renderer = create(view());
    });
    expect(renderer!.root.findAllByType("aside")).toHaveLength(1);
    expect(onPresentationChange).toHaveBeenLastCalledWith("inline");

    preference.autoExpandThreadDetailsPanel = false;
    await act(() => renderer!.update(view()));
    expect(renderer!.root.findAllByType("aside")).toHaveLength(0);
    expect(renderer!.root.findAllByType("p")).toHaveLength(0);

    preference.autoExpandThreadDetailsPanel = true;
    await act(() => renderer!.update(view()));
    expect(renderer!.root.findAllByType("aside")).toHaveLength(1);
  });
});
