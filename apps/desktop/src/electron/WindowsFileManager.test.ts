import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, vi } from "vite-plus/test";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import {
  focusExistingWindowsFolder,
  startWindowsFileManager,
  stopWindowsFileManager,
} from "./WindowsFileManager.ts";

function makeHelper(autoReady = true) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let receive: (chunk: string) => void;
  const requests: { folderPath: string; selectedPath?: string }[] = [];
  const child = {
    stdout: {
      setEncoding: vi.fn(),
      on: (_event: string, listener: typeof receive) => {
        receive = listener;
        if (autoReady) queueMicrotask(() => receive("READY\r\n"));
      },
    },
    stderr: { resume: vi.fn() },
    stdin: {
      on: vi.fn(),
      write: (line: string) => {
        requests.push(JSON.parse(line));
        queueMicrotask(() => receive("0\r\n"));
      },
      end: vi.fn(),
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    },
    kill: vi.fn(),
  };
  return {
    child,
    requests,
    ready: () => receive("READY\r\n"),
    exit: () => listeners.get("exit")?.(0),
  };
}

describe.skipIf(HostProcessPlatform.defaultValue() !== "win32")(
  "Windows file manager helper",
  () => {
    afterEach(() => {
      stopWindowsFileManager();
      spawn.mockReset();
    });

    it.effect("holds the first request until the helper's UTF-8 reader is ready", () =>
      Effect.gen(function* () {
        const fixture = makeHelper(false);
        spawn.mockReturnValue(fixture.child);
        startWindowsFileManager();
        const result = yield* Effect.forkChild(focusExistingWindowsFolder("D:/quoted 中文"));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal(fixture.requests.length, 0);
        fixture.ready();
        assert.isFalse(yield* Fiber.join(result));
        assert.deepEqual(fixture.requests, [{ folderPath: "D:/quoted 中文" }]);
      }),
    );

    it.effect("reuses one hidden process for concurrent Unicode and quoted path requests", () =>
      Effect.gen(function* () {
        const fixture = makeHelper();
        spawn.mockReturnValue(fixture.child);
        startWindowsFileManager();
        startWindowsFileManager();
        const paths = [
          "D:/one/author's 中文.txt",
          "D:/two/other.txt",
          "\\\\server\\share\\file.txt",
        ];
        const results = yield* Effect.all(
          paths.map((selectedPath) => focusExistingWindowsFolder("D:/one", selectedPath)),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(results, [false, false, false]);
        assert.deepEqual(
          fixture.requests,
          paths.map((selectedPath) => ({ folderPath: "D:/one", selectedPath })),
        );
        assert.equal(spawn.mock.calls.length, 1);
        const [, args, options] = spawn.mock.calls[0]!;
        assert.isTrue(options.windowsHide);
        assert.equal(args[args.indexOf("-WindowStyle") + 1], "Hidden");
        stopWindowsFileManager();
        assert.equal(fixture.child.kill.mock.calls.length, 1);
        assert.equal(fixture.child.stdin.end.mock.calls.length, 1);
      }),
    );

    it.effect("restarts after the helper exits without retaining stale replies", () =>
      Effect.gen(function* () {
        const first = makeHelper();
        const second = makeHelper();
        spawn.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
        assert.isFalse(yield* focusExistingWindowsFolder("D:/first"));
        first.exit();
        assert.isFalse(yield* focusExistingWindowsFolder("D:/second"));
        assert.equal(spawn.mock.calls.length, 2);
        assert.deepEqual(first.requests, [{ folderPath: "D:/first" }]);
        assert.deepEqual(second.requests, [{ folderPath: "D:/second" }]);
      }),
    );
  },
);
