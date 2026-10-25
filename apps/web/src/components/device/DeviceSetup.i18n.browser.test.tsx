import { EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
const localeState = vi.hoisted(() => ({ language: "zh-CN" as "zh-CN" | "en", command: vi.fn() }));
vi.mock("~/hooks/useSettings", async (original) => {
  const actual = await original<typeof import("../../hooks/useSettings")>();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  return {
    ...actual,
    useClientSettings: <T,>(selector: (settings: Settings) => T) =>
      selector({ ...actual.getClientSettings(), language: localeState.language }),
  };
});
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => localeState.command,
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
import { I18nProvider } from "../../i18n/I18nProvider";
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";
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

function view() {
  return (
    <I18nProvider>
      <Dialog open>
        <WizardPopup>
          <DeviceSetup environmentId={EnvironmentId.make("environment-local")} state={state} />
        </WizardPopup>
      </Dialog>
    </I18nProvider>
  );
}
function setup() {
  localeState.language = "zh-CN";
  localeState.command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}
describe("device setup localization", () => {
  it("renders the setup wizard copy and advances in Simplified Chinese", async () => {
    setup();
    await using _screen = await render(view());
    await expect.element(page.getByRole("heading", { name: "设置设备" })).toBeVisible();
    await expect
      .element(page.getByText("使用模拟器和仿真器前，先查看此环境中运行的内容。", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("设备中心", { exact: true })).toBeVisible();
    await expect.element(page.getByText("启用设备中心", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "取消" })).toBeVisible();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect.element(page.getByText("检查模拟器支持", { exact: true })).toBeVisible();
  });
  it("follows a language change without remounting the wizard", async () => {
    setup();
    await using screen = await render(view());
    localeState.language = "en";
    await screen.rerender(view());
    await expect.element(page.getByRole("heading", { name: "Set up devices" })).toBeVisible();
    await expect.element(page.getByText("Device hub", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Enable the device hub", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeVisible();
  });
});
