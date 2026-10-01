export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";

const THREAD_PANEL_INLINE_MIN_WIDTH = 1_104;

export type ThreadPanelPresentation = "inline" | "popover";

export function resolveThreadPanelPresentation(
  workspaceWidth: number | null,
  occupiedRightPanelWidth: number,
  rightPanelMaximized: boolean,
  autoExpandThreadDetailsPanel = true,
): ThreadPanelPresentation {
  if (!autoExpandThreadDetailsPanel) return "popover";
  if (workspaceWidth === null) return "inline";

  const chatPaneWidth = rightPanelMaximized ? 0 : workspaceWidth - occupiedRightPanelWidth;
  return chatPaneWidth < THREAD_PANEL_INLINE_MIN_WIDTH ? "popover" : "inline";
}
