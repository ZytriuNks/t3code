import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const settingsState = vi.hoisted(() => ({ language: "zh-CN" as "system" | "en" | "zh-CN" }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: typeof settingsState) => T) =>
    selector(settingsState),
}));

import { I18nProvider, useI18n } from "./I18nProvider";

function Probe() {
  const { language, t } = useI18n();
  return <span>{`${language}:${t("settings.language.title")}`}</span>;
}

it("updates translated copy and the document language with the client preference", async () => {
  settingsState.language = "zh-CN";
  const ui = () => (
    <I18nProvider>
      <Probe />
    </I18nProvider>
  );
  await using screen = await render(ui());
  await expect.element(screen.getByText("zh-CN:语言")).toBeVisible();
  expect(document.documentElement.lang).toBe("zh-CN");

  settingsState.language = "en";
  await screen.rerender(ui());
  await expect.element(screen.getByText("en:Language")).toBeVisible();
  expect(document.documentElement.lang).toBe("en");
});
