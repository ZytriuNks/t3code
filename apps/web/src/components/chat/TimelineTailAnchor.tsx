import { type MessageId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import { use, type ReactNode } from "react";
import { TimelineRowCtx } from "./timelineRowContext";
export function TimelineTailAnchor({
  children,
  className,
  messageId,
  kind = "activity",
}: {
  children: ReactNode;
  className?: string;
  messageId?: MessageId;
  kind?: "activity" | "footnotes" | "meta";
}) {
  const { registerTailAnchor, tailMessageId } = use(TimelineRowCtx);
  const ref = useRef<HTMLDivElement | null>(null);
  const enabled = messageId === undefined || messageId === tailMessageId;
  useLayoutEffect(() => {
    if (!enabled || !ref.current) return;
    return registerTailAnchor(ref.current);
  }, [enabled, registerTailAnchor]);
  return (
    <div ref={ref} className={className} data-timeline-tail-anchor={enabled ? kind : undefined}>
      {children}
    </div>
  );
}
