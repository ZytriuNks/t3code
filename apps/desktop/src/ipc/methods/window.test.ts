import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

const { focusedWebContents, ownerWindow, showItemInFolder, openPath, focusExistingWindowsFolder } =
  vi.hoisted(() => ({
    focusedWebContents: vi.fn(),
    ownerWindow: vi.fn(),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(),
    focusExistingWindowsFolder: vi.fn(),
  }));
vi.mock("../../electron/WindowsFileManager.ts", () => ({ focusExistingWindowsFolder }));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
  shell: { showItemInFolder, openPath },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  openLocalPath,
  pasteAsText,
  pickProjectFavicon,
  getRelayTelemetryEnabled,
  probeRemoteEditors,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeedSome(readyWslConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.succeed("current-window-token"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const bootstrapsLayer = (instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>) =>
  Layer.merge(DesktopBackendPool.layerTest([...instances]), backendConfigurationLayer);

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("hands out the current window's token to a backend launched with the secret", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "current-window-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        bootstrapsLayer([
          {
            ...defaultWslInstance,
            currentConfig: Effect.succeedSome({
              ...readyWslConfig,
              bootstrap: {
                ...readyWslConfig.bootstrap,
                desktopBootstrapSecret: "desktop-secret",
              },
            }),
          },
        ]),
      ),
    ),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome(retryingConfig),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(bootstrapsLayer([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome({
        ...readyWslConfig,
        preflightFailure: Option.some({
          reason: "WSL probe timed out",
          fatal: false,
          retryLimit: 12,
        }),
      }),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(bootstrapsLayer([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeedSome(window),
        }),
      ),
    );
  });
});

