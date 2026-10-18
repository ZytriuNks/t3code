import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({ current: "zh-CN" as "system" | "en" | "zh-CN" }));
const themeState = vi.hoisted(() => ({
  importOpenVsxThemeExtension: vi.fn(),
  searchOpenVsxThemes: vi.fn(),
  toast: vi.fn(),
}));
const ghostty = vi.hoisted(() => ({
  create: vi.fn(),
  surface: {
    dispose: vi.fn(),
    setFont: vi.fn(async () => undefined),
    setTheme: vi.fn(),
    write: vi.fn(),
  },
}));
// The previews hand their copy to real renderers that need a browser, so the
// renderers are replaced by stand-ins that keep the props they receive.
const composerPreview = vi.hoisted(() => ({
  props: undefined as
    | { readonly accessibleCopy?: ComposerAccessibleCopy; readonly value?: string }
    | undefined,
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector?: (settings: { language: "system" | "en" | "zh-CN" }) => T) =>
    selector ? selector({ language: languageState.current }) : { language: languageState.current },
}));

// The appearance page's previews are real renderers: Lexical for the prompt
// preview, the SSR diff pipeline for the code preview, and the Ghostty WASM
// canvas for the terminal preview. None of them carries the copy under test,
// so each is replaced by the smallest stand-in that keeps them out of this
// test's module graph.
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: { create: ghostty.create },
}));
vi.mock("../ThreadTerminalDrawer", () => ({
  terminalThemeFromApp: () => ({ background: "#000000" }),
}));
vi.mock("../../hooks/useTheme", () => ({
  readThemeHalvesRaw: () => ({}),
  useTheme: () => ({ theme: "dark", resolvedTheme: "dark" }),
}));
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: (props: { readonly accessibleCopy?: ComposerAccessibleCopy }) => {
    composerPreview.props = props;
    return null;
  },
}));
vi.mock("@pierre/diffs/ssr", () => ({ preloadPatchFile: async () => [] }));

// The theme workflow reads published palettes and the Open VSX registry; both
// are external sources, so the copy under test is driven instead.
vi.mock("../../hooks/useEnvironmentTheme", () => ({
  useEnvironmentThemeDefinitions: () => [],
}));
vi.mock("../../openVsxThemes", () => ({
  importOpenVsxThemeExtension: themeState.importOpenVsxThemeExtension,
  searchOpenVsxThemes: themeState.searchOpenVsxThemes,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: themeState.toast },
}));

vi.mock("../ui/select", () => ({
  Select: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  SelectButton: "button",
  SelectItem: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  SelectPopup: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({
    "aria-label": ariaLabel,
    children,
  }: {
    readonly "aria-label"?: string;
    readonly children?: ReactNode;
  }) => <div aria-label={ariaLabel}>{children}</div>,
  SelectValue: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  selectTriggerVariants: () => "",
}));
vi.mock("../ui/combobox", () => ({
  Combobox: "div",
  ComboboxEmpty: "p",
  ComboboxInput: "input",
  ComboboxSearchInput: "input",
  ComboboxItem: "div",
  ComboboxListVirtualized: "div",
  ComboboxPopup: "div",
  ComboboxTrigger: "button",
}));
// The virtualized list renders the rows the picker hands it, so the option
// copy is observable instead of being hidden behind a scroll window.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    readonly data: readonly string[];
    readonly renderItem: (args: { readonly item: string; readonly index: number }) => ReactNode;
  }) => data.map((item, index) => renderItem({ item, index })),
}));

// The theme workflow's popovers, tooltips and dialogs are portalled base-ui
// primitives: each renders its contents inline, and the dialogs keep the
// open/closed contract so a closed dialog contributes no copy. The popup
// markers let a test read one surface's copy without the other surfaces'
// tooltips bleeding into it.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  TooltipProvider: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    readonly render?: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  PopoverPopup: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { readonly render?: ReactNode }) => <>{render}</>,
}));
vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { readonly open?: boolean; readonly children?: ReactNode }) =>
      open ? <div data-theme-import-dialog="">{children}</div> : null,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});
