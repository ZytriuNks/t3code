import { Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { useI18n } from "../../i18n/I18nProvider";
import { translate } from "../../i18n/messages";
import type { ComposerAccessibleCopy } from "../ComposerPromptEditor";
import { importOpenVsxThemeExtension, searchOpenVsxThemes } from "../../openVsxThemes";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  THEME_FILE_VERSION,
  T3_CHAT_THEME,
} from "../../themePalette";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { toastManager } from "../ui/toast";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TerminalFontPreview, PromptFontPreview } from "./SettingsFontPreviews";
import { ThemeEditorPanel } from "./ThemeEditorPanel";
import { ThemeLibrary } from "./ThemeSettings";
import { ThemeSearchSection } from "./ThemeSearchSection";
import { useThemeEditorStore } from "./themeEditorStore";
import "~/index.css";

vi.mock("../../i18n/I18nProvider", { spy: true });
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("~/terminal/ghostty/surface", () => ({ GhosttyTerminalSurface: { create: vi.fn() } }));
vi.mock("../ThreadTerminalDrawer", () => ({
  terminalThemeFromApp: () => ({ background: "#000000" }),
}));
vi.mock("../../hooks/useTheme", () => ({
  readThemeHalvesRaw: () => ({}),
  useTheme: () => ({ theme: "dark", resolvedTheme: "dark" }),
  useRenderedAppearance: () => "dark",
}));
vi.mock("@pierre/diffs/ssr", () => ({ preloadPatchFile: async () => [] }));
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: ({
    value,
    accessibleCopy: copy,
  }: {
    value: string;
    accessibleCopy: ComposerAccessibleCopy;
  }) => (
    <div>
      <p>{value}</p>
      <button
        type="button"
        aria-label={copy.mentionPreview("apps/web/src/terminal/ghostty/surface.test.ts")}
      >
        surface.test.ts
      </button>
      <button
        type="button"
        aria-label={copy.mentionPreview("apps/web/src/components/settings/SettingsPanels.tsx")}
      >
        SettingsPanels.tsx
      </button>
      <button
        type="button"
        aria-label={`${copy.skillLabel("Frontend Design")}${copy.accessibleLabelSuffix}`}
      >
        Frontend Design
      </button>
      <p>{copy.skillNoDescription}</p>
      <button type="button">{copy.skillViewInstructions}</button>
    </div>
  ),
}));
vi.mock("../../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../../openVsxThemes", () => ({
  importOpenVsxThemeExtension: vi.fn(),
  searchOpenVsxThemes: vi.fn(),
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: vi.fn() },
}));

function setup() {
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
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const locale = Atom.make<"en" | "zh-CN">("zh-CN");
  vi.mocked(useI18n).mockImplementation(function useTestI18n() {
    const language = useAtomValue(locale);
    return { language, preference: language, t: (key, values) => translate(language, key, values) };
  });
  const surface = {
    dispose: vi.fn(),
    setFont: vi.fn(async () => undefined),
    setTheme: vi.fn(),
    write: vi.fn(),
  };
  vi.mocked(GhosttyTerminalSurface.create).mockImplementation(async (mount, options) => {
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", options.inputAriaLabel!);
    const scrollback = document.createElement("div");
    scrollback.setAttribute("role", "log");
    scrollback.setAttribute("aria-label", options.scrollbackAriaLabel!);
    mount.append(input, scrollback);
    surface.dispose.mockImplementation(() => {
      input.remove();
      scrollback.remove();
    });
    return surface as never;
  });
  vi.mocked(searchOpenVsxThemes).mockResolvedValue([]);
  const wrap = (node: ReactNode) => (
    <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
  );
  const english = () => act(() => registry.set(locale, "en"));
  const owned = stack.move();
  return { wrap, english, surface, [Symbol.dispose]: () => owned.dispose() };
}

const libraryProps = {
  initialAppearance: "dark",
  onImportOpenChange: () => undefined,
  refreshTheme: () => undefined,
  setAppearanceMode: () => true,
  setTheme: () => true,
  setThemeHalf: () => true,
  themeHalves: null,
} as const;

function themeLibrary(overrides: Partial<Parameters<typeof ThemeLibrary>[0]> = {}) {
  return (
    <ThemeLibrary
      appearanceMode="system"
      customThemes={getCustomThemes()}
      isImportOpen={false}
      theme={T3_CHAT_THEME.id}
      {...libraryProps}
      {...overrides}
    />
  );
}
function installedTheme() {
  return installCustomTheme(
    parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance: "dark",
      colors: { accent: "#1f6e4a" },
    }),
  );
}

