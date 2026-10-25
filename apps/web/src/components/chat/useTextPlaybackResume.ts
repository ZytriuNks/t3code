import { useLayoutEffect, useState } from "react";
import type { RunId } from "@t3tools/contracts";
import type { SmoothTextResumeInput } from "../../lib/smoothTextPlayback";
import type { TimelineRowSharedState } from "./timelineRowContext";
export function useTextPlaybackResume(
  ctx: TimelineRowSharedState,
  itemId: string | undefined,
  entryId: string,
  runId: RunId | null,
  surface: string,
  currentText: string,
): SmoothTextResumeInput | undefined {
  const playback = ctx.textPlayback;
  const key = JSON.stringify([
    ctx.threadRef?.environmentId ?? ctx.activeThreadEnvironmentId,
    ctx.threadRef?.threadId ?? ctx.routeThreadKey,
    runId,
    itemId ?? entryId,
    surface,
  ]);
  const createMount = () => {
    const committed = ctx.committedPlaybackEntries.current;
    const committedEntry = (
      committed?.navigation === ctx.mountedText ? committed.entries : []
    ).find(
      (entry) =>
        (entry.kind === "message" || entry.kind === "work") &&
        entry.id === entryId &&
        ((entry.kind === "message" ? entry.projectedItem : entry.entry.projectedItem)?.item.id ??
          entry.id) === (itemId ?? entryId) &&
        (entry.kind === "message"
          ? entry.message.runId === runId
          : entry.kind === "work" && (entry.entry.runId ?? null) === runId),
    );
    const committedText =
      committedEntry?.kind === "message"
        ? committedEntry.message.text
        : committedEntry?.kind === "work"
          ? (committedEntry.entry.detail ?? "")
          : undefined;
    return {
      key,
      navigation: ctx.mountedText,
      // A first source mounted in its receiving commit is live. A delayed first
      // appearance also owns any text already committed while it was offscreen.
      text: ctx.mountedPlaybackSurfaces.has(key)
        ? currentText
        : (committedText ?? ctx.mountedText.get(entryId) ?? ""),
    };
  };
  const [mount, setMount] = useState(createMount);
  let activeMount = mount;
  if (mount.key !== key || mount.navigation !== ctx.mountedText) {
    activeMount = createMount();
    setMount(activeMount);
  }
  useLayoutEffect(() => {
    ctx.mountedPlaybackSurfaces.add(key);
  }, [ctx.mountedPlaybackSurfaces, key]);
  const baseline = itemId ? playback?.baselineByItemId.get(itemId) : undefined;
  const hasPlayback = playback !== null;
  const legacyRun = playback?.legacyRunIds.has(runId ?? "") ?? false;
  const forceShow =
    playback !== null &&
    (playback.phase === "pending" ||
      legacyRun ||
      (baseline !== undefined && baseline.runId !== runId) ||
      (playback.phase === "legacy" && (baseline !== undefined || runId === null)));
  const resumeBaselineText = forceShow ? "" : (baseline?.text ?? "");
  const resumeMountText = activeMount.text;
  const resumeSynchronized = forceShow || baseline !== undefined || resumeMountText.length > 0;
  const resumeGeneration = playback?.generation;
  return (() => {
    if (!hasPlayback) return undefined;
    return {
      key,
      baselineText: resumeBaselineText,
      mountText: resumeMountText,
      synchronized: resumeSynchronized,
      ...(resumeGeneration === undefined ? {} : { generation: resumeGeneration }),
      ...(forceShow ? { forceShow: true } : {}),
    } satisfies SmoothTextResumeInput;
  })();
}
