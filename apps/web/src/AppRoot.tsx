import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { setHideUnavailableContextMenuItems } from "./contextMenuPreferences";
import { I18nProvider } from "./i18n/I18nProvider";
import { useClientSettings } from "./hooks/useSettings";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(() => installDesktopSystemContextMenu(window.desktopBridge), []);
  useContextMenuPreferenceSync();

  return (
    <I18nProvider>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
        <PreviewAutomationHosts />
        <ElectronBrowserHost />
        <QuitHoldOverlay />
      </AppAtomRegistryProvider>
    </I18nProvider>
  );
}

/**
 * Mirror settings flags that the imperative context menu fallback reads at
 * open time. Settings live in React state but the menu runs as a plain function
 * from `localApi.contextMenu.show`, so we propagate the flag into the module
 * store whenever the user flips it.
 */
function useContextMenuPreferenceSync(): void {
  const hideUnavailable = useClientSettings((settings) => settings.hideUnavailableContextMenuItems);
  useEffect(() => {
    setHideUnavailableContextMenuItems(hideUnavailable);
  }, [hideUnavailable]);
}
