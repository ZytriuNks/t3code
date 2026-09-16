import type { ConnectionStatusCopy } from "@t3tools/client-runtime/connection";
import type { LanguagePreference } from "@t3tools/contracts/settings";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { resolveAppLanguage, resolveSystemLocale, type AppLanguage } from "./locale";
import { translate, type MessageKey, type MessageValues } from "./messages";

export interface I18nContextValue {
  readonly language: AppLanguage;
  readonly preference: LanguagePreference;
  readonly t: (key: MessageKey, values?: MessageValues) => string;
}

const defaultValue: I18nContextValue = {
  language: "en",
  preference: "system",
  t: (key, values) => translate("en", key, values),
};

const I18nContext = createContext<I18nContextValue>(defaultValue);

function readSystemLocale(): string | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;

  return resolveSystemLocale({
    desktopLocale: window.desktopBridge?.getSystemLocale?.() ?? null,
    browserLanguages:
      navigator.languages.length > 0
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [],
  });
}

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const preference = useClientSettings((settings) => settings.language);
  const systemLocale = useMemo(() => readSystemLocale(), []);
  const language = resolveAppLanguage(preference, systemLocale);
  const t = useCallback(
    (key: MessageKey, values?: MessageValues) => translate(language, key, values),
    [language],
  );
  const value = useMemo(() => ({ language, preference, t }), [language, preference, t]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useConnectionStatusCopy(): ConnectionStatusCopy {
  const { t } = useI18n();
  return useMemo(
    () => ({
      available: t("connection.available"),
      offline: t("connection.offline"),
      connecting: t("connection.connecting"),
      reconnecting: t("connection.reconnecting"),
      reconnectingWithReason: (reason) => t("connection.reconnectingWithReason", { reason }),
      connected: t("connection.connected"),
      connectionFailed: t("connection.failed"),
      connectionFailedWithReason: (reason) => t("connection.failedWithReason", { reason }),
      reconnectingTitle: t("connection.reconnectingTitle"),
    }),
    [t],
  );
}
