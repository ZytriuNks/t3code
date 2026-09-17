import type { DevicePlatform, DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import { Check, CircleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { DialogClose } from "~/components/ui/dialog";
import { WizardHeader, WizardPanel, WizardSteps, WizardFooter } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n/I18nProvider";

const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");

export const deviceHubDescription =
  "Enable this environment to open simulators and emulators, whether they run here or on a remote device host.";
export const agentDeviceDescription =
  "Allow new agent sessions in this environment to start and control local and remote devices, with required tools set up automatically.";

export function platformSetupStatus(
  state: DeviceServiceState,
  platform: DevicePlatform,
  t: ReturnType<typeof useI18n>["t"],
) {
  const availability = state.hosts
    .flatMap((host) => host.platforms)
    .find((candidate) => candidate.platform === platform);
  if (!availability?.available) {
    return {
      ready: false,
      message:
        availability?.reason ??
        t("settings.devices.setup.supportNotDetected", { platform: platformName(platform) }),
    };
  }
  if (
    state.hostStatus === "ready" &&
    !state.devices.some((device) => device.platform === platform)
  ) {
    return {
      ready: false,
      message:
        platform === "ios"
          ? t("settings.devices.setup.iosRuntimeMissing")
          : t("settings.devices.setup.androidDeviceMissing"),
    };
  }
  return {
    ready: true,
    message:
      platform === "ios"
        ? t("settings.devices.setup.iosReady")
        : t("settings.devices.setup.androidReady"),
  };
}

export function DeviceSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly onComplete?: () => void;
}) {
  const { t } = useI18n();
  const configure = useAtomCommand(deviceEnvironment.configure);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [pending, setPending] = useState<"hub" | "check" | "agent" | "complete" | null>(null);
  const [step, setStep] = useState(0);
  const enabled = props.state.hostStatus !== "disabled";
  const busy = props.state.hostStatus === "installing" || props.state.hostStatus === "starting";

  const update = async (
    kind: NonNullable<typeof pending>,
    input: { enabled?: boolean; agentAccessEnabled?: boolean; onboardingCompleted?: boolean },
  ) => {
    setPending(kind);
    try {
      const result = await configure({ environmentId: props.environmentId, input });
      if (kind === "complete" && result._tag === "Success") props.onComplete?.();
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <WizardHeader
        title={t("settings.devices.setup.title")}
        description={t("settings.devices.setup.description")}
      >
        <WizardSteps
          steps={[
            t("settings.devices.setup.step.deviceHub"),
            t("settings.devices.setup.step.simulators"),
            t("settings.devices.setup.step.agentAccess"),
          ]}
          currentStep={step}
          onStepChange={setStep}
          isStepDisabled={(requested) => busy || pending !== null || requested > step}
        />
      </WizardHeader>

      <WizardPanel>
        {step === 0 ? (
          <section className="space-y-3 text-sm">
            <h3 className="font-medium">{t("settings.devices.setup.enableHub")}</h3>
            <div className="flex items-start justify-between gap-4">
              <p className="text-muted-foreground">{t("settings.devices.hub.description")}</p>
              <Switch
                checked={enabled}
                disabled={busy || pending !== null}
                aria-label={t("settings.devices.setup.enableHub")}
                onCheckedChange={(checked) =>
                  void update("hub", {
                    enabled: Boolean(checked),
                    ...(checked ? {} : { agentAccessEnabled: false }),
                  })
                }
              />
            </div>
            <DeviceHubSetupStatus
              state={props.state}
              pending={pending === "hub" || (busy && pending !== "agent")}
            />
          </section>
        ) : null}

        {step === 1 ? (
          <section className="space-y-3 text-sm">
            <h3 className="font-medium">{t("settings.devices.setup.checkSupport")}</h3>
            <DevicePlatformSetup
              state={props.state}
              checking={pending === "check"}
              disabled={!enabled || busy || pending !== null}
              onCheck={() => {
                setPending("check");
                void list({ environmentId: props.environmentId, input: {} }).finally(() =>
                  setPending(null),
                );
              }}
            />
          </section>
        ) : null}

        {step === 2 ? (
          <section className="space-y-3 text-sm">
            <h3 className="font-medium">{t("settings.devices.setup.allowAgentControl")}</h3>
            <div className="flex items-start justify-between gap-4">
              <p className="text-muted-foreground">{t("settings.devices.agent.description")}</p>
              <Switch
                checked={props.state.agentAccessEnabled}
                disabled={!enabled || busy || pending !== null}
                aria-label={t("settings.devices.setup.allowAgentControl")}
                onCheckedChange={(checked) =>
                  void update("agent", { agentAccessEnabled: Boolean(checked) })
                }
              />
            </div>
            <AgentDeviceSetupStatus state={props.state} pending={pending === "agent"} />
            <p className="text-xs text-muted-foreground">
              {t("settings.devices.setup.manualControls")}
            </p>
          </section>
        ) : null}
        {props.state.hostStatus === "failed" && props.state.hostStatusDetail ? (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {props.state.hostStatusDetail}
          </p>
        ) : null}
      </WizardPanel>

      <WizardFooter>
        {step === 0 ? (
          <DialogClose render={<Button variant="outline" />}>
            {t("settings.general.cancel")}
          </DialogClose>
        ) : (
          <Button
            variant="outline"
            disabled={busy || pending !== null}
            onClick={() => setStep(step - 1)}
          >
            {t("settings.devices.setup.back")}
          </Button>
        )}
        {step < 2 ? (
          <Button
            disabled={props.state.hostStatus !== "ready" || pending !== null}
            onClick={() => setStep(step + 1)}
          >
            {t("settings.devices.setup.continue")}
          </Button>
        ) : (
          <Button
            disabled={props.state.hostStatus !== "ready" || pending !== null}
            onClick={() => void update("complete", { onboardingCompleted: true })}
          >
            {pending === "complete"
              ? t("settings.devices.setup.saving")
              : t("settings.devices.setup.done")}
          </Button>
        )}
      </WizardFooter>
    </>
  );
}

export function DeviceHubSetupStatus({
  state,
  pending,
  compact = false,
}: {
  readonly state: DeviceServiceState;
  readonly pending: boolean;
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  if (!pending && state.hostStatus !== "ready") return null;
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      {pending ? <Spinner className="size-3" /> : <Check className="size-3 text-success" />}
      {pending
        ? state.hostStatus === "installing"
          ? compact
            ? t("settings.devices.setup.installing")
            : t("settings.devices.setup.installingHub")
          : state.hostStatus === "starting"
            ? compact
              ? t("settings.devices.setup.starting")
              : t("settings.devices.setup.startingHub")
            : compact
              ? t("settings.devices.setup.updating")
              : t("settings.devices.setup.updatingHub")
        : t("settings.devices.setup.hubReady")}
    </p>
  );
}

function DevicePlatformSetup(props: {
  readonly state: DeviceServiceState;
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly onCheck: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <PlatformStatus platform="iOS" status={platformSetupStatus(props.state, "ios", t)} />
      <PlatformStatus platform="Android" status={platformSetupStatus(props.state, "android", t)} />
      <p className="text-xs text-muted-foreground">{t("settings.devices.setup.platformHint")}</p>
      <Button size="compact" variant="outline" disabled={props.disabled} onClick={props.onCheck}>
        {props.checking ? <Spinner className="size-3" /> : null}
        {props.checking
          ? t("settings.devices.setup.checking")
          : t("settings.devices.setup.checkAgain")}
      </Button>
    </div>
  );
}

export function AgentDeviceSetupStatus(props: {
  readonly state: DeviceServiceState;
  readonly pending: boolean;
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  if (props.pending) {
    const label =
      props.state.hostStatus === "installing"
        ? props.compact
          ? t("settings.devices.setup.installing")
          : t("settings.devices.setup.installingAgentTools")
        : props.state.hostStatus === "starting"
          ? props.compact
            ? t("settings.devices.setup.starting")
            : t("settings.devices.setup.startingAgentTools")
          : props.compact
            ? t("settings.devices.setup.updating")
            : t("settings.devices.setup.updatingAgentAccess");
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        {label}
      </p>
    );
  }
  if (
    props.state.agentAccessEnabled &&
    props.state.hostStatus === "ready" &&
    props.state.hosts.some((host) => host.agentDeviceInstalled)
  ) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-3 text-success" />
        {t("settings.devices.setup.agentReady")}
      </p>
    );
  }
  return null;
}

export function PlatformStatus(props: {
  readonly platform: string;
  readonly status: { readonly ready: boolean; readonly message: string };
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  const Icon = props.status.ready ? Check : CircleAlert;
  return (
    <div
      className={cn("flex gap-2", !props.compact && "rounded-md border border-border/60 px-3 py-2")}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          props.status.ready ? "text-success" : "text-muted-foreground",
        )}
      />
      <div className={cn(props.compact && props.status.ready && "flex items-center gap-2")}>
        <p className="font-medium">{props.platform}</p>
        <p className="text-xs text-muted-foreground">
          {props.compact && props.status.ready
            ? t("settings.devices.setup.ready")
            : props.status.message}
        </p>
      </div>
    </div>
  );
}
