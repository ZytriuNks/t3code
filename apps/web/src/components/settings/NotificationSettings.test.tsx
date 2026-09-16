import { type ClientSettingsPatch } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({
  current: "zh-CN" as "system" | "en" | "zh-CN",
}));
const notificationSettings = vi.hoisted(() => ({
  current: { notificationMode: "off" },
  update: vi.fn<(patch: ClientSettingsPatch) => Promise<void>>(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector?: (settings: { language: "system" | "en" | "zh-CN" }) => T) =>
    selector ? selector({ language: languageState.current }) : { language: languageState.current },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: <T,>(
    selector?: (settings: { notificationMode: string }) => T,
  ): T | { notificationMode: string } =>
    selector ? selector(notificationSettings.current) : notificationSettings.current,
  useUpdateScopedSettings: () => notificationSettings.update,
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    readonly title?: React.ReactNode;
    readonly description?: React.ReactNode;
    readonly control?: React.ReactNode;
  }) => (
    <div data-slot="settings-row">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {control}
    </div>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    onValueChange,
    children,
  }: {
    readonly onValueChange?: (value: string) => void;
    readonly children?: React.ReactNode;
  }) => (
    <div data-slot="select" data-on-value-change={typeof onValueChange === "function"}>
      {children}
      <button
        type="button"
        data-slot="select-option"
        data-value="notifications"
        onClick={() => void onValueChange?.("notifications")}
      />
      <button
        type="button"
        data-slot="select-option"
        data-value="notifications-and-sound"
        onClick={() => void onValueChange?.("notifications-and-sound")}
      />
    </div>
  ),
  SelectTrigger: ({
    children,
    ...props
  }: {
    readonly children?: React.ReactNode;
    readonly "aria-label"?: string;
  }) => (
    <div data-slot="select-trigger" aria-label={props["aria-label"]}>
      {children}
    </div>
  ),
  SelectValue: ({ children }: { readonly children?: React.ReactNode }) => (
    <span data-slot="select-value">{children}</span>
  ),
  SelectPopup: ({ children }: { readonly children?: React.ReactNode }) => (
    <div data-slot="select-popup">{children}</div>
  ),
  SelectItem: ({ children }: { readonly children?: React.ReactNode }) => (
    <div data-slot="select-item">{children}</div>
  ),
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { NotificationSettings } from "./NotificationSettings";

let renderer: ReactTestRenderer | undefined;

function render() {
  return create(
    <I18nProvider>
      <NotificationSettings />
    </I18nProvider>,
  );
}

/** Every text run in the rendered tree, in document order. */
function textContents(): string[] {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      collected.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer!.toJSON());
  return collected;
}

function rowDescription(): string {
  return renderer!.root
    .findAllByType("p")
    .map((node) => node.children.join(""))
    .join("");
}

function selectOption(value: string) {
  return renderer!.root.find(
    (node) => node.props["data-slot"] === "select-option" && node.props["data-value"] === value,
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  languageState.current = "zh-CN";
  notificationSettings.current = { notificationMode: "off" };
  notificationSettings.update.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", { isSecureContext: false });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("notification settings", () => {
  it("shows the notification modes and the row copy in Simplified Chinese", async () => {
    await act(async () => {
      renderer = render();
    });

    // The trigger shows the current mode; the options keep their display order.
    expect(
      renderer!.root.find((node) => node.props["data-slot"] === "select-value").children,
    ).toEqual(["关闭"]);
    const modeLabels = ["关闭", "仅通知", "仅声音", "通知和声音"];
    expect(textContents().filter((text) => modeLabels.includes(text))).toEqual([
      "关闭",
      ...modeLabels,
    ]);
    expect(rowDescription()).toBe(
      "线程完成、失败或需要输入或审批时发出系统提醒。在 T3 Code 打开期间适用于此设备。",
    );
  });

  it("explains the missing browser notification support in Simplified Chinese", async () => {
    await act(async () => {
      renderer = render();
    });

    await act(async () => {
      selectOption("notifications").props.onClick();
    });

    expect(rowDescription()).toBe(
      "通知需要受支持的浏览器通过 HTTPS 打开，或使用桌面应用。仍可选择仅声音。",
    );
    expect(notificationSettings.update).not.toHaveBeenCalled();
  });

  it("unlocks notification sound and keeps the granted mode", async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal(
      "AudioContext",
      class {
        readonly state = "running";
        readonly resume = resume;
      },
    );

    await act(async () => {
      renderer = render();
    });
    await act(async () => {
      selectOption("notifications-and-sound").props.onClick();
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(notificationSettings.update).toHaveBeenCalledExactlyOnceWith({
      notificationMode: "notifications-and-sound",
    });
  });
});
