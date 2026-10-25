import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";
import composerSource from "./chat/ChatComposer.tsx?raw";
import diffSource from "./DiffPanel.tsx?raw";
import paletteSource from "./CommandPalette.tsx?raw";
import branchSource from "./BranchToolbarBranchSelector.tsx?raw";
import { translate, type MessageKey, type MessageValues } from "../i18n/messages";

// 在 Node 中执行消费者自身的表达式，避免为纯文案分支引入 DOM 或复制实现。
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

function translator(language: "en" | "zh-CN") {
  return (key: MessageKey, values?: MessageValues) => translate(language, key, values);
}

it("selects the production composer placeholder and disabled state in both languages", () => {
  const placeholder = between(
    composerSource,
    "                    placeholder={",
    "\n                    disabled={",
  )
    .trim()
    .replace(/}$/, "");
  const disabled = between(
    composerSource.slice(composerSource.indexOf("                    placeholder={")),
    "                    disabled={",
    "\n                  />",
  )
    .trim()
    .replace(/}$/, "");
  for (const [language, chosen, empty] of [
    [
      "en",
      "Choose an option above",
      "Ask anything, @tag files/folders, $use skills, or / for commands",
    ],
    ["zh-CN", "请在上方选择一个选项", "输入消息…"],
  ] as const) {
    const bindings = {
      t: translator(language),
      isComposerApprovalState: false,
      activePendingProgress: {},
      isChoiceOnlyPendingQuestion: true,
      showPlanFollowUpPrompt: false,
      activeProposedPlan: null,
      projectSelectionRequired: false,
      showProviderUnavailable: false,
      phase: "idle",
      isConnecting: false,
      activePendingIsResponding: false,
    };
    expect(evaluate<string>(`return (${placeholder});`, bindings)).toBe(chosen);
    expect(evaluate<boolean>(`return (${disabled});`, bindings)).toBe(true);
    expect(
      evaluate<string>(`return (${placeholder});`, {
        ...bindings,
        activePendingProgress: null,
        isChoiceOnlyPendingQuestion: false,
      }),
    ).toBe(empty);
    expect(
      evaluate<boolean>(`return (${disabled});`, {
        ...bindings,
        isChoiceOnlyPendingQuestion: false,
      }),
    ).toBe(false);
  }
});

it("selects production Diff scope labels with the selected turn number", () => {
  const expression = between(
    diffSource,
    "  const selectedScopeLabel =",
    "  const reviewSectionId =",
  ).trim();
  for (const [language, turnLabel, workspace] of [
    ["en", "Turn 3", "Working tree"],
    ["zh-CN", "第 3 轮", "工作区"],
  ] as const) {
    const bindings = {
      t: translator(language),
      selectedRunId: "selected",
      selectedGitScope: "unstaged",
      selectedTurn: { runId: "selected" },
      latestTurn: { runId: "latest" },
      selectedCheckpointTurnCount: 3,
    };
    expect(evaluate<string>(`return ${expression}`, bindings)).toBe(turnLabel);
    expect(evaluate<string>(`return ${expression}`, { ...bindings, selectedRunId: null })).toBe(
      workspace,
    );
  }
});

it("uses current branch copy success and failure copy after a locale change", async () => {
  const callback = between(
    branchSource,
    "  const copyBranchName =",
    "  const handleBranchContextMenu =",
  );
  const status = between(
    branchSource,
    "  const branchStatusText =",
    "  const copyBranchName =",
  ).trim();
  const write = vi.fn().mockResolvedValue(true);
  const toast = vi.fn();
  const show = (language: "en" | "zh-CN") => {
    const bindings = {
      t: translator(language),
      writeTextToClipboard: write,
      toastManager: { add: toast },
      stackedThreadToast: (value: unknown) => value,
      toBranchActionErrorMessage: (error: unknown, fallback: string) =>
        error instanceof Error ? error.message : fallback,
      isInitialBranchesLoadPending: false,
      isFetchingNextPage: false,
      hasNextPage: true,
      refs: [{}, {}],
      totalBranchCount: 7,
    };
    return {
      copy: evaluate<(branch: string) => void>(`return ${callback}`, bindings),
      label: evaluate<string>(`return ${status}`, bindings),
    };
  };
  expect(show("en").label).toBe("Showing 2 of 7 refs");
  const chinese = show("zh-CN");
  expect(chinese.label).toBe("显示 7 个引用中的 2 个");
  chinese.copy("feature/keep-me");
  await vi.waitFor(() =>
    expect(toast).toHaveBeenLastCalledWith({
      type: "success",
      title: "已复制分支名称",
      description: "feature/keep-me",
    }),
  );
  expect(write).toHaveBeenCalledWith("feature/keep-me", "branch name");
  write.mockRejectedValueOnce(null);
  chinese.copy("feature/keep-me");
  await vi.waitFor(() =>
    expect(toast).toHaveBeenLastCalledWith({
      type: "error",
      title: "无法复制分支名称",
      description: "发生错误。",
    }),
  );
  show("en").copy("feature/keep-me");
  await vi.waitFor(() =>
    expect(toast).toHaveBeenLastCalledWith({
      type: "success",
      title: "Branch name copied",
      description: "feature/keep-me",
    }),
  );
});

it("runs the production restart action in both languages with the same stop command", async () => {
  const block = between(
    paletteSource,
    'value: "action:restart-agent-session",',
    "\n  actionItems.push({",
  );
  const title = between(block, "      title: ", "\n      icon:").trim().replace(/,$/, "");
  const handler = between(block, "      run: ", "\n    });").trim().replace(/,$/, "");
  for (const [language, label, success, description] of [
    [
      "en",
      "Restart agent session",
      "Agent session will restart",
      "Your next message starts a fresh session.",
    ],
    ["zh-CN", "重启代理会话", "代理会话将重启", "发送下一条消息时将启动新的代理会话。"],
  ] as const) {
    const stop = vi.fn().mockResolvedValue({ _tag: "Success" });
    const toast = vi.fn();
    const bindings = {
      t: translator(language),
      thread: {
        environmentId: "remote",
        id: "thread",
        projectId: "project",
        runtime: { providerInstanceId: "pi" },
        modelSelection: { instanceId: "pi" },
      },
      stopThreadSession: stop,
      squashAtomCommandFailure: (error: unknown) => error,
      toastManager: { add: toast },
      projectByKey: new Map(),
      refreshProviders: vi.fn(),
    };
    expect(evaluate<string>(`return ${title};`, bindings)).toBe(label);
    await evaluate<() => Promise<void>>(`return ${handler};`, bindings)();
    expect(stop).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote",
      input: { threadId: "thread" },
    });
    expect(toast).toHaveBeenCalledWith({ type: "success", title: success, description });
  }
});
