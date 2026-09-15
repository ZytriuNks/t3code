import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({ current: "zh-CN" as "system" | "en" | "zh-CN" }));
const ghostty = vi.hoisted(() => ({
  create: vi.fn(),
  surface: {
    dispose: vi.fn(),
    setFont: vi.fn(async () => undefined),
    setTheme: vi.fn(),
    write: vi.fn(),
  },
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
  useTheme: () => ({ theme: "dark", resolvedTheme: "dark" }),
}));
vi.mock("../ComposerPromptEditor", () => ({ ComposerPromptEditor: () => null }));
vi.mock("@pierre/diffs/ssr", () => ({ preloadPatchFile: async () => [] }));

vi.mock("../ui/select", () => ({ selectTriggerVariants: () => "" }));
vi.mock("../ui/combobox", () => ({
  Combobox: "div",
  ComboboxEmpty: "p",
  ComboboxInput: "input",
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

import { I18nProvider } from "../../i18n/I18nProvider";
import { translate } from "../../i18n/messages";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TerminalFontPreview } from "./SettingsFontPreviews";

let renderer: ReactTestRenderer | undefined;

function localized(node: ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

function renderLocalized(node: ReactNode) {
  // Host refs are null in the test renderer unless a node mock is supplied,
  // and the terminal preview only mounts its surface when the ref resolves.
  return create(localized(node), { createNodeMock: () => ({}) });
}

/** Every text run in the rendered tree, in document order. */
function textContents(): string[] {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      collected.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer!.toJSON());
  return collected;
}

function accessibleNames(): string[] {
  return renderer!.root
    .findAll((node) => typeof node.props["aria-label"] === "string")
    .map((node) => node.props["aria-label"] as string);
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  languageState.current = "zh-CN";
  ghostty.create.mockReset().mockResolvedValue(ghostty.surface);
  ghostty.surface.write.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
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
