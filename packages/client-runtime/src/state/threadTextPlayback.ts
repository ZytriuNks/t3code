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

/**
 * Older history pages are finished text by definition. Add only the items this
 * page introduced, so they mount at rest; live items keep their own baseline.
 */
export function withHistoryPageBaseline(
  playback: ThreadTextPlaybackState,
  previous: OrchestrationV2ThreadProjection,
  merged: OrchestrationV2ThreadProjection,
): ThreadTextPlaybackState {
  const known = new Set<string>();
  for (const row of previous.visibleTurnItems) known.add(row.item.id);
  for (const item of previous.turnItems) known.add(item.id);
  let baselineByItemId: Map<
    string,
    { readonly runId: string | null; readonly text: string }
  > | null = null;
  const add = (item: OrchestrationV2ThreadProjection["turnItems"][number]) => {
    if (item.type !== "assistant_message" && item.type !== "reasoning") return;
    if (known.has(item.id) || playback.baselineByItemId.has(item.id)) return;
    baselineByItemId ??= new Map(playback.baselineByItemId);
    baselineByItemId.set(item.id, { runId: item.runId, text: item.text });
  };
  for (const row of merged.visibleTurnItems) add(row.item);
  for (const item of merged.turnItems) add(item);
  return baselineByItemId === null ? playback : { ...playback, baselineByItemId };
}
