import type { ReactNode } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
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
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: () => "auth-state",
    startProviderAuth: "start",
    respondProviderAuth: "respond",
    completeProviderAuth: "complete",
    cancelProviderAuth: "cancel",
    logoutProviderAuth: "logout",
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ title, description }: { title: ReactNode; description: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      <div>{description}</div>
    </section>
  ),
}));

import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("provider authentication language switching", () => {
  it("updates the live sign-in discovery status when the app language changes", async () => {
    state.language = "en";
    const ui = () => (
      <ProviderAuthenticationSection
        environmentId={EnvironmentId.make("environment")}
        environmentLabel="Laptop"
        instanceId={provider.instanceId}
        provider={provider}
        readOnly={false}
      />
    );
    await using screen = await render(ui());
    await expect
      .element(screen.getByText("Discovering sign-in methods…", { exact: true }))
      .toBeVisible();

    state.language = "zh-CN";
    await screen.rerender(ui());

    await expect.element(screen.getByText("正在查找登录方式…", { exact: true })).toBeVisible();
  });
});
