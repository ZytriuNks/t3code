import { createContext } from "react";
import type { SmoothOutputMode, SmoothOutputLineMode } from "@t3tools/contracts";
import type { SmoothTextResumeInput } from "../../lib/smoothTextPlayback";
export const SmoothMarkdownContext = createContext({
  host: null as HTMLElement | null,
  inlineHost: null as HTMLElement | null,
  detached: false,
  streaming: false,
  smooth: false,
  mode: "character" as SmoothOutputMode,
  lineMode: "adaptive" as SmoothOutputLineMode,
  scope: "",
  autoCollapse: false,
  fadeDurationMs: 200,
  yieldDurationMs: 200,
  playbackResume: undefined as SmoothTextResumeInput | undefined,
});
