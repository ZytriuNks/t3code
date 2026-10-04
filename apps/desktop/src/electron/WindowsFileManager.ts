// @effect-diagnostics-next-line nodeBuiltinImport:off -- This native adapter owns a persistent, bidirectional helper pipe.
import * as NodeChildProcess from "node:child_process";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";

import { activateWindowsForegroundWithApi, loadWindowsForegroundApi } from "./WindowsForeground.ts";

const LOOKUP_SOURCE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$shell = New-Object -ComObject Shell.Application
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $handle = '0'
  try {
    $request = $line | ConvertFrom-Json
    $target = [System.IO.Path]::GetFullPath($request.folderPath).TrimEnd('\\')
    foreach ($window in @($shell.Windows())) {
      try {
        if ($window.FullName -notlike '*explorer.exe') { continue }
        $folder = [System.IO.Path]::GetFullPath($window.Document.Folder.Self.Path).TrimEnd('\\')
        if (-not [string]::Equals($folder, $target, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($request.selectedPath) {
          $item = $window.Document.Folder.ParseName([System.IO.Path]::GetFileName($request.selectedPath))
          if ($null -eq $item) { continue }
          $window.Document.SelectItem($item, 29)
          if (@($window.Document.SelectedItems() | Where-Object { $_.Path -eq $request.selectedPath }).Count -eq 0) { continue }
        }
        $handle = [string]$window.HWND
        break
      } catch {}
    }
  } catch {}
  [Console]::Out.WriteLine($handle)
}
`;

let helper: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
let lane: Promise<unknown> = Promise.resolve();
let ready: Promise<void> = Promise.resolve();
let pending:
  | { readonly resolve: (handle: string) => void; readonly reject: () => void }
  | undefined;

/** Warm one hidden COM helper; its stdin closes when the owning desktop process exits. */
export function startWindowsFileManager(): void {
  if (HostProcessPlatform.defaultValue() !== "win32" || helper !== undefined) return;
  const windowsRoot = HostProcessEnvironment.defaultValue().SystemRoot || "C:\\Windows";
  const child = NodeChildProcess.spawn(
    `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    [
      "-STA",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(LOOKUP_SOURCE, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  helper = child;
  let signalReady: () => void;
  ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    if (helper !== child) return;
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const handle = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (handle === "READY") {
        signalReady();
        continue;
      }
      pending?.resolve(handle);
    }
  });
  const failed = () => {
    if (helper !== child) return;
    helper = undefined;
    pending?.reject();
  };
  child.on("error", failed);
  child.on("exit", failed);
  child.stdin.on("error", failed);
}

export function stopWindowsFileManager(): void {
  const child = helper;
  helper = undefined;
  pending?.reject();
  child?.stdin.end();
  child?.kill();
}

function lookupWindow(folderPath: string, selectedPath?: string): Promise<string> {
  const result = lane.then(
    () =>
      new Promise<string>((resolve, reject) => {
        startWindowsFileManager();
        if (helper === undefined) {
          resolve("0");
          return;
        }
        const child = helper;
        const finish = (handle: string) => {
          clearTimeout(timer);
          pending = undefined;
          resolve(handle);
        };
        const fail = () => {
          clearTimeout(timer);
          pending = undefined;
          reject(new Error("Explorer window lookup unavailable."));
        };
        // @effect-diagnostics-next-line globalTimers:off -- Bound a native pipe request outside the Effect scheduler.
        const timer = setTimeout(() => {
          fail();
          stopWindowsFileManager();
        }, 2_000);
        pending = { resolve: finish, reject: fail };
        void ready.then(() => {
          if (helper !== child) return;
          child.stdin.write(JSON.stringify({ folderPath, selectedPath }) + "\n");
        });
      }),
  );
  lane = result.catch(() => undefined);
  return result;
}

/** Match the complete folder path and select the requested file before focusing. */
export const focusExistingWindowsFolder = Effect.fn("desktop.shell.focusExistingWindowsFolder")(
  function* (folderPath: string, selectedPath?: string) {
    return yield* Effect.gen(function* () {
      const output = yield* Effect.promise(() => lookupWindow(folderPath, selectedPath));
      if (!/^\d+$/.test(output)) return false;
      const handle = BigInt(output);
      if (handle === 0n) return false;
      const api = yield* Effect.promise(loadWindowsForegroundApi);
      return yield* Effect.sync(() => {
        api.restoreWindow?.(handle);
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(handle);
        return (
          activateWindowsForegroundWithApi(buffer, api) && api.getForegroundWindow() === handle
        );
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
      ),
    );
  },
);
