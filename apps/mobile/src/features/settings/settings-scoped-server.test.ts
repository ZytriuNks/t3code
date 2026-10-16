import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings as ServerSettingsSchema,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;
const decodeServerSettings = Schema.decodeSync(ServerSettingsSchema);
const encodeServerSettings = Schema.encodeSync(ServerSettingsSchema);

describe("mobile smooth output prerequisites", () => {
  it.each([false, true])(
    "enables the effective restructured layout with smooth output (project=%s)",
    (projectSelected) => {
      const environments = [
        environment(firstId, DEFAULT_SERVER_SETTINGS),
        environment(secondId, {
          ...DEFAULT_SERVER_SETTINGS,
          responseStreamingMode: "paragraph",
          projectSettingsOverrides: { [secondProject]: { responseStreamingMode: "turn" } },
        }),
      ];
      const targets = resolveMobileSettingsTargets(
        environments,
        projectSelected
          ? [
              { environmentId: firstId, id: firstProject },
              { environmentId: secondId, id: secondProject },
            ]
          : null,
      );
      const writes = planMobileScopedSettingsPatch(targets, projectSelected, {
        responseStreamingMode: "smooth",
      });
      expect(writes).toHaveLength(2);
      writes.forEach((write, index) => {
        const original = environments[index]!.serverConfig.settings;
        const patched = applyServerSettingsPatch(original, write.patch);
        const saved = decodeServerSettings(encodeServerSettings(patched));
        const projectId = projectSelected ? targets[index]!.projectId : null;
        expect(resolveProjectSettings(saved, projectId).settings).toMatchObject({
          responseStreamingMode: "smooth",
          conversationStructure: "restructured",
        });
        if (projectSelected) {
          expect(saved.conversationStructure).toBe(original.conversationStructure);
          expect(saved.responseStreamingMode).toBe(original.responseStreamingMode);
        }
      });
    },
  );

  it.each([false, true])(
    "downgrades only each target's effective smooth mode (project=%s)",
    (projectSelected) => {
      const environments = [
        environment(firstId, {
          ...DEFAULT_SERVER_SETTINGS,
          conversationStructure: "restructured",
          responseStreamingMode: projectSelected ? "turn" : "smooth",
          projectSettingsOverrides: { [firstProject]: { responseStreamingMode: "smooth" } },
        }),
        environment(secondId, { ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "paragraph" }),
      ];
      const targets = resolveMobileSettingsTargets(
        environments,
        projectSelected
          ? [
              { environmentId: firstId, id: firstProject },
              { environmentId: secondId, id: secondProject },
            ]
          : null,
      );
      const writes = planMobileScopedSettingsPatch(targets, projectSelected, {
        conversationStructure: "default",
      });
      const saved = writes.map(
        (write, index) =>
          resolveProjectSettings(
            applyServerSettingsPatch(environments[index]!.serverConfig.settings, write.patch),
            projectSelected ? targets[index]!.projectId : null,
          ).settings,
      );
      expect(saved.map((settings) => settings.responseStreamingMode)).toEqual([
        "realtime",
        "paragraph",
      ]);
      expect(saved.map((settings) => settings.conversationStructure)).toEqual([
        "default",
        "default",
      ]);
    },
  );

  it.each(["turn", "paragraph", "realtime"] as const)(
    "keeps the layout unchanged when selecting %s",
    (responseStreamingMode) => {
      const targets = resolveMobileSettingsTargets(
        [environment(firstId, DEFAULT_SERVER_SETTINGS)],
        null,
      );
      const writes = planMobileScopedSettingsPatch(targets, false, { responseStreamingMode });
      expect(applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, writes[0]!.patch)).toMatchObject({
        conversationStructure: DEFAULT_SERVER_SETTINGS.conversationStructure,
        responseStreamingMode,
      });
    },
  );

  it("restores inherited output and layout after enabling smooth output on a project", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph" as const,
      projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
    };
    const members = [{ environmentId: firstId, id: firstProject }];
    const targets = resolveMobileSettingsTargets([environment(firstId, settings)], members);
    const enable = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "smooth",
    });
    const enabled = applyServerSettingsPatch(settings, enable[0]!.patch);
    const clear = planMobileScopedSettingsClear(
      resolveMobileSettingsTargets([environment(firstId, enabled)], members),
      ["responseStreamingMode", "conversationStructure", "enableAgentBrowserAccess"],
    );
    const saved = applyServerSettingsPatch(enabled, clear[0]!.patch);
    expect(resolveProjectSettings(saved, firstProject).settings).toMatchObject({
      conversationStructure: "default",
      responseStreamingMode: "paragraph",
    });
    expect(saved.projectSettingsOverrides[firstProject]).toEqual({ defaultAutoPull: true });
  });

  it.each(["turn", "paragraph", "realtime", "smooth"] as const)(
    "preserves an explicit %s mode alongside a layout patch",
    (responseStreamingMode) => {
      const targets = resolveMobileSettingsTargets(
        [environment(firstId, DEFAULT_SERVER_SETTINGS)],
        null,
      );
      const writes = planMobileScopedSettingsPatch(targets, false, {
        conversationStructure: "default",
        responseStreamingMode,
      });
      expect(applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, writes[0]!.patch)).toMatchObject({
        conversationStructure: "default",
        responseStreamingMode,
      });
    },
  );
});

