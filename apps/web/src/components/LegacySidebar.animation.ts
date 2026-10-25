import { useStableCallback } from "~/hooks/useStableCallback";
import { autoAnimate } from "@formkit/auto-animate";

export const LEGACY_SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

export function useLegacySidebarListAnimation() {
  return useStableCallback((node: HTMLElement | null) => {
    if (!node) return;
    const controller = autoAnimate(node, LEGACY_SIDEBAR_LIST_ANIMATION_OPTIONS);
    return () => controller.destroy?.();
  });
}
