import { AuthOrchestrationOperateScope, EnvironmentId, type EditorId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { ServerConfig } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { act, fakeTimers, render as renderUi } from "../../../test/render";
import type { RemoteOpenState } from "../../remoteOpen";
import { serverEnvironment } from "../../state/server";

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

vi.mock(import("../../state/session"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId);
  return {
    ...(await importOriginal()),
    readEnvironmentScope: readEnvironmentScope as never,
    useEnvironmentScope: ((environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(environmentId, scope),
      )) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "Test host" })) as never,
}));
vi.mock(import("../../editorPreferences"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePreferredEditor: (available: readonly EditorId[]) => {
      const [preferred, setPreferred] = actual.usePreferredEditor(available);
      const recordPreferred: typeof setPreferred = (editor) => {
        state.setPreferred(editor);
        setPreferred(editor);
      };
      return [preferred, recordPreferred] as const;
    },
  };
});
vi.mock(import("../../remoteOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: () => state.clientEditors,
  useRemoteOpenHint: () => [false, state.markHintSeen] as const,
  openRemoteEditorUrl: state.openUrl,
}));

import { OpenInPicker } from "./OpenInPicker";
import {
  registerOpenFavoriteEditorCommand,
  useOpenFavoriteEditorShortcut,
} from "./OpenInPickerShortcut";

const primary = EnvironmentId.make("primary");
const selected = EnvironmentId.make("selected");
const editors: readonly EditorId[] = ["vscode"];

async function setup() {
  state.allowed.clear();
  state.remote = { mode: "local-exec" };
  state.clientEditors = editors;
  state.serverConfig = { shellRevealInFileManager: true };
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openUrl.mockReset().mockResolvedValue(true);
  state.setPreferred.mockReset();
  state.markHintSeen.mockReset();
  state.listeners.clear();
  window.localStorage.clear();

  await using stack = new AsyncDisposableStack();
  const _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  stack.use(_platform);
  const _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  stack.use(_storage);
  // The app registers this command at startup (appInit).
  const _openFavorite = { [Symbol.dispose]: registerOpenFavoriteEditorCommand() };
  stack.use(_openFavorite);
  stack.use(
    vi
      .spyOn(serverEnvironment, "configValueAtom")
      .mockImplementation(() => Atom.make(state.serverConfig as ServerConfig)),
  );
  const screen = stack.use(await renderUi(null));
  async function renderPicker(
    availableEditors: readonly EditorId[] = editors,
    panel = false,
    {
      openInCwd = "/work/project",
      revealFileManager = false,
      reveal = false,
      onExternalOpen,
    }: {
      openInCwd?: string;
      revealFileManager?: boolean;
      reveal?: boolean;
      onExternalOpen?: () => void;
    } = {},
  ) {
    await act(async () => {
      for (const listener of state.listeners) listener();
      const node = (
        <OpenInPicker
          environmentId={selected}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          availableEditors={availableEditors}
          openInCwd={openInCwd}
          revealFileManager={revealFileManager}
          reveal={reveal}
          {...(onExternalOpen ? { onExternalOpen } : {})}
          displayMode={panel ? "panel" : "toolbar"}
          compact={!panel}
        />
      );
      await screen.rerender(node);
    });
  }

  function byLabel(label: string) {
    const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(element, label).not.toBeNull();
    return element!;
  }

  const primaryButton = () => byLabel("Open file in preferred editor");
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }

  async function pressOpenFavorite(mac = false) {
    const event = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: !mac,
      metaKey: mac,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.body.dispatchEvent(event));
    return event;
  }

  function FavoriteEditorFallback() {
    useOpenFavoriteEditorShortcut({
      enabled: true,
      environmentId: selected,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      availableEditors: editors,
      openInCwd: "/work/project",
    });
    return null;
  }

  const environment = stack.move();
  return {
    screen,
    renderPicker,
    byLabel,
    primaryButton,
    menuItems,
    click,
    pressOpenFavorite,
    FavoriteEditorFallback,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
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
    const { renderPicker, primaryButton, click } = fixture;
    state.allowed.add(selected);
    const onExternalOpen = vi.fn();
    let resolveOpen!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
    state.run.mockReturnValue(
      new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    await renderPicker(["file-manager"], false, { reveal: true, onExternalOpen });
    await click(primaryButton());
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
    const { renderPicker, primaryButton, pressOpenFavorite } = fixture;
    state.allowed.add(selected);
    state.serverConfig = { shellRevealInFileManager: false };
    await renderPicker(["file-manager"], false, { reveal: true });
    expect(primaryButton().disabled).toBe(true);
    await pressOpenFavorite();
    expect(state.run).not.toHaveBeenCalled();
  });
  it("retains the workspace card when the host open fails", async () => {
    await using fixture = await setup();
    const { renderPicker, byLabel, click } = fixture;
    state.allowed.add(selected);
    state.run.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Open failed"))));
    const onExternalOpen = vi.fn();
    await renderPicker(editors, true, { onExternalOpen });
    await click(byLabel("Open in VS Code"));
    expect(state.run).toHaveBeenCalledOnce();
    expect(onExternalOpen).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "reports remote open completion only when accepted (%s)",
    async (opened) => {
      await using fixture = await setup();
      const { renderPicker, primaryButton, click } = fixture;
      state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
      state.openUrl.mockResolvedValue(opened);
      const onExternalOpen = vi.fn();
      await renderPicker(editors, false, { onExternalOpen });
      await click(primaryButton());
      expect(state.openUrl).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(onExternalOpen).toHaveBeenCalledTimes(opened ? 1 : 0));
    },
  );
});

