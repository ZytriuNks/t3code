import { useLayoutEffect, useRef, type ReactNode } from "react";
import { smoothLineCurveProgress } from "../../lib/smoothLineMotion";
import { requestSmoothTextLayoutFrame, setSmoothTextFrameHeight } from "../../lib/smoothTextLayout";

export function TimelineStatusHeight({
  identity,
  enabled,
  duration,
  claim,
  children,
}: {
  identity: string;
  enabled: boolean;
  duration: number;
  claim(identity: string): boolean;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const entranceRef = useRef<{
    identity: string;
    height: number;
    start: number;
    value: number;
  } | null>(null);
  useLayoutEffect(() => {
    // Consume disabled/history entrances too, so toggling smooth output cannot
    // replay an already visible status. Text/timer updates are not dependencies.
    const initial = claim(identity);
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!enabled || !frame || !content) {
      entranceRef.current = null;
      return;
    }
    if (entranceRef.current?.identity !== identity) {
      entranceRef.current = initial
        ? {
            identity,
            height: content.getBoundingClientRect().height,
            start: performance.now(),
            value: 0,
          }
        : null;
    }
    const entrance = entranceRef.current;
    if (!entrance) return;
    let cancelled = false;
    let cancelFrame: (() => void) | undefined;
    setSmoothTextFrameHeight(frame, entrance.value);
    const tick = (at: number) => {
      if (cancelled) return;
      const elapsed = at - entrance.start;
      if (elapsed >= duration) {
        entranceRef.current = null;
        setSmoothTextFrameHeight(frame, entrance.height);
        setSmoothTextFrameHeight(frame, null);
        return;
      }
      entrance.value = entrance.height * smoothLineCurveProgress(elapsed, duration, 0, 0);
      setSmoothTextFrameHeight(frame, entrance.value);
      cancelFrame = requestSmoothTextLayoutFrame(frame, tick);
    };
    cancelFrame = requestSmoothTextLayoutFrame(frame, tick);
    return () => {
      cancelled = true;
      cancelFrame?.();
      // StrictMode replays effects on this instance; keep its unfinished claim.
      // A real remount has a new ref and cannot reclaim the consumed identity.
      setSmoothTextFrameHeight(frame, null);
    };
  }, [claim, duration, enabled, identity]);
  return (
    <div ref={frameRef} className="overflow-hidden" data-timeline-status-height={identity}>
      <div ref={contentRef} className="flow-root">
        {children}
      </div>
    </div>
  );
}
