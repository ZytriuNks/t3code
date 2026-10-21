import {
  resolveLanguages,
  resolveThemes,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;

export type CodeHighlightMessage =
  | {
      type: "highlight";
      documentId: number;
      requestId: number;
      code: string;
      language: string;
      theme: DiffThemeName;
      resolvedThemes?: Awaited<ReturnType<typeof resolveThemes>>;
      resolvedLanguages?: Awaited<ReturnType<typeof resolveLanguages>>;
    }
  | { type: "release"; documentId: number };

export interface CodeHighlightResult {
  documentId: number;
  requestId: number;
  code: string;
  root?: HighlightedRoot;
  error?: string;
}

interface Session {
  latestCode: string | undefined;
  inFlightCode: string | undefined;
  closed: boolean;
  language: string;
  theme: DiffThemeName;
  onResult: (result: CodeHighlightResult) => void;
  resources?: {
    themes: Awaited<ReturnType<typeof resolveThemes>>;
    languages: Awaited<ReturnType<typeof resolveLanguages>>;
  };
  resourcesSent: boolean;
}

/** One request per document may be in flight; intermediate stream prefixes are discarded. */
export function createCodeHighlightCoordinator(
  worker: Pick<Worker, "postMessage" | "addEventListener">,
) {
  const sessions = new Map<number, Session>();
  let nextDocumentId = 0;
  let nextRequestId = 0;
  let failed = false;
  const themePromises = new Map<DiffThemeName, ReturnType<typeof resolveThemes>>();
  const languagePromises = new Map<string, ReturnType<typeof resolveLanguages>>();

  function resourcesFor(language: string, theme: DiffThemeName) {
    let themes = themePromises.get(theme);
    if (!themes) {
      themes = resolveThemes([theme]);
      themePromises.set(theme, themes);
    }
    let languages = languagePromises.get(language);
    if (!languages) {
      languages = resolveLanguages([language as SupportedLanguages]);
      languagePromises.set(language, languages);
    }
    return Promise.all([themes, languages]);
  }

  function send(documentId: number, session: Session) {
    const code = session.latestCode;
    if (code === undefined || session.inFlightCode !== undefined || !session.resources) return;
    session.inFlightCode = code;
    const firstRequest = !session.resourcesSent;
    session.resourcesSent = true;
    worker.postMessage(
      {
        type: "highlight",
        documentId,
        requestId: ++nextRequestId,
        code,
        language: session.language,
        theme: session.theme,
        ...(firstRequest
          ? {
              resolvedThemes: session.resources.themes,
              resolvedLanguages: session.resources.languages,
            }
          : {}),
      } satisfies CodeHighlightMessage,
      [],
    );
  }

  worker.addEventListener("message", (event: MessageEvent<CodeHighlightResult>) => {
    const result = event.data;
    const session = sessions.get(result.documentId);
    if (!session || session.closed || session.inFlightCode !== result.code) return;
    session.inFlightCode = undefined;
    if (session.latestCode === result.code) session.onResult(result);
    else send(result.documentId, session);
  });
  worker.addEventListener("error", () => {
    failed = true;
    for (const [documentId, session] of sessions) {
      session.onResult({
        documentId,
        requestId: ++nextRequestId,
        code: session.latestCode ?? "",
        error: "Code highlighting worker failed",
      });
    }
  });

  return {
    open(language: string, theme: DiffThemeName, onResult: Session["onResult"]) {
      const documentId = ++nextDocumentId;
      const session: Session = {
        language,
        theme,
        onResult,
        latestCode: undefined,
        inFlightCode: undefined,
        closed: false,
        resourcesSent: false,
      };
      sessions.set(documentId, session);
      void resourcesFor(language, theme).then(
        ([themes, languages]) => {
          if (session.closed) return;
          session.resources = { themes, languages };
          send(documentId, session);
        },
        (error: unknown) => {
          if (session.closed) return;
          session.onResult({
            documentId,
            requestId: ++nextRequestId,
            code: session.latestCode ?? "",
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      if (failed) {
        queueMicrotask(() => {
          if (!session.closed)
            session.onResult({
              documentId,
              requestId: ++nextRequestId,
              code: session.latestCode ?? "",
              error: "Code highlighting worker failed",
            });
        });
      }
      return {
        update(code: string) {
          if (session.closed || session.latestCode === code) return;
          session.latestCode = code;
          if (failed) return;
          send(documentId, session);
        },
        close() {
          if (session.closed) return;
          session.closed = true;
          sessions.delete(documentId);
          worker.postMessage({ type: "release", documentId } satisfies CodeHighlightMessage, []);
        },
      };
    },
    close() {
      for (const documentId of sessions.keys()) {
        worker.postMessage({ type: "release", documentId } satisfies CodeHighlightMessage, []);
      }
      sessions.clear();
    },
  };
}

let sharedCoordinator: ReturnType<typeof createCodeHighlightCoordinator> | undefined;

export function getCodeHighlightCoordinator() {
  return (sharedCoordinator ??= createCodeHighlightCoordinator(
    new Worker(new URL("./syntaxHighlight.worker.ts", import.meta.url), { type: "module" }),
  ));
}