describe("host editor access", () => {
  it("uses the selected grant for both the button and a retained shortcut", async () => {
    await using fixture = await setup();
    const { renderPicker, byLabel, primaryButton, click, pressOpenFavorite } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    // Revoke without rerendering to exercise execution-time grant checks.
    state.allowed.delete(selected);
    state.allowed.add(primary);
    await click(primaryButton());
    // The shortcut is consumed and opens nothing once the grant is gone.
    expect((await pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();

    await renderPicker();
    expect(primaryButton().disabled).toBe(true);
    expect(byLabel("Choose editor").disabled).toBe(true);
    expect((await pressOpenFavorite()).defaultPrevented).toBe(false);
  });
  it("closes an open picker on revocation and launches only after a fresh grant", async () => {
    await using fixture = await setup();
    const { screen, renderPicker, primaryButton, click } = fixture;
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
    await click(primaryButton());
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: "/work/project", editor: "vscode" },
    });
  });
});

describe("client editor links", () => {
  it("opens an SSH editor URL without host operate permission", async () => {
    await using fixture = await setup();
    const { renderPicker, primaryButton, click } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    await renderPicker();
    expect(primaryButton().disabled).toBe(false);
    await click(primaryButton());
    expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/ssh-remote+test-host/work/project",
    );
    expect(state.run).not.toHaveBeenCalled();
    expect(state.markHintSeen).toHaveBeenCalledOnce();
    expect(state.setPreferred).toHaveBeenCalledExactlyOnceWith("vscode");
  });
  it("does not change preferences when the client rejects the SSH URL", async () => {
    await using fixture = await setup();
    const { renderPicker, pressOpenFavorite } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    state.openUrl.mockResolvedValue(false);
    await renderPicker();
    const event = await pressOpenFavorite();
    expect(state.openUrl).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
    expect(state.markHintSeen).not.toHaveBeenCalled();
  });
});

describe("remote editor links", () => {
  it("opens the link from the fallback when the picker is not mounted", async () => {
    await using fixture = await setup();
    const { screen, pressOpenFavorite, FavoriteEditorFallback } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } };
    await act(async () => screen.rerender(<FavoriteEditorFallback />));

    expect((await pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.openUrl).toHaveBeenCalledWith(expect.stringContaining("ssh-remote+sol"));
    expect(state.run).not.toHaveBeenCalled();
  });
});

describe("open in editor announcement", () => {
  it("speaks only after the shortcut opened the editor, from the picker or the fallback", async () => {
    await using fixture = await setup();
    const { screen, renderPicker, pressOpenFavorite, FavoriteEditorFallback } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    using _timers = fakeTimers();
    const regions = () => [...document.querySelectorAll('body > [aria-live="polite"]')];
    const spoken = async () => {
      await act(async () => vi.runAllTimers());
      return regions()
        .map((region) => region.textContent)
        .join("");
    };
    const refuse = () =>
      state.run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("No editor"))));

    refuse();
    await pressOpenFavorite();
    expect(await spoken()).toBe("");
    await pressOpenFavorite();
    expect(await spoken()).toBe("Opened in VS Code");

    for (const region of regions()) region.textContent = "";
    await act(async () => screen.rerender(<FavoriteEditorFallback />));
    refuse();
    await pressOpenFavorite();
    expect(await spoken()).toBe("");
    await pressOpenFavorite();
    expect(await spoken()).toBe("Opened in VS Code");
  });
});
