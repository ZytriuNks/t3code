import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import type { TimelineLayout } from "./timelineLayout";

/** Bridge eager LegendList measurements to its real React root commit. */
export function createTimelineListLayout() {
  let snapshot: { owner: TimelineLayout; revision: number } | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    itemSizeChanged(owner: TimelineLayout | null, info: { itemKey: string; size: number }) {
      if (!owner) return;
      snapshot = { owner, revision: owner.itemSizeChanged(info.itemKey, info.size) };
      for (const listener of listeners) listener();
    },
  };
}

export function TimelineListLayoutCommit({
  observer,
  layoutRef,
}: {
  observer: ReturnType<typeof createTimelineListLayout>;
  layoutRef: RefObject<TimelineLayout | null>;
}) {
  // LegendList's spacer and PositionViews also use useSyncExternalStore.
  // This leaf joins those synchronous updates in the same React root. Smooth
  // timelines disable list MVCP, so position recalculation finishes in the
  // measurement stack, before React renders this snapshot. No RAF delay proves it.
  const snapshot = useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getSnapshot,
  );
  const complete = snapshot?.owner.captureList(snapshot.revision);
  useLayoutEffect(() => {
    if (snapshot?.owner === layoutRef.current) complete?.();
  }, [snapshot, layoutRef, complete]);
  return null;
}