vi.mock("../ui/alert-dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({
      open,
      children,
    }: {
      readonly open?: boolean;
      readonly children?: ReactNode;
    }) => (open ? <div data-theme-alert-dialog="">{children}</div> : null),
    AlertDialogClose: ({
      render,
      children,
    }: {
      readonly render?: ReactElement<{ readonly children?: ReactNode }>;
      readonly children?: ReactNode;
    }) =>
      render ? (
        cloneElement(render, undefined, children)
      ) : (
        <button type="button">{children}</button>
      ),
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogPopup: Container,
    AlertDialogTitle: Container,
  };
});
vi.mock("../ui/input-group", () => ({
  InputGroup: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  InputGroupAddon: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  InputGroupInput: (props: Record<string, unknown> & { readonly size?: unknown }) => {
    const { size: _size, ...inputProps } = props;
    return <input {...inputProps} />;
  },
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    readonly checked?: boolean;
    readonly onCheckedChange?: (checked: boolean) => void;
    readonly [key: string]: unknown;
  }) => (
    <button
      aria-checked={checked}
      aria-label={typeof props["aria-label"] === "string" ? props["aria-label"] : undefined}
      onClick={() => onCheckedChange?.(!checked)}
      role="switch"
      type="button"
    />
  ),
}));
vi.mock("../ui/toggle-group", () => ({
  Toggle: ({
    children,
    value,
    ...props
  }: {
    readonly children?: ReactNode;
    readonly value?: string;
  }) => (
    <button data-value={value} type="button" {...props}>
      {children}
    </button>
  ),
  ToggleGroup: ({
    children,
    ...props
  }: {
    readonly children?: ReactNode;
    readonly value?: ReadonlyArray<string>;
    readonly variant?: string;
    readonly onValueChange?: unknown;
  }) => {
    const {
      value: _value,
      variant: _variant,
      onValueChange: _onValueChange,
      ...groupProps
    } = props;
    return <div {...groupProps}>{children}</div>;
  },
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { translate } from "../../i18n/messages";
import type { ComposerAccessibleCopy } from "../ComposerPromptEditor";
import {
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  THEME_FILE_VERSION,
  T3_CHAT_THEME_ID,
} from "../../themePalette";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TerminalFontPreview, PromptFontPreview } from "./SettingsFontPreviews";
import { ThemeEditorPanel } from "./ThemeEditorPanel";
import { ThemeLibrary } from "./ThemeSettings";
import { ThemeSearchSection } from "./ThemeSearchSection";
import { useThemeEditorStore } from "./themeEditorStore";

let renderer: ReactTestRenderer | undefined;

function localized(node: ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

function renderLocalized(node: ReactNode) {
  // Host refs are null in the test renderer unless a node mock is supplied,
  // and the terminal preview only mounts its surface when the ref resolves.
  return create(localized(node), { createNodeMock: () => ({}) });
}

/** Every string run in a rendered tree, in document order. */
function collectText(node: unknown): string[] {
  const collected: string[] = [];
  const walk = (current: unknown): void => {
    if (typeof current === "string") {
      collected.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (current && typeof current === "object" && "children" in current) {
      walk((current as { children: unknown }).children);
    }
  };
  walk(node);
  return collected;
}

/** Every text run in the rendered tree, in document order. */
function textContents(): string[] {
  return collectText(renderer!.toJSON());
}

function accessibleNames(): string[] {
  return renderer!.root
    .findAll((node) => typeof node.props["aria-label"] === "string")
    .map((node) => node.props["aria-label"] as string);
}

/** The text a rendered host element shows. */
function textOf(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === "string").join("");
}

/** Host elements only: a composite's props carry the props the caller passed. */
function hostNodes(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[] {
  return renderer!.root.findAll((node) => typeof node.type === "string" && predicate(node));
}

function byLabel(ariaLabel: string): ReactTestInstance {
  return renderer!.root.find(
    (node) => typeof node.type === "string" && node.props["aria-label"] === ariaLabel,
  );
}

function byRole(role: string): ReactTestInstance {
  return renderer!.root.find((node) => typeof node.type === "string" && node.props.role === role);
}

function byText(text: string): ReactTestInstance {
  return hostNodes((node) => textOf(node) === text)[0]!;
}

function byMarker(marker: string): ReactTestInstance {
  return renderer!.root.find((node) => node.props[marker] !== undefined);
}

/** A DOM event as far as the click handlers under test read it. */
function press(node: ReactTestInstance): void {
  node.props.onClick({ stopPropagation: () => undefined });
}

function replayButton() {
  return renderer!.root.find((node) => node.type === "button");
}

/** The widths of the panels the preview animates, read from their classes. */
function animatedPanelWidths(): string[] {
  return renderer!.root
    .findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("transition-[width,height,border-width]"),
    )
    .flatMap((node) => String(node.props.className).split(" "))
    .filter((token) => /^w-\d+$/.test(token));
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    documentElement: { lang: "en" },
    getElementById: () => null,
    querySelectorAll: () => [],
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    removeEventListener: vi.fn(),
    setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
  });
  languageState.current = "zh-CN";
  themeState.importOpenVsxThemeExtension.mockReset();
  themeState.searchOpenVsxThemes.mockReset();
  themeState.toast.mockReset();
  ghostty.create.mockReset().mockResolvedValue(ghostty.surface);
  ghostty.surface.write.mockReset();
  composerPreview.props = undefined;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  useThemeEditorStore.getState().closeThemeEditor();
  invalidateCustomThemes();
  vi.unstubAllGlobals();
});

