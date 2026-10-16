import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import type { ThreadTextPlaybackState } from "./threadState.ts";

/** Capture only at subscription/snapshot/marker boundaries, never for live deltas. */
export function captureThreadTextPlayback(
  projection: OrchestrationV2ThreadProjection | null,
  generation: number,
  phase: ThreadTextPlaybackState["phase"],
  previousLegacyRunIds: ReadonlySet<string> = new Set(),
): ThreadTextPlaybackState {
  const baselineByItemId = new Map<
    string,
    { readonly runId: string | null; readonly text: string }
  >();
  const legacyRunIds = new Set(phase === "legacy" ? previousLegacyRunIds : []);
  const capture = (item: OrchestrationV2ThreadProjection["turnItems"][number]) => {
    if (item.type !== "assistant_message" && item.type !== "reasoning") return;
    baselineByItemId.set(item.id, { runId: item.runId, text: item.text });
    if (phase === "legacy" && item.runId !== null) legacyRunIds.add(item.runId);
  };
  if (projection !== null) {
    for (const row of projection.visibleTurnItems) capture(row.item);
    for (const item of projection.turnItems) capture(item);
    if (phase === "legacy") {
      for (const run of projection.runs) legacyRunIds.add(run.id);
    }
  }
  return { generation, phase, baselineByItemId, legacyRunIds };
}
