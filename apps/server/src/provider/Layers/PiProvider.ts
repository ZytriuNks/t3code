/**
 * PiProvider — snapshot/probe layer for the Pi coding agent.
 *
 * Health is probed with `pi --version`. Models, the user's default model, and
 * the user's commands (extension slash commands, prompt templates, skills)
 * are discovered through a short-lived ephemeral RPC session
 * (`pi --mode rpc --no-session`), so everything the user configured in
 * `~/.pi/agent` — custom providers, models.json entries, extensions, skills —
 * shows up in T3 without any hardcoded catalog.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Pi's extension config is read synchronously during RPC discovery.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Pi's path resolution must match its extension runtime.
import * as NodePath from "node:path";

import {
  type CustomModelSetting,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../../orchestration-v2/Adapters/piT3McpInjection.ts";
import {
  makePiRpcConnection,
  piRecordField as recordField,
  piRecordString as recordString,
} from "../../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "../PiCommands.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // The adapter reports context usage from Pi's streaming usage while a
  // turn runs, so clients can reserve the meter before the first settle.
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 15_000;
/**
 * get_entries arrived in 0.80.3 and agent_settled landed in source at 0.80.4.
 * Version 0.80.5 was the first published package containing both hooks. T3
 * needs them for rollback boundaries and reliable turn terminalization.
 */
export const MINIMUM_PI_VERSION = "0.80.5";

/** Deferring to the user's own settings.json default model. */
const PI_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Pi default",
  isCustom: false,
  capabilities: EMPTY_PI_MODEL_CAPABILITIES,
};

interface PiDiscovery extends PiDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
}

const PI_OPENAI_FAST_CONFIG_FILENAME = "pi-openai-fast.json";
const PI_OPENAI_FAST_PACKAGE = "@benvargas/pi-openai-fast";

interface PiOpenAIFastFileConfig {
  readonly persistState?: boolean;
  readonly active?: boolean;
  readonly supportedModels?: ReadonlyArray<string>;
}

export interface PiOpenAIFastConfig {
  readonly active: boolean;
  readonly supportedModels: ReadonlySet<string>;
}

function hasPiOpenAIFastCommand(commandsData: unknown): boolean {
  const commands = recordField(commandsData, "commands");
  if (!Array.isArray(commands)) return false;
  return commands.some((command) => {
    if (
      recordString(command, "name") !== "fast" ||
      recordString(command, "source") !== "extension"
    ) {
      return false;
    }
    const sourceInfo = recordField(command, "sourceInfo");
    return [
      recordString(sourceInfo, "source"),
      recordString(sourceInfo, "path"),
      recordString(sourceInfo, "baseDir"),
    ].some((value) => isPiOpenAIFastPackageSource(value));
  });
}

function isPiOpenAIFastPackageSource(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const packageName = PI_OPENAI_FAST_PACKAGE.toLowerCase();
  return (
    normalized === packageName ||
    normalized === `npm:${packageName}` ||
    normalized.startsWith(`npm:${packageName}@`) ||
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.endsWith(`/node_modules/${packageName}`)
  );
}

function resolvePiAgentDirectory(environment: NodeJS.ProcessEnv, cwd: string): string {
  const configured = environment.PI_CODING_AGENT_DIR;
  const path =
    configured === undefined || configured.length === 0
      ? NodePath.join(NodeOS.homedir(), ".pi", "agent")
      : configured === "~"
        ? NodeOS.homedir()
        : configured.startsWith("~/") || configured.startsWith("~\\")
          ? NodePath.join(NodeOS.homedir(), configured.slice(2))
          : configured;
  return NodePath.isAbsolute(path) ? path : NodePath.resolve(cwd, path);
}

function readPiOpenAIFastConfig(path: string): PiOpenAIFastFileConfig {
  if (!NodeFS.existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.persistState === "boolean" ? { persistState: value.persistState } : {}),
      ...(typeof value.active === "boolean" ? { active: value.active } : {}),
      ...(Array.isArray(value.supportedModels)
        ? { supportedModels: normalizePiOpenAIFastSupportedModels(value.supportedModels) }
        : {}),
    };
  } catch {
    return {};
  }
}

