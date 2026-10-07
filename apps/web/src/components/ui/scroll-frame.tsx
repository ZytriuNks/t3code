import { type ReactNode, useLayoutEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { OverlayScrollbar } from "./overlay-scrollbar";

/** Decorates an existing scroll node, including virtualizers that own their DOM
 * and refs. The first child remains the scroll viewport; the bar is its sibling.
 * Both axes use overlays so hiding native bars preserves horizontal dragging. */
export function ScrollFrame({
  children,
  className,
  variant = "compact",
  windowEdge = variant === "page",
}: {
  children: ReactNode;
  className?: string;
  variant?: "page" | "compact";
  windowEdge?: boolean;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [scrollable, setScrollable] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!frame) return;
    const update = () => {
      const child = frame.firstElementChild;
      setScrollable(
        child instanceof HTMLElement && child.getAttribute("role") !== "scrollbar" ? child : null,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(frame, { childList: true });
    return () => observer.disconnect();
  }, [frame]);
  return (
    <div
      ref={setFrame}
      className={cn(
        "scroll-frame relative flex min-h-0 min-w-0 flex-col [&>:first-child]:min-h-0",
        className,
      )}
    >
      {children}
      <OverlayScrollbar
        scrollable={scrollable}
        triangles={variant === "page"}
        autoHide={variant === "compact"}
        thumbInset={variant === "compact" ? "gutter" : "edge"}
        embedded={!windowEdge}
      />
      <OverlayScrollbar scrollable={scrollable} orientation="horizontal" autoHide embedded />
    </div>
  );
}