describe("appearance settings localization", () => {
  it("replays the panel preview and updates its accessible action with the language", async () => {
    using fixture = setup();
    await using screen = await render(fixture.wrap(<PanelAnimationsPreview durationMs={0} />));
    const button = screen.getByRole("button", { name: "重放面板动画预览", exact: true });
    const panel = button.element().firstElementChild!;
    await vi.waitFor(() => expect(panel.getBoundingClientRect().width).toBeGreaterThan(0));
    await button.click();
    await vi.waitFor(() => expect(panel.getBoundingClientRect().width).toBe(0));
    await button.click();
    await vi.waitFor(() => expect(panel.getBoundingClientRect().width).toBeGreaterThan(0));
    await fixture.english();
    await expect
      .element(screen.getByRole("button", { name: "Replay panel animation preview", exact: true }))
      .toBeVisible();
  });
  it("draws the terminal transcript and recreates its accessible surface when the language changes", async () => {
    using fixture = setup();
    await using screen = await render(
      fixture.wrap(<TerminalFontPreview family="Menlo" size={12} />),
    );
    await expect
      .element(screen.getByRole("textbox", { name: "终端输入", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("log", { name: "终端回滚区", exact: true }))
      .toBeInTheDocument();
    expect(fixture.surface.write).toHaveBeenCalledWith(expect.stringContaining("vpr dev"));
    await fixture.english();
    await expect
      .element(screen.getByRole("textbox", { name: "Terminal input", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("log", { name: "Terminal scrollback", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("textbox", { name: "终端输入", exact: true }))
      .not.toBeInTheDocument();
  });
  it("translates prompt preview chips while preserving paths and skill names", async () => {
    using fixture = setup();
    await using screen = await render(fixture.wrap(<PromptFontPreview />));
    await expect
      .element(
        screen.getByRole("button", {
          name: "预览 apps/web/src/terminal/ghostty/surface.test.ts",
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", {
          name: "预览 apps/web/src/components/settings/SettingsPanels.tsx",
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "技能 Frontend Design。显示详情", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("此技能暂无描述。", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "查看说明", exact: true }))
      .toBeVisible();
    expect(screen.container.textContent).toContain("apps/web/src/terminal/ghostty/surface.test.ts");
    await fixture.english();
    await expect
      .element(
        screen.getByRole("button", {
          name: "Preview apps/web/src/terminal/ghostty/surface.test.ts",
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Skill Frontend Design. Show details", exact: true }),
      )
      .toBeVisible();
  });
  it("searches and selects fonts in the current language without translating family names", async () => {
    using fixture = setup();
    const onSelect = vi.fn();
    await using screen = await render(
      fixture.wrap(
        <FontFamilyPicker
          ariaLabel="Interface font family"
          defaultFamily="Menlo"
          selectedFamily=""
          onSelect={onSelect}
        />,
      ),
    );
    await screen.getByRole("combobox", { name: "Interface font family", exact: true }).click();
    await expect.element(page.getByPlaceholder("搜索字体…", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: "Menlo 默认", exact: true }))
      .toBeVisible();
    await page.getByPlaceholder("搜索字体…", { exact: true }).fill("no-such-family-xyz");
    await expect.element(page.getByText("未找到字体。", { exact: true })).toBeVisible();
    await fixture.english();
    await expect.element(page.getByPlaceholder("Search fonts…", { exact: true })).toBeVisible();
    await expect.element(page.getByText("No fonts found.", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Search fonts…", { exact: true }).fill("");
    await page.getByRole("option", { name: "Menlo default", exact: true }).click();
    expect(onSelect).toHaveBeenCalledWith("");
  });
});

describe("theme workflow localization", () => {
  it("selects appearance schemes and opens the add and create workflows", async () => {
    using fixture = setup();
    const setAppearanceMode = vi.fn(() => true);
    const onImportOpenChange = vi.fn();
    await using screen = await render(
      fixture.wrap(themeLibrary({ onImportOpenChange, setAppearanceMode })),
    );
    await screen.getByRole("button", { name: "使用深色模式", exact: true }).click();
    expect(setAppearanceMode).toHaveBeenCalledWith("dark");
    await screen.getByRole("button", { name: "添加主题", exact: true }).click();
    expect(onImportOpenChange).toHaveBeenCalledWith(true);
    await screen.getByRole("button", { name: "创建主题", exact: true }).click();
    expect(useThemeEditorStore.getState().session).toMatchObject({
      editingThemeId: null,
      initialAppearance: "dark",
    });
    await fixture.english();
    await expect
      .element(screen.getByRole("group", { name: "Appearance mode", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Follow the system appearance", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Create theme", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Add theme", exact: true }))
      .toBeVisible();
  });
  it("removes a custom theme through its localized confirmation and resets the active theme", async () => {
    using fixture = setup();
    const theme = installedTheme();
    const setTheme = vi.fn(() => true);
    await using screen = await render(
      fixture.wrap(themeLibrary({ customThemes: [theme], setTheme, theme: theme.id })),
    );
    for (const name of ["复制 Aurora", "编辑 Aurora", "导出 Aurora", "移除 Aurora"]) {
      await expect.element(screen.getByRole("button", { name, exact: true })).toBeInTheDocument();
    }
    await screen.getByRole("button", { name: "移除 Aurora", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect
      .element(page.getByText("随时导入其 JSON 文件即可恢复。", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "移除主题", exact: true }).click();
    expect(setTheme).toHaveBeenCalledWith("system");
    expect(getCustomThemes()).toEqual([]);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("imports pasted JSON and reports the original theme name", async () => {
    using fixture = setup();
    const onImportOpenChange = vi.fn();
    await using _screen = await render(
      fixture.wrap(themeLibrary({ isImportOpen: true, onImportOpenChange })),
    );
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    const json = page.getByRole("textbox", { name: "主题 JSON", exact: true });
    expect(json.element().getAttribute("placeholder")).toContain('"name": "Aurora"');
    await json.fill(
      JSON.stringify({
        version: THEME_FILE_VERSION,
        name: "Aurora",
        appearance: "dark",
        colors: { accent: "#1f6e4a" },
      }),
    );
    await dialog.getByRole("button", { name: "添加主题", exact: true }).click();
    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["Aurora"]);
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "success",
      title: "Aurora 已添加",
      description: "现在它是你的深色主题。",
    });
    expect(onImportOpenChange).toHaveBeenCalledWith(false);
  });
  it("searches, sorts and installs community themes without translating extension names", async () => {
    using fixture = setup();
    const dracula = {
      collectionId: "dracula",
      description: "",
      downloadCount: 1_200_000,
      iconUrl: null,
      id: "dracula",
      manifestUrl: "https://example.com/package.json",
      sha256Url: "https://example.com/sha256",
      vsixUrl: "https://example.com/theme.vsix",
      version: "1.0.0",
      license: "MIT",
      name: "Dracula",
      publisher: "Dracula Theme",
      sourceUrl: "https://github.com/dracula/visual-studio-code",
    };
    vi.mocked(searchOpenVsxThemes).mockResolvedValue([dracula]);
    vi.mocked(importOpenVsxThemeExtension).mockResolvedValue([
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "dracula",
        name: "Dracula",
        appearance: "dark",
        colors: { accent: "#ff79c6" },
        collection: { id: "dracula", label: "Dracula" },
      }),
    ]);
    const onInstalled = vi.fn();
    await using screen = await render(
      fixture.wrap(<ThemeSearchSection open onInstalled={onInstalled} />),
    );
    const search = screen.getByRole("searchbox", { name: "搜索 Open VSX 主题", exact: true });
    await search.fill("dracula");
    await search.click();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("button", { name: "安装 Dracula", exact: true }))
      .toBeVisible();
    expect(searchOpenVsxThemes).toHaveBeenCalledWith("dracula", {
      signal: expect.anything(),
      sortBy: "downloadCount",
    });
    await screen.getByRole("combobox", { name: "主题排序", exact: true }).click();
    await expect.element(page.getByRole("option", { name: "下载最多", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "下载最多", exact: true }).click();
    await expect
      .element(screen.getByRole("link", { name: "查看 Dracula 的源代码", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "安装 Dracula", exact: true }).click();
    await vi.waitFor(() =>
      expect(onInstalled).toHaveBeenCalledWith(
        [expect.objectContaining({ id: "dracula", label: "Dracula" })],
        { updated: false },
      ),
    );
    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["Dracula"]);
  });
  it("opens the color picker and filters advanced theme roles with localized controls", async () => {
    using fixture = setup();
    await using screen = await render(
      fixture.wrap(
        <ThemeEditorPanel
          editingTheme={null}
          initialAppearance="dark"
          onOpenChange={() => undefined}
          onSaved={() => true}
          open
          restoreTheme={() => undefined}
        />,
      ),
    );
    await expect
      .element(screen.getByRole("dialog", { name: "创建主题", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByPlaceholder("例如 Aurora", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "选择背景颜色", exact: true }).click();
    await expect
      .element(page.getByRole("slider", { name: "背景 色相", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("group", { name: "背景 饱和度和亮度", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("HEX", { exact: true })).toBeVisible();
    await expect.element(page.getByText("RGB", { exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("switch", { name: /使用高级主题颜色/ }).click();
    await screen.getByRole("textbox", { name: "筛选颜色", exact: true }).fill("终端背景");
    await expect.element(screen.getByText("终端背景", { exact: true })).toBeVisible();
    await screen.getByRole("textbox", { name: "筛选颜色", exact: true }).fill("");
    await screen.getByRole("button", { name: "检查应用颜色", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "取消检查应用颜色", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "取消检查应用颜色", exact: true }).click();
    await fixture.english();
    await expect
      .element(screen.getByRole("dialog", { name: "Create theme", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Inspect app colors", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Choose Background color", exact: true }))
      .toBeVisible();
  });
});
