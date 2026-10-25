import { type ComponentProps } from "react";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { RightPanelTabs } from "./RightPanelTabs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));

const noop = () => undefined;
async function setup() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"));
  const screen = stack.use(await render(null));
  const addFiles = vi.fn();
  async function renderPanel(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
    await act(() =>
      screen.rerender(
        <RightPanelTabs
          mode="inline"
          open
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          })}
          surfaces={[]}
          environmentId={null}
          activeSurfaceId={null}
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map()}
          onActivate={noop}
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddBrowser={noop}
          onAddBrowserInProfile={noop}
          onAddTerminal={noop}
          onAddDiff={noop}
          onAddFiles={addFiles}
          onAddPullRequest={noop}
          onAddPullRequests={noop}
          onAddDevice={noop}
          browserAvailable={false}
          terminalAvailable={false}
          diffAvailable={false}
          filesAvailable
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
          {...overrides}
        >
          content
        </RightPanelTabs>,
      ),
    );
  }

  async function press(key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
    return event;
  }

  const owned = stack.move();
  return {
    ...screen,
    addFiles,
    renderPanel,
    press,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("right panel new-tab shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      await using fixture = await setup();
      const { addFiles, renderPanel, press } = fixture;
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel();
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "Linked pull requests",
      );
      expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      expect(addFiles).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it.each(["inline", "sheet"] as const)(
    "opens Agents from the %s launcher and closes its tab",
    async (mode) => {
      await using fixture = await setup();
      const { container, renderPanel, press } = fixture;
      const ref = scopeThreadRef(EnvironmentId.make("agents-env"), ThreadId.make("parent"));
      useRightPanelStore.setState({ byThreadKey: {} });
      await renderPanel({
        mode,
        agentsAvailable: true,
        onAddAgents: () => useRightPanelStore.getState().open(ref, "agents"),
      });
      expect(container.textContent).toContain("Agents");
      await press("a");
      const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
      expect(panel.activeSurfaceId).toBe("agents");
      await renderPanel({
        mode,
        surfaces: panel.surfaces,
        activeSurfaceId: panel.activeSurfaceId,
        onCloseSurface: (surface) => useRightPanelStore.getState().closeSurface(ref, surface.id),
      });
      expect(
        container.querySelector('[data-active="true"]')?.textContent ?? container.textContent,
      ).toContain("Agents");
      const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close Agents"]');
      expect(close).not.toBeNull();
      await act(() => close!.click());
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
      ).toEqual([]);
    },
  );

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    await using fixture = await setup();
    const { renderPanel, press } = fixture;
    await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      await using fixture = await setup();
      const { container, renderPanel, press } = fixture;
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel({
        getShortcutContext: () => ({
          terminalFocus: true,
          terminalOpen: true,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        }),
      });
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    await using fixture = await setup();
    const { container, renderPanel, press } = fixture;
    const input = document.createElement("input");
    await renderPanel({
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    document.body.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Add panel surface"]'),
    );
    input.remove();
  });

  it("does not open over another popup or during text composition", async () => {
    await using fixture = await setup();
    const { container, renderPanel, press } = fixture;
    await renderPanel();
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    dialog.dataset.open = "";
    container.append(dialog);
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    await using fixture = await setup();
    const { addFiles, renderPanel, press } = fixture;
    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await renderPanel(panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await renderPanel({ ...panel, open: false });
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    await renderPanel(panel);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });
});
