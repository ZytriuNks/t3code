/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent (`cursor-agent`) runtime.
 *
 * Cursor uses the SDK for model discovery, login, and sessions.
 *
 * 文本生成使用同一实例的 SDK 登录凭据。
 *
 * @module provider/Drivers/CursorDriver
 */
import { CursorSettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCursorTextGeneration } from "../../textGeneration/CursorTextGeneration.ts";
import {
  CursorAdapterV2Driver,
  type CursorAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CursorAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readCursorUsageLimits } from "../Layers/cursorUsageLimits.ts";
import { CursorSdkCatalog } from "../Layers/CursorSdkCatalog.ts";
import { makeCursorAuth } from "../CursorAuth.ts";
import { FileCredentialStore } from "../cursorSdk.ts";
import * as CursorAgentSdk from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
} from "../Layers/CursorProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { probeCursorSkills } from "./CursorSkills.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
// cursor-agent updates itself, so the resolved executable is its own updater.
// No executable means nothing to update, not "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "cursor-agent",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
    ),
};

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | CursorSdkCatalog
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const CursorDriver: ProviderDriver<CursorSettings, CursorDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const cursorSdkCatalog = yield* CursorSdkCatalog;
      const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
      const credentialPath = path.join(
        (yield* ServerConfig).stateDir,
        "provider-auth",
        encodeURIComponent(instanceId),
        "cursor.json",
      );
      const auth = yield* makeCursorAuth({
        instanceId,
        displayName: displayName ?? "Cursor",
        enabled,
        ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
        store: new FileCredentialStore(credentialPath),
        credentialBinding: { owner: "t3", key: `cursor:${instanceId}` },
        onChanged: (signedIn): Effect.Effect<void, ProviderSetupError> =>
          snapshot.refresh.pipe(
            Effect.flatMap((provider) =>
              !signedIn || provider.auth.status === "authenticated"
                ? Effect.void
                : Effect.fail(
                    new ProviderSetupError({
                      instanceId,
                      operation: "start",
                      detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                    }),
                  ),
            ),
          ),
      });
      const stampSnapshot: typeof stampIdentity = (draft) =>
        stampIdentity({
          ...draft,
          setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
          auth: { ...draft.auth, canLogout: !auth.usesApiKey },
        });
      const orchestrationAdapter = yield* CursorAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          ...sdkRunner,
          open: (input) =>
            auth.requireApiKey.pipe(
              Effect.flatMap((apiKey) =>
                Effect.acquireRelease(
                  sdkRunner
                    .open({ ...input, options: { ...input.options, apiKey } })
                    .pipe(
                      Effect.flatMap((session) =>
                        Effect.cached(session.close).pipe(
                          Effect.map((close) => ({ ...session, close })),
                        ),
                      ),
                    ),
                  (session) => session.close.pipe(Effect.ignore),
                ),
              ),
              auth.withAccess,
              Effect.mapError((cause) =>
                isSdkRunnerError(cause)
                  ? cause
                  : new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "open", cause }),
              ),
            ),
        }),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Cursor orchestration adapter.",
              cause,
            }),
        ),
      );
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          ...(effectiveConfig.binaryPath ? { binaryPath: effectiveConfig.binaryPath } : {}),
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const textGeneration = yield* makeCursorTextGeneration(
        effectiveConfig,
        processEnv,
        auth.requireApiKey,
        auth.withAccess,
      );

      const checkProvider = auth.readApiKey.pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((apiKey) =>
          checkCursorProviderStatus(
            effectiveConfig,
            { ...processEnv, CURSOR_API_KEY: apiKey },
            auth.usesApiKey ? "api-key" : "browser",
          ).pipe(
            Effect.filterOrElse(
              (snapshot) =>
                !(
                  effectiveConfig.enabled &&
                  snapshot.installed &&
                  snapshot.auth.status === "authenticated"
                ),
              (snapshot) =>
                Effect.gen(function* () {
                  const settings = yield* serverSettings.getSettings;
                  const usageLimits = yield* readCursorUsageLimits(
                    effectiveConfig,
                    { ...processEnv, CURSOR_API_KEY: apiKey },
                    settings.cursorKeychainUsageEnabled,
                  );
                  return { ...snapshot, usageLimits };
                }),
            ),
          ),
        ),
        Effect.map(stampSnapshot),
        Effect.provideService(CursorSdkCatalog, cursorSdkCatalog),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CursorSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Cursor snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth: auth.controller,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                probeCursorSkills(cwd, processEnv).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to discover Cursor skills for '${cwd}'`,
                        cause,
                      }),
                  ),
                ),
              ]).pipe(Effect.map(([current, skills]) => ({ ...current, skills }))),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
