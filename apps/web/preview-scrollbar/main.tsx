/**
 * Standalone harness for reviewing the overlay scrollbar's rendered form.
 *
 * The real app cannot be driven from a dev server: its root route awaits a
 * session-state fetch from the server sidecar and throws before anything
 * renders. This page mounts the component directly against synthetic scroll
 * containers so the geometry, spacing, and hover behaviour can be seen in a
 * browser without the backend. It is a review tool, not part of the app.
 */
import { StrictMode, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { OverlayScrollbar } from "../src/components/ui/overlay-scrollbar";
import { cn } from "../src/lib/utils";
import "./preview.css";

/** Enough rows to make the container overflow, so a thumb is actually drawn. */
const ROW_COUNT = 60;

function Panel({
  label,
  note,
  triangles,
  width,
  thumbInset,
  bottomGap,
  scrollPadding,
  edgeOffset,
  rowClassName,
}: {
  label: string;
  note: string;
  triangles?: boolean;
  width?: string;
  thumbInset?: "edge" | "gutter";
  bottomGap?: "hairline" | "roomy";
  /** Horizontal padding on the scroll container, as LegendList has. */
  scrollPadding?: string;
  edgeOffset?: string;
  rowClassName?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollable, setScrollable] = useState<HTMLElement | null>(null);
  const [autoHide, setAutoHide] = useState(false);

  // Mirrors what the real hosts do: hide after a moment without scrolling, so
  // the hover-reveal path is the thing under review.
  const hideTimer = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    setAutoHide(false);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setAutoHide(true), 700);
  }, []);

  const onStep = useCallback((direction: -1 | 1) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollBy({ top: direction * element.clientHeight * 0.3, behavior: "smooth" });
  }, []);

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{label}</h2>
        <span className="text-xs text-muted-foreground">{note}</span>
      </header>
      {/* Mirrors the real DOM: the bar is a CHILD of the scroll container, and
          that container carries horizontal padding (LegendList uses px-3 sm:px-5).
          A `right-0` bar therefore resolves against the padding box, not the
          viewport — which is why it sits short of the edge. */}
      <div className="relative h-72 overflow-hidden rounded-md border bg-background">
        <div
          ref={(node) => {
            scrollRef.current = node;
            if (node && node !== scrollable) setScrollable(node);
          }}
          onScroll={onScroll}
          className={cn(
            "h-full overflow-y-auto overscroll-y-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            scrollPadding,
          )}
        >
          <div className={cnRows(rowClassName)}>
            {Array.from({ length: ROW_COUNT }, (_, index) => (
              <div key={index} className="flex h-9 items-center border-b text-xs last:border-b-0">
                row {index + 1}
              </div>
            ))}
          </div>
        </div>
        <OverlayScrollbar
          scrollable={scrollable}
          triangles={triangles}
          visible={!autoHide}
          width={width}
          thumbInset={thumbInset}
          bottomGap={bottomGap}
          edgeOffset={edgeOffset}
          onStep={onStep}
        />
      </div>
    </section>
  );
}

function cnRows(className?: string) {
  return className ?? "py-1";
}

function App() {
  const [dark, setDark] = useState(true);
  return (
    <div className={dark ? "dark" : undefined}>
      <main className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold">Overlay scrollbar review</h1>
            <p className="text-xs text-muted-foreground">
              Synthetic containers, real component. Hover each panel to check the reveal, drag the thumb
              to check it tracks the cursor, and hold a triangle to check the coast.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDark((value) => !value)}
            className="shrink-0 rounded-md border px-3 py-1.5 text-xs"
          >
            {dark ? "Light" : "Dark"}
          </button>
        </header>

        <Panel
          label="Timeline"
          note="LegendList padding px-3 sm:px-5 — edgeOffset cancels it"
          triangles
          bottomGap="hairline"
          scrollPadding="px-3 sm:px-5"
          edgeOffset="1.3125rem"
          rowClassName="px-3 py-1"
          scrollPadding=""
        />
        <Panel
          label="Model picker"
          note="gutter inset, roomy bottom gap"
          width="6px"
          thumbInset="gutter"
          bottomGap="roomy"
          scrollPadding="px-2"
          edgeOffset="0px"
          rowClassName="px-3 py-1.5"
        />
      </main>
    </div>
  );
}

const container = document.createElement("div");
container.id = "root";
document.body.append(container);
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);