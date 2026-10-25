import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { planScopedSettingsPatch, persistScopedSettingsPatch } from "./scopedSettings";
import { resolveSettingsScope, type ResolvedSettingsScope } from "./settingsScope";
import { describe, expect, it, vi } from "vite-plus/test";

import { useLayoutEffect } from "react";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  scope: null as ResolvedSettingsScope | null,
  locale: "en" as "en" | "zh-CN",
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../i18n/I18nProvider", async () => {
  const { translate } = await import("../../i18n/messages");
  return {
    useI18n: () => ({
      t: (
        key: import("../../i18n/messages").MessageKey,
        values?: import("../../i18n/messages").MessageValues,
      ) => translate(state.locale, key, values),
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

vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({ scope: state.scope ?? { kind: "all" } }),
}));

vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./SettingsPanels";

function setup() {
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.scope = null;
  state.update.mockReset();
  state.locale = "en";
  state.confirm.mockReset().mockResolvedValue(true);
}

async function mountRestore() {
  let current!: ReturnType<typeof useSettingsRestore>;
  function Probe() {
    const restore = useSettingsRestore();
    useLayoutEffect(() => {
      current = restore;
    });
    return <output>{restore.changedSettingLabels.join(", ")}</output>;
  }
  const screen = await render(<Probe />);
  const rerender = screen.rerender;
  return Object.assign(screen, {
    current: () => current,
    rerender: () => rerender(<Probe />),
  });
}

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Auto-resume limited threads"],
    ["snoozeLimitedThreads", "Snooze limited threads"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    setup();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    await using fixture = await mountRestore();
    const restore = fixture.current();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it.each([
    ["language", "zh-CN", "Language"],
    ["autoExpandThreadDetailsPanel", false, "Automatically expand workspace details"],
    ["hideUnavailableContextMenuItems", true, "Hide unavailable context menu items"],
    ["scratchBaseDirectory", "D:/isolated/scratch", "No-project chats base directory"],
    ["legacySidebarEnabled", true, "Sidebar (legacy)"],
    ["legacySidebarProjectGuides", false, "Indentation guides"],
    ["legacySidebarThreadStatusDots", true, "Thread status dots"],
    ["legacySidebarHideStatusLabels", true, "Hide thread status labels"],
  ] as const)("restores the fork setting %s after confirmation", async (key, value, label) => {
    setup();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: value };
    await using fixture = await mountRestore();
    const restore = fixture.current();
    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();
    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("refreshes the reset summary and confirmation when the app language changes", async () => {
    setup();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, language: "zh-CN" };
    await using fixture = await mountRestore();
    expect(fixture.current().changedSettingLabels).toEqual(["Language"]);

    state.locale = "zh-CN";
    await fixture.rerender();
    const restore = fixture.current();
    expect(restore.changedSettingLabels).toEqual(["语言"]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain("恢复默认设置？");
    expect(state.confirm.mock.calls[0]?.[0]).toContain("将重置：语言。");
    expect(state.update.mock.calls[0]?.[0].language).toBe(DEFAULT_UNIFIED_SETTINGS.language);
  });

  it.each(["project", "checkout"] as const)(
    "restores local and project settings through the real planner at %s scope",
    async (kind) => {
      setup();
      const environmentId = EnvironmentId.make("restore-environment");
      const projectId = ProjectId.make("restore-project");
      const member = {
        id: projectId,
        environmentId,
        title: "Restore project",
        workspaceRoot: "/restore-project",
        physicalProjectKey: `${environmentId}:/restore-project`,
        environmentLabel: "Restore environment",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
      };
      const group: SidebarProjectSnapshot = {
        ...member,
        projectKey: "restore-group",
        displayName: member.title,
        memberProjects: [member],
        memberProjectRefs: [{ environmentId, projectId }],
        groupedProjectCount: 1,
        environmentPresence: "remote-only",
        allRemoteMembersAreDesktopLocal: false,
        allRemoteMembersAreWsl: false,
        remoteEnvironmentLabels: [member.environmentLabel],
      };
      let saved: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        scratchBaseDirectory: "D:/environment-only",
        projectSettingsOverrides: {
          [projectId]: {
            conversationStructure: "restructured" as const,
            smoothTextFadeDurationMs: 450,
            defaultAutoPull: true,
          },
        },
      };
      const environments = [
        {
          environmentId,
          label: member.environmentLabel,
          connection: { phase: "connected" as const },
          serverConfig: {
            settings: saved,
            environment: { capabilities: { projectSettingsOverrides: true } },
          },
        },
      ];
      const scope = resolveSettingsScope(
        {
          project: group.projectKey,
          ...(kind === "checkout" ? { checkout: member.physicalProjectKey } : {}),
        },
        [group],
        environments,
      );
      state.scope = scope;
      state.settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        ...resolveProjectSettings(saved, projectId).settings,
        favorites: [],
        providerModelPreferences: {},
        language: "zh-CN",
      };
      let persisted: ReturnType<typeof persistScopedSettingsPatch> | undefined;
      let localLanguage = "zh-CN";
      state.update.mockImplementation((patch) => {
        persisted = persistScopedSettingsPatch(
          planScopedSettingsPatch(scope, environments, patch),
          async ({ input }) => {
            saved = applyServerSettingsPatch(saved, input.patch);
            return { _tag: "Success", value: saved };
          },
          (clientPatch) => {
            localLanguage = clientPatch.language ?? localLanguage;
          },
        );
      });
      await using fixture = await mountRestore();
      const restore = fixture.current();
      await restore.restoreDefaults();
      await persisted;

      expect(resolveProjectSettings(saved, projectId).settings).toMatchObject({
        conversationStructure: DEFAULT_SERVER_SETTINGS.conversationStructure,
        smoothTextFadeDurationMs: DEFAULT_SERVER_SETTINGS.smoothTextFadeDurationMs,
        defaultAutoPull: true,
      });
      expect(localLanguage).toBe(DEFAULT_UNIFIED_SETTINGS.language);
      expect(saved.scratchBaseDirectory).toBe("D:/environment-only");
      expect(restore.changedSettingLabels).not.toContain("No-project chats base directory");
      expect(state.confirm.mock.calls[0]?.[0]).not.toContain("No-project chats base directory");
    },
  );

  it("does not reset settings after cancellation", async () => {
    setup();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);
    await using fixture = await mountRestore();
    await fixture.current().restoreDefaults();

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
