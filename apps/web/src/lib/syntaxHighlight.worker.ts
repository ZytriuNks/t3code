import {
  attachResolvedLanguages,
  attachResolvedThemes,
  getSharedHighlighter,
  type DiffsHighlighter,
} from "@pierre/diffs";

import { createIncrementalHighlightedDocument } from "./incrementalHighlighting.ts";
import type { CodeHighlightMessage, CodeHighlightResult } from "./asyncCodeHighlighting.ts";
import type { DiffThemeName } from "./diffRendering";

let highlighterPromise: Promise<DiffsHighlighter> | undefined;
const documents = new Map<
  number,
  {
    language: string;
    theme: DiffThemeName;
    highlight: ReturnType<typeof createIncrementalHighlightedDocument>;
  }
>();
const active = new Set<number>();

function getHighlighter() {
  return (highlighterPromise ??= getSharedHighlighter({
    langs: ["text"],
    themes: [],
    preferredHighlighter: "shiki-wasm",
  }));
}

self.addEventListener("message", (event: MessageEvent<CodeHighlightMessage>) => {
  const request = event.data;
  if (request.type === "release") {
    active.delete(request.documentId);
    documents.delete(request.documentId);
    return;
  }
  active.add(request.documentId);
  void (async () => {
    try {
      const highlighter = await getHighlighter();
      if (!active.has(request.documentId)) return;
      if (request.resolvedThemes) attachResolvedThemes(request.resolvedThemes, highlighter);
      if (request.resolvedLanguages)
        attachResolvedLanguages(request.resolvedLanguages, highlighter);
      let document = documents.get(request.documentId);
      if (!document || document.language !== request.language || document.theme !== request.theme) {
        document = {
          language: request.language,
          theme: request.theme,
          highlight: createIncrementalHighlightedDocument(
            highlighter,
            request.language,
            request.theme,
          ),
        };
        documents.set(request.documentId, document);
      }
      const root = document.highlight(request.code);
      postMessage({
        documentId: request.documentId,
        requestId: request.requestId,
        code: request.code,
        root,
      } satisfies CodeHighlightResult);
    } catch (error) {
      if (!active.has(request.documentId)) return;
      postMessage({
        documentId: request.documentId,
        requestId: request.requestId,
        code: request.code,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CodeHighlightResult);
    }
  })();
});
