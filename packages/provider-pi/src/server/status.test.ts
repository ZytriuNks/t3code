// @effect-diagnostics-next-line nodeBuiltinImport:off - Pi 配置探测的同步文件边界与生产实现保持一致。
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Pi 扩展使用原生路径规则。
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { checkPiProviderStatus, MINIMUM_PI_VERSION, resolvePiOpenAIFastConfig } from "./status.ts";

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

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const isVersionProbe =
      ChildProcess.isStandardCommand(command) &&
      // Windows 的 .cmd 包装会把参数转入带转义的 shell 命令字符串。
      (command.args.includes("--version") || command.command.includes("--version"));
    return Effect.succeed(
      isVersionProbe
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it("resolves project Fast config and honors persistState false", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync("."), "t3-pi-fast-test-"));
    try {
      const configPath = NodePath.join(cwd, ".pi", "extensions", "pi-openai-fast.json");
      NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
      NodeFS.writeFileSync(
        configPath,
        JSON.stringify({
          persistState: false,
          active: true,
          supportedModels: ["openai/gpt-5.6-sol", "invalid"],
        }),
      );
      const commandsData = {
        commands: [
          {
            name: "fast",
            source: "extension",
            sourceInfo: { source: "npm:@benvargas/pi-openai-fast" },
          },
        ],
      };
      const config = resolvePiOpenAIFastConfig({ commandsData, environment: {}, cwd });
      assert.isDefined(config);
      assert.isFalse(config?.active);
      assert.deepEqual([...config!.supportedModels], ["openai/gpt-5.6-sol"]);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
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
