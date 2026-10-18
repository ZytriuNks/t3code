import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({ current: "zh-CN" as "system" | "en" | "zh-CN" }));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <T,>(
    selector: (settings: { readonly language: "system" | "en" | "zh-CN" }) => T,
  ) => selector({ language: languageState.current }),
}));

vi.mock("./chat/composerEventScope", () => ({
  useComposerMenuProps: () => ({}),
}));

vi.mock("./chat/ThreadDetailsControl", () => ({
  ThreadDetailsSelectControl: ({
    "aria-label": ariaLabel,
    children,
  }: {
    readonly "aria-label"?: string;
    readonly children?: ReactNode;
  }) => <button aria-label={ariaLabel}>{children}</button>,
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    readonly render?: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("./ui/select", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Container,
    SelectGroup: Container,
    SelectGroupLabel: Container,
    SelectItem: Container,
    SelectPopup: Container,
    SelectTrigger: ({
      "aria-label": ariaLabel,
      children,
    }: {
      readonly "aria-label"?: string;
      readonly children?: ReactNode;
    }) => <button aria-label={ariaLabel}>{children}</button>,
    SelectValue: Container,
  };
});

import { I18nProvider } from "../i18n/I18nProvider";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

let renderer: ReactTestRenderer | undefined;

const environmentId = EnvironmentId.make("dev-box");
const projectId = ProjectId.make("project");

function localized(node: ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

function collectText(node: unknown): string[] {
  const collected: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      collected.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (current && typeof current === "object" && "children" in current) {
      visit((current as { readonly children: unknown }).children);
    }
  };
  visit(node);
  return collected;
}

function textContents(): string[] {
  return collectText(renderer!.toJSON());
}

function accessibleNames(): string[] {
  return renderer!.root
    .findAll((node) => typeof node.props["aria-label"] === "string")
    .map((node) => node.props["aria-label"] as string);
}

beforeEach(() => {
  languageState.current = "zh-CN";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("branch toolbar localization", () => {
  it("translates the environment selector while keeping environment names verbatim", async () => {
    const selector = (
      <BranchToolbarEnvironmentSelector
        envLocked={false}
        environmentId={environmentId}
        availableEnvironments={[
          {
            environmentId,
            projectId,
            label: "Dev Box",
            isPrimary: false,
            machine: "server",
          },
        ]}
        onAutoEnvironment={() => undefined}
        onEnvironmentChange={() => undefined}
      />
    );

    await act(() => {
      renderer = create(localized(selector));
    });

    expect(textContents()).toContain("运行于");
    expect(textContents()).toContain("自动均衡");
    expect(textContents()).toContain("Dev Box");
    expect(accessibleNames()).toContain("运行于");

    languageState.current = "en";
    await act(() => {
      renderer!.update(localized(selector));
    });

    expect(textContents()).toContain("Run on");
    expect(textContents()).toContain("Auto balance");
    expect(textContents()).toContain("Dev Box");
    expect(accessibleNames()).toContain("Run on");
  });

  it("translates the workspace selector without changing its behavior values", async () => {
    const selector = (
      <BranchToolbarEnvModeSelector
        envLocked={false}
        effectiveEnvMode="local"
        activeWorktreePath={null}
        onEnvModeChange={() => undefined}
      />
    );

    await act(() => {
      renderer = create(localized(selector));
    });

    expect(textContents()).toContain("工作区");
    expect(textContents()).toContain("当前检出");
    expect(textContents()).toContain("新工作树");
    expect(accessibleNames()).toContain("工作区");

    languageState.current = "en";
    await act(() => {
      renderer!.update(localized(selector));
    });

    expect(textContents()).toContain("Workspace");
    expect(textContents()).toContain("Current checkout");
    expect(textContents()).toContain("New worktree");
    expect(accessibleNames()).toContain("Workspace");
  });
});
