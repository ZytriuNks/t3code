// @vitest-environment jsdom
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";

const state = vi.hoisted(() => ({
  updateSettings: vi.fn(async () => ({ _tag: "Success" as const })),
  writable: new Set<string>(),
  filter: {
    selectedTargets: [] as SettingsTarget[],
    projectGroups: [] as {
      key: string;
      label: string;
      members: { project: { environmentId: EnvironmentId; id: ProjectId } }[];
    }[],
    selectedProjectKey: null as string | null,
  },
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: (props: { readonly children?: unknown }) =>
      createElement("div", null, props.children as never),
    ScrollView: (props: { readonly children?: unknown }) =>
      createElement("div", null, props.children as never),
    Pressable: (props: {
      readonly children?: unknown;
      readonly disabled?: boolean;
      readonly accessibilityLabel?: string;
      readonly onPress?: () => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          disabled: props.disabled,
          "aria-label": props.accessibilityLabel,
          onClick: props.onPress,
        },
        props.children as never,
      ),
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../components/ScreenScrollView", async () => {
  const { createElement } = await import("react");
  return {
    ScreenScrollView: (props: { readonly children?: unknown }) =>
      createElement("div", null, props.children as never),
  };
});
vi.mock("../../components/AppText", async () => {
  const { createElement } = await import("react");
  return {
    AppText: (props: { readonly children?: unknown }) =>
      createElement("span", null, props.children as never),
    AppTextInput: (props: { readonly value?: string }) =>
      createElement("input", { value: props.value }),
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.updateSettings,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string) => state.writable.has(environmentId),
  useEnvironmentsWithScope: (targets: readonly { readonly environmentId: string }[]) =>
    new Set(
      targets
        .map((target) => target.environmentId)
        .filter((environmentId) => state.writable.has(environmentId)),
    ),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => state.filter,
}));
vi.mock("./components/SettingsRow", async () => {
  const { createElement } = await import("react");
  return {
    SettingsRow: (props: { readonly label: string; readonly value?: string }) =>
      createElement("div", null, props.label, props.value ?? null),
  };
});
vi.mock("./components/SettingsEnvironmentFilterHeader", async () => {
  const { createElement } = await import("react");
  const Empty = () => createElement("div", null);
  return { AndroidSettingsEnvironmentFilter: Empty, SettingsEnvironmentFilterHeader: Empty };
});
vi.mock("./components/SettingsScreen", async () => {
  const { createElement } = await import("react");
  return {
    SettingsScreen: (props: { readonly title?: string; readonly children?: unknown }) =>
      createElement(
        "div",
        { "data-title": props.title },
        props.title ? createElement("h1", null, props.title) : null,
        props.children as never,
      ),
  };
});
vi.mock("./components/SettingsSection", async () => {
  const { createElement } = await import("react");
  return {
    SettingsSection: (props: {
      readonly title?: string;
      readonly children?: unknown;
      readonly trailing?: unknown;
    }) =>
      createElement(
        "section",
        { "data-section": props.title },
        props.title ? createElement("h2", null, props.title) : null,
        props.trailing as never,
        props.children as never,
      ),
  };
});
vi.mock("./components/SettingsChoiceRow", async () => {
  const { createElement } = await import("react");
  return {
    SettingsChoiceRow: (props: {
      readonly label: string;
      readonly description?: string;
      readonly selected: boolean;
      readonly disabled?: boolean;
      readonly onPress: () => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "data-choice": props.label,
          "data-selected": props.selected ? "true" : "false",
          "aria-label": props.label,
          title: props.description,
          disabled: props.disabled,
          onClick: props.onPress,
        },
        props.label,
      ),
  };
});
vi.mock("./components/SettingsSwitchRow", async () => {
  const { createElement } = await import("react");
  return {
    SettingsSwitchRow: (props: {
      readonly label: string;
      readonly subtitle?: string;
      readonly value?: boolean;
      readonly disabled?: boolean;
      readonly onValueChange?: (value: boolean) => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "data-switch": props.label,
          "aria-label": props.label,
          title: props.subtitle,
          disabled: props.disabled,
          onClick: () => props.onValueChange?.(!props.value),
        },
        props.label,
      ),
  };
});
vi.mock("./components/SettingsProjectOverridesSection", async () => {
  const { createElement } = await import("react");
  return {
    SettingsProjectOverridesSection: (props: {
      readonly projectLabel: string;
      readonly hasOverrides: boolean;
      readonly supportsOverrides: boolean;
      readonly disabled?: boolean;
      readonly onClear: () => void;
    }) =>
      createElement(
        "section",
        {
          "data-overrides": props.hasOverrides ? "true" : "false",
          "data-supports-overrides": props.supportsOverrides ? "true" : "false",
        },
        createElement("span", null, props.projectLabel),
        props.hasOverrides
          ? createElement(
              "button",
              {
                type: "button",
                "aria-label": "Use environment defaults",
                disabled: props.disabled,
                onClick: props.onClear,
              },
              "Use defaults",
            )
          : null,
      ),
  };
});
vi.mock("./components/BranchNamingSettings", async () => {
  const { createElement } = await import("react");
  return {
    BranchNamingSettings: () => createElement("div", null, "Branch naming settings"),
  };
});

import {
  SettingsEnvironmentAgentBehaviorRouteScreen,
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsEnvironmentSourceControlRouteScreen,
} from "./SettingsServerControlsRouteScreen";

function settingsTarget(
  environmentId: EnvironmentId,
  settings: Partial<ServerSettings> = {},
): SettingsTarget {
  return {
    environmentId,
    label: `env-${environmentId}`,
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
      environment: {
        capabilities: { projectSettingsOverrides: true, threadRestartContinuation: true },
      },
    },
  } as SettingsTarget;
}

