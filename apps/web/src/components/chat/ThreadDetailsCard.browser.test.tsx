import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
const preference = vi.hoisted(() => ({ autoExpandThreadDetailsPanel: true }));
vi.mock("../../hooks/useSettings", async (original) => {
  const actual = await original<typeof import("../../hooks/useSettings")>();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  return {
    ...actual,
    useClientSettings: <T,>(selector: (settings: Settings) => T) =>
      selector({ ...actual.getClientSettings(), ...preference }),
  };
});
import { useRightPanelStore } from "../../rightPanelStore";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { PopoverCreateHandle } from "../ui/popover";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const original = useRightPanelStore.getState().threadPanelVisibilityByThreadKey;
  stack.defer(() => {
    useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: original });
  });
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  preference.autoExpandThreadDetailsPanel = true;
  const onPresentationChange = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("card-test"),
    threadId: ThreadId.make("thread"),
  };
  const container = { width: 1600, height: 900 };
  const lane = { padding: 48, minChatWidth: 640 };

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

  const anchor = createRef<HTMLButtonElement>();
  const handle = PopoverCreateHandle();
  const view = () => (
    <ChatCanvasContext value={canvas}>
      <button ref={anchor}>Workspace</button>
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={anchor}
        handle={handle}
        onPresentationChange={onPresentationChange}
      >
        {() => <p>Workspace controls</p>}
      </ThreadDetailsCard>
    </ChatCanvasContext>
  );
  const screen = stack.use(await render(null));
  const owned = stack.move();
  return {
    screen,
    view,
    threadRef,
    onPresentationChange,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
describe("workspace card preference", () => {
  it("keeps manual opening available when automatic expansion is disabled", async () => {
    await using fixture = await setup();
    const { screen, view, threadRef, onPresentationChange } = fixture;
    preference.autoExpandThreadDetailsPanel = false;
    await screen.rerender(view());
    await expect
      .element(page.getByText("Workspace controls", { exact: true }))
      .not.toBeInTheDocument();
    expect(onPresentationChange).toHaveBeenLastCalledWith("popover");
    await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true));
    await expect.element(page.getByText("Workspace controls", { exact: true })).toBeVisible();
    await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false));
    await expect
      .element(page.getByText("Workspace controls", { exact: true }))
      .not.toBeInTheDocument();
  });
  it("applies preference changes while the thread is open", async () => {
    await using fixture = await setup();
    const { screen, view, onPresentationChange } = fixture;
    await screen.rerender(view());
    expect(screen.container.querySelectorAll("aside")).toHaveLength(1);
    expect(onPresentationChange).toHaveBeenLastCalledWith("inline");
    preference.autoExpandThreadDetailsPanel = false;
    await screen.rerender(view());
    expect(screen.container.querySelectorAll("aside")).toHaveLength(0);
    await expect
      .element(page.getByText("Workspace controls", { exact: true }))
      .not.toBeInTheDocument();
    preference.autoExpandThreadDetailsPanel = true;
    await screen.rerender(view());
    expect(screen.container.querySelectorAll("aside")).toHaveLength(1);
  });
});
