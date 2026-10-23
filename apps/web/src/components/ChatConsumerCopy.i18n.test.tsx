// @vitest-environment jsdom
import * as NodeModule from "node:module";
import { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import composerSource from "./chat/ChatComposer.tsx?raw";
import diffSource from "./DiffPanel.tsx?raw";
import paletteSource from "./CommandPalette.tsx?raw";
import branchSource from "./BranchToolbarBranchSelector.tsx?raw";
import { I18nProvider, useI18n } from "../i18n/I18nProvider";
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from "../composerPlaceholder";

const state = vi.hoisted(() => ({ language: "en" }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { language: string }) => unknown) =>
    select({ language: state.language }),
}));
// These large consumers are tested at their executing copy/handler boundary,
// avoiding server/virtualizer mocks. The code comes from the candidate, not a
// duplicate decision tree; locale is supplied by the real mounted provider.
function between(source: string, from: string, to: string) {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`Missing consumer start: ${from}`);
  const end = source.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`Missing consumer end: ${to}`);
  return source.slice(start + from.length, end);
}
function evaluate<T>(code: string, bindings: Record<string, unknown>): T {
  const stripped = NodeModule.stripTypeScriptTypes(`function evaluate() { ${code} }`, {
    mode: "strip",
  });
  return new Function(...Object.keys(bindings), `${stripped}; return evaluate();`)(
    ...Object.values(bindings),
  ) as T;
}
const container = document.createElement("div");
const root = createRoot(container);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => {
  await act(() => root.render(null));
  state.language = "en";
});

it("switches the production composer pending/default placeholder without losing disabled state", async () => {
  const expression = between(
    composerSource,
    "                    placeholder={",
    "\n                    disabled={",
  )
    .trim()
    .replace(/}$/, "");
  const show = (choice: boolean) => {
    function Consumer() {
      const { t } = useI18n();
      const placeholder = evaluate<string>(`return (${expression});`, {
        t,
        isComposerApprovalState: false,
        activePendingProgress: choice ? {} : null,
        isChoiceOnlyPendingQuestion: choice,
        showPlanFollowUpPrompt: false,
        activeProposedPlan: null,
        projectSelectionRequired: false,
        showProviderUnavailable: false,
        phase: "idle",
        DISCONNECTED_COMPOSER_PLACEHOLDER,
      });
      return <textarea placeholder={placeholder} disabled={choice} />;
    }
    return act(() =>
      root.render(
        <I18nProvider>
          <Consumer />
        </I18nProvider>,
      ),
    );
  };
  await show(true);
  expect(container.querySelector("textarea")?.placeholder).toBe("Choose an option above");
  state.language = "zh-CN";
  await show(true);
  expect(container.querySelector("textarea")?.placeholder).toBe("请在上方选择一个选项");
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  await show(false);
  expect(container.querySelector("textarea")?.placeholder).toBe("输入消息…");
});

it("switches production Diff scope labels including the selected turn number", async () => {
  const expression = between(
    diffSource,
    "  const selectedScopeLabel =",
    "  const reviewSectionId =",
  ).trim();
  const show = (turn: number | null) => {
    function Consumer() {
      const { t } = useI18n();
      const label = evaluate<string>(`return ${expression}`, {
        t,
        selectedRunId: turn === null ? null : "selected",
        selectedGitScope: "unstaged",
        selectedTurn: { runId: "selected" },
        latestTurn: { runId: "latest" },
        selectedCheckpointTurnCount: turn,
      });
      return <button>{label}</button>;
    }
    return act(() =>
      root.render(
        <I18nProvider>
          <Consumer />
        </I18nProvider>,
      ),
    );
  };
  await show(3);
  expect(container.textContent).toBe("Turn 3");
  state.language = "zh-CN";
  await show(3);
  expect(container.textContent).toBe("第 3 轮");
  await show(null);
  expect(container.textContent).toBe("工作区");
});

