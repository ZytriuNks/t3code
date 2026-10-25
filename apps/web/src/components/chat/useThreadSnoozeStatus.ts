import {
  effectiveSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import { useSyncExternalStore } from "react";

export function useThreadSnoozeStatus(shell: ThreadSnoozeShell | null, enabled: boolean) {
  const wakeAtMs = Date.parse(shell?.snoozedUntil ?? "");
  const snapshot = useSyncExternalStore(
    (onChange) => {
      if (!enabled || !Number.isFinite(wakeAtMs)) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        const remaining = wakeAtMs - Date.now();
        if (remaining <= 0) {
          onChange();
          return;
        }
        timer = setTimeout(schedule, Math.min(remaining + 50, 2_147_483_647));
      };
      schedule();
      return () => clearTimeout(timer);
    },
    () => {
      if (!enabled || shell === null) return null;
      // 返回业务状态，避免不断变化的时间戳破坏外部快照的稳定性。
      const now = new Date().toISOString();
      return effectiveSnoozed(shell, { now }) ? "snoozed" : threadWokeAt(shell, { now });
    },
  );
  return {
    snoozed: snapshot === "snoozed",
    wokeAt: snapshot === "snoozed" ? null : snapshot,
  };
}
