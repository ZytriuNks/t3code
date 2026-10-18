import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function ScratchBaseDirectorySettings() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const targets = selectedTargets.filter(
    (target) => target.serverConfig.scratchWorkspaceRoot !== undefined,
  );
  if (selectedProjectKey !== null || targets.length === 0) return null;

  return (
    <SettingsSection title="No-project chats">
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          Each new chat gets its own folder under this directory on the selected environment. Use an
          absolute path or ~/ outside a Git repository. Leave blank for the default scratch
          directory. Existing chats keep their folders.
        </Text>
        {targets.map((target) => (
          <ScratchBaseDirectoryField key={target.environmentId} target={target} />
        ))}
      </View>
    </SettingsSection>
  );
}

function ScratchBaseDirectoryField({ target }: { readonly target: SettingsTarget }) {
  const value = target.serverConfig.settings.scratchBaseDirectory;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "no-project chats base directory update",
    reportFailure: true,
  });
  const nextValue = (draft ?? value).trim();

  async function save(directory: string) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId: target.environmentId,
        input: { patch: { scratchBaseDirectory: directory } },
      });
      if (result._tag !== "Failure") setDraft(null);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-t3-medium text-foreground-muted">{target.label}</Text>
      <AppTextInput
        accessibilityLabel={`No-project chats base directory on ${target.label}`}
        className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
        value={draft ?? value}
        onChangeText={setDraft}
        onSubmitEditing={() => {
          if (nextValue !== value) void save(nextValue);
        }}
        placeholder="Default scratch directory"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        editable={!saving}
      />
      <View className="flex-row gap-3">
        {nextValue !== value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save no-project chats base directory on ${target.label}`}
            disabled={saving}
            onPress={() => void save(nextValue)}
            className="min-h-11 justify-center rounded-full bg-subtle-strong px-4 py-2 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground">Save</Text>
          </Pressable>
        ) : null}
        {value !== "" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Use default no-project chats directory on ${target.label}`}
            disabled={saving}
            onPress={() => void save("")}
            className="min-h-11 justify-center rounded-full bg-subtle px-4 py-2 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground">Use default</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
