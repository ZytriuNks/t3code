import type { AssistantCitation } from "@t3tools/contracts";

export const ASSISTANT_CITATION_CHAT_LINK_CLASS_NAME =
  "inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline hover:bg-(--context-chip-accent)/17 focus-visible:outline-2 focus-visible:outline-foreground";
export const ASSISTANT_CITATION_LABEL_CLASS_NAME = "max-w-[16em]";

/** The chat chip and inert layout use the same whitespace and truncation. */
export function assistantCitationLabel(citation: AssistantCitation) {
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  return preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
}
