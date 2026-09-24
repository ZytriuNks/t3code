// @effect-diagnostics-next-line nodeBuiltinImport:off - temporary config fixtures exercise Pi's native filesystem format.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - temporary config fixtures use platform-native paths.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  MINIMUM_PI_VERSION,
  resolvePiOpenAIFastConfig,
} from "./PiProvider.ts";

const encoder = new TextEncoder();

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piRpcProcessHandle() {
  return Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const decoder = new TextDecoder();
    const stdin = Sink.forEach((bytes: Uint8Array) => {
      const request = JSON.parse(decoder.decode(bytes)) as {
        readonly id: string;
        readonly type: string;
      };
      const data =
        request.type === "get_state"
          ? { thinkingLevel: "medium" }
          : request.type === "get_available_models"
            ? {
                models: [
                  { provider: "openai", id: "gpt-supported", reasoning: true },
                  { provider: "openai", id: "gpt-unlisted", reasoning: true },
                ],
              }
            : request.type === "get_commands"
              ? piOpenAIFastCommandData
              : undefined;
      const response = JSON.stringify({ type: "response", id: request.id, success: true, data });
      return Queue.offer(output, encoder.encode(`${response}\n`)).pipe(Effect.asVoid);
    });

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(900_000_002),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin,
      stdout: Stream.fromQueue(output),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  });
}

function piProbeSpawner(version: string, enableRpcDiscovery = false) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    if (args.includes("--version")) {
      return Effect.succeed(processHandle({ stdout: `pi ${version}\n` }));
    }
    return enableRpcDiscovery
      ? piRpcProcessHandle()
      : Effect.succeed(processHandle({ stderr: "RPC startup failed", exitCode: 1 }));
  });
}

const settings = {
  enabled: true,
  binaryPath: process.execPath,
  launchArgs: "",
  customModels: [],
} as const;

const piOpenAIFastCommandData = {
  commands: [
    {
      name: "fast",
      source: "extension",
      sourceInfo: { source: "npm:@benvargas/pi-openai-fast" },
    },
  ],
} as const;

