import { autoAnimate } from "@formkit/auto-animate";
import { useCallback, useEffect, useRef } from "react";

export const LEGACY_SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

export function useLegacySidebarListAnimation() {
  const controllerRef = useRef<ReturnType<typeof autoAnimate> | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    controllerRef.current?.destroy?.();
    controllerRef.current = node ? autoAnimate(node, LEGACY_SIDEBAR_LIST_ANIMATION_OPTIONS) : null;
  }, []);
  useEffect(() => () => controllerRef.current?.destroy?.(), []);
  return ref;
}
