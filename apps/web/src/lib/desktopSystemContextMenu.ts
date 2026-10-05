import type { DesktopBridge } from "@t3tools/contracts";

import { isContextMenuOpen, showContextMenuFallback } from "../contextMenuFallback";

/** Draw the shell's editing menu without replacing its native clipboard operations. */
export function installDesktopSystemContextMenu(
  bridge: Pick<DesktopBridge, "onSystemContextMenu" | "resolveSystemContextMenu"> | undefined,
): (() => void) | undefined {
  if (!bridge?.onSystemContextMenu || !bridge.resolveSystemContextMenu) return undefined;
  const resolve = bridge.resolveSystemContextMenu;
  return bridge.onSystemContextMenu((request) => {
    // An application-specific menu wins if both entry points see the same gesture.
    const selection = isContextMenuOpen()
      ? Promise.resolve(null)
      : showContextMenuFallback(request.items, request.position, { preserveFocus: true });
    void selection
      .then((itemId) => resolve({ requestId: request.requestId, itemId }))
      .catch(() => console.error("Failed to handle desktop editing menu."));
  });
}
