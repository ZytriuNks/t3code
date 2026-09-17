import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { AppleIcon, AndroidIcon } from "../Icons";
import { Spinner } from "../ui/spinner";
import type { EnvironmentId, SshDeviceHostConfig } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useDeviceState } from "../../state/device";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MoreVertical, PlusIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";

import { useSettingsScope } from "./SettingsScopeContext";
import { toastManager } from "../ui/toast";
import { updateDeviceHosts } from "./deviceHostsSettings.logic";
import { DeviceHostEditor } from "./DeviceHostEditor";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import { deviceHostConnectionKey } from "./deviceHostConnectionChecks";
import { useI18n } from "../../i18n/I18nProvider";

export function DeviceHostsSettings(props: { environmentId: EnvironmentId | null }) {
  const { t } = useI18n();
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState<SshDeviceHostConfig | null>(null);
  const [originalHost, setOriginalHost] = useState<SshDeviceHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    connected: environment.connection.phase === "connected",
  }));
  const { checks, testConnection } = useHostConnectionChecks(targets);
  const save = async (host: SshDeviceHostConfig, remove = false, original = host) => {
    if (!props.environmentId || projectScope) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        environments.map(async (environment) => {
          if (environment.connection.phase !== "connected" || !environment.serverConfig) {
            throw new Error("Environment disconnected");
          }
          return update({
            environmentId: environment.environmentId,
            input: {
              patch: {
                deviceHosts: updateDeviceHosts(
                  environment.serverConfig.settings.deviceHosts,
                  host,
                  remove,
                  original,
                ),
              },
            },
          });
        }),
      );
      const failed = environments.filter((_, index) => {
        const result = results[index];
        return result?.status !== "fulfilled" || result.value._tag === "Failure";
      });
      if (failed.length === 0) {
        setEditing(null);
      } else {
        toastManager.add({
          type: "error",
          title: t("settings.devices.hosts.saveFailed"),
          description: t("settings.devices.hosts.updateFailed", {
            environments: failed.map((environment) => environment.label).join(", "),
          }),
        });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      id="device-hosts"
      title={t("settings.devices.hosts.title")}
      serverScoped
      settingKeys={["deviceHosts"]}
      description={t("settings.devices.hosts.description")}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={projectScope || busy || !props.environmentId || editing !== null}
          onClick={() => {
            setOriginalHost(null);
            setEditing({ id: randomUUID(), label: "", target: "" });
          }}
        >
          <PlusIcon className="size-3.5" /> {t("settings.devices.hosts.add")}
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {!props.environmentId ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.devices.hosts.connectSelected")}
          </p>
        ) : (
          <>
            {connectedEnvironments.map((environment) => (
              <div key={environment.environmentId}>
                {connectedEnvironments.length > 1 ? (
                  <p className="pt-3 pb-1 text-xs font-medium text-muted-foreground">
                    {environment.label}
                  </p>
                ) : null}
                <DeviceHostList
                  environmentId={environment.environmentId}
                  hosts={environment.serverConfig?.settings.deviceHosts ?? []}
                  busy={projectScope || busy}
                  checks={checks}
                  testConnection={async (host) => {
                    const results = await testConnection(host);
                    if (!results) return;
                    const failed = targets.filter(
                      (target) => results[target.environmentId]?.status === "failed",
                    );
                    toastManager.add({
                      type: failed.length ? "error" : "success",
                      title: failed.length
                        ? t("settings.devices.hosts.testFailed", {
                            host: host.label,
                            failed: failed.length,
                            total: targets.length,
                          })
                        : t("settings.devices.hosts.testPassed", { host: host.label }),
                      description: failed.length
                        ? t("settings.devices.hosts.testDescriptionFailed", {
                            environments: failed.map((target) => target.label).join(", "),
                          })
                        : t("settings.devices.hosts.testDescriptionPassed"),
                    });
                    return results;
                  }}
                  onEdit={(host) => {
                    setOriginalHost(host);
                    setEditing(host);
                  }}
                  onRemove={(host) => void save(host, true)}
                />
              </div>
            ))}
            {editing ? (
              <DeviceHostEditor
                key={editing.id}
                host={editing}
                isNew={originalHost === null}
                targets={targets}
                busy={busy}
                onSave={(host) => void save(host, false, originalHost ?? host)}
                onClose={() => setEditing(null)}
              />
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

function DeviceHostList({
  environmentId,
  hosts,
  busy,
  onEdit,
  onRemove,
  checks,
  testConnection,
}: {
  environmentId: EnvironmentId;
  hosts: ReadonlyArray<SshDeviceHostConfig>;
  busy: boolean;
  onEdit: (host: SshDeviceHostConfig) => void;
  onRemove: (host: SshDeviceHostConfig) => void;
  checks: ReturnType<typeof useHostConnectionChecks>["checks"];
  testConnection: ReturnType<typeof useHostConnectionChecks>["testConnection"];
}) {
  const { t } = useI18n();
  const { state } = useDeviceState(environmentId);
  return (
    <>
      {hosts.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("settings.devices.hosts.none")}</p>
      ) : null}
      {hosts.map((host) => {
        const status = state.hostStatuses[host.id];
        const check = checks[deviceHostConnectionKey(host)]?.[environmentId];
        const platforms =
          (check?.status === "connected" ? check.platforms : undefined) ??
          state.hosts.find((value) => value.id === host.id)?.platforms ??
          [];
        const progress =
          check?.status === "pending"
            ? t("settings.devices.hosts.checking")
            : status?.status === "installing"
              ? t("settings.devices.hosts.installing")
              : status?.status === "starting"
                ? t("settings.devices.hosts.connecting")
                : null;
        const error =
          check?.status === "failed"
            ? check.error
            : check?.status === "local"
              ? undefined
              : status?.status === "failed"
                ? status.detail
                : undefined;
        return (
          <div key={host.id} className="flex items-center gap-2 border-t border-border/50 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">{host.label}</p>
                {platforms
                  .filter((platform) => platform.available)
                  .map((platform) => (
                    <Tooltip key={platform.platform}>
                      <TooltipTrigger
                        render={
                          <span
                            tabIndex={0}
                            role="img"
                            aria-label={t("settings.devices.availability.platformAvailable", {
                              platform: platform.platform === "ios" ? "iOS" : "Android",
                            })}
                            className="shrink-0 text-muted-foreground"
                          />
                        }
                      >
                        {platform.platform === "ios" ? (
                          <AppleIcon className="size-3.5" />
                        ) : (
                          <AndroidIcon className="size-3.5" />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup>
                        {t("settings.devices.availability.platformAvailable", {
                          platform: platform.platform === "ios" ? "iOS" : "Android",
                        })}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
              </div>
              <p className="truncate text-xs text-muted-foreground">{host.target}</p>
              {check?.status === "local" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.devices.hosts.local")}
                </p>
              ) : null}
              {error ? (
                <div className="mt-1" role="status">
                  <details className="text-xs text-destructive">
                    <summary>{t("settings.devices.hosts.connectionFailed")}</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
                  </details>
                </div>
              ) : null}
            </div>
            {progress ? (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Spinner className="size-3" />
                {progress}
              </span>
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label={t("settings.devices.hosts.options", { name: host.label })}
                  />
                }
              >
                <MoreVertical />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  onClick={() => {
                    onEdit(host);
                  }}
                >
                  {t("settings.devices.hosts.edit")}
                </MenuItem>
                <MenuItem variant="destructive" onClick={() => onRemove(host)}>
                  {t("settings.devices.hosts.remove")}
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || progress !== null}
              onClick={() => void testConnection(host)}
            >
              {t("settings.devices.hosts.testConnection")}
            </Button>
          </div>
        );
      })}
    </>
  );
}
