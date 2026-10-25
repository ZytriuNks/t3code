import type { ReactNode } from "react";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));

vi.mock("../../i18n/I18nProvider", async () => {
  const { translate } = await import("../../i18n/messages");
  return {
    useI18n: () => ({
      language: state.language,
      t: (
        key: import("../../i18n/messages").MessageKey,
        values?: import("../../i18n/messages").MessageValues,
      ) => translate(state.language, key, values),
    }),
  };
});
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => Symbol("providers"),
    providerAuthState: () => Symbol("auth-state"),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("./ProviderAuthenticationSection", () => ({ ProviderAuthenticationSection: () => null }));
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";

vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <div>{description}</div>
      {control}
    </section>
  ),
}));

import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

describe("provider wizard sign-in step language switching", () => {
  it("translates the discovery row and the footer action", async () => {
    state.language = "en";
    const ui = () => (
      <Dialog open>
        <WizardPopup>
          <ProviderWizardAuthenticationStep
            environmentId={EnvironmentId.make("environment")}
            environmentLabel="Laptop"
            instanceId={ProviderInstanceId.make("acpRegistry_kilo")}
            onFinish={() => undefined}
          />
        </WizardPopup>
      </Dialog>
    );
    await using screen = await render(ui());
    await expect.element(page.getByText("Skip for now", { exact: true })).toBeVisible();

    state.language = "zh-CN";
    await screen.rerender(ui());

    await expect.element(page.getByText("账户", { exact: true })).toBeVisible();
    await expect.element(page.getByText("正在查找登录方式…", { exact: true })).toBeVisible();
    await expect.element(page.getByText("暂时跳过", { exact: true })).toBeVisible();
  });
});
