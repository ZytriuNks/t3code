import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { CHATGPT_USAGE_URL, isChatGptUsageLimitFailure } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadDetail } from "../../state/use-thread-detail";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ChatGPT's own usage limit is a subscription state, not a provider quota, so
  // it gets its own wording and a link to the account's usage settings. The
  // scheduled recovery below still applies when the reset time is known.
  const detail = Option.getOrNull(useThreadDetail({ environmentId, threadId: thread.id }).data);
  const chatGptUsageLimit = isChatGptUsageLimitFailure(
    detail?.visibleTurnItems.map((entry) => entry.item) ?? [],
    detail?.runs.find((run) => run.id === thread.latestRun?.runId),
  );
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  // Managed sharing reaches the client as a `provider_error` that only names the
  // limit in its failure code, so the ChatGPT card must not depend on the
  // usage_limit class that drives the scheduled-recovery card below.
  if (
    !chatGptUsageLimit &&
    (thread.runtime?.status !== "failed" ||
      thread.runtime.lastErrorClass !== "usage_limit" ||
      !runId)
  )
    return null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await updateMetadata({
        environmentId,
        input: {
          threadId: thread.id,
          limitRecovery: {
            runId,
            resetAt,
            ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    } finally {
      setPending(false);
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      {chatGptUsageLimit ? (
        <View className="flex-row items-center gap-2">
          <ProviderIcon provider="codex" size={16} />
          <Text className="text-sm font-t3-medium text-warning-foreground">
            ChatGPT usage limit reached
          </Text>
        </View>
      ) : null}
      <Text className="text-sm text-warning-foreground">
        {resetAt
          ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
          : chatGptUsageLimit
            ? "Review your usage settings in ChatGPT to continue."
            : "The provider did not report a reset time. Retry manually when your limit is available."}
      </Text>
      {chatGptUsageLimit ? (
        <Pressable
          accessibilityRole="link"
          className="min-h-11 self-start justify-center rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          onPress={() => void Linking.openURL(CHATGPT_USAGE_URL).catch(() => undefined)}
        >
          <Text className="text-sm font-t3-medium text-foreground">Manage usage</Text>
        </Pressable>
      ) : null}
      {canSchedule ? (
        <View className="flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => void toggle("resume")}
            className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm text-foreground">
              {scheduled ? "Cancel auto-resume" : "Resume at reset"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={pending || (!snoozed && Date.parse(resetAt!) <= Date.now())}
            onPress={() => void toggle("snooze")}
            className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm text-foreground">
              {snoozed ? "Wake now" : "Snooze until reset"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
