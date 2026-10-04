import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type LaunchEditorInput,
} from "@t3tools/contracts";

/** Avoid launching a subprocess for the desktop app's native local file manager. */
export async function tryOpenDesktopFileManager(
  input: LaunchEditorInput,
  target: ConnectionTarget,
  bridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps" | "openLocalPath"> | undefined,
): Promise<boolean> {
  if (
    input.editor !== "file-manager" ||
    target._tag !== "PrimaryConnectionTarget" ||
    bridge?.openLocalPath === undefined ||
    !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(input.cwd)
  ) {
    return false;
  }
  try {
    const primary = bridge
      .getLocalEnvironmentBootstraps()
      .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (primary === undefined || primary.runningDistro !== null) return false;
    return await bridge.openLocalPath({ path: input.cwd, reveal: input.reveal === true });
  } catch {
    // Older desktop bridges and native launch failures retain the RPC path.
    return false;
  }
}