describe("appearance settings localization", () => {
  it("replays the panel animation preview with an action name in the current language", async () => {
    await act(async () => {
      renderer = renderLocalized(<PanelAnimationsPreview durationMs={200} />);
    });

    expect(accessibleNames()).toEqual(["重放面板动画预览"]);
    expect(animatedPanelWidths()).toEqual(["w-4", "w-5"]);

    await act(async () => {
      replayButton().props.onClick();
    });

    // Replaying the preview collapses the side panels it animates.
    expect(animatedPanelWidths()).toEqual(["w-0", "w-0"]);

    languageState.current = "en";
    await act(async () => {
      renderer!.update(localized(<PanelAnimationsPreview durationMs={200} />));
    });

    expect(accessibleNames()).toEqual(["Replay panel animation preview"]);
  });

  it("names the terminal font preview in the current language and still draws its transcript", async () => {
    await act(async () => {
      renderer = renderLocalized(<TerminalFontPreview family="Menlo" size={12} />);
    });

    expect(accessibleNames()).toEqual(["终端字体预览"]);
    expect(ghostty.surface.write).toHaveBeenCalledWith(expect.stringContaining("vpr dev"));

    languageState.current = "en";
    await act(async () => {
      renderer!.update(localized(<TerminalFontPreview family="Menlo" size={12} />));
    });

    expect(accessibleNames()).toEqual(["Terminal font preview"]);
  });

  it("frames the prompt preview's chips in the current language and keeps paths and skill names verbatim", async () => {
    await act(async () => {
      renderer = renderLocalized(<PromptFontPreview />);
    });

    // The preview still shows the real prompt text, chip for chip.
    expect(composerPreview.props?.value).toContain("apps/web/src/terminal/ghostty/surface.test.ts");
    const copy = composerPreview.props?.accessibleCopy;
    expect(copy).toBeDefined();
    expect(copy!.mentionPreview("apps/web/src/terminal/ghostty/surface.test.ts")).toBe(
      "预览 apps/web/src/terminal/ghostty/surface.test.ts",
    );
    expect(copy!.mentionPreview("apps/web/src/components/settings/SettingsPanels.tsx")).toBe(
      "预览 apps/web/src/components/settings/SettingsPanels.tsx",
    );
    expect(`${copy!.skillLabel("Frontend Design")}${copy!.accessibleLabelSuffix}`).toBe(
      "技能 Frontend Design。显示详情",
    );
    expect(copy!.skillNoDescription).toBe("此技能暂无描述。");
    expect(copy!.skillViewInstructions).toBe("查看说明");

    languageState.current = "en";
    await act(async () => {
      renderer!.update(localized(<PromptFontPreview />));
    });

    const english = composerPreview.props!.accessibleCopy!;
    expect(english.mentionPreview("apps/web/src/terminal/ghostty/surface.test.ts")).toBe(
      "Preview apps/web/src/terminal/ghostty/surface.test.ts",
    );
    expect(`${english.skillLabel("Frontend Design")}${english.accessibleLabelSuffix}`).toBe(
      "Skill Frontend Design. Show details",
    );
  });

  it("labels the terminal preview surface's input and scrollback in the current language", async () => {
    await act(async () => {
      renderer = renderLocalized(<TerminalFontPreview family="Menlo" size={12} />);
    });

    expect(ghostty.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputAriaLabel: "终端输入",
        scrollbackAriaLabel: "终端回滚区",
      }),
    );

    languageState.current = "en";
    await act(async () => {
      renderer!.unmount();
      renderer = renderLocalized(<TerminalFontPreview family="Menlo" size={12} />);
    });

    expect(ghostty.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputAriaLabel: "Terminal input",
        scrollbackAriaLabel: "Terminal scrollback",
      }),
    );
  });

  it("keeps the font picker copy in the current language and its family names verbatim", async () => {
    await act(async () => {
      renderer = renderLocalized(
        <FontFamilyPicker
          ariaLabel="Interface font family"
          defaultFamily="Menlo"
          selectedFamily=""
          onSelect={() => undefined}
        />,
      );
    });

    expect(renderer!.root.find((node) => node.type === "input").props.placeholder).toBe(
      "搜索字体…",
    );
    expect(textContents()).toContain("未找到字体。");
    expect(textContents()).toContain("Menlo");
    expect(textContents()).toContain("默认");

    languageState.current = "en";
    await act(async () => {
      renderer!.update(
        localized(
          <FontFamilyPicker
            ariaLabel="Interface font family"
            defaultFamily="Menlo"
            selectedFamily=""
            onSelect={() => undefined}
          />,
        ),
      );
    });

    expect(renderer!.root.find((node) => node.type === "input").props.placeholder).toBe(
      "Search fonts…",
    );
    expect(textContents()).toContain("No fonts found.");
    expect(textContents()).toContain("default");
  });

  it("translates the appearance sections, rows and previews with the shared dictionary", () => {
    expect(translate("zh-CN", "settings.appearance.interface.title")).toBe("界面");
    expect(translate("zh-CN", "settings.appearance.motion.title")).toBe("动效");
    expect(translate("zh-CN", "settings.appearance.typography.title")).toBe("排版");
    expect(translate("zh-CN", "settings.search.item.word-wrap.title")).toBe("自动换行");
    expect(translate("zh-CN", "settings.appearance.motion.replayPreview")).toBe("重放面板动画预览");
    expect(translate("zh-CN", "settings.appearance.environmentIdentification.option.artwork")).toBe(
      "图案",
    );
    expect(translate("zh-CN", "settings.appearance.diffColors.option.redGreen")).toBe("红绿配色");

    expect(translate("en", "settings.appearance.interface.title")).toBe("Interface");
    expect(translate("en", "settings.appearance.motion.title")).toBe("Motion");
    expect(translate("en", "settings.appearance.typography.title")).toBe("Typography");
    expect(translate("en", "settings.search.item.word-wrap.title")).toBe("Word wrap");
    expect(translate("en", "settings.appearance.motion.replayPreview")).toBe(
      "Replay panel animation preview",
    );
    expect(translate("en", "settings.appearance.terminalFont.previewLabel")).toBe(
      "Terminal font preview",
    );
    expect(translate("en", "settings.appearance.promptFont.previewPlaceholder")).toBe(
      "Ask for changes, send follow-ups, or attach images",
    );
  });
});

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
      theme={T3_CHAT_THEME_ID}
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