it("uses the current branch copy callback after locale changes and interpolates ref counts", async () => {
  const callback = between(
    branchSource,
    "  const copyBranchName =",
    "  const handleBranchContextMenu =",
  );
  const status = between(
    branchSource,
    "  const branchStatusText =",
    "\n  // ---------------------------------------------------------------------------",
  ).trim();
  const write = vi.fn().mockResolvedValue(true);
  const toast = vi.fn();
  function Consumer() {
    const { t } = useI18n();
    const copy = evaluate<(branch: string) => void>(`const copy = ${callback} return copy;`, {
      t,
      useCallback,
      writeTextToClipboard: write,
      toastManager: { add: toast },
      stackedThreadToast: (value: unknown) => value,
      toBranchActionErrorMessage: (error: unknown, fallback: string) =>
        error instanceof Error ? error.message : fallback,
    });
    const label = evaluate<string>(`return ${status}`, {
      t,
      isInitialBranchesLoadPending: false,
      isFetchingNextPage: false,
      hasNextPage: true,
      refs: [{}, {}],
      totalBranchCount: 7,
    });
    return <button onClick={() => copy("feature/keep-me")}>{label}</button>;
  }
  const show = () =>
    act(() =>
      root.render(
        <I18nProvider>
          <Consumer />
        </I18nProvider>,
      ),
    );
  await show();
  expect(container.textContent).toBe("Showing 2 of 7 refs");
  state.language = "zh-CN";
  await show();
  expect(container.textContent).toBe("显示 7 个引用中的 2 个");
  await act(async () => container.querySelector("button")!.click());
  expect(write).toHaveBeenCalledWith("feature/keep-me", "branch name");
  expect(toast).toHaveBeenCalledWith({
    type: "success",
    title: "已复制分支名称",
    description: "feature/keep-me",
  });
  write.mockRejectedValueOnce(null);
  await act(async () => container.querySelector("button")!.click());
  expect(toast).toHaveBeenLastCalledWith({
    type: "error",
    title: "无法复制分支名称",
    description: "发生错误。",
  });
  state.language = "en";
  await show();
  await act(async () => container.querySelector("button")!.click());
  expect(toast).toHaveBeenLastCalledWith({
    type: "success",
    title: "Branch name copied",
    description: "feature/keep-me",
  });
});

it("runs the current restart action after language switching with localized success and the same stop command", async () => {
  const block = between(
    paletteSource,
    'value: "action:restart-agent-session",',
    "\n  actionItems.push({",
  );
  const title = between(block, "      title: ", "\n      icon:").trim().replace(/,$/, "");
  const handler = between(block, "      run: ", "\n    });").trim().replace(/,$/, "");
  const stop = vi.fn().mockResolvedValue({ _tag: "Success" });
  const toast = vi.fn();
  const thread = {
    environmentId: "remote",
    id: "thread",
    projectId: "project",
    runtime: { providerInstanceId: "pi" },
    modelSelection: { instanceId: "pi" },
  };
  const show = () => {
    function Consumer() {
      const { t } = useI18n();
      const bindings = {
        t,
        thread,
        stopThreadSession: stop,
        squashAtomCommandFailure: (error: unknown) => error,
        toastManager: { add: toast },
        projectByKey: new Map(),
        refreshProviders: vi.fn(),
      };
      return (
        <button onClick={evaluate<() => Promise<void>>(`return ${handler};`, bindings)}>
          {evaluate<string>(`return ${title};`, bindings)}
        </button>
      );
    }
    return act(() =>
      root.render(
        <I18nProvider>
          <Consumer />
        </I18nProvider>,
      ),
    );
  };
  await show();
  expect(container.textContent).toBe("Restart agent session");
  state.language = "zh-CN";
  await show();
  expect(container.textContent).toBe("重启代理会话");
  await act(async () => container.querySelector("button")!.click());
  expect(stop).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: { threadId: "thread" },
  });
  expect(toast).toHaveBeenCalledWith({
    type: "success",
    title: "代理会话将重启",
    description: "发送下一条消息时将启动新的代理会话。",
  });
});
