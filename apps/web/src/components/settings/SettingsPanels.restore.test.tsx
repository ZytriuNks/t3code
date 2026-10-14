import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../i18n/I18nProvider", async () => {
  const { translate } = await import("../../i18n/messages");
  return {
    useI18n: () => ({
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
        translate("en", key, values),
    }),
  };
});

vi.mock("../../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTheme")>()),
  useTheme: () => ({
    theme: "system",
    followSystem: true,
    themeHalves: null,
    setTheme: vi.fn(),
    setFollowSystem: vi.fn(),
    setThemeHalf: vi.fn(),
    clearThemeHalves: vi.fn(),
  }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
}));

vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./SettingsPanels";

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
});

describe("restoring V2 settings", () => {
  it("detects and restores a changed text fade duration", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, smoothTextFadeDurationMs: 420 };
    hooks.beginRender();
    const restore = useSettingsRestore();
    expect(restore.changedSettingLabels).toEqual(["Text fade duration"]);
    await restore.restoreDefaults();
    expect(state.update.mock.calls[0]?.[0].smoothTextFadeDurationMs).toBe(200);
  });

  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Auto-resume limited threads"],
    ["snoozeLimitedThreads", "Snooze limited threads"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);
    hooks.beginRender();

    await useSettingsRestore().restoreDefaults();

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("detects and restores the line animation without changing the output unit", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, smoothOutputLineMode: "parallel" };
    hooks.beginRender();
    const restore = useSettingsRestore();
    expect(restore.changedSettingLabels).toEqual(["Line animation"]);

    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain("Line animation");
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({
      smoothOutputLineMode: "adaptive",
      smoothOutputMode: DEFAULT_UNIFIED_SETTINGS.smoothOutputMode,
    });
  });
  it("detects disabled Markdown preload and restores its enabled default", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, smoothMarkdownPreload: false };
    hooks.beginRender();
    const restore = useSettingsRestore();
    expect(restore.changedSettingLabels).toEqual(["Preload Markdown formatting"]);
    await restore.restoreDefaults();
    expect(state.update.mock.calls[0]?.[0].smoothMarkdownPreload).toBe(true);
  });
  it("restores automatic footnote collapse to its default expanded behavior", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, footnotesAutoCollapse: true };
    hooks.beginRender();
    const restore = useSettingsRestore();
    expect(restore.changedSettingLabels).toEqual(["Automatically collapse footnotes"]);
    await restore.restoreDefaults();
    expect(state.update.mock.calls[0]?.[0].footnotesAutoCollapse).toBe(false);
  });

  it("restores the no-project chats base directory", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, scratchBaseDirectory: "~/Chats" };
    hooks.beginRender();
    const restore = useSettingsRestore();
    expect(restore.changedSettingLabels).toEqual(["No-project chats base directory"]);
    await restore.restoreDefaults();
    expect(state.update.mock.calls[0]?.[0].scratchBaseDirectory).toBe("");
  });
});
