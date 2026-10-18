import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { SettingsControlRow } from "./SettingsControlRow";

export function SettingsSwitchRow(
  props: Omit<ComponentProps<typeof SettingsControlRow>, "children"> & {
    readonly value: boolean | null;
    readonly onValueChange: (value: boolean) => void;
  },
) {
  return (
    <SettingsControlRow
      disabled={props.disabled}
      icon={props.icon}
      label={props.label}
      subtitle={props.subtitle}
    >
      <ThemedSwitch
        style={{ alignSelf: "center" }}
        accessibilityLabel={props.label}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </SettingsControlRow>
  );
}
