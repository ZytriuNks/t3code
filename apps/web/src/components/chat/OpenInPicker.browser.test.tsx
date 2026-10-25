import { AuthOrchestrationOperateScope, EnvironmentId, type EditorId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { serverEnvironment } from "../../state/server";
import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RemoteOpenState } from "../../remoteOpen";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  remote: { mode: "local-exec" } as RemoteOpenState,
  clientEditors: ["vscode"] as readonly EditorId[],
  serverConfig: { shellRevealInFileManager: true },
  run: vi.fn(),
  openUrl: vi.fn(),
  setPreferred: vi.fn(),
  markHintSeen: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock("../../state/session", async (original) => {
  const actual = await original<typeof import("../../state/session")>();
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId);
  return {
    ...actual,
    readEnvironmentScope,
    useEnvironmentScope: (environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(environmentId, scope),
      ),
  };
});
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => state.run,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironment: () => ({ label: "Test host" }),
}));
vi.mock("../../editorPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../editorPreferences")>();
  return {
    ...actual,
    usePreferredEditor: (available: readonly EditorId[]) => {
      const [preferred, setPreferred] = actual.usePreferredEditor(available);
      return [
        preferred,
        (editor: EditorId) => {
          state.setPreferred(editor);
          setPreferred(editor);
        },
      ] as const;
    },
  };
});
vi.mock("../../remoteOpen", async (original) => ({
  ...(await original<typeof import("../../remoteOpen")>()),
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: () => state.clientEditors,
  useRemoteOpenHint: () => [false, state.markHintSeen],
  openRemoteEditorUrl: state.openUrl,
}));
vi.mock("../../keybindings", async (original) => ({
  ...(await original<typeof import("../../keybindings")>()),
  isOpenFavoriteEditorShortcut: (event: KeyboardEvent) => event.key === "o" && event.ctrlKey,
  shortcutLabelForCommand: () => "Ctrl+O",
}));

import { OpenInPicker } from "./OpenInPicker";

const primary = EnvironmentId.make("primary");
const selected = EnvironmentId.make("selected");
const editors: readonly EditorId[] = ["vscode"];

async function setup() {
  await using stack = new AsyncDisposableStack();
  state.allowed.clear();
  state.remote = { mode: "local-exec" };
  state.clientEditors = editors;
  state.serverConfig = { shellRevealInFileManager: true };
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openUrl.mockReset().mockResolvedValue(true);
  state.setPreferred.mockReset();
  state.markHintSeen.mockReset();
  state.listeners.clear();
  const previous = localStorage.getItem("t3code:last-editor");
  localStorage.removeItem("t3code:last-editor");
  stack.defer(() => {
    if (previous === null) localStorage.removeItem("t3code:last-editor");
    else localStorage.setItem("t3code:last-editor", previous);
  });
  stack.use(
    vi
      .spyOn(serverEnvironment, "configValueAtom")
      .mockImplementation(() => Atom.make(state.serverConfig as ServerConfig)),
  );
  const screen = stack.use(await render(null));
  const renderPicker = async (
    availableEditors: readonly EditorId[] = editors,
    panel = false,
    options: { reveal?: boolean; onExternalOpen?: () => void } = {},
  ) => {
    await act(() => {
      for (const listener of state.listeners) listener();
    });
    await screen.rerender(
      <OpenInPicker
        environmentId={selected}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={availableEditors}
        openInCwd="/work/project"
        displayMode={panel ? "panel" : "toolbar"}
        compact={!panel}
        {...options}
      />,
    );
  };
  const primaryButton = () =>
    screen.getByRole("button", { name: "Open file in preferred editor", exact: true });
  const owned = stack.move();
  return { screen, renderPicker, primaryButton, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
function keyboardEvent() {
  return new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true });
}

