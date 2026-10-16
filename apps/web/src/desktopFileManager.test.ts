import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type DesktopBridge, type LaunchEditorInput } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { tryOpenDesktopFileManager } from "./desktopFileManager";

const primary = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("local-test"),
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const input: LaunchEditorInput = {
  cwd: "D:/outside workspace/author's 中文.txt",
  editor: "file-manager",
  reveal: true,
};
const makeBridge = (runningDistro: string | null = null) => ({
  getLocalEnvironmentBootstraps: () => [
    {
      id: "primary",
      label: "Local",
      runningDistro,
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
    },
  ],
  openLocalPath: vi.fn(async () => true),
});

describe("tryOpenDesktopFileManager", () => {
  it("reveals an absolute local file without a backend launch", async () => {
    const bridge = makeBridge();
    expect(await tryOpenDesktopFileManager(input, primary, bridge)).toBe(true);
    expect(bridge.openLocalPath.mock.calls).toEqual([[{ path: input.cwd, reveal: true }]]);
  });

  it("opens folders and unsupported files through their OS association", async () => {
    const bridge = makeBridge();
    expect(await tryOpenDesktopFileManager({ ...input, reveal: false }, primary, bridge)).toBe(
      true,
    );
    expect(bridge.openLocalPath.mock.calls).toEqual([[{ path: input.cwd, reveal: false }]]);
  });

  it("leaves editor launches on the backend", async () => {
    const bridge = makeBridge();
    expect(await tryOpenDesktopFileManager({ ...input, editor: "vscode" }, primary, bridge)).toBe(
      false,
    );
    expect(bridge.openLocalPath).not.toHaveBeenCalled();
  });

  it("leaves remote and secondary WSL environments on their own backend", async () => {
    const bridge = makeBridge();
    for (const connectionId of ["remote-test", "local:wsl:ubuntu"]) {
      const target = new BearerConnectionTarget({
        environmentId: EnvironmentId.make(connectionId),
        label: "Other",
        connectionId,
      });
      expect(await tryOpenDesktopFileManager(input, target, bridge)).toBe(false);
    }
    expect(bridge.openLocalPath).not.toHaveBeenCalled();
  });

  it("does not mistake the WSL primary for a native Windows backend", async () => {
    const bridge = makeBridge("Ubuntu");
    expect(await tryOpenDesktopFileManager(input, primary, bridge)).toBe(false);
    expect(bridge.openLocalPath).not.toHaveBeenCalled();
  });

  it("requires a known native primary bootstrap and an absolute Windows path", async () => {
    const bridge = makeBridge();
    for (const cwd of ["relative/file.txt", "/home/user/file.txt", "D:relative.txt"]) {
      expect(await tryOpenDesktopFileManager({ ...input, cwd }, primary, bridge)).toBe(false);
    }
    bridge.getLocalEnvironmentBootstraps = () => [];
    expect(await tryOpenDesktopFileManager(input, primary, bridge)).toBe(false);
    expect(bridge.openLocalPath).not.toHaveBeenCalled();
  });

  it("accepts native UNC paths", async () => {
    const bridge = makeBridge();
    expect(
      await tryOpenDesktopFileManager(
        { ...input, cwd: "\\\\server\\share\\file.txt" },
        primary,
        bridge,
      ),
    ).toBe(true);
  });

  it("falls back for browser clients, older bridges, and native launch failures", async () => {
    expect(await tryOpenDesktopFileManager(input, primary, undefined)).toBe(false);
    const bridge = makeBridge();
    const olderBridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps" | "openLocalPath"> = {
      getLocalEnvironmentBootstraps: bridge.getLocalEnvironmentBootstraps,
    };
    expect(await tryOpenDesktopFileManager(input, primary, olderBridge)).toBe(false);
    bridge.openLocalPath.mockResolvedValue(false);
    expect(await tryOpenDesktopFileManager(input, primary, bridge)).toBe(false);
    bridge.openLocalPath.mockRejectedValue(new Error("Native shell unavailable"));
    expect(await tryOpenDesktopFileManager(input, primary, bridge)).toBe(false);
    bridge.getLocalEnvironmentBootstraps = () => {
      throw new Error("Bootstrap unavailable");
    };
    expect(await tryOpenDesktopFileManager(input, primary, bridge)).toBe(false);
  });
});
