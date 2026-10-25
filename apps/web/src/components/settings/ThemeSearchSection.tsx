import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon, PackagePlusIcon, PaletteIcon, SearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSort,
} from "../../openVsxThemes";
import { useDebouncedValue } from "../../state/queries";
import {
  getCustomThemes,
  getStoredCustomThemeCollection,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "../../themePalette";
import { GitHubIcon, GitLabIcon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; labelKey: MessageKey }> = [
  { value: "downloadCount", labelKey: "settings.appearance.theme.sortMostDownloaded" },
  { value: "rating", labelKey: "settings.appearance.theme.sortBestRated" },
  { value: "timestamp", labelKey: "settings.appearance.theme.sortNewest" },
  { value: "relevance", labelKey: "settings.appearance.theme.sortMostRelevant" },
];
const SEARCH_DEBOUNCE_MS = 350;

function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function SourceLinkIcon({ url }: { url: string }) {
  const host = sourceHost(url);
  if (host === "github.com" || host?.endsWith(".github.com"))
    return <GitHubIcon className="size-3.5" />;
  if (host === "gitlab.com" || host?.endsWith(".gitlab.com"))
    return <GitLabIcon className="size-3.5" monochrome />;
  return <ExternalLinkIcon className="size-3.5" />;
}

function ThemeExtensionIcon({ extension }: { extension: OpenVsxThemeExtension }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {extension.iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={extension.iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <PaletteIcon className="size-4" />
      )}
    </div>
  );
}