const serverId = EnvironmentId.make("server");
const laptopId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");

const projectGroup = {
  key: "project-group",
  label: "Project",
  members: [
    { project: { environmentId: serverId, id: projectId } },
    { project: { environmentId: laptopId, id: laptopProjectId } },
  ],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.updateSettings.mockClear();
  state.writable = new Set([String(serverId), String(laptopId)]);
  state.filter = { selectedTargets: [], projectGroups: [], selectedProjectKey: null };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderScreen(element: React.ReactElement) {
  await act(async () => root.render(element));
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
}

async function press(label: string) {
  const candidate = button(label);
  expect(candidate, `button ${label}`).toBeDefined();
  await act(async () => candidate!.click());
}

describe("agent behavior page", () => {
  it("offers realtime and smooth output next to the finished-turn modes", async () => {
    state.filter.selectedTargets = [settingsTarget(serverId)];
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    const labels = [...container.querySelectorAll("[data-choice]")].map((row) =>
      row.getAttribute("data-choice"),
    );
    expect(labels).toEqual([
      "After the turn",
      "Finished paragraphs",
      "Real-time output",
      "Smooth output",
      "Current layout",
      "Restructured",
    ]);
  });

  it("writes smooth output with the restructured layout it needs", async () => {
    state.filter.selectedTargets = [settingsTarget(serverId)];
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    await press("Smooth output");
    expect(state.updateSettings.mock.calls).toEqual([
      [
        {
          environmentId: serverId,
          input: {
            patch: { responseStreamingMode: "smooth", conversationStructure: "restructured" },
          },
        },
      ],
    ]);
  });

  it("leaves smooth output when the current layout is chosen", async () => {
    state.filter.selectedTargets = [
      settingsTarget(serverId, {
        conversationStructure: "restructured",
        responseStreamingMode: "smooth",
      }),
    ];
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    await press("Current layout");
    expect(state.updateSettings.mock.calls).toEqual([
      [
        {
          environmentId: serverId,
          input: { patch: { conversationStructure: "default", responseStreamingMode: "realtime" } },
        },
      ],
    ]);
  });

  it("writes the layout per selected checkout at project scope", async () => {
    state.filter.selectedTargets = [settingsTarget(serverId), settingsTarget(laptopId)];
    state.filter.projectGroups = [projectGroup];
    state.filter.selectedProjectKey = projectGroup.key;
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    await press("Smooth output");
    expect(state.updateSettings.mock.calls).toEqual([
      [
        {
          environmentId: serverId,
          input: {
            patch: {
              projectSettingsOverrides: {
                [projectId]: {
                  responseStreamingMode: "smooth",
                  conversationStructure: "restructured",
                },
              },
            },
          },
        },
      ],
      [
        {
          environmentId: laptopId,
          input: {
            patch: {
              projectSettingsOverrides: {
                [laptopProjectId]: {
                  responseStreamingMode: "smooth",
                  conversationStructure: "restructured",
                },
              },
            },
          },
        },
      ],
    ]);
  });

  it("uses defaults to clear every layout and smooth output override key", async () => {
    state.filter.selectedTargets = [
      settingsTarget(serverId, {
        projectSettingsOverrides: {
          [projectId]: {
            smoothTextYieldDurationMs: 250,
            smoothTextFadeDurationMs: 120,
            footnotesAutoCollapse: true,
            conversationStructure: "restructured",
            responseStreamingMode: "smooth",
            defaultAutoPull: true,
          },
        },
      }),
    ];
    state.filter.projectGroups = [
      {
        key: "single",
        label: "Single",
        members: [{ project: { environmentId: serverId, id: projectId } }],
      },
    ];
    state.filter.selectedProjectKey = "single";
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    expect(container.querySelector('[data-overrides="true"]')).not.toBeNull();
    await press("Use defaults");
    expect(state.updateSettings.mock.calls).toEqual([
      [
        {
          environmentId: serverId,
          input: {
            patch: { projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } } },
          },
        },
      ],
    ]);
  });

  it("still detects the layout reset when only a smooth tuning key is overridden", async () => {
    state.filter.selectedTargets = [
      settingsTarget(serverId, {
        projectSettingsOverrides: { [projectId]: { smoothTextYieldDurationMs: 250 } },
      }),
    ];
    state.filter.projectGroups = [
      {
        key: "single",
        label: "Single",
        members: [{ project: { environmentId: serverId, id: projectId } }],
      },
    ];
    state.filter.selectedProjectKey = "single";
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    expect(container.querySelector('[data-overrides="true"]')).not.toBeNull();
  });

  it("disables the choices without the settings write scope", async () => {
    state.writable = new Set();
    state.filter.selectedTargets = [settingsTarget(serverId)];
    await renderScreen(<SettingsEnvironmentAgentBehaviorRouteScreen />);
    const realtime = button("Real-time output");
    expect(realtime?.disabled).toBe(true);
    await act(async () => realtime!.click());
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("refuses environment-wide keys at project scope", async () => {
    state.filter.selectedTargets = [settingsTarget(serverId)];
    state.filter.projectGroups = [projectGroup];
    state.filter.selectedProjectKey = projectGroup.key;
    await renderScreen(<SettingsEnvironmentMaintenanceRouteScreen />);
    expect(button("Check provider updates")?.disabled).toBe(true);
  });
});

describe("source control page", () => {
  it("keeps the upstream branch naming and agent credit controls", async () => {
    state.filter.selectedTargets = [settingsTarget(serverId)];
    await renderScreen(<SettingsEnvironmentSourceControlRouteScreen />);
    expect(container.textContent).toContain("Branch naming settings");
    expect(button("Remove agent credits when merging")).toBeDefined();
    expect(button("Start from origin")).toBeDefined();
  });
});
