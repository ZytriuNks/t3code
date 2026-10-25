import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const languageState = vi.hoisted(() => ({ current: "zh-CN" as "en" | "zh-CN" }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: { language: "en" | "zh-CN" }) => T) =>
    selector({ language: languageState.current }),
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { SecretInput } from "./SecretInput";

it("describes a stored secret in the current language", async () => {
  languageState.current = "zh-CN";
  const ui = () => (
    <I18nProvider>
      <SecretInput configured value="" />
    </I18nProvider>
  );
  await using screen = await render(ui());
  await expect.element(screen.getByPlaceholder("已存储密钥，输入新值以替换")).toBeVisible();

  languageState.current = "en";
  await screen.rerender(ui());
  await expect
    .element(screen.getByPlaceholder("Stored secret, enter a new value to replace"))
    .toBeVisible();
});