describe("openLocalPath", () => {
  const window = {
    webContents: { id: 42 },
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
  const layer = (exists = true, platform: NodeJS.Platform = "win32", directory = false) =>
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(window) }),
      Layer.succeed(HostProcess.Platform, platform),
      FileSystem.layerNoop({
        exists: () => Effect.succeed(exists),
        stat: () =>
          Effect.succeed({ type: directory ? "Directory" : "File" } as FileSystem.File.Info),
      }),
    );
  const target = "D:/outside workspace/author's 中文.txt";

  it.effect("uses native reveal for an existing absolute file outside the project", () =>
    Effect.gen(function* () {
      showItemInFolder.mockClear();
      openPath.mockClear();
      focusExistingWindowsFolder.mockClear().mockReturnValue(Effect.succeed(false));
      assert.isTrue(
        yield* openLocalPath.handler({ path: target, reveal: true }, { sender: { id: 42 } }),
      );
      assert.deepEqual(showItemInFolder.mock.calls, [[target]]);
      assert.equal(openPath.mock.calls.length, 0);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("opens a folder or executable through the native default association", () =>
    Effect.gen(function* () {
      showItemInFolder.mockClear();
      openPath.mockClear().mockResolvedValue("");
      assert.isTrue(
        yield* openLocalPath.handler({ path: target, reveal: false }, { sender: { id: 42 } }),
      );
      assert.deepEqual(openPath.mock.calls, [[target]]);
      assert.equal(showItemInFolder.mock.calls.length, 0);
      openPath.mockResolvedValue("No associated application");
      assert.isFalse(
        yield* openLocalPath.handler({ path: target, reveal: false }, { sender: { id: 42 } }),
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect("selects a revealed file in the existing folder before bringing it forward", () =>
    Effect.gen(function* () {
      showItemInFolder.mockClear();
      openPath.mockClear();
      focusExistingWindowsFolder.mockClear().mockReturnValue(Effect.succeed(true));
      assert.isTrue(
        yield* openLocalPath.handler({ path: target, reveal: true }, { sender: { id: 42 } }),
      );
      const path = yield* Path.Path;
      assert.deepEqual(focusExistingWindowsFolder.mock.calls, [[path.dirname(target), target]]);
      assert.equal(showItemInFolder.mock.calls.length, 0);
      assert.equal(openPath.mock.calls.length, 0);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects missing and relative paths without opening Explorer's default folder", () =>
    Effect.gen(function* () {
      showItemInFolder.mockClear();
      openPath.mockClear();
      for (const path of ["relative.txt", "D:relative.txt", "/home/test.txt", target]) {
        assert.isFalse(
          yield* openLocalPath.handler({ path, reveal: true }, { sender: { id: 42 } }),
        );
      }
      assert.equal(showItemInFolder.mock.calls.length, 0);
      assert.equal(openPath.mock.calls.length, 0);
    }).pipe(Effect.provide(layer(false))),
  );

  it.effect("restores the matching folder window before opening a new one", () =>
    Effect.gen(function* () {
      openPath.mockClear().mockResolvedValue("");
      focusExistingWindowsFolder.mockClear().mockReturnValue(Effect.succeed(true));
      assert.isTrue(
        yield* openLocalPath.handler({ path: target, reveal: false }, { sender: { id: 42 } }),
      );
      assert.deepEqual(focusExistingWindowsFolder.mock.calls, [[target]]);
      assert.equal(openPath.mock.calls.length, 0);
      showItemInFolder.mockClear();
      assert.isTrue(
        yield* openLocalPath.handler({ path: target, reveal: true }, { sender: { id: 42 } }),
      );
      assert.equal(showItemInFolder.mock.calls.length, 0);
      focusExistingWindowsFolder.mockReturnValue(Effect.succeed(false));
      assert.isTrue(
        yield* openLocalPath.handler({ path: target, reveal: false }, { sender: { id: 42 } }),
      );
      assert.deepEqual(openPath.mock.calls, [[target]]);
    }).pipe(Effect.provide(layer(true, "win32", true))),
  );

  it.effect("only accepts requests from the main renderer on Windows", () =>
    Effect.gen(function* () {
      showItemInFolder.mockClear();
      assert.isFalse(
        yield* openLocalPath
          .handler({ path: target, reveal: true }, { sender: { id: 99 } })
          .pipe(Effect.provide(layer())),
      );
      assert.isFalse(
        yield* openLocalPath.handler({ path: target, reveal: true }).pipe(Effect.provide(layer())),
      );
      assert.isFalse(
        yield* openLocalPath
          .handler({ path: target, reveal: true }, { sender: { id: 42 } })
          .pipe(Effect.provide(layer(true, "darwin"))),
      );
      assert.equal(showItemInFolder.mock.calls.length, 0);
    }),
  );
});

describe("pasteAsText", () => {
  it.effect(
    "pastes into the focused guest only after the main renderer acknowledges the menu action",
    () => {
      const paste = vi.fn();
      const mainPaste = vi.fn();
      const window = {
        webContents: { id: 42, paste: mainPaste },
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow;
      focusedWebContents.mockReturnValue({ paste, isDestroyed: () => false });
      ownerWindow.mockReturnValue(window);

      return Effect.gen(function* () {
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        assert.equal(mainPaste.mock.calls.length, 0);

        yield* pasteAsText.handler(undefined, { sender: { id: 99 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue({}); // A focused PiP/other BrowserWindow.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(null); // Detached contents.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(window);
        focusedWebContents.mockReturnValue({ paste, isDestroyed: () => true });
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        focusedWebContents.mockReturnValue(null);
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
      }).pipe(
        Effect.provide(
          Layer.mock(ElectronWindow.ElectronWindow)({
            main: Effect.succeedSome(window),
          }),
        ),
      );
    },
  );
});
describe("getRelayTelemetryEnabled", () => {
  it.effect("reads the desktop host opt-out before returning the renderer policy", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* getRelayTelemetryEnabled.handler().pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_TELEMETRY_ENABLED: "false",
          }),
        ),
      );
      assert.isTrue(
        yield* getRelayTelemetryEnabled
          .handler()
          .pipe(Effect.provideService(HostProcess.Environment, {})),
      );
    }),
  );
});

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.include(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
