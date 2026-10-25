import {
  getCodeHighlightCoordinator,
  type CodeHighlightResult,
} from "../../lib/asyncCodeHighlighting";
import { Check, Copy } from "lucide";
import { PlayIcon, WrapTextIcon } from "lucide-react";
import { toHtml } from "hast-util-to-html";
import React, { use, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import type { DiffThemeName } from "../../lib/diffRendering";
import {
  appendPlainCodeTail,
  reuseCompletedHighlightedLines,
  createIncrementalHighlightedDocument,
} from "../../lib/incrementalHighlighting";
import { LRUCache } from "../../lib/lruCache";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HighlightedCodeLines } from "./HighlightedCodeLines";
import {
  createHighlightCacheKey,
  estimateHighlightedSize,
  extractFenceLanguage,
} from "./MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { PierreEntryIcon } from "./PierreEntryIcon";

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

const THREAD_FIND_IGNORE_PROPS = {
  "data-thread-find-ignore": "",
} as React.HTMLAttributes<HTMLDivElement>;

export function MarkdownCodeBlockFrame({
  as: Wrapper = "div",
  language,
  fenceTitle,
  theme,
  wrapped = true,
  title,
  actions,
  headerProps,
  pendingCode = false,
  historical = false,
  children,
}: {
  as?: React.ElementType;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  wrapped?: boolean;
  /** Replaces the language title, as the composer does with its language picker. */
  title?: React.ReactNode;
  actions?: React.ReactNode;
  headerProps?: React.HTMLAttributes<HTMLDivElement>;
  pendingCode?: boolean;
  historical?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Wrapper
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
      data-smooth-history={historical ? "" : undefined}
      data-markdown-code-pending={pendingCode ? "" : undefined}
    >
      <div
        {...headerProps}
        className={cn(
          "chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none",
          headerProps?.className,
        )}
      >
        {title ?? (
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <MarkdownCodeBlockTitleContent
              fenceTitle={fenceTitle}
              language={language}
              theme={theme}
            />
          </span>
        )}
        {actions}
      </div>
      {children}
    </Wrapper>
  );
}

function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  onRunShellCommand,
  isStreaming,
  viewToggle,
  canWrap = true,
  diagram = false,
  pendingCode = false,
  historical = false,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  onRunShellCommand?: ((command: string) => void) | undefined;
  isStreaming: boolean;
  viewToggle?: ReactNode;
  canWrap?: boolean;
  diagram?: boolean;
  pendingCode?: boolean;
  historical?: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(() => getClientSettings().wordWrap);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const command = code.trim();
  const canRun =
    onRunShellCommand !== undefined &&
    !isStreaming &&
    /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language) &&
    code.endsWith("\n") &&
    command.length > 0 &&
    !command.endsWith("\\") &&
    // Control and invisible format characters (bidi overrides, zero-width) can
    // make the rendered command differ from what the terminal would receive.
    !/[\p{Cc}\p{Cf}]/u.test(code.slice(0, -1));

  const handleCopy = () => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  };

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copyLabel}
          />
        }
      >
        <MorphIcon className="size-3" icon={copied ? Check : Copy} />
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );

  if (diagram) {
    return (
      <div className="my-[0.65rem] border border-transparent" data-language={language}>
        <div className="flex items-center justify-end gap-0.5 pt-1.5 pr-1.5 select-none">
          {viewToggle}
          {copyButton}
        </div>
        {children}
      </div>
    );
  }

  return (
    <MarkdownCodeBlockFrame
      language={language}
      fenceTitle={fenceTitle}
      theme={theme}
      wrapped={wrapped}
      pendingCode={pendingCode}
      historical={historical}
      headerProps={THREAD_FIND_IGNORE_PROPS}
      actions={
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {canWrap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={wrapped ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((value) => !value)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {canRun ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => onRunShellCommand(command)}
                    aria-label="Run in terminal"
                  />
                }
              >
                <PlayIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Run in terminal</TooltipPopup>
            </Tooltip>
          ) : null}
          {viewToggle}
          {copyButton}
        </span>
      }
    >
      {children}
    </MarkdownCodeBlockFrame>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