it.each(["local-exec", "remote-links"] as const)(
  "selects the preferred editor without launching a %s workspace",
  async (mode) => {
    await using fixture = await setup();
    const { screen, renderPicker } = fixture;
    state.allowed.add(selected);
    state.clientEditors = ["cursor", "vscode"];
    state.remote =
      mode === "local-exec" ? { mode } : { mode, host: { kind: "ssh-alias", host: "test-host" } };
    await renderPicker(["cursor", "vscode"], true);
    await expect
      .element(screen.getByRole("button", { name: "Open in Cursor", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Choose editor" }).click();
    await page.getByRole("menuitem", { name: "VS Code", exact: true }).click();
    expect(localStorage.getItem("t3code:last-editor")).toBe('"vscode"');
    expect(state.run).not.toHaveBeenCalled();
    expect(state.openUrl).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Open in VS Code", exact: true }).click();
    if (mode === "local-exec") {
      expect(state.run).toHaveBeenCalledExactlyOnceWith({
        environmentId: selected,
        input: { cwd: "/work/project", editor: "vscode" },
      });
    } else {
      expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
        "vscode://vscode-remote/ssh-remote+test-host/work/project",
      );
    }
  },
);

describe("file reveal and external-open completion", () => {
  it("requests file selection for a reveal toolbar and closes only after success", async () => {
    await using fixture = await setup();
    const { renderPicker, primaryButton } = fixture;
    state.allowed.add(selected);
    const onExternalOpen = vi.fn();
    let resolveOpen!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
    state.run.mockReturnValue(
      new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    await renderPicker(["file-manager"], false, { reveal: true, onExternalOpen });
    await primaryButton().click();
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: "/work/project", editor: "file-manager", reveal: true },
    });
    expect(onExternalOpen).not.toHaveBeenCalled();
    resolveOpen(AsyncResult.success(undefined));
    await vi.waitFor(() => expect(onExternalOpen).toHaveBeenCalledOnce());
  });
  it("does not offer a file manager unable to reveal the selected file", async () => {
    await using fixture = await setup();
    const { renderPicker, primaryButton } = fixture;
    state.allowed.add(selected);
    state.serverConfig = { shellRevealInFileManager: false };
    await renderPicker(["file-manager"], false, { reveal: true });
    await expect.element(primaryButton()).toBeDisabled();
    await act(() => window.dispatchEvent(keyboardEvent()));
    expect(state.run).not.toHaveBeenCalled();
  });
  it("retains the workspace card when the host open fails", async () => {
    await using fixture = await setup();
    const { screen, renderPicker } = fixture;
    state.allowed.add(selected);
    state.run.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Open failed"))));
    const onExternalOpen = vi.fn();
    await renderPicker(editors, true, { onExternalOpen });
    await screen.getByRole("button", { name: "Open in VS Code", exact: true }).click();
    expect(state.run).toHaveBeenCalledOnce();
    expect(onExternalOpen).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "reports remote open completion only when accepted (%s)",
    async (opened) => {
      await using fixture = await setup();
      const { renderPicker, primaryButton } = fixture;
      state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
      state.openUrl.mockResolvedValue(opened);
      const onExternalOpen = vi.fn();
      await renderPicker(editors, false, { onExternalOpen });
      await primaryButton().click();
      expect(state.openUrl).toHaveBeenCalledOnce();
      expect(onExternalOpen).toHaveBeenCalledTimes(opened ? 1 : 0);
    },
  );
});

describe("host editor access", () => {
  it("uses the selected grant for both the button and a retained shortcut", async () => {
    await using fixture = await setup();
    const { screen, renderPicker, primaryButton } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    state.allowed.delete(selected);
    state.allowed.add(primary);
    await primaryButton().click();
    const event = keyboardEvent();
    await act(() => window.dispatchEvent(event));
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    await renderPicker();
    await expect.element(primaryButton()).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Choose editor" })).toBeDisabled();
  });
  it("closes an open picker on revocation and launches only after a fresh grant", async () => {
    await using fixture = await setup();
    const { screen, renderPicker, primaryButton } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    await screen.getByRole("button", { name: "Choose editor" }).click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    state.allowed.delete(selected);
    await renderPicker();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    state.allowed.add(selected);
    await renderPicker();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await primaryButton().click();
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: "/work/project", editor: "vscode" },
    });
  });
});

describe("client editor links", () => {
  it("opens an SSH editor URL without host operate permission", async () => {
    await using fixture = await setup();
    const { renderPicker, primaryButton } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    await renderPicker();
    await expect.element(primaryButton()).toBeEnabled();
    await primaryButton().click();
    expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/ssh-remote+test-host/work/project",
    );
    expect(state.run).not.toHaveBeenCalled();
    expect(state.markHintSeen).toHaveBeenCalledOnce();
    expect(state.setPreferred).toHaveBeenCalledExactlyOnceWith("vscode");
  });
  it("does not change preferences when the client rejects the SSH URL", async () => {
    await using fixture = await setup();
    const { renderPicker } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    state.openUrl.mockResolvedValue(false);
    await renderPicker();
    const event = keyboardEvent();
    await act(() => window.dispatchEvent(event));
    expect(state.openUrl).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
    expect(state.markHintSeen).not.toHaveBeenCalled();
  });
});
