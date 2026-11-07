// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  collectPresentFiles,
  collectTests,
  comparisonBase,
  defaultConcurrency,
  gitLines,
  runCheck,
  runSteps,
  type Step,
} from "./check-changed.ts";

const GiB = 1024 ** 3;

const checkHandle = (exitCode: number, output: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.encodeText(Stream.make(output)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

describe("check:changed", () => {
  it.effect("keeps untracked files while excluding repository directories and deleted files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "check-changed-" });
      yield* fs.writeFileString(NodePath.join(cwd, "new.ts"), "export const value = 1;");
      yield* fs.makeDirectory(NodePath.join(cwd, "nested-repository"));
      assert.deepStrictEqual(
        yield* collectPresentFiles(["new.ts", "nested-repository/", "deleted.ts"], cwd),
        ["new.ts"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deduplicates changed and adjacent tests with Windows path separators", () =>
    Effect.gen(function* () {
      const tests = yield* collectTests(["src/source.ts", "src/source.test.ts"], "C:/fixture");
      assert.deepStrictEqual([...tests].sort(), [
        "src/source.browser.test.tsx",
        "src/source.test.ts",
      ]);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () =>
            Effect.succeed([
              "source.ts",
              "source.test.ts",
              "source.browser.test.tsx",
              "other.test.ts",
            ]),
        }),
      ),
      Effect.provide(NodePlatformPath.layerWin32),
    ),
  );

  it.effect("launches Windows vp shims with escaped arguments and captures their output", () =>
    Effect.gen(function* () {
      const commands: Array<ChildProcess.Command> = [];
      const args = ["test", "run", "dir with spaces/source.test.ts", "value & more"];
      const env = { FORCE_COLOR: "1" };
      const result = yield* runCheck(args, "C:/check root", env).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { PATH: "C:\\tools with spaces" }),
        Effect.provideService(SpawnExecutableResolution, () => "C:\\tools with spaces\\vp.cmd"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            commands.push(command);
            return Effect.succeed(checkHandle(0, "check output\n"));
          }),
        ),
      );
      assert.deepStrictEqual(result, { ok: true, output: "check output\n" });
      assert.strictEqual(commands.length, 1);
      const command = commands[0]!;
      assert.strictEqual(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") throw new Error("Expected a standard command");
      assert.strictEqual(
        command.command,
        String.raw`^"C:\tools^ with^ spaces\vp.cmd^" ^"test^" ^"run^" ^"dir^ with^ spaces/source.test.ts^" ^"value^ ^&^ more^"`,
      );
      assert.deepStrictEqual(command.args, []);
      assert.strictEqual(command.options.cwd, "C:/check root");
      assert.strictEqual(command.options.shell, true);
      assert.deepStrictEqual(command.options.env, env);
      assert.strictEqual(command.options.extendEnv, true);
    }),
  );

  it.effect("preserves failed check output and reports launcher errors as failures", () =>
    Effect.gen(function* () {
      const failed = yield* runCheck(["lint"], "/check root").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(checkHandle(7, "lint error"))),
        ),
      );
      assert.deepStrictEqual(failed, { ok: false, output: "lint error" });
      const error = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcessSpawner",
        method: "spawn",
        description: "spawn vp ENOENT",
      });
      const launchFailed = yield* runCheck(["lint"], "/check root").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.fail(error)),
        ),
      );
      assert.deepStrictEqual(launchFailed, { ok: false, output: error.message });
    }),
  );

  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });
});

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  const emptyConfig = NodePath.join(root, "empty-git-config");
  const fixtureConfig = {
    "core.excludesFile": emptyConfig,
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
  };
  // Git cannot open Node's Windows devNull path; keep user config and ignores out through a real empty file.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
    ...Object.fromEntries(
      Object.entries(fixtureConfig).flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
  try {
    NodeFS.writeFileSync(emptyConfig, "");
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    env,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const compare = (root: string, ref: Option.Option<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* comparisonBase(root, ref).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none(), project.env);
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"), project.env);
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});
