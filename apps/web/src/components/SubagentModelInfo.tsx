import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type OrchestrationV2Subagent,
  type ServerProvider,
} from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function resolveSubagentModelInfo(input: {
  modelSelection: ModelSelection | null | undefined;
  subagent?: OrchestrationV2Subagent | null | undefined;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const { modelSelection, subagent, providers } = input;
  const instanceId = modelSelection?.instanceId ?? subagent?.providerInstanceId;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const driver = provider?.driver ?? subagent?.driver;
  const providerLabel = provider
    ? resolveProviderInstanceDisplayName(provider)
    : driver
      ? (PROVIDER_DISPLAY_NAMES[driver] ?? driver)
      : (instanceId ?? "—");
  const model = modelSelection?.model ?? subagent?.model;
  const catalogModel = provider?.models.find((candidate) => candidate.slug === model);
  const options = modelSelection?.options ?? [];
  const effort = options.find((option) =>
    ["reasoningEffort", "effort", "thinking", "variant"].includes(option.id),
  );
  const effortDescriptor = catalogModel?.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === effort?.id,
  );
  const effortLabel =
    effortDescriptor?.type === "select"
      ? (effortDescriptor.options.find((choice) => choice.id === effort?.value)?.label ??
        String(effort?.value ?? ""))
      : typeof effort?.value === "string"
        ? effort.value
        : typeof effort?.value === "boolean"
          ? effort.value
            ? "On"
            : "Off"
          : "";
  const fastMode = options.find((option) => option.id === "fastMode")?.value;
  const serviceTier = options.find((option) => option.id === "serviceTier")?.value;
  return {
    providerLabel,
    modelLabel: catalogModel?.name ?? model ?? "—",
    effortLabel,
    fast:
      typeof fastMode === "boolean"
        ? fastMode
        : serviceTier === "priority" || serviceTier === "fast",
  };
}

export function SubagentModelInfo({
  info,
  className,
}: {
  info: ReturnType<typeof resolveSubagentModelInfo>;
  className?: string;
}) {
  const prefix = `${info.providerLabel} · ${info.modelLabel}`;
  const traits = [info.fast ? "Fast" : "", info.effortLabel].filter(Boolean).join(" ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex min-w-0 items-center gap-1", className)} />}
      >
        <span className="truncate">{prefix}</span>
        {traits ? (
          <span className="inline-flex shrink-0 items-center gap-1">
            <span aria-hidden>·</span>
            {info.fast ? (
              <>
                <ZapIcon className="size-3 fill-current opacity-80" aria-hidden />
                <span className="sr-only">Fast</span>
              </>
            ) : null}
            {info.effortLabel}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{[prefix, traits].filter(Boolean).join(" · ")}</TooltipPopup>
    </Tooltip>
  );
}
