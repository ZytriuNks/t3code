import type { LanguagePreference } from "@t3tools/contracts/settings";

export type AppLanguage = Exclude<LanguagePreference, "system">;

function isSimplifiedChineseLocale(locale: string | null | undefined): boolean {
  const normalized = locale?.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) return false;

  return (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized.startsWith("zh-cn-") ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-sg-") ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  );
}

export function resolveAppLanguage(
  preference: LanguagePreference,
  systemLocale: string | null | undefined,
): AppLanguage {
  if (preference !== "system") return preference;
  return isSimplifiedChineseLocale(systemLocale) ? "zh-CN" : "en";
}

export function resolveSystemLocale({
  desktopLocale,
  browserLanguages,
}: {
  readonly desktopLocale: string | null | undefined;
  readonly browserLanguages: ReadonlyArray<string>;
}): string | null {
  const hostLocale = desktopLocale?.trim();
  if (hostLocale) return hostLocale;

  return browserLanguages.find((locale) => locale.trim().length > 0) ?? null;
}
