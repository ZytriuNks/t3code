import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AcpRegistryPrepareResult,
  AcpRegistrySearchAgent,
  EnvironmentId,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useI18n } from "../../i18n/I18nProvider";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

interface AcpRegistrySearchStepProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
  readonly onLoadingChange?: (loading: boolean) => void;
  readonly onPreparingChange?: (preparing: boolean) => void;
}

function applyAcpRegistryPrepareResult(
  agent: AcpRegistrySearchAgent,
  prepared: AcpRegistryPrepareResult,
): AcpRegistrySearchAgent {
  return {
    ...agent,
    id: prepared.agentId,
    version: prepared.version,
    distribution: prepared.distribution,
  };
}

export function AcpRegistrySearchStep({
  environmentId,
  providerInstances,
  onPrepared,
  onManualConfiguration,
  onLoadingChange,
  onPreparingChange,
}: AcpRegistrySearchStepProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  // An empty registry query is the compact compatible catalog. Start there so
  // entering this step is useful before the user knows what to search for.
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const prepareGeneration = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId,
      input: { query: submittedQuery },
    }),
  );
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });

  useEffect(
    () => () => {
      prepareGeneration.current += 1;
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
      onPreparingChange?.(false);
    },
    [onPreparingChange],
  );

  const submitSearch = (nextQuery: string) => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    const trimmed = nextQuery.trim();
    setQuery(trimmed);
    setPrepareError(null);
    if (trimmed === submittedQuery) {
      search.refresh();
    } else {
      setSubmittedQuery(trimmed);
    }
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitSearch(query);
  };

  const handlePrepare = async (agent: AcpRegistrySearchAgent) => {
    const generation = ++prepareGeneration.current;
    setPrepareError(null);
    setPreparingId(agent.id);
    onPreparingChange?.(true);
    const result = await prepareAgent({ environmentId, input: { agentId: agent.id } });
    if (prepareGeneration.current !== generation) return;
    setPreparingId(null);
    onPreparingChange?.(false);
    if (result._tag === "Success") {
      onPrepared(applyAcpRegistryPrepareResult(agent, result.value));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPrepareError(
        errorMessage(
          squashAtomCommandFailure(result),
          t("settings.providers.dialog.preparationFailed"),
        ),
      );
    }
  };

  const results = search.data?.agents ?? null;
  const isInitialSearch = search.isPending && results === null;
  const isRefreshing = search.isPending && results !== null;
  const resultCount = results?.length ?? 0;

  useLayoutEffect(() => {
    onLoadingChange?.(search.isPending);
    return () => onLoadingChange?.(false);
  }, [onLoadingChange, search.isPending]);

  return (
    <section className="grid gap-3" aria-labelledby="acp-registry-search-heading">
      <h3 className="sr-only" id="acp-registry-search-heading">
        {t("settings.providers.dialog.chooseAgent")}
      </h3>

      <form className="flex flex-wrap items-center gap-2" onSubmit={handleSearch}>
        <InputGroup className="min-w-40 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("settings.providers.dialog.searchRegistryAria")}
            disabled={preparingId !== null}
            onChange={(event) => {
              const nextQuery = event.currentTarget.value;
              setQuery(nextQuery);
              setPrepareError(null);
              if (searchTimer.current !== null) clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(() => {
                searchTimer.current = null;
                setSubmittedQuery(nextQuery.trim());
              }, 300);
            }}
            placeholder={t("settings.providers.dialog.searchAgents")}
            size="sm"
            type="search"
            value={query}
          />
        </InputGroup>
        <Button
          disabled={preparingId !== null}
          onClick={onManualConfiguration}
          size="sm"
          type="button"
          variant="ghost-muted"
        >
          {t("settings.providers.dialog.enterManually")}
        </Button>
      </form>

      <div className="sr-only" role="status">
        {isInitialSearch
          ? t("settings.providers.dialog.searching")
          : isRefreshing
            ? t("settings.providers.dialog.refreshing")
            : results
              ? t(
                  resultCount === 1
                    ? "settings.providers.dialog.resultCountOne"
                    : "settings.providers.dialog.resultCountOther",
                  { count: resultCount },
                )
              : ""}
      </div>

      {search.error || prepareError ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{prepareError ?? search.error}</AlertDescription>
        </Alert>
      ) : null}

      {isInitialSearch ? (
        <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
          {t("settings.providers.dialog.searchingRegistry")}
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center">
            <p className="text-sm font-medium">
              {t("settings.providers.dialog.noCompatibleAgents")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.providers.dialog.broaderSearch")}
            </p>
          </div>
        ) : (
          <ScrollArea scrollFade className="max-h-64">
            {/* The overlay scrollbar takes no layout space, so the rows
                reserve its lane explicitly. */}
            <div className="pr-2.5">
              {results.map((agent) => {
                const alreadyAdded = isConfiguredAcpRegistryAgent(providerInstances, agent.id);
                const isPreparing = preparingId === agent.id;
                const progressLabel =
                  agent.distribution === "binary"
                    ? t("settings.providers.dialog.downloading")
                    : t("settings.providers.dialog.preparing");
                return (
                  <article className="min-w-0 py-2.5" key={agent.id}>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <ProviderInstanceIcon
                          driverKind={ProviderDriverKind.make("acpRegistry")}
                          displayName={agent.name}
                          acpRegistryAgentId={agent.id}
                          acpRegistryIconUrl={agent.icon ?? undefined}
                          iconClassName="size-6 rounded-md text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h4 className="min-w-0 truncate text-sm font-medium text-foreground">
                              {agent.name}
                            </h4>
                          </div>
                          {agent.description ? (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {agent.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {agent.website || agent.repository ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost-muted"
                                  aria-label={t("settings.providers.dialog.aboutAgent", {
                                    name: agent.name,
                                  })}
                                  render={
                                    <a
                                      href={agent.website || agent.repository || undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                    />
                                  }
                                >
                                  <ExternalLinkIcon />
                                </Button>
                              }
                            />
                            <TooltipPopup>
                              {t("settings.providers.dialog.aboutAgent", { name: agent.name })}
                            </TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Button
                          aria-label={t("settings.providers.dialog.agentAction", {
                            action: alreadyAdded
                              ? t("settings.providers.dialog.alreadyAdded")
                              : isPreparing
                                ? progressLabel
                                : t("settings.providers.dialog.addAction"),
                            name: agent.name,
                          })}
                          disabled={alreadyAdded || preparingId !== null}
                          onClick={() => void handlePrepare(agent)}
                          size="xs"
                          variant={isPreparing ? "secondary" : "outline"}
                        >
                          {alreadyAdded
                            ? t("settings.providers.dialog.addedAction")
                            : isPreparing
                              ? progressLabel
                              : t("settings.providers.dialog.addAction")}
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        )
      ) : null}
    </section>
  );
}
