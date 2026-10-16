import type { DevicePlatformAvailability } from "@t3tools/contracts";
import { Check, Minus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useI18n } from "../../i18n/I18nProvider";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => (
        <Tooltip key={platform.platform}>
          <TooltipTrigger render={<span tabIndex={0} className="inline-flex items-center gap-1" />}>
            {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
            {platform.platform === "ios" ? "iOS" : "Android"}{" "}
            {platform.available
              ? t("settings.devices.availability.available")
              : t("settings.devices.availability.unavailable")}
          </TooltipTrigger>
          <TooltipPopup>
            {platform.reason ??
              t("settings.devices.availability.platformAvailable", {
                platform: platform.platform === "ios" ? "iOS" : "Android",
              })}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