export function ThemeSearchSection({
  open,
  onInstalled,
}: {
  open: boolean;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  // Recorded only once a search succeeds, so a finished install reruns the
  // search only when the query or sort changed while it was in flight, and the
  // install error the user needs to see survives.
  const [lastSearchKey, setLastSearchKey] = useState<string | null>(null);
  const [handledSearch, setHandledSearch] = useState<{
    key: string;
    query: string;
    fetch: boolean;
  } | null>(null);
  // An install aborts any search, so once it ends the current key is checked
  // again even though it has not changed.
  const [searchInterrupted, setSearchInterrupted] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setSortBy("downloadCount");
      setResults(null);
      setError(null);
      setIsSearching(false);
      setInstallingId(null);
      setPendingUpdate(null);
      setLastSearchKey(null);
      setHandledSearch(null);
      setSearchInterrupted(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [open]);

  const queryCleared = !query.trim() && installingId === null;
  if (
    queryCleared &&
    (results !== null ||
      error !== null ||
      isSearching ||
      lastSearchKey !== null ||
      handledSearch !== null)
  ) {
    setResults(null);
    setError(null);
    setIsSearching(false);
    setLastSearchKey(null);
    setHandledSearch(null);
  }

  useEffect(() => {
    if (!queryCleared) return;
    requestRef.current?.abort();
    requestRef.current = null;
  }, [queryCleared]);

  const startRequest = () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    return controller;
  };

  const fetchResults = (trimmed: string, controller: AbortController) => {
    const key = `${trimmed}\u0000${sortBy}`;
    void searchOpenVsxThemes(trimmed, { signal: controller.signal, sortBy })
      .then(
        (nextResults) => {
          if (controller.signal.aborted) return;
          setResults(nextResults);
          setLastSearchKey(key);
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          setResults(null);
          setLastSearchKey(null);
          setError(
            cause instanceof Error ? cause.message : t("settings.appearance.theme.searchFailed"),
          );
        },
      )
      .then(() => {
        if (requestRef.current !== controller) return;
        requestRef.current = null;
        setIsSearching(false);
      });
  };

  const runSearch = (searchText: string) => {
    const trimmed = searchText.trim();
    if (!trimmed) return;
    setError(null);
    setIsSearching(true);
    fetchResults(trimmed, startRequest());
  };

  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searchKey = `${debouncedQuery}\u0000${sortBy}`;
  // An unsettled query would hit Open VSX for text that is no longer visible;
  // wait for the debounce to catch up to the current input instead.
  const searchSettled =
    open && installingId === null && debouncedQuery !== "" && debouncedQuery === query.trim();

  const keyChanged = handledSearch?.key !== searchKey;
  if (searchSettled && (keyChanged || searchInterrupted)) {
    // Typing and then undoing lands back on the key already shown; keep those
    // results instead of searching again.
    const fetch = lastSearchKey !== searchKey;
    setHandledSearch({ key: searchKey, query: debouncedQuery, fetch });
    setSearchInterrupted(false);
    // An install error on an unchanged, already-shown query stays visible.
    if (fetch || keyChanged) setError(null);
    setIsSearching(fetch);
  }

  const fetchHandledSearch = useEffectEvent((searchText: string) => {
    fetchResults(searchText, startRequest());
  });

  useEffect(() => {
    if (!handledSearch) return;
    if (handledSearch.fetch) {
      fetchHandledSearch(handledSearch.query);
      return;
    }
    // A request for a newer key may still be in flight; abort it so it cannot
    // overwrite the results being kept.
    requestRef.current?.abort();
    requestRef.current = null;
  }, [handledSearch]);

  const handleSortChange = (value: OpenVsxThemeSort | null) => {
    const nextSort = SORT_OPTIONS.find((option) => option.value === value)?.value;
    if (!nextSort) return;
    setSortBy(nextSort);
  };

  const handleInstall = async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
    setError(null);
    let installedCollection: ReadonlyArray<ThemeDefinition>;
    try {
      installedCollection = getStoredCustomThemeCollection(extension.collectionId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("settings.appearance.theme.installedReadFailed"),
      );
      return;
    }
    const updated = installedCollection.length > 0;
    if (updated && !allowUpdate) {
      setPendingUpdate(extension);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsSearching(false);
    setSearchInterrupted(true);
    setInstallingId(extension.id);
    try {
      const themes = await importOpenVsxThemeExtension(extension, controller.signal);
      if (!controller.signal.aborted) {
        const imported = replaceCustomThemeCollection(extension.collectionId, themes, {
          expectedCollection: installedCollection,
        });
        onInstalled(imported, { updated });
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error ? cause.message : t("settings.appearance.theme.installFailed"),
        );
      }
    }
    if (requestRef.current === controller) {
      requestRef.current = null;
      setInstallingId(null);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-sm font-medium" id="theme-search-heading">
          {t("settings.appearance.theme.searchHeading")}
        </h3>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {t("settings.appearance.theme.searchDescription")}
        </p>
      </div>
      <InputGroup>
        <InputGroupAddon>
          {isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t("settings.appearance.theme.searchLabel")}
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !isSearching && installingId === null)
              runSearch(query.trim());
          }}
          placeholder={t("settings.appearance.theme.searchPlaceholder")}
          size="lg"
          type="search"
          value={query}
        />
      </InputGroup>

      {!isSearching || results !== null ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="text-muted-foreground text-xs">
              {t("settings.appearance.theme.popular")}
            </p>
            {SUGGESTED_SEARCHES.map((suggestion) => (
              <Button
                key={suggestion}
                disabled={installingId !== null}
                size="xs"
                variant="ghost"
                onClick={() => {
                  if (query.trim() === suggestion) {
                    runSearch(suggestion);
                  } else {
                    setQuery(suggestion);
                  }
                }}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          {results && results.length > 0 ? (
            <div className="flex shrink-0 items-center justify-end gap-2">
              <p className="text-muted-foreground text-xs">{t("settings.appearance.theme.sort")}</p>
              <Select
                disabled={installingId !== null}
                value={sortBy}
                onValueChange={handleSortChange}
              >
                <SelectTrigger
                  size="sm"
                  className="w-40"
                  aria-label={t("settings.appearance.theme.sortLabel")}
                >
                  <SelectValue>
                    {t(
                      SORT_OPTIONS.find((option) => option.value === sortBy)?.labelKey ??
                        "settings.appearance.theme.sortMostDownloaded",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} hideIndicator value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="sr-only" role="status">
        {isSearching
          ? t("settings.appearance.theme.searching")
          : results
            ? t(
                results.length === 1
                  ? "settings.appearance.theme.searchResultOne"
                  : "settings.appearance.theme.searchResultOther",
                { count: results.length },
              )
            : ""}
      </div>

      {error ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isSearching && results === null ? (
        <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Spinner /> {t("settings.appearance.theme.searching")}
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed text-center">
            <p className="text-sm font-medium">{t("settings.appearance.theme.noResults")}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t("settings.appearance.theme.broaderSearch")}
            </p>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((extension) => {
              const isInstalling = installingId === extension.id;
              const isInstalled = getCustomThemes().some(
                (theme) => theme.collection?.id === extension.collectionId,
              );
              const action = isInstalled
                ? t("settings.appearance.theme.update")
                : t("settings.appearance.theme.install");
              const progressAction = isInstalled
                ? t("settings.appearance.theme.updating")
                : t("settings.appearance.theme.installing");
              const actionLabelKey: MessageKey = isInstalling
                ? isInstalled
                  ? "settings.appearance.theme.updatingAction"
                  : "settings.appearance.theme.installingAction"
                : isInstalled
                  ? "settings.appearance.theme.updateAction"
                  : "settings.appearance.theme.installAction";
              return (
                <article
                  className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
                  key={extension.id}
                >
                  <div className="flex min-w-0 gap-3">
                    <ThemeExtensionIcon key={extension.iconUrl} extension={extension} />
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate text-sm font-medium">{extension.name}</h4>
                      <p className="truncate text-muted-foreground text-xs">
                        {t("settings.appearance.theme.extensionMeta", {
                          publisher: extension.publisher,
                          count: DOWNLOAD_FORMAT.format(extension.downloadCount),
                        })}
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">
                    {extension.description ||
                      t("settings.appearance.theme.extensionDescriptionFallback")}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {extension.sourceUrl ? (
                        <Button
                          aria-label={t("settings.appearance.theme.viewSource", {
                            name: extension.name,
                          })}
                          render={<a href={extension.sourceUrl} rel="noreferrer" target="_blank" />}
                          size="icon-micro"
                          variant="ghost-muted"
                        >
                          <SourceLinkIcon url={extension.sourceUrl} />
                        </Button>
                      ) : null}
                    </div>
                    <Button
                      aria-label={t(actionLabelKey, { name: extension.name })}
                      disabled={installingId !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => void handleInstall(extension, false)}
                    >
                      {isInstalling ? (
                        <Spinner />
                      ) : isInstalled ? (
                        <RefreshIcon />
                      ) : (
                        <PackagePlusIcon />
                      )}
                      {isInstalling ? progressAction : action}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      <AlertDialog
        open={pendingUpdate !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingUpdate(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.appearance.theme.updateTitle", { name: pendingUpdate?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.appearance.theme.updateDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("settings.general.cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                if (extension) void handleInstall(extension, true);
              }}
            >
              {t("settings.appearance.theme.updateTheme")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
