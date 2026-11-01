import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";

const state = vi.hoisted(() => ({
  updateSettings: vi.fn(async () => ({ _tag: "Success" as const })),
  filter: {
    selectedTargets: [] as SettingsTarget[],
    projectGroups: [] as { key: string; label: string; members: unknown[] }[],
    selectedProjectKey: null as string | null,
  },
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: (props: { readonly children?: unknown }) =>
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
  };
});
vi.mock("../../components/ui/AppText", async () => {
  const { createElement } = await import("react");
  return {
    AppText: (props: { readonly children?: unknown }) =>
      createElement("span", null, props.children as never),
    AppTextInput: (props: {
      readonly value?: string;
      readonly accessibilityLabel?: string;
      readonly onChangeText?: (value: string) => void;
    }) =>
      createElement("input", {
        "data-scratch-input": "true",
        "aria-label": props.accessibilityLabel,
        value: props.value ?? "",
        onInput: (event: { currentTarget: { value: string } }) =>
          props.onChangeText?.(event.currentTarget.value),
      }),
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.updateSettings,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => state.filter,
}));
vi.mock("./components/SettingsSection", async () => {
  const { createElement } = await import("react");
  return {
    SettingsSection: (props: { readonly title?: string; readonly children?: unknown }) =>
      createElement(
        "section",
        { "data-section": props.title },
        props.title ? createElement("h2", null, props.title) : null,
        props.children as never,
      ),
  };
});

import { ScratchBaseDirectorySettings } from "./ScratchBaseDirectorySettings";

function settingsTarget(
  environmentId: EnvironmentId,
  settings: Partial<ServerSettings> = {},
  scratchSupported = true,
): SettingsTarget {
  return {
    environmentId,
    label: `env-${environmentId}`,
    connection: { phase: "connected" },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
      environment: {
        capabilities: { projectSettingsOverrides: true, threadAutoSettlement: true },
      },
      ...(scratchSupported ? { scratchWorkspaceRoot: "/scratch" } : {}),
    },
  } as SettingsTarget;
}

const serverId = EnvironmentId.make("server");
const projectGroup = { key: "project", label: "Project", members: [] };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.updateSettings.mockClear();
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

async function renderThreads() {
  await act(async () => root.render(<ScratchBaseDirectorySettings />));
}

async function typeIntoScratchInput(value: string) {
  const input = container.querySelector<HTMLInputElement>("[data-scratch-input]");
  expect(input).not.toBeNull();
  await act(async () => {
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
}

it("shows the no-project chats base directory on an environment that supports scratch folders", async () => {
  state.filter.selectedTargets = [settingsTarget(serverId, { scratchBaseDirectory: "" })];
  await renderThreads();
  expect(container.textContent).toContain("No-project chats");
  expect(
    container.querySelector('[aria-label="No-project chats base directory on env-server"]'),
  ).not.toBeNull();
});

it("saves a new no-project chats base directory", async () => {
  state.filter.selectedTargets = [settingsTarget(serverId)];
  await renderThreads();
  await typeIntoScratchInput("/srv/scratch");
  const save = button("Save");
  expect(save).toBeDefined();
  await act(async () => save!.click());
  expect(state.updateSettings.mock.calls).toEqual([
    [
      {
        environmentId: serverId,
        input: { patch: { scratchBaseDirectory: "/srv/scratch" } },
      },
    ],
  ]);
});

it("clears the base directory back to the default scratch folder", async () => {
  state.filter.selectedTargets = [
    settingsTarget(serverId, { scratchBaseDirectory: "/srv/scratch" }),
  ];
  await renderThreads();
  const reset = button("Use default");
  expect(reset).toBeDefined();
  await act(async () => reset!.click());
  expect(state.updateSettings.mock.calls).toEqual([
    [{ environmentId: serverId, input: { patch: { scratchBaseDirectory: "" } } }],
  ]);
});

it("hides the base directory on a project scope", async () => {
  state.filter.selectedTargets = [settingsTarget(serverId)];
  state.filter.projectGroups = [projectGroup];
  state.filter.selectedProjectKey = projectGroup.key;
  await renderThreads();
  expect(container.textContent).not.toContain("No-project chats");
});

it("hides the base directory when the environment cannot host scratch folders", async () => {
  state.filter.selectedTargets = [settingsTarget(serverId, { scratchBaseDirectory: "" }, false)];
  await renderThreads();
  expect(container.textContent).not.toContain("No-project chats");
});