function normalizePiOpenAIFastSupportedModels(
  values: ReadonlyArray<unknown>,
): ReadonlyArray<string> {
  const models: Array<string> = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const key = value.trim();
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) continue;
    const provider = key.slice(0, slash).trim();
    const id = key.slice(slash + 1).trim();
    if (provider.length > 0 && id.length > 0) models.push(`${provider}/${id}`);
  }
  return models;
}

export function resolvePiOpenAIFastConfig(input: {
  readonly commandsData: unknown;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): PiOpenAIFastConfig | undefined {
  if (!hasPiOpenAIFastCommand(input.commandsData)) return undefined;
  const cwd = input.cwd ?? process.cwd();
  const agentDirectory = resolvePiAgentDirectory(input.environment, cwd);
  const globalConfig = readPiOpenAIFastConfig(
    NodePath.join(agentDirectory, "extensions", PI_OPENAI_FAST_CONFIG_FILENAME),
  );
  const projectConfig = readPiOpenAIFastConfig(
    NodePath.join(cwd, ".pi", "extensions", PI_OPENAI_FAST_CONFIG_FILENAME),
  );
  const config = { ...globalConfig, ...projectConfig };
  if (config.supportedModels === undefined) return undefined;
  return {
    active: config.persistState !== false && config.active === true,
    supportedModels: new Set(config.supportedModels),
  };
}

function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [PI_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

function parseDiscoveredModels(
  data: unknown,
  defaultThinkingLevel: unknown,
  fastConfig?: PiOpenAIFastConfig,
): ReadonlyArray<ServerProviderModel> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      isCustom: false,
      capabilities: thinkingCapabilitiesForPiModel(
        model,
        defaultThinkingLevel,
        fastConfig?.supportedModels.has(slug) ? fastConfig.active : undefined,
      ),
    });
  }
  return parsed;
}

const discoverPiViaRpc = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const launch = buildPiRpcLaunch({
      launchArgs,
      environment,
      mcpSession: undefined,
      extensionPath: undefined,
      ephemeral: true,
    });
    const connection = yield* makePiRpcConnection({
      command: piSettings.binaryPath || "pi",
      args: launch.args,
      cwd,
      env: launch.env,
    });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    const stateData = yield* connection.request({ type: "get_state" });
    const modelsData = yield* connection.request({ type: "get_available_models" });
    const commandsData = yield* connection
      .request({ type: "get_commands" })
      .pipe(Effect.orElseSucceed(() => undefined));
    const fastConfig = resolvePiOpenAIFastConfig({
      commandsData,
      environment,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const discoveredModels = parseDiscoveredModels(
      modelsData,
      recordString(stateData, "thinkingLevel"),
      fastConfig,
    );
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return {
      models: discoveredModels,
      slashCommands: withPiBuiltinSlashCommands(slashCommands),
      skills,
      authenticated: discoveredModels.length > 0,
    } satisfies PiDiscovery;
  }).pipe(Effect.scoped);

const runPiVersionCommand = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);
    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH. Install with `npm install -g @earendil-works/pi-coding-agent`."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `T3 Code could not determine the Pi version. Pi ${MINIMUM_PI_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ${version} is unsupported. Update to Pi ${MINIMUM_PI_VERSION} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: resolvedLaunchArgs.message,
      },
    });
  }

  const discoveryExit = yield* discoverPiViaRpc(
    piSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
  ).pipe(Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Pi is available, but T3 Code could not refresh its models and commands. The live session will retry startup.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Pi is available, but model and command discovery needs interactive input. The live session will handle it.",
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = piModelsFromSettings(piSettings.customModels, discovery.models);
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "pi" },
      ...(discovery.authenticated
        ? {}
        : {
            message:
              "Pi has no usable models. Run `pi` in a terminal and use /login, or configure an API key in ~/.pi/agent.",
          }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
