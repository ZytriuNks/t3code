import { Button } from "../../components/ui/Button";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { CHATGPT_USAGE_URL, isChatGptUsageLimitFailure } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import * as Option from "effect/Option";
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
  // Whether the reset already passed is state a timer flips at resetAt: the
  // compiler caches render output on its inputs, so reading the clock during
  // render would leave the snooze button enabled after the reset.
  const resetAtMs = resetAt === null ? null : Date.parse(resetAt);
  const [resetPassedFor, setResetPassedFor] = useState<number | null>(null);
  const resetPassed = resetAtMs !== null && resetPassedFor === resetAtMs;
  useEffect(() => {
    if (resetAtMs === null || Number.isNaN(resetAtMs)) return;
    const flip = () => setResetPassedFor(resetAtMs);
    const delay = resetAtMs - Date.now();
    if (delay <= 0) {
      flip();
      return;
    }
    // Beyond setTimeout's 32-bit range the card re-renders long before then.
    if (delay > 2_147_483_647) return;
    const timer = setTimeout(flip, delay);
    return () => clearTimeout(timer);
  }, [resetAtMs]);
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
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
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
          <Button
            label={scheduled ? "Cancel auto-resume" : "Resume at reset"}
            tone="secondary"
            disabled={pending}
            onPress={() => void toggle("resume")}
          />
          <Button
            label={snoozed ? "Wake now" : "Snooze until reset"}
            tone="secondary"
            disabled={pending || (!snoozed && resetPassed)}
            onPress={() => void toggle("snooze")}
          />
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
