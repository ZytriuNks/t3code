// @effect-diagnostics nodeBuiltinImport:off - exercises the synchronous check launcher with disposable files and captured spawns.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Shell from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";

import { collectPresentFiles, collectTests, runCheck } from "./check-changed.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
}));
vi.mock("node:path", async (importOriginal) => ({
  ...(await importOriginal<typeof NodePath>()),
}));

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-changed-"));
  return {
    cwd,
    [Symbol.dispose]() {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function spawnResult(status: number | null, error?: Error) {
  return {
    status,
    signal: null,
    output: [],
    pid: 0,
    stdout: "",
    stderr: "",
    ...(error ? { error } : {}),
  };
}

it("keeps new untracked source files while excluding repository directory entries and deleted files", () => {
  using temp = fixture();
  NodeFS.writeFileSync(NodePath.join(temp.cwd, "new.ts"), "export const value = 1;");
  NodeFS.mkdirSync(NodePath.join(temp.cwd, "nested-repository"));
  expect(collectPresentFiles(["new.ts", "nested-repository/", "deleted.ts"], temp.cwd)).toEqual([
    "new.ts",
  ]);
});

it("deduplicates changed and adjacent tests when the host joins paths with Windows separators", () => {
  using temp = fixture();
  NodeFS.mkdirSync(NodePath.join(temp.cwd, "src"));
  NodeFS.writeFileSync(NodePath.join(temp.cwd, "src/source.ts"), "");
  NodeFS.writeFileSync(NodePath.join(temp.cwd, "src/source.test.ts"), "");
  NodeFS.writeFileSync(NodePath.join(temp.cwd, "src/source.browser.test.tsx"), "");
  NodeFS.writeFileSync(NodePath.join(temp.cwd, "src/other.test.ts"), "");
  const join = NodePath.join;
  using _join = vi
    .spyOn(NodePath, "join")
    .mockImplementation((...parts) =>
      parts[0] === "src" ? NodePath.win32.join(...parts) : join(...parts),
    );
  expect([...collectTests(["src/source.ts", "src/source.test.ts"], temp.cwd)].sort()).toEqual([
    "src/source.browser.test.tsx",
    "src/source.test.ts",
  ]);
});

it("launches the resolved vp command with its arguments, working directory and inherited output", () => {
  const args = ["test", "run", "dir with spaces/source.test.ts", "value & more"];
  const resolved = { command: "escaped vp command", args: [], shell: true };
  using resolve = vi.spyOn(Shell, "resolveSpawnCommand").mockReturnValue(Effect.succeed(resolved));
  using spawn = vi.spyOn(NodeChildProcess, "spawnSync").mockReturnValue(spawnResult(0));
  expect(runCheck(args, "/check root")).toBe(true);
  expect(resolve).toHaveBeenCalledExactlyOnceWith("vp", args);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(resolved.command, resolved.args, {
    cwd: "/check root",
    stdio: "inherit",
    shell: true,
  });
});

it("preserves a failed check result without reporting a launcher error", () => {
  using _resolve = vi
    .spyOn(Shell, "resolveSpawnCommand")
    .mockReturnValue(Effect.succeed({ command: "vp", args: ["lint"], shell: false }));
  using spawn = vi.spyOn(NodeChildProcess, "spawnSync").mockReturnValue(spawnResult(7));
  using error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(runCheck(["lint"], "/check root")).toBe(false);
  expect(spawn).toHaveBeenCalledExactlyOnceWith("vp", ["lint"], {
    cwd: "/check root",
    stdio: "inherit",
    shell: false,
  });
  expect(error).not.toHaveBeenCalled();
});

it("reports launcher errors and fails the check when no process starts", () => {
  using _resolve = vi
    .spyOn(Shell, "resolveSpawnCommand")
    .mockReturnValue(Effect.succeed({ command: "vp", args: [], shell: false }));
  using _spawn = vi
    .spyOn(NodeChildProcess, "spawnSync")
    .mockReturnValue(spawnResult(null, new Error("spawn vp ENOENT")));
  using error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(runCheck(["lint"], "/check root")).toBe(false);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    "check:changed: could not launch vp: spawn vp ENOENT",
  );
});
