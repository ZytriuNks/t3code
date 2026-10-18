import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const settingsState = vi.hoisted(() => ({ language: "zh-CN" as "system" | "en" | "zh-CN" }));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: typeof settingsState) => T) =>
    selector(settingsState),
}));

import { I18nProvider, useI18n } from "./I18nProvider";

let renderer: ReactTestRenderer | undefined;

function Probe() {
  const { language, t } = useI18n();
  return <span>{`${language}:${t("settings.language.title")}`}</span>;
}

function renderProvider(children: ReactNode) {
  return create(<I18nProvider>{children}</I18nProvider>);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  settingsState.language = "zh-CN";
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("I18nProvider", () => {
  it("updates translated copy and the document language with the client preference", async () => {
    await act(() => {
      renderer = renderProvider(<Probe />);
    });

    expect(renderer!.toJSON()).toMatchObject({ children: ["zh-CN:语言"] });
    expect(document.documentElement.lang).toBe("zh-CN");

    settingsState.language = "en";
    await act(() => {
      renderer!.update(
        <I18nProvider>
          <Probe />
        </I18nProvider>,
      );
    });

    expect(renderer!.toJSON()).toMatchObject({ children: ["en:Language"] });
    expect(document.documentElement.lang).toBe("en");
  });
});
