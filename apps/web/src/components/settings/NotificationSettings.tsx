import { useState } from "react";
import type { ClientSettings } from "@t3tools/contracts/settings";

import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type NotificationMode = ClientSettings["notificationMode"];

/** Display order of the modes, with the key that names each one. */
const NOTIFICATION_MODE_KEYS = {
  off: "settings.general.notifications.mode.off",
  notifications: "settings.general.notifications.mode.notifications",
  sound: "settings.general.notifications.mode.sound",
  "notifications-and-sound": "settings.general.notifications.mode.notificationsAndSound",
} as const satisfies Record<NotificationMode, MessageKey>;

const NOTIFICATION_MODES = Object.keys(NOTIFICATION_MODE_KEYS) as ReadonlyArray<NotificationMode>;

export function NotificationSettings() {
  const { t } = useI18n();
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications", t)}
      description={permissionMessage ?? t("settings.general.notifications.description")}
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(t("settings.general.notifications.unsupported"));
                return;
              }
              setRequesting(true);
              try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                  setPermissionMessage(t("settings.general.notifications.blocked"));
                  return;
                }
              } catch {
                setPermissionMessage(t("settings.general.notifications.unavailable"));
                return;
              } finally {
                setRequesting(false);
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("settings.search.item.thread-notifications.title")}
          >
            <SelectValue>{t(NOTIFICATION_MODE_KEYS[mode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {NOTIFICATION_MODES.map((value) => (
              <SelectItem key={value} hideIndicator value={value}>
                {t(NOTIFICATION_MODE_KEYS[value])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