describe("mobile usage-limit settings across environments", () => {
  it.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "shows %s as mixed and can enable it everywhere without changing other settings",
    (key) => {
      const targets = resolveMobileSettingsTargets(
        [
          environment(firstId, { ...DEFAULT_SERVER_SETTINGS, [key]: true }),
          environment(secondId, { ...DEFAULT_SERVER_SETTINGS, [key]: false }),
        ],
        null,
      );

      expect(uniformMobileSetting(targets, key)).toBeNull();
      const writes = planMobileScopedSettingsPatch(targets, false, { [key]: true });
      expect(writes).toEqual([
        { environmentId: firstId, patch: { [key]: true } },
        { environmentId: secondId, patch: { [key]: true } },
      ]);
      const updatedTargets = targets.map((target) => ({
        ...target,
        settings: {
          ...target.settings,
          [key]:
            writes.find((write) => write.environmentId === target.environment.environmentId)?.patch[
              key
            ] ?? target.settings[key],
        },
      }));
      expect(uniformMobileSetting(updatedTargets, key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(0, 1), key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(1), key)).toBe(false);
      expect(uniformMobileSetting([], key)).toBeNull();
    },
  );
});

function environment(environmentId: EnvironmentId, settings: ServerSettings): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  } as SettingsTarget;
}

describe("mobile project settings scope", () => {
  it("edits each checkout's own override without changing either environment default", () => {
    const firstSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph",
      projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
    };
    const secondSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "turn",
      projectSettingsOverrides: {},
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, firstSettings), environment(secondId, secondSettings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );

    const writes = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "turn",
    });
    expect(writes).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
          },
        },
      },
      {
        environmentId: secondId,
        patch: { projectSettingsOverrides: { [secondProject]: { responseStreamingMode: "turn" } } },
      },
    ]);
    expect(firstSettings.responseStreamingMode).toBe("paragraph");
    expect(secondSettings.responseStreamingMode).toBe("turn");
  });

  it("removes a project override when a picker sends null for a key that cannot store it", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultThreadEnvMode: null })).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultThreadEnvMode: "worktree",
              defaultAutoPull: true,
              defaultModelSelection: null,
            },
          },
        },
      },
    ]);
  });

  it("resets only the selected page's override and rejects environment-wide writes", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );

    expect(planMobileScopedSettingsClear(targets, ["responseStreamingMode"])).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planMobileScopedSettingsPatch(targets, true, { enableProviderUpdateChecks: false }),
    ).toEqual([]);
  });
});
