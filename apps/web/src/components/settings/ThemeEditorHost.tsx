import { lazy, Suspense, useSyncExternalStore } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n/I18nProvider";
import {
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useThemeEditorStore } from "./themeEditorStore";

const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);

function useThemeDefinition(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

export function ThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const { t } = useI18n();
  const { theme, setTheme, themeHalves, refreshTheme } = useTheme();
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);

  // The panel reports which path it actually took: a theme removed while its
  // editor is open resolves to null there, so the save becomes a create even
  // though the session still names it.
  const handleSaved = (
    savedTheme: ThemeDefinition,
    { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
  ) => {
    // A merge completed an existing theme's light/dark pair; activating the
    // whole theme shows the new palette right away.
    if (mergedAppearance) {
      if (!setTheme(savedTheme.id)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("settings.appearance.theme.saveFailed"),
            description: t("settings.appearance.theme.storageUnavailable"),
          }),
        );
        return false;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: t("settings.appearance.theme.updated", { name: savedTheme.label }),
          description: t(
            mergedAppearance === "light"
              ? "settings.appearance.theme.lightPaletteAdded"
              : "settings.appearance.theme.darkPaletteAdded",
          ),
        }),
      );
      return true;
    }
    if (!created) {
      // The edited theme may be showing through the base preference or either
      // half of the mix; the preference itself is untouched (a setTheme here
      // would clear the mix), the palette just needs re-applying.
      const wasActive =
        getThemeDefinition(theme)?.id === savedTheme.id ||
        themeHalves?.light === savedTheme.id ||
        themeHalves?.dark === savedTheme.id;
      if (wasActive) refreshTheme();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: t("settings.appearance.theme.saved", { name: savedTheme.label }),
          description: t(
            wasActive
              ? "settings.appearance.theme.changesActive"
              : "settings.appearance.theme.changesSaved",
          ),
        }),
      );
      return true;
    }

    if (!setTheme(savedTheme.id)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.appearance.theme.saveFailed"),
          description: t("settings.appearance.theme.storageUnavailable"),
        }),
      );
      return false;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: t("settings.appearance.theme.created", { name: savedTheme.label }),
        description: t("settings.appearance.theme.nowActive"),
      }),
    );
    return true;
  };

  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={editingTheme}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onOpenChange={(open) => {
          if (!open) closeThemeEditor();
        }}
        onSaved={handleSaved}
        open
        restoreTheme={refreshTheme}
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
