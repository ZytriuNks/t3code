"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

/** A single-value horizontal slider. Commit work in `onValueCommitted`. */
function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: SliderPrimitive.Root.Props<number> & { "aria-label"?: string }) {
  return (
    <SliderPrimitive.Root
      className={cn("w-full data-disabled:opacity-64", className)}
      data-slot="slider"
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-2 select-none data-disabled:cursor-not-allowed">
        <SliderPrimitive.Track className="relative h-1 w-full grow rounded-full bg-input">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            className="block size-4 rounded-full border border-primary/40 bg-background shadow-sm/5 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