function withPiFastConfigFixture(
  run: (fixture: {
    readonly agentDir: string;
    readonly cwd: string;
    readonly configPath: string;
  }) => void,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-fast-"));
  const agentDir = NodePath.join(root, "agent");
  const cwd = NodePath.join(root, "workspace");
  const configPath = NodePath.join(agentDir, "extensions", "pi-openai-fast.json");
  NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
  NodeFS.mkdirSync(cwd);
  try {
    run({ agentDir, cwd, configPath });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function resolveFastConfig(
  fixture: { readonly agentDir: string; readonly cwd: string },
  commandsData: unknown = piOpenAIFastCommandData,
) {
  return resolvePiOpenAIFastConfig({
    commandsData,
    environment: { PI_CODING_AGENT_DIR: fixture.agentDir },
    cwd: fixture.cwd,
  });
}

describe("PiProvider", () => {
  it("reads package fast configuration from PI_CODING_AGENT_DIR", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-fast-"));
    try {
      const agentDir = NodePath.join(root, "agent");
      const workspace = NodePath.join(root, "workspace");
      NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
      NodeFS.mkdirSync(workspace);
      NodeFS.writeFileSync(
        NodePath.join(agentDir, "extensions", "pi-openai-fast.json"),
        JSON.stringify({
          persistState: true,
          active: true,
          supportedModels: ["openai/gpt-fast"],
        }),
      );

      const config = resolvePiOpenAIFastConfig({
        commandsData: {
          commands: [
            {
              name: "fast",
              source: "extension",
              sourceInfo: { source: "npm:@benvargas/pi-openai-fast" },
            },
          ],
        },
        environment: { PI_CODING_AGENT_DIR: agentDir },
        cwd: workspace,
      });

      assert.equal(config?.active, true);
      assert.deepEqual([...(config?.supportedModels ?? new Set()).values()], ["openai/gpt-fast"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not expose fast configuration when the target extension is not loaded", () => {
    withPiFastConfigFixture((fixture) => {
      NodeFS.writeFileSync(
        fixture.configPath,
        JSON.stringify({ active: true, supportedModels: ["openai/gpt-fast"] }),
      );

      assert.isUndefined(resolveFastConfig(fixture, { commands: [] }));
    });
  });

  it("does not confuse another /fast command for Pi OpenAI Fast", () => {
    withPiFastConfigFixture((fixture) => {
      NodeFS.writeFileSync(
        fixture.configPath,
        JSON.stringify({ active: true, supportedModels: ["openai/gpt-fast"] }),
      );

      assert.isUndefined(
        resolveFastConfig(fixture, {
          commands: [
            {
              name: "fast",
              source: "extension",
              sourceInfo: { source: "npm:@someone-else/pi-fast" },
            },
          ],
        }),
      );
    });
  });

  it("does not guess the extension default model list when supportedModels is missing", () => {
    withPiFastConfigFixture((fixture) => {
      NodeFS.writeFileSync(
        fixture.configPath,
        JSON.stringify({ active: true, persistState: true }),
      );

      assert.isUndefined(resolveFastConfig(fixture));
    });
  });

  it("keeps a model outside Fast eligibility unless it is explicitly supported", () => {
    withPiFastConfigFixture((fixture) => {
      NodeFS.writeFileSync(
        fixture.configPath,
        JSON.stringify({ active: true, supportedModels: ["openai/gpt-supported"] }),
      );
      const config = resolveFastConfig(fixture);

      assert.equal(config?.active, true);
      assert.isTrue(config?.supportedModels.has("openai/gpt-supported"));
      assert.isFalse(config?.supportedModels.has("openai/gpt-unlisted"));
    });
  });

  it.effect("does not show Fast for discovered models outside supportedModels", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-fast-rpc-"));
      const agentDir = NodePath.join(root, "agent");
      const cwd = NodePath.join(root, "workspace");
      const configPath = NodePath.join(agentDir, "extensions", "pi-openai-fast.json");
      NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
      NodeFS.mkdirSync(cwd);
      NodeFS.writeFileSync(
        configPath,
        '{"active":true,"persistState":true,"supportedModels":["openai/gpt-supported"]}',
      );
      try {
        const snapshot = yield* checkPiProviderStatus(
          settings,
          { PI_CODING_AGENT_DIR: agentDir },
          cwd,
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            piProbeSpawner("0.84.3", true),
          ),
        );
        const supportedTier = snapshot.models
          .find((model) => model.slug === "openai/gpt-supported")
          ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");
        const unlistedTier = snapshot.models
          .find((model) => model.slug === "openai/gpt-unlisted")
          ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");

        assert.equal(supportedTier?.currentValue, "priority");
        assert.isUndefined(unlistedTier);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("treats persisted fast mode as inactive when persistState is false", () => {
    withPiFastConfigFixture((fixture) => {
      NodeFS.writeFileSync(
        fixture.configPath,
        JSON.stringify({ active: true, persistState: false, supportedModels: ["openai/gpt-fast"] }),
      );
      const config = resolveFastConfig(fixture);

      assert.equal(config?.active, false);
      assert.isTrue(config?.supportedModels.has("openai/gpt-fast"));
    });
  });

  it("hides fast configuration when its config file is missing", () => {
    withPiFastConfigFixture((fixture) => {
      assert.isUndefined(resolveFastConfig(fixture));
    });
  });

  it("hides fast configuration when its config file is malformed", () => {
    withPiFastConfigFixture((fixture) => {
      NodeFS.writeFileSync(fixture.configPath, '{"active": true,');

      assert.isUndefined(resolveFastConfig(fixture));
    });
  });

  it.effect("does not expose Fast for Pi's unresolved default model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(settings);
      const defaultModel = snapshot.models.find((model) => model.slug === "default");

      assert.deepEqual(defaultModel?.capabilities?.optionDescriptors, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("uses project fast configuration before global configuration", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-fast-"));
    try {
      const agentDir = NodePath.join(root, "agent");
      const workspace = NodePath.join(root, "workspace");
      NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(workspace, ".pi", "extensions"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(agentDir, "extensions", "pi-openai-fast.json"),
        JSON.stringify({
          persistState: true,
          active: false,
          supportedModels: ["openai/global-model"],
        }),
      );
      NodeFS.writeFileSync(
        NodePath.join(workspace, ".pi", "extensions", "pi-openai-fast.json"),
        JSON.stringify({
          active: true,
          supportedModels: ["openai/project-model"],
        }),
      );

      const config = resolvePiOpenAIFastConfig({
        commandsData: {
          commands: [
            {
              name: "fast",
              source: "extension",
              sourceInfo: { source: "npm:@benvargas/pi-openai-fast" },
            },
          ],
        },
        environment: { PI_CODING_AGENT_DIR: agentDir },
        cwd: workspace,
      });

      assert.equal(config?.active, true);
      assert.deepEqual(
        [...(config?.supportedModels ?? new Set()).values()],
        ["openai/project-model"],
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
