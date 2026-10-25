import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({ language: "zh-CN" as "en" | "zh-CN" }));
vi.mock("../hooks/useSettings", async (original) => {
  const actual = await original<typeof import("../hooks/useSettings")>();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  return {
    ...actual,
    useClientSettings: <T,>(select: (settings: Settings) => T) =>
      select({ ...actual.getClientSettings(), language: state.language }),
  };
});
import { I18nProvider } from "../i18n/I18nProvider";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

const environmentId = EnvironmentId.make("dev-box");
const projectId = ProjectId.make("project");

describe("branch toolbar localization", () => {
  it("translates the environment selector while keeping environment names and actions", async () => {
    state.language = "zh-CN";
    const auto = vi.fn();
    const select = vi.fn();
    const view = () => (
      <I18nProvider>
        <BranchToolbarEnvironmentSelector
          envLocked={false}
          environmentId={environmentId}
          availableEnvironments={[
            { environmentId, projectId, label: "Dev Box", isPrimary: false, machine: "server" },
          ]}
          onAutoEnvironment={auto}
          onEnvironmentChange={select}
        />
      </I18nProvider>
    );
    await using screen = await render(view());
    await expect
      .element(screen.getByRole("combobox", { name: "运行于" }))
      .toHaveTextContent("Dev Box");
    await screen.getByRole("combobox", { name: "运行于" }).click();
    await expect.element(page.getByRole("option", { name: "自动均衡" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Dev Box" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    state.language = "en";
    await screen.rerender(view());
    await screen.getByRole("combobox", { name: "Run on" }).click();
    await expect.element(page.getByRole("option", { name: "Dev Box" })).toBeVisible();
    await page.getByRole("option", { name: "Auto balance" }).click();
    expect(auto).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });

  it("translates the workspace selector without changing its behavior values", async () => {
    state.language = "zh-CN";
    const select = vi.fn();
    const view = () => (
      <I18nProvider>
        <BranchToolbarEnvModeSelector
          envLocked={false}
          effectiveEnvMode="local"
          activeWorktreePath={null}
          onEnvModeChange={select}
        />
      </I18nProvider>
    );
    await using screen = await render(view());
    await screen.getByRole("combobox", { name: "工作区" }).click();
    await expect.element(page.getByRole("option", { name: "当前检出" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "新工作树" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    state.language = "en";
    await screen.rerender(view());
    await screen.getByRole("combobox", { name: "Workspace" }).click();
    await expect.element(page.getByRole("option", { name: "Current checkout" })).toBeVisible();
    await page.getByRole("option", { name: "New worktree" }).click();
    expect(select).toHaveBeenCalledExactlyOnceWith("worktree");
  });
});
