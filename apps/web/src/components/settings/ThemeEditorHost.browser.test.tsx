import { Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n/I18nProvider";
import { translate } from "../../i18n/messages";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getThemeDefinition,
  getThemeModes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  themeColorToHex,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../../themePalette";
import { useThemeEditorStore } from "./themeEditorStore";
import { toastManager } from "../ui/toast";
import { ThemeEditorHost } from "./ThemeEditorHost";
import "~/index.css";
vi.mock("../../hooks/useTheme", { spy: true });
vi.mock("../../i18n/I18nProvider", { spy: true });
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

function setup(language: "en" | "zh-CN" = "zh-CN") {
  const stack = new DisposableStack();
  const storage = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  const style = document.documentElement.getAttribute("style");
  const session = useThemeEditorStore.getState().session;
  stack.defer(() => {
    useThemeEditorStore.setState({ session });
    if (storage === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
    else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, storage);
    invalidateCustomThemes();
    if (style === null) document.documentElement.removeAttribute("style");
    else document.documentElement.setAttribute("style", style);
    vi.resetAllMocks();
  });
  localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
  useThemeEditorStore.setState({ session: null });
  vi.mocked(toastManager.add).mockReset();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const locale = Atom.make<"en" | "zh-CN">(language);
  const theme = {
    theme: "system" as ThemePreference,
    themeHalves: null as ThemeHalves | null,
    setTheme: vi.fn().mockReturnValue(true),
    refreshTheme: vi.fn(),
  };
  vi.mocked(useTheme).mockImplementation(() => theme as never);
  vi.mocked(useI18n).mockImplementation(function useTestI18n() {
    const language = useAtomValue(locale);
    return { language, preference: language, t: (key, values) => translate(language, key, values) };
  });
  const view = () => (
    <RegistryContext.Provider value={registry}>
      <ThemeEditorHost />
    </RegistryContext.Provider>
  );
  const open = (
    editingThemeId: string | null = null,
    seedThemeId: string | null = null,
    appearance: ThemeAppearance = "dark",
  ) =>
    act(() =>
      useThemeEditorStore.getState().openThemeEditor({
        editingThemeId,
        seedThemeId,
        seedName: null,
        initialAppearance: appearance,
      }),
    );
  const owned = stack.move();
  return { registry, locale, theme, view, open, [Symbol.dispose]: () => owned.dispose() };
}
function storedTheme(appearance: ThemeAppearance = "dark") {
  return installCustomTheme(
    parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance,
      colors: { accent: "#1f6e4a" },
    }),
  );
}

describe("ThemeEditorHost", () => {
  it.each(["editingTheme", "seedTheme"] as const)(
    "reopens a %s with colors saved since its previous session",
    async (field) => {
      using fixture = setup();
      const { open, view } = fixture;
      const theme = storedTheme();
      await open(
        field === "editingTheme" ? theme.id : null,
        field === "seedTheme" ? theme.id : null,
      );
      await using screen = await render(view());
      await expect.element(screen.getByRole("dialog")).toBeVisible();
      expect((screen.container.querySelector("#accent-hex") as HTMLInputElement).value).toBe(
        "#1f6e4a",
      );
      await act(() =>
        updateCustomTheme({ ...theme, colors: { ...theme.colors, accent: "#7241b8" } }),
      );
      await screen.getByRole("button", { name: "关闭主题编辑器", exact: true }).click();
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      await open(
        field === "editingTheme" ? theme.id : null,
        field === "seedTheme" ? theme.id : null,
      );
      await expect.element(screen.getByRole("dialog")).toBeVisible();
      expect((screen.container.querySelector("#accent-hex") as HTMLInputElement).value).toBe(
        "#7241b8",
      );
    },
  );
  it("creates a new theme when the edited theme is removed from the library", async () => {
    using fixture = setup();
    const theme = storedTheme();
    await fixture.open(theme.id);
    await using screen = await render(fixture.view());
    await expect
      .element(screen.getByRole("heading", { name: "编辑主题", exact: true }))
      .toBeVisible();
    await act(() => removeCustomTheme(theme.id));
    await expect
      .element(screen.getByRole("heading", { name: "创建主题", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "创建主题", exact: true }).click();
    expect(fixture.theme.setTheme).toHaveBeenCalledWith("aurora");
    expect(getThemeDefinition("aurora")).not.toBeNull();
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "success",
      title: "Aurora 已创建",
      description: "现已启用。",
    });
  });
  it("creates and activates a theme with a verbatim name in Chinese", async () => {
    using fixture = setup();
    await fixture.open();
    await using screen = await render(fixture.view());
    await screen.getByRole("textbox", { name: "主题名称", exact: true }).fill("Aurora");
    await screen.getByRole("button", { name: "创建主题", exact: true }).click();
    expect(fixture.theme.setTheme).toHaveBeenCalledWith("aurora");
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "success",
      title: "Aurora 已创建",
      description: "现已启用。",
    });
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("merges a dark palette into an existing light theme and activates it", async () => {
    using fixture = setup();
    storedTheme("light");
    await fixture.open();
    await using screen = await render(fixture.view());
    await screen.getByRole("textbox", { name: "主题名称", exact: true }).fill("Aurora");
    await screen.getByRole("button", { name: "添加深色配色", exact: true }).click();
    expect(fixture.theme.setTheme).toHaveBeenCalledWith("aurora");
    expect(getThemeModes(getThemeDefinition("aurora")!)).toEqual(["light", "dark"]);
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "success",
      title: "Aurora 已更新",
      description: "已添加其深色配色。",
    });
  });
  it("keeps the editor open and rolls back a new theme when activation fails", async () => {
    using fixture = setup();
    fixture.theme.setTheme.mockReturnValue(false);
    await fixture.open();
    await using screen = await render(fixture.view());
    await screen.getByRole("textbox", { name: "主题名称", exact: true }).fill("Aurora");
    await screen.getByRole("button", { name: "创建主题", exact: true }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(getThemeDefinition("aurora")).toBeNull();
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "error",
      title: "无法保存主题",
      description: "浏览器存储不可用，因此更改未保存。",
    });
  });
  it("refreshes an edited theme used by a mixed appearance without clearing that preference", async () => {
    using fixture = setup();
    const theme = storedTheme();
    fixture.theme.themeHalves = { light: "light", dark: theme.id };
    await fixture.open(theme.id);
    await using screen = await render(fixture.view());
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const accent = screen.container.querySelector<HTMLInputElement>("#accent-hex")!;
    await screen
      .getByLabelText(accent.getAttribute("aria-label")!, { exact: true })
      .fill("#7241b8");
    await screen.getByRole("button", { name: "保存更改", exact: true }).click();
    expect(fixture.theme.refreshTheme).toHaveBeenCalled();
    expect(fixture.theme.setTheme).not.toHaveBeenCalled();
    expect(themeColorToHex(getThemeDefinition(theme.id)!.colors.accent)).toBe("#7241b8");
  });
  it("reports an inactive theme save in English without activating it", async () => {
    using fixture = setup("en");
    const theme = storedTheme();
    await fixture.open(theme.id);
    await using screen = await render(fixture.view());
    await screen.getByRole("button", { name: "Save changes", exact: true }).click();
    // 关闭预览会恢复当前配色；保存未启用的主题不应再额外刷新。
    expect(fixture.theme.refreshTheme).toHaveBeenCalledTimes(1);
    expect(fixture.theme.setTheme).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "success",
      title: "Aurora saved",
      description: "Your changes are saved.",
    });
  });
});
