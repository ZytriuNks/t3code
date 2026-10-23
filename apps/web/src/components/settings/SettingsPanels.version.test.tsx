// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../branding")>()),
  APP_VERSION: "0.0.45",
}));

import { AboutVersionSection } from "./SettingsPanels";

const installedState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.0-fork-7",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

let renderer: ReactTestRenderer | undefined;
let registry: AtomRegistry.AtomRegistry;
let listener: ((state: DesktopUpdateState) => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  listener = undefined;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

function desktopBridge(getUpdateState: () => Promise<DesktopUpdateState>) {
  const bridge = {
    getUpdateState,
    onUpdateState: (next: (state: DesktopUpdateState) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } satisfies Pick<DesktopBridge, "getUpdateState" | "onUpdateState">;
  vi.stubGlobal("desktopBridge", bridge);
}

async function mount() {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <AboutVersionSection />
      </RegistryContext.Provider>,
    );
  });
}

function displayedVersion() {
  return renderer!.root.findByType("code").children.join("");
}

describe("settings app version", () => {
  it("shows the running desktop version instead of the web bundle or downloaded update", async () => {
    desktopBridge(async () => ({
      ...installedState,
      status: "downloaded",
      availableVersion: "0.1.0-fork-8",
      downloadedVersion: "0.1.0-fork-8",
    }));
    await mount();
    await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
    await vi.waitFor(() => expect(displayedVersion()).toBe("0.1.0-fork-7"));
  });

  it("updates the visible version from desktop events without remounting", async () => {
    const getUpdateState = vi.fn(async () => ({
      ...installedState,
      currentVersion: "0.1.0-fork-6",
    }));
    desktopBridge(getUpdateState);
    await mount();
    await vi.waitFor(() => expect(displayedVersion()).toBe("0.1.0-fork-6"));

    await act(async () => listener!(installedState));
    await vi.waitFor(() => expect(displayedVersion()).toBe("0.1.0-fork-7"));
    expect(getUpdateState).toHaveBeenCalledTimes(1);
  });

  it("uses the web bundle version without a desktop bridge", async () => {
    vi.stubGlobal("desktopBridge", undefined);
    await mount();
    expect(displayedVersion()).toBe("0.0.45");
  });

  it("replaces the fallback after the desktop's initial state arrives", async () => {
    let resolveInitial: ((state: DesktopUpdateState) => void) | undefined;
    desktopBridge(
      () =>
        new Promise<DesktopUpdateState>((resolve) => {
          resolveInitial = resolve;
        }),
    );
    await mount();
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf("function"));
    expect(displayedVersion()).toBe("0.0.45");

    await act(async () => resolveInitial!(installedState));
    await vi.waitFor(() => expect(displayedVersion()).toBe("0.1.0-fork-7"));
  });
});