export function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) setHasStreamed(true);
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  // Once lines are mounted individually, keep that renderer when streaming
  // finishes so switching to cached HTML cannot clear an existing selection.
  const cachedHighlightedHtml =
    !isStreaming && !hasStreamed ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  if (/^(?:js|javascript|jsx|ts|typescript|tsx)$/.test(language) && typeof Worker !== "undefined") {
    return (
      <WorkerShikiCodeBlock
        code={code}
        language={language}
        themeName={themeName}
        cacheKey={cacheKey}
        isStreaming={isStreaming}
        preserveLines={isStreaming || hasStreamed}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
      preserveLines={isStreaming || hasStreamed}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
  preserveLines: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  preserveLines,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const [highlightState, setHighlightState] = useState(() => ({
    highlighter,
    language,
    themeName,
    preserveLines,
    highlight: preserveLines
      ? createIncrementalHighlightedDocument(highlighter, language, themeName)
      : null,
  }));
  const currentHighlight =
    highlightState.highlighter === highlighter &&
    highlightState.language === language &&
    highlightState.themeName === themeName &&
    highlightState.preserveLines === preserveLines
      ? highlightState
      : {
          highlighter,
          language,
          themeName,
          preserveLines,
          highlight: preserveLines
            ? createIncrementalHighlightedDocument(highlighter, language, themeName)
            : null,
        };
  if (currentHighlight !== highlightState) setHighlightState(currentHighlight);
  const incrementalHighlight = currentHighlight.highlight;
  const highlighted = (() => {
    try {
      if (incrementalHighlight) return incrementalHighlight(code);
      return preserveLines
        ? highlighter.codeToHast(code, { lang: language, theme: themeName })
        : highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return preserveLines
        ? highlighter.codeToHast(code, { lang: "text", theme: themeName })
        : highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  })();

  useEffect(() => {
    if (!isStreaming) {
      const highlightedHtml = typeof highlighted === "string" ? highlighted : toHtml(highlighted);
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlighted, isStreaming]);

  return typeof highlighted === "string" ? (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
  ) : (
    <div className="chat-markdown-shiki">
      <HighlightedCodeLines root={highlighted} />
    </div>
  );
}

function WorkerShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  preserveLines,
}: UncachedShikiCodeBlockProps) {
  const [failed, setFailed] = useState(false);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    theme: DiffThemeName;
    root: ReturnType<Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>["codeToHast"]>;
  }>();
  const sessionRef = useRef<ReturnType<
    ReturnType<typeof getCodeHighlightCoordinator>["open"]
  > | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentCode = useEffectEvent(() => code);

  useEffect(() => {
    const ownerDocument = containerRef.current?.ownerDocument;
    let pending: CodeHighlightResult | undefined;
    let disposed = false;
    const selectionIntersectsCode = () => {
      const container = containerRef.current;
      const selection = ownerDocument?.getSelection();
      if (!container || !selection || selection.isCollapsed) return false;
      for (let index = 0; index < selection.rangeCount; index++) {
        if (selection.getRangeAt(index).intersectsNode(container)) return true;
      }
      return false;
    };
    const applyResult = (result: CodeHighlightResult) => {
      pending = undefined;
      ownerDocument?.removeEventListener("selectionchange", onSelectionChange);
      if (result.error || !result.root) {
        sessionRef.current?.close();
        sessionRef.current = null;
        setFailed(true);
        return;
      }
      setHighlighted((previous) => ({
        code: result.code,
        language,
        theme: themeName,
        root:
          previous?.language === language && previous.theme === themeName
            ? reuseCompletedHighlightedLines(
                previous.root,
                result.root!,
                previous.code,
                result.code,
              )
            : result.root!,
      }));
    };
    const onSelectionChange = () => {
      if (disposed || !pending || selectionIntersectsCode()) return;
      applyResult(pending);
    };
    const receiveResult = (result: CodeHighlightResult) => {
      if (disposed) return;
      if (selectionIntersectsCode()) {
        pending = result;
        ownerDocument?.addEventListener("selectionchange", onSelectionChange);
      } else {
        applyResult(result);
      }
    };
    let session: ReturnType<ReturnType<typeof getCodeHighlightCoordinator>["open"]> | undefined;
    try {
      session = getCodeHighlightCoordinator().open(language, themeName, receiveResult);
      sessionRef.current = session;
      session.update(currentCode());
    } catch {
      const fallbackCode = currentCode();
      queueMicrotask(() =>
        receiveResult({
          documentId: 0,
          requestId: 0,
          code: fallbackCode,
          error: "Worker unavailable",
        }),
      );
    }
    return () => {
      disposed = true;
      pending = undefined;
      ownerDocument?.removeEventListener("selectionchange", onSelectionChange);
      if (sessionRef.current === session) sessionRef.current = null;
      session?.close();
    };
  }, [language, themeName]);

  useEffect(() => {
    sessionRef.current?.update(code);
  }, [code]);

  useEffect(() => {
    if (
      isStreaming ||
      highlighted?.code !== code ||
      highlighted.language !== language ||
      highlighted.theme !== themeName
    )
      return;
    const html = toHtml(highlighted.root);
    highlightedCodeCache.set(cacheKey, html, estimateHighlightedSize(html, code));
  }, [cacheKey, code, highlighted, isStreaming, language, themeName]);

  if (failed) {
    return (
      <UncachedShikiCodeBlock
        code={code}
        language={language}
        themeName={themeName}
        cacheKey={cacheKey}
        isStreaming={isStreaming}
        preserveLines={preserveLines}
      />
    );
  }

  const visible =
    highlighted?.language === language && highlighted.theme === themeName
      ? appendPlainCodeTail(highlighted.root, highlighted.code, code)
      : undefined;
  return (
    <div ref={containerRef} className="chat-markdown-shiki">
      {visible ? (
        <HighlightedCodeLines root={visible} />
      ) : (
        <pre className="shiki">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
