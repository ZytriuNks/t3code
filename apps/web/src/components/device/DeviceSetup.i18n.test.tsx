import { EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const localeState = vi.hoisted(() => ({ language: "zh-CN" as "zh-CN" | "en" }));

vi.mock("~/hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  return {
    useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
      const settings = { ...DEFAULT_CLIENT_SETTINGS, language: localeState.language };
      return selector ? selector(settings) : settings;
    },
  };
});
vi.mock("~/state/device", () => ({
  deviceEnvironment: { configure: Symbol("configure"), list: Symbol("list") },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("~/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  return {
    DialogClose: (props: { readonly children?: ReactNode }) =>
      createElement("span", null, props.children as never),
  };
});
vi.mock("~/components/ui/wizard", async () => {
  const { createElement } = await import("react");
  return {
    WizardHeader: (props: {
      readonly title: string;
      readonly description: string;
      readonly children?: ReactNode;
    }) =>
      createElement(
        "header",
        null,
        createElement("h1", null, props.title),
        createElement("p", null, props.description),
        props.children as never,
      ),
    WizardPanel: (props: { readonly children?: ReactNode }) =>
      createElement("section", null, props.children as never),
    WizardSteps: (props: { readonly steps: readonly string[] }) =>
      createElement(
        "nav",
        null,
        props.steps.map((step) => createElement("span", { key: step }, step)),
      ),
    WizardFooter: (props: { readonly children?: ReactNode }) =>
      createElement("footer", null, props.children as never),
  };
});

import { I18nProvider } from "~/i18n/I18nProvider";
import { DeviceSetup } from "./DeviceSetup";

const state = {
  hosts: [],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device",
  revision: 1,
} satisfies DeviceServiceState;

function textContents(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => textContents(child, out));
  else if (node && typeof node === "object" && "children" in node)
    textContents((node as { children: unknown }).children, out);
  return out;
}

function view() {
  return (
    <I18nProvider>
      <DeviceSetup environmentId={EnvironmentId.make("environment-local")} state={state} />
    </I18nProvider>
  );
}

describe("device setup localization", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    act(() => {
      renderer = create(view());
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("renders the setup wizard copy in Simplified Chinese", () => {
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("设置设备");
    expect(text).toContain("使用模拟器和仿真器前，先查看此环境中运行的内容。");
    expect(text).toContain("设备中心");
    expect(text).toContain("启用设备中心");
    expect(text).toContain("取消");

    // The wizard advances with the localized control, not an English literal.
    const next = renderer!.root
      .findAllByType("button")
      .find((button) => JSON.stringify(button.props.children).includes("继续"));
    expect(next).toBeDefined();
    act(() => next!.props.onClick());
    expect(textContents(renderer!.toJSON())).toContain("检查模拟器支持");
  });

  it("follows a language change without remounting the wizard", () => {
    act(() => {
      localeState.language = "en";
      renderer!.update(view());
    });
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("Set up devices");
    expect(text).toContain("Device hub");
    expect(text).toContain("Enable the device hub");
    expect(text).toContain("Continue");
  });
});
