import { ScrollFrame } from "~/components/ui/scroll-frame";
import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/**
 * Highlighted source for files that cannot be edited: captured attachments,
 * host files outside the workspace and truncated reads. Same surface theme,
 * word-wrap preference and virtualization as the editable workspace file.
 */
export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown>["onPostRender"];
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  return (
    <DiffWorkerPoolProvider>
      <div className="file-preview-scroll-frame relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollFrame
          variant="page"
          className="flex-1 [--overlay-scrollbar-track:var(--code-background)]"
        >
          <Virtualizer
            key={`${props.name}:${resolvedTheme}:${props.text.length}`}
            className={cn(
              "file-preview-virtualizer min-h-0 flex-1 overflow-auto",
              wordWrap && "pe-3",
            )}
            config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
          >
            <File
              file={{
                name: props.name,
                contents: props.text,
                ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
              }}
              options={{
                disableFileHeader: true,
                overflow: wordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                themeType: resolvedTheme,
                unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
              }}
              className="min-h-full"
            />
          </Virtualizer>
        </ScrollFrame>
      </div>
    </DiffWorkerPoolProvider>
  );
}