describe("theme workflow localization", () => {
  it("shows the appearance schemes and theme actions in the current language", async () => {
    const setAppearanceMode = vi.fn(() => true);
    const onImportOpenChange = vi.fn();

    await act(async () => {
      renderer = renderLocalized(themeLibrary({ onImportOpenChange, setAppearanceMode }));
    });

    expect(textContents()).toContain("跟随系统");
    expect(textContents()).toContain("浅色");
    expect(textContents()).toContain("深色");
    expect(textContents()).toContain("配色方案");
    expect(textContents()).toContain("主题");
    expect(textContents()).toContain("创建主题");
    expect(textContents()).toContain("添加主题");
    expect(accessibleNames()).toContain("显示模式");
    expect(accessibleNames()).toContain("跟随系统外观");
    expect(accessibleNames()).toContain("使用浅色模式");
    expect(accessibleNames()).toContain("使用深色模式");

    await act(async () => press(byLabel("使用深色模式")));

    expect(setAppearanceMode).toHaveBeenCalledWith("dark");

    await act(async () => press(byText("添加主题")));

    expect(onImportOpenChange).toHaveBeenCalledWith(true);

    await act(async () => press(byText("创建主题")));

    // Creating still seeds the draft from the theme that is on screen.
    expect(useThemeEditorStore.getState().session).toMatchObject({
      editingThemeId: null,
      initialAppearance: "dark",
    });

    languageState.current = "en";
    await act(async () => {
      renderer!.update(localized(themeLibrary({ onImportOpenChange, setAppearanceMode })));
    });

    expect(textContents()).toContain("System");
    expect(textContents()).toContain("Light");
    expect(textContents()).toContain("Dark");
    expect(textContents()).toContain("Color scheme");
    expect(textContents()).toContain("Themes");
    expect(textContents()).toContain("Create theme");
    expect(textContents()).toContain("Add theme");
    expect(accessibleNames()).toContain("Appearance mode");
    expect(accessibleNames()).toContain("Follow the system appearance");
    expect(accessibleNames()).toContain("Use dark mode");
  });

  it("names a theme card's actions and the removal dialog while keeping the theme name verbatim", async () => {
    const theme = installedTheme();
    const setTheme = vi.fn(() => true);

    await act(async () => {
      renderer = renderLocalized(
        themeLibrary({ customThemes: [theme], setTheme, theme: "aurora" }),
      );
    });

    expect(accessibleNames()).toContain("使用 Aurora 主题");
    expect(accessibleNames()).toContain("将 Aurora 用于深色模式");
    expect(accessibleNames()).toContain("复制 Aurora");
    expect(accessibleNames()).toContain("编辑 Aurora");
    expect(accessibleNames()).toContain("导出 Aurora");
    expect(accessibleNames()).toContain("移除 Aurora");
    expect(textContents()).toContain("Aurora");
    expect(textContents()).not.toContain("移除“Aurora”？");

    await act(async () => press(byLabel("移除 Aurora")));

    const dialog = byMarker("data-theme-alert-dialog");
    expect(collectText(dialog)).toContain("移除“Aurora”？");
    expect(collectText(dialog)).toContain("随时导入其 JSON 文件即可恢复。");
    expect(collectText(dialog)).toContain("取消");
    expect(collectText(dialog)).toContain("移除主题");

    await act(async () =>
      press(dialog.findAllByType("button").find((node) => textOf(node) === "移除主题")!),
    );

    expect(setTheme).toHaveBeenCalledWith("system");
    expect(getCustomThemes()).toEqual([]);
    expect(textContents()).not.toContain("移除“Aurora”？");
  });

  it("imports a pasted theme through the localized dialog and reports its name verbatim", async () => {
    const onImportOpenChange = vi.fn();

    await act(async () => {
      renderer = renderLocalized(themeLibrary({ isImportOpen: true, onImportOpenChange }));
    });

    const dialog = byMarker("data-theme-import-dialog");
    expect(collectText(dialog)).toContain("添加主题");
    expect(collectText(dialog)).toContain("或导入文件");
    expect(collectText(dialog)).toContain("主题 JSON");
    expect(collectText(dialog)).toContain("主题文件");
    expect(collectText(dialog)).toContain("拖放 T3 Code 或 VS Code 的 .json 文件");
    expect(collectText(dialog)).toContain("选择文件");
    expect(collectText(dialog)).toContain("搜索社区主题");
    expect(collectText(dialog)).toContain("热门");
    expect(collectText(dialog)).toContain("取消");
    // The JSON sample stays exactly as the file format spells it.
    expect(dialog.findByType("textarea").props.placeholder).toContain('"name": "Aurora"');
    expect(dialog.findByType("textarea").props["aria-label"]).toBe("主题 JSON");

    await act(async () => {
      dialog.findByType("textarea").props.onChange({
        currentTarget: {
          value: JSON.stringify({
            version: THEME_FILE_VERSION,
            name: "Aurora",
            appearance: "dark",
            colors: { accent: "#1f6e4a" },
          }),
        },
      });
    });

    await act(async () => {
      press(dialog.findAllByType("button").find((node) => textOf(node) === "添加主题")!);
    });

    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["Aurora"]);
    expect(themeState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Aurora 已添加",
      description: "现在它是你的深色主题。",
    });
    expect(onImportOpenChange).toHaveBeenCalledWith(false);
  });

  it("searches and installs Open VSX themes with localized chrome and verbatim extension names", async () => {
    const dracula = {
      collectionId: "dracula",
      description: "",
      downloadCount: 1_200_000,
      iconUrl: undefined,
      id: "dracula",
      name: "Dracula",
      publisher: "Dracula Theme",
      sourceUrl: "https://github.com/dracula/visual-studio-code",
    };
    themeState.searchOpenVsxThemes.mockResolvedValue([dracula]);
    themeState.importOpenVsxThemeExtension.mockResolvedValue([
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

    await act(async () => {
      renderer = renderLocalized(<ThemeSearchSection open onInstalled={onInstalled} />);
    });

    expect(textContents()).toContain("搜索社区主题");
    expect(textContents()).toContain("热门");
    expect(accessibleNames()).toContain("搜索 Open VSX 主题");
    expect(renderer!.root.findByType("input").props.placeholder).toBe("搜索主题...");

    await act(async () => {
      renderer!.root.findByType("input").props.onChange({ currentTarget: { value: "dracula" } });
    });
    await act(async () => {
      renderer!.root
        .findByType("input")
        .props.onKeyDown({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } });
    });

    expect(themeState.searchOpenVsxThemes).toHaveBeenCalledWith("dracula", {
      signal: expect.anything(),
      sortBy: "downloadCount",
    });
    expect(textContents()).toContain("Dracula");
    expect(textContents()).toContain("排序");
    expect(textContents()).toContain("下载最多");
    expect(accessibleNames()).toContain("主题排序");
    expect(
      textContents().some((text) => text.includes("Dracula Theme") && text.includes("次下载")),
    ).toBe(true);
    expect(textContents()).toContain("适用于编辑器的社区配色主题。");
    expect(accessibleNames()).toContain("查看 Dracula 的源代码");
    expect(accessibleNames()).toContain("安装 Dracula");

    await act(async () => press(byLabel("安装 Dracula")));

    expect(themeState.importOpenVsxThemeExtension).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "dracula", label: "Dracula" })],
      { updated: false },
    );
    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["Dracula"]);
  });

  it("labels the theme editor and its color picker in the current language", async () => {
    await act(async () => {
      renderer = renderLocalized(
        <ThemeEditorPanel
          editingTheme={null}
          initialAppearance="dark"
          onOpenChange={() => undefined}
          onSaved={() => true}
          open
          restoreTheme={() => undefined}
        />,
      );
    });

    expect(byRole("dialog").props["aria-label"]).toBe("创建主题");
    expect(textContents()).toContain("创建主题");
    expect(textContents()).toContain("主题名称");
    expect(
      renderer!.root.find(
        (node) => node.type === "input" && typeof node.props.placeholder === "string",
      ).props.placeholder,
    ).toBe("例如 Aurora");
    expect(textContents()).toContain("外观");
    expect(textContents()).toContain("浅色");
    expect(textContents()).toContain("深色");
    expect(textContents()).toContain("颜色");
    expect(textContents()).toContain("两种颜色，其余自动推导");
    expect(textContents()).toContain("高级");
    expect(textContents()).toContain("取消");
    expect(textContents()).toContain("创建主题");
    expect(accessibleNames()).toContain("主题外观");
    expect(accessibleNames()).toContain("使用高级主题颜色");
    expect(accessibleNames()).toContain("检查应用颜色");
    expect(accessibleNames()).toContain("最小化主题编辑器");
    expect(accessibleNames()).toContain("关闭主题编辑器");
    expect(textContents()).toContain("在下方选择颜色");
    // The guided color field and its picker name the role and its controls.
    expect(textContents()).toContain("背景");
    expect(textContents()).toContain("强调色");
    expect(textContents()).toContain("选择颜色");
    expect(accessibleNames()).toContain("显示背景的用途");
    expect(accessibleNames()).toContain("选择背景颜色");
    expect(accessibleNames()).toContain("背景 HEX 值");
    expect(accessibleNames()).toContain("背景 饱和度和亮度");
    expect(accessibleNames()).toContain("背景 色相");
    // HEX and RGB stay the format's own names.
    expect(textContents()).toContain("HEX");
    expect(textContents()).toContain("RGB");

    await act(async () => press(byRole("switch")));

    expect(textContents()).toContain("基础");
    expect(textContents()).toContain("品牌与内容");
    expect(textContents()).toContain("上下文");
    expect(textContents()).toContain("状态");
    expect(textContents()).toContain("上层表面");
    expect(textContents()).toContain("终端背景");
    expect(
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "筛选颜色")
        .props["aria-label"],
    ).toBe("筛选颜色");
    expect(accessibleNames()).toContain("筛选颜色");
    expect(accessibleNames()).toContain("显示表面的用途");

    await act(async () => press(byLabel("检查应用颜色")));

    expect(textContents()).toContain("选择元素 · 按 Esc 取消");
    expect(accessibleNames()).toContain("取消检查应用颜色");

    await act(async () => press(byLabel("取消检查应用颜色")));

    expect(textContents()).toContain("在下方选择颜色");

    languageState.current = "en";
    await act(async () => {
      renderer!.update(
        localized(
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
    });

    expect(byRole("dialog").props["aria-label"]).toBe("Create theme");
    expect(textContents()).toContain("Theme name");
    expect(textContents()).toContain("Appearance");
    expect(textContents()).toContain("Colors");
    expect(textContents()).toContain("Foundation");
    expect(textContents()).toContain("Raised surface");
    expect(accessibleNames()).toContain("Inspect app colors");
    expect(accessibleNames()).toContain("Choose Background color");
  });
});
