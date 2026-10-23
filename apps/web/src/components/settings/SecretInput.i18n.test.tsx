import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({ current: "zh-CN" as "en" | "zh-CN" }));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector?: (settings: { language: "en" | "zh-CN" }) => T) =>
    selector ? selector({ language: languageState.current }) : { language: languageState.current },
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { SecretInput } from "./SecretInput";

let renderer: ReactTestRenderer | undefined;

function tree() {
  return (
    <I18nProvider>
      <SecretInput configured value="" />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  languageState.current = "zh-CN";
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("SecretInput localization", () => {
  it("describes a stored secret in the current language", async () => {
    await act(async () => {
      renderer = create(tree());
    });
    expect(renderer!.root.findByType("input").props.placeholder).toBe("已存储密钥，输入新值以替换");

    languageState.current = "en";
    await act(async () => renderer!.update(tree()));
    expect(renderer!.root.findByType("input").props.placeholder).toBe(
      "Stored secret, enter a new value to replace",
    );
  });
});
