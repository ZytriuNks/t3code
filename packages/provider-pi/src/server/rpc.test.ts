import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makePiRpcConnection, type PiRpcRecord } from "./rpc.ts";

it.effect.each(["success", "error", "timeout", "info"] as const)(
  "records safe Pi request timing at the transport boundary: %s",
  (scenario) => {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message, logLevel }) => {
      logs.push({ message, logLevel });
    });
    return Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const requests = yield* Queue.unbounded<PiRpcRecord>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(999_999_999),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Queue.offer(
                requests,
                JSON.parse(new TextDecoder().decode(chunk)) as PiRpcRecord,
              ).pipe(Effect.asVoid),
            ),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: { API_KEY: "timing-env-secret" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const fiber = yield* connection
        .request(
          { type: "get_state", message: "timing-prompt-secret", token: "timing-token-secret" },
          100,
        )
        .pipe(Effect.result, Effect.forkChild);
      const request = yield* Queue.take(requests);
      yield* TestClock.adjust("25 millis");
      if (scenario === "timeout") yield* TestClock.adjust("75 millis");
      else
        yield* Queue.offer(
          stdout,
          new TextEncoder().encode(
            JSON.stringify({
              type: "response",
              id: request.id,
              command: "get_state",
              success: scenario !== "error",
              data: { secret: "timing-response-secret" },
              error: "timing-error-secret",
            }) + "\n",
          ),
        );
      yield* Fiber.join(fiber);
      const text = JSON.stringify(logs);
      for (const secret of [
        "timing-env-secret",
        "timing-prompt-secret",
        "timing-token-secret",
        "timing-response-secret",
        "timing-error-secret",
      ])
        assert.notInclude(text, secret);
      const entries = logs as Array<{ message: unknown[]; logLevel: string }>;
      const timing = entries.filter((entry) => entry.message[0] === "pi-rpc.elapsed");
      if (scenario === "info") assert.deepEqual(timing, []);
      else {
        assert.lengthOf(timing, 1);
        assert.equal(timing[0]!.logLevel, "Debug");
        assert.deepEqual(timing[0]!.message[1], {
          operation: "get_state",
          outcome: scenario === "success" ? "ok" : "err",
          elapsedMs: scenario === "timeout" ? 100 : 25,
          timeoutMs: 100,
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, scenario === "info" ? "Info" : "Debug"),
        ),
      ),
    );
  },
);
