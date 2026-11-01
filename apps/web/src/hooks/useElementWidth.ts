import { observeResize } from "~/lib/observeResize";
import { useLayoutEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the element and observes its size through the shared resize observer
  useLayoutEffect(() => {
    if (!element) return;

    const update = (nextWidth: number) => {
      setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    update(element.getBoundingClientRect().width);
    return observeResize(element, ([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
  }, [element]);

  return [setElement, width] as const;
}
