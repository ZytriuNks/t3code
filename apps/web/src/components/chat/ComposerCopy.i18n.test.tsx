// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { I18nProvider } from "../../i18n/I18nProvider";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

const state = vi.hoisted(() => ({ language: "en", open: vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: (select: (settings: { language: string }) => unknown) =>
    select({ language: state.language }),
}));
vi.mock("../SidebarStageBackdrop", () => ({ useSidebarStageBackdropVariant: () => null }));
vi.mock("../../shortcutModifierState", () => ({ useShortcutModifierState: () => ({}) }));
vi.mock("~/commandPaletteBus", () => ({ openCommandPalette: state.open }));
vi.mock("~/state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => null,
    scratchWorkspaceRootFor: () => null,
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
const container = document.createElement("div");
const root = createRoot(container);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => {
  await act(() => root.render(null));
  state.language = "en";
  state.open.mockClear();
});

it("switches the live hero language without losing the Add project action", async () => {
  const show = (title: string | null = null) =>
    act(() =>
      root.render(
        <I18nProvider>
          <DraftHeroHeadline draftId={null} activeProjectRef={null} activeProjectTitle={title} />
        </I18nProvider>,
      ),
    );
  await show();
  expect(container.querySelector("h1")?.textContent).toBe("Add a project to start");
  state.language = "zh-CN";
  await show();
  expect(container.querySelector("h1")?.textContent).toBe("添加项目以开始");
  await show("Demo");
  expect(container.querySelector("h1")?.getAttribute("aria-label")).toBe("在 Demo 中构建什么？");
  expect(container.querySelector("button")?.textContent).toBe("Demo");
  await act(() => container.querySelector("button")!.click());
  expect(state.open).toHaveBeenCalledExactlyOnceWith({ open: "add-project" });
  state.language = "en";
  await show("Demo");
  expect(container.querySelector("h1")?.getAttribute("aria-label")).toBe(
    "What should we build in Demo?",
  );
});

it("switches send/queue/disconnected copy in the mounted action and keeps permission gating", async () => {
  const submit = vi.fn();
  const props: ComponentProps<typeof ComposerPrimaryActions> = {
    compact: false,
    canOperateThread: true,
    pendingAction: null,
    isRunning: true,
    canInterrupt: true,
    followUpBehavior: "queue",
    showPlanFollowUpPrompt: false,
    promptHasText: true,
    isSendBusy: false,
    sendDisabledReason: null,
    isConnecting: false,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: true,
    onSubmitMessage: submit,
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    onImplementPlanInNewThread: vi.fn(),
  };
  const show = (overrides: Partial<typeof props> = {}) =>
    act(() =>
      root.render(
        <I18nProvider>
          <ComposerPrimaryActions {...props} {...overrides} />
        </I18nProvider>,
      ),
    );
  await show();
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Queue message");
  state.language = "zh-CN";
  await show();
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("将消息加入队列");
  await act(() => container.querySelector("button")!.click());
  expect(submit).toHaveBeenCalledOnce();
  await show({ isEnvironmentUnavailable: true });
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("环境已断开连接");
  expect(container.querySelector("button")?.disabled).toBe(true);
  await show({ isRunning: false, canOperateThread: false });
  expect(container.querySelector("button")?.disabled).toBe(true);
});
