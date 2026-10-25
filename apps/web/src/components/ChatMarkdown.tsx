import { SmoothMarkdownContext } from "./chat/smoothMarkdownContext";
import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "@t3tools/shared/fileLinks";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isHostPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { AuthFilesystemReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS as SHARED_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_SANITIZE_SCHEMA as SHARED_MARKDOWN_SANITIZE_SCHEMA,
} from "@t3tools/shared/markdownPipeline";

import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MailIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import {
  AssetWorkspaceAssetNotFoundError,
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import React, {
  Suspense,
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  use,
  memo,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import ReactMarkdown from "react-markdown";
import { toHtml } from "hast-util-to-html";
import {
  createIncrementalMarkdownPlugin,
  remarkRetainIncrementalMarkdown,
} from "../markdown-incremental";
import type { Root as MarkdownRoot, RootContent as MarkdownRootContent } from "mdast";
import { rehypeRawIfPresent, remarkStableTaskCheckboxes } from "../markdown-streaming";
import {
  remarkStreamingFootnoteAdmission,
  rehypeStreamingFootnoteAdmission,
  type StreamingFootnoteAdmissionData,
} from "../lib/streamingFootnoteAdmission";
import { defaultUrlTransform } from "react-markdown";
import {
  assistantCitationLabel,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
import {
  StreamingFootnoteHostContext,
  StreamingFootnotePlaybackContext,
  StreamingFootnoteItemVisibilityContext,
  StreamingMarkdownFootnoteItem,
  StreamingMarkdownFootnotes,
} from "./chat/StreamingMarkdownFootnotes";
import type { Plugin } from "unified";
import { mathKind } from "@t3tools/shared/markdownMath";
import remarkMath from "remark-math";
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren, skillInlineMatches } from "./chat/SkillInlineText";
import { MarkdownMath } from "./chat/MarkdownMath";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { markdownImageGallery } from "./chat/markdownImageGallery";
import { type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./preview/fileExplorerLabel";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./chat/externalLinkContextMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";

import {
  measureSmoothTextBlocks,
  type SmoothTextCandidate,
  type SmoothTextVisibleNode,
} from "../lib/smoothTextCommit";
import { contextChipVariants, CONTEXT_CHIP_LABEL_CLASS_NAME } from "./ContextChip";

import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { resolveDiffThemeName } from "../lib/diffRendering";

import { RenderErrorBoundary } from "./RenderErrorBoundary";

import { useRenderedAppearance } from "../hooks/useTheme";
import { useSmoothText } from "../hooks/useSmoothText";
import { useStreamingMarkdownText } from "../hooks/useStreamingMarkdownText";
import { useClientSettings } from "../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { createInlineBufferPlugin } from "../markdown-streaming";
import { SMOOTH_TEXT_BUFFER_MS } from "../lib/smoothText";
import type { SmoothTextResumeInput } from "../lib/smoothTextPlayback";
import type { SmoothOutputMode, SmoothOutputLineMode } from "@t3tools/contracts";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  isUnsupportedMarkdownFileLink,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../markdownFileHostPath";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../remoteOpen";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { assetEnvironment } from "../state/assets";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { projectEnvironment } from "../state/projects";
import { filesystemEnvironment } from "../state/filesystem";
import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
  useOpenChangeRequestLink,
} from "~/lib/openPullRequestLink";
import { useOpenLink } from "../browser/useOpenLink";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
} from "../browser/openFileInPreview";
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./chat/MarkdownCodeBlock";
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
  markdownImageCopy,
} from "./chat/ChatMarkdownMedia";
import {
  MARKDOWN_LINK_FAVICON_BOX_CLASS_NAME,
  leadingExternalLinkTextLength,
  MarkdownExternalLinkContent,
} from "./chat/MarkdownExternalLink";
import {
  MARKDOWN_FILE_LINK_CLASS_NAME,
  type MarkdownFileLinkProps,
  MarkdownFileLink,
} from "./chat/MarkdownFileLink";
import {
  hasMarkdownFilePrimaryAction,
  canUseMarkdownFileShellActions,
} from "./chat/MarkdownFileLink.logic";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
import { rehypeTextDirection } from "./chat/markdownTextDirection";
import { hastHasText, hastPlainTextDeep, plainHastText } from "./chat/markdownHast.logic";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./chat/markdownActionFailure";

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

interface ChatMarkdownProps {
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  smoothStreaming?: boolean;
  smoothOutputMode?: SmoothOutputMode;
  smoothOutputLineMode?: SmoothOutputLineMode;
  smoothMarkdownPreload?: boolean;
  smoothTextFadeDurationMs?: number;
  smoothTextYieldDurationMs?: number | undefined;
  footnotesAutoCollapse?: boolean;
  /** Registers the message-local footnote control with its timeline's tail coordinates. */
  registerFootnoteTail?: ((element: HTMLElement) => () => void) | undefined;
  /** Marks source completion while preserving playback geometry and fades. */
  smoothComplete?: boolean;
  smoothTextResume?: SmoothTextResumeInput | undefined;
  /** Claims the first snapshot of a newly received timeline entry for buffering. */
  claimInitialSmoothText?: (() => boolean) | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads GitHub-hosted media through `cwd`'s GitHub credential, which a private repository's
      uploads need; without it those images and videos load unauthenticated and 404. */
  githubMedia?: boolean | undefined;
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  "google-docs": FileTextIcon,
  "google-slides": PresentationIcon,
  "google-sheets": FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>;

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);

  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </div>
          <div className="text-xs text-muted-foreground">{presentationLabel}</div>
        </div>
      </div>
      {props.onUse ? (
        <Button
          data-thread-find-ignore
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

type SmoothSourceHastNode =
  | HastElement["children"][number]
  | { type: "root"; children: HastElement["children"] };

function rehypePreserveSmoothSourceMeta() {
  return (tree: SmoothSourceHastNode, file: { toString(): string }) => {
    const source = String(file);
    const visit = (node: SmoothSourceHastNode) => {
      if (node.type === "element" && node.tagName === "li") {
        const start = node.position?.start.offset;
        const markerOffset =
          typeof start === "number" ? findTaskListMarkerOffset(source, start) : null;
        if (markerOffset !== null)
          node.properties = { ...node.properties, dataTaskMarkerOffset: markerOffset };
      }
      if (node.type === "element" && node.tagName === "pre")
        node.properties = {
          ...node.properties,
          dataClosedCodeFence: isClosedCodeFence(node, source, hastPlainTextDeep(node)),
        };
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...SHARED_MARKDOWN_SANITIZE_SCHEMA,
  attributes: {
    ...SHARED_MARKDOWN_SANITIZE_SCHEMA.attributes,
    li: [
      ...(SHARED_MARKDOWN_SANITIZE_SCHEMA.attributes["*"] ?? []),
      ...((SHARED_MARKDOWN_SANITIZE_SCHEMA as NonNullable<Parameters<typeof rehypeSanitize>[0]>)
        .attributes?.li ?? []),
      "dataTaskMarkerOffset",
    ],
    pre: [...(SHARED_MARKDOWN_SANITIZE_SCHEMA.attributes["*"] ?? []), "dataClosedCodeFence"],
    img: [...SHARED_MARKDOWN_SANITIZE_SCHEMA.attributes.img, "dataStreamImagePending"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  ...SHARED_MARKDOWN_REHYPE_PLUGINS.slice(0, -1),
  rehypePreserveSmoothSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
const SMOOTH_MARKDOWN_REHYPE_PLUGINS = CHAT_MARKDOWN_REHYPE_PLUGINS.map((plugin) =>
  plugin === rehypeRaw ? rehypeRawIfPresent : plugin,
);
const LITERAL_MARKDOWN_REHYPE_PLUGINS = [rehypePreserveSmoothSourceMeta];

/** GitHub's own five alert kinds, in its colors: the glyph names the urgency, the title says it. */
const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

function footnoteNavigationKey(node: HastElement): string {
  const links: unknown[] = [];
  const visit = (entry: HastElement) => {
    if (entry.properties.dataFootnoteBackref !== undefined) links.push(entry.properties);
    else for (const child of entry.children) if (child.type === "element") visit(child);
  };
  visit(node);
  return JSON.stringify(links);
}

function hasFootnoteContent(node: HastElement): boolean {
  if (node.properties.dataFootnoteBackref !== undefined) return false;
  if (["img", "video", "audio", "input", "hr"].includes(node.tagName)) return true;
  return node.children.some((child) =>
    child.type === "text"
      ? /\S/u.test(child.value)
      : child.type === "element" && hasFootnoteContent(child),
  );
}

// Heading ids are added after sanitizing, which would prefix them a second time.
const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
  rehypeTextDirection,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const SMOOTH_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...SMOOTH_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
  rehypeTextDirection,
];
const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [
  ...LITERAL_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
  rehypeTextDirection,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

/** The server config fields markdown reads. */
function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config?.environment.capabilities.pullRequests === true,
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManagerLabel:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? config.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(config.environment.platform.os)
          : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.revealInFileManagerLabel === next.revealInFileManagerLabel &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

function useStableMarkdownFileLinks(next: Map<string, MarkdownFileLinkMeta>) {
  const [previous, setPrevious] = useState(next);
  const stable =
    previous.size === next.size &&
    [...next].every(([key, value]) => {
      const old = previous.get(key);
      return (
        old !== undefined &&
        old.filePath === value.filePath &&
        old.targetPath === value.targetPath &&
        old.displayPath === value.displayPath &&
        old.workspaceRelativePath === value.workspaceRelativePath &&
        old.basename === value.basename &&
        old.line === value.line &&
        old.column === value.column
      );
    })
      ? previous
      : next;
  // Unchanged links must not invalidate every historical Markdown consumer.
  if (stable !== previous) setPrevious(stable);
  return stable;
}
// The config object changes with every provider status push and snapshot. The
// atom keeps its previous value while the fields markdown reads are equal, so
// those pushes don't re-render every visible reply.
const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

function useChatMarkdownState({
  text,
  inline = false,
  smoothComplete = false,
  cwd,
  threadRef,
  pullRequestPanelRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  workspaceMutationId,
  onImageExpand,
  renderContextReference,
  headingLevelOffset = 0,
  githubMedia = false,
}: ChatMarkdownProps) {
  const resolvedTheme = useRenderedAppearance();
  const markdownRef = useRef<HTMLElement>(null);
  const mediaRequestId = useRef(0);
  // A preview opened from another thread or workspace never carries over.
  const mediaScopeKey = [
    threadRef?.environmentId,
    threadRef?.threadId,
    explicitEnvironmentId,
    cwd,
    imageBaseDir,
  ].join("\u0000");
  // Tagged with the scope it was opened in: a request from the previous scope can
  // resolve before the effect cleanup below invalidates it, and must stay hidden.
  const [localMedia, setLocalMedia] = useState<{
    scope: string;
    preview: ExpandedImagePreview;
  } | null>(null);
  const localMediaPreview = localMedia?.scope === mediaScopeKey ? localMedia.preview : null;
  const closeLocalMediaPreview = () => setLocalMedia(null);
  const expandMedia =
    onImageExpand ??
    ((preview: ExpandedImagePreview) => setLocalMedia({ scope: mediaScopeKey, preview }));
  const [mediaScope, setMediaScope] = useState(mediaScopeKey);
  if (mediaScope !== mediaScopeKey) {
    setMediaScope(mediaScopeKey);
    setLocalMedia(null);
  }
  // A layout cleanup runs in the commit that changes scope, so a request resolving
  // before paint cannot reach a parent onImageExpand either.
  useLayoutEffect(
    () => () => {
      mediaRequestId.current += 1;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the scope invalidates media requests still loading for it.
    [mediaScopeKey],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const openMarkdownMedia = (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => {
    const requestId = ++mediaRequestId.current;
    void resolveMarkdownMediaPreview({
      source,
      resolvedFilePath,
      cwd,
      threadRef,
      // Read at click time: a reconnect replaces the prepared connection, and
      // subscribing would hand every rendered markdown element a new context.
      httpBaseUrl:
        environmentId === null ? undefined : readPreparedConnection(environmentId)?.httpBaseUrl,
      createAssetUrl,
      onOpenFile: threadRef
        ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
        : undefined,
    }).then(
      (preview) => {
        if (preview && mediaRequestId.current === requestId) {
          const selected = preview.images[preview.index];
          expandMedia(
            selected && selected.type !== "video" && markdownRef.current
              ? markdownImageGallery(clickedImage ?? markdownRef.current, selected)
              : preview,
          );
        }
      },
      (error: unknown) => {
        if (mediaRequestId.current !== requestId) return;
        let description =
          error instanceof Error
            ? error.message
            : "The file could not be loaded. It may have been moved or deleted.";
        if (
          isAssetNotFoundError(error) &&
          error.resource._tag === "media-file" &&
          environmentId !== null
        ) {
          // The connection may resolve while the media lookup is pending.
          const target = readPreparedConnection(environmentId)?.target ?? null;
          if (
            target !== null &&
            resolveRemoteOpenState({
              target,
              sshTarget: null,
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
            }).mode !== "local-exec"
          ) {
            description = `The file was not found on ${target.label} at ${error.checkedPath ?? error.resource.path}.`;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description,
          }),
        );
      },
    );
  };
  const { pullRequestsEnabled, availableEditors, revealInFileManagerLabel } = useAtomValue(
    markdownServerConfigFieldsAtom(environmentId),
  );
  const projects = useProjects();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealFileInFileManager = (filePath: string) => {
    if (environmentId === null) {
      return Promise.resolve(
        AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return Promise.resolve(
        AsyncResult.failure<void, Error>(
          Cause.fail(new Error("This connection cannot reveal files on this environment.")),
        ),
      );
    }
    return openInEditor({
      environmentId,
      input: { cwd: filePath, editor: "file-manager", reveal: true },
    });
  };
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const parsedMarkdownFileLinks = (() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text))) {
      if (parseComposerContextHref(href)) continue;
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  })();
  const parsedInlineCodeFileLinks = (() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  })();
  const markdownFileLinkMetaByHref = useStableMarkdownFileLinks(parsedMarkdownFileLinks);
  const inlineCodeFileLinkMetaByText = useStableMarkdownFileLinks(parsedInlineCodeFileLinks);
  const fileLinkParentSuffixByPath = (() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  })();
  const markdownUrlTransform = (href: string) => {
    if (parseAssistantCitationHref(href)) return href;
    if (parseComposerContextHref(href)) return href;
    if (parseThreadLinkHref(href)) return href;
    if (isWindowsDrivePathHref(href)) return href;
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  };
  const handleCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    const fragment = event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    event.clipboardData.setData(
      "text/html",
      fragment
        ? encodeComposerContextClipboardHtml(payload.text, fragment, payload.html)
        : payload.html,
    );
  };
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribed rather than read at click time: the anchor has to decide
  // synchronously whether to intercept its `_blank`, and a subscription is what
  // makes a persisted "app" apply once settings hydrate after launch.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  const mathEnabled = useClientSettings((settings) => settings.mathRenderingEnabled);
  const resolveThreadPullRequest = (
    href: string,
  ): (ThreadPullRequestKey & { readonly url: string }) | null => {
    if (
      threadRef === undefined ||
      readThreadShell(threadRef) === null ||
      !pullRequestLinking.canLink(href)
    )
      return null;
    const parsed = parseChangeRequestUrl(href);
    return parsed === null ? null : { ...parsed, url: href };
  };
  const linkedThreadPullRequestFor = (href: string) => {
    if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
      return null;
    const parsed = parseChangeRequestUrl(href);
    return parsed === null ? null : { ...parsed, url: href };
  };
  const updateThreadPullRequestLink = async (href: string, linked: boolean) => {
    if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    await pullRequestLinking.changeLink(threadRef, href, linked);
  };
  const openExternalLinkInPreview = (url: string) => {
    if (!threadRef || !canOperatePreview) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Preview access is unavailable for this client.",
            }),
          ),
        ),
      );
    }
    return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, url);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link in browser",
              description: error.message,
            }),
          );
        }
      }
      return result;
    });
  };
  const openMarkdownFileInPreview = (path: string) => {
    const preparedConnection = threadRef ? readPreparedConnection(threadRef.environmentId) : null;
    if (!threadRef || !canOperatePreview || preparedConnection === null) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Environment is not connected.",
            }),
          ),
        ),
      );
    }
    return openFileInPreview({
      threadRef,
      filePath: path,
      workspaceRoot: cwd,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      createAssetUrl,
      openPreview,
    });
  };
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
    if (
      !workspaceRelativePath ||
      !cwd ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    ) {
      return null;
    }
    const isBasename = needsWorkspaceBasenameLookup(workspaceRelativePath);
    const strippedPath = isBasename
      ? null
      : stripRepeatedWorkspacePrefix(workspaceRelativePath, cwd);
    if (!isBasename && strippedPath === null) return null;
    const result = await searchProjectEntries({
      environmentId,
      input: {
        cwd,
        query: strippedPath ?? workspaceRelativePath,
        limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        kind: "file",
      },
    });
    if (result._tag !== "Success") return null;
    if (strippedPath === null) {
      return pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries);
    }
    const match = pickStrippedWorkspaceMatch(strippedPath, cwd, result.value.entries);
    if (match === null) return null;
    // Search can be truncated or still scanning, so it cannot rule out the
    // literal path. Check the host before redirecting to the stripped match.
    const metadata = await getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    return metadata._tag === "Success" && metadata.value.entries[0] === null ? match : null;
  };
  const openFileInPanel = (fileLinkMeta: MarkdownFileLinkMeta, panelPath: string) => {
    if (!threadRef) return;
    // Claimed on every open so a synchronous one supersedes a lookup already
    // in flight.
    const isLatestLookup = claimWorkspaceBasenameLookup();
    const openAt = (path: string) =>
      useRightPanelStore.getState().openFile(threadRef, path, fileLinkMeta.line);
    if (
      fileLinkMeta.workspaceLookupPath === null ||
      !cwd ||
      (!needsWorkspaceBasenameLookup(panelPath) &&
        stripRepeatedWorkspacePrefix(panelPath, cwd) === null)
    ) {
      openAt(panelPath);
      return;
    }
    void (async () => {
      const match = await findWorkspaceFileMatch(fileLinkMeta);
      if (!isLatestLookup()) return;
      openAt(match ?? panelPath);
    })();
  };
  const fileLinkChip = (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    mediaSource?: string,
  ) => {
    const resolveHostPath = () =>
      resolveMarkdownFileHostPath({
        meta: fileLinkMeta,
        cwd,
        findWorkspaceMatch: () => findWorkspaceFileMatch(fileLinkMeta),
      });
    const mediaPath = mediaSource ?? fileLinkMeta.filePath;
    const canPreviewMedia =
      mediaMimeTypeFromExtension(
        fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
      ) !== null;
    const unsupportedFile = isUnsupportedMarkdownFileLink(fileLinkMeta.filePath);
    const panelPath = unsupportedFile
      ? null
      : (fileLinkMeta.workspaceRelativePath ??
        (!canPreviewMedia && isHostPath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null));

    return (
      <MarkdownFileLink
        environmentId={environmentId}
        href={fileLinkMeta.targetPath}
        targetPath={fileLinkMeta.targetPath}
        iconPath={fileLinkMeta.filePath}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
        panelPath={panelPath}
        line={fileLinkMeta.line}
        label={fileLinkLabel(
          {
            path: fileLinkMeta.filePath,
            ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
            ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
          },
          fileLinkParentSuffixByPath,
        )}
        copyMarkdown={copyMarkdown}
        theme={resolvedTheme}
        threadRef={threadRef}
        onOpen={
          canUseShellActions && (!unsupportedFile || availableEditors.includes("file-manager"))
            ? async () => {
                const hostPath = await resolveHostPath();
                return unsupportedFile && environmentId !== null
                  ? openInEditor({
                      environmentId,
                      input: { cwd: hostPath.absolutePath, editor: "file-manager" },
                    })
                  : openInPreferredEditor(markdownFileEditorTarget(fileLinkMeta, hostPath));
              }
            : undefined
        }
        resolveCopyPaths={async () =>
          markdownFileCopyPaths(fileLinkMeta, await resolveHostPath(), cwd)
        }
        onOpenInPanel={(path) => openFileInPanel(fileLinkMeta, path)}
        onOpenMedia={
          threadRef && canPreviewMedia
            ? () => openMarkdownMedia(mediaPath, fileLinkMeta.filePath)
            : undefined
        }
        openInEditorMenuLabel={preferredEditorMenuLabel}
        onReveal={
          canUseShellActions && revealInFileManagerLabel !== undefined
            ? async () => revealFileInFileManager((await resolveHostPath()).absolutePath)
            : undefined
        }
        revealLabel={revealInFileManagerLabel}
        onOpenInBrowser={
          threadRef &&
          canOperatePreview &&
          isPreviewAvailableFor(threadRef.environmentId) &&
          isBrowserPreviewFile(fileLinkMeta.filePath)
            ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
            : undefined
        }
      />
    );
  };

  const componentState = {
    canOperateHost,
    canOperatePreview,
    cwd,
    diffThemeName,
    environmentId,
    expandMedia,
    fileLinkChip,
    githubMedia,
    renderContextReference,
    headingLevelOffset,
    imageBaseDir,
    workspaceMutationId,
    inlineCodeFileLinkMetaByText,
    inline,
    mathEnabled,
    isStreaming,
    smoothComplete,
    linkTargetPreference,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    onUseArtifactTemplate,
    onRunShellCommand,
    openChangeRequestLink,
    openDeferredMarkdownLink,
    openExternalLinkInPreview,
    openMarkdownMedia,
    projects,
    linkedThreadPullRequestFor,
    resolveThreadPullRequest,
    resolvedTheme,
    pullRequestsEnabled,
    skills,
    threadRef,
    updateThreadPullRequestLink,
  };
  return {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);
const ChatMarkdownSourceContext = React.createContext("");
// Paragraphs only need skills. Completion and link metadata must not render
// every historical paragraph through the full renderer context again.
const ChatMarkdownSkillsContext = React.createContext(EMPTY_MARKDOWN_SKILLS);

// The markdown source changes on every streamed delta. Only the renderers that
// slice it by node offset read it, so it sits apart from the renderer context.

function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ReactMarkdownExtraProps) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

// Keep component types stable when streaming changes the message state.
const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
  div: function MarkdownDiv({ node, children, ...props }) {
    const { onUseArtifactTemplate } = use(ChatMarkdownRendererContext);
    const artifactTemplate = artifactTemplateFromHastProperties(node?.properties);
    if (artifactTemplate) {
      return (
        <CodexArtifactTemplateCard template={artifactTemplate} onUse={onUseArtifactTemplate} />
      );
    }
    return <div {...props}>{children}</div>;
  },
  p: function MarkdownParagraph({ node: _node, children, ...props }) {
    const skills = use(ChatMarkdownSkillsContext);
    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert =
      GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div
        role="note"
        dir={props.dir}
        className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
      >
        <p
          data-thread-find-ignore="true"
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ul: function MarkdownUnorderedList({ node: _node, ...props }) {
    return <ul {...props} />;
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const skills = use(ChatMarkdownSkillsContext);
    const footnotes = use(StreamingFootnoteItemVisibilityContext);
    const { smooth } = use(SmoothMarkdownContext);
    if (footnotes?.items.some((item) => item.id === props.id))
      return (
        <StreamingMarkdownFootnoteItem {...props}>
          {renderSkillInlineMarkdownChildren(children, skills)}
        </StreamingMarkdownFootnoteItem>
      );
    // The parser owns source offsets. Completed list rows no longer subscribe
    // to every new character in the document just to keep their checkbox target.
    const markerOffset = node?.properties.dataTaskMarkerOffset;
    const isTaskItem = String(props.className ?? "").includes("task-list-item");
    return (
      <li
        {...props}
        data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}
        data-task-marker-offset={typeof markerOffset === "number" ? markerOffset : undefined}
        data-smooth-list-empty={smooth && !hastPlainTextDeep(node).trim() ? "" : undefined}
      >
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownSourceContext);
    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === "checkbox"}
        />
      );
    }
    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label="Toggle task"
        checked={checked}
        onChange={(event) => {
          const listItemStart = Number(event.currentTarget.closest("li")?.dataset.listItemOffset);
          if (!Number.isSafeInteger(listItemStart)) return;
          const markerOffset = findTaskListMarkerOffset(text, listItemStart);
          if (markerOffset === null) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    if (
      node?.properties?.dataFootnoteRef !== undefined ||
      node?.properties?.dataFootnoteBackref !== undefined
    ) {
      // Footnote navigation is native document navigation. It does not depend
      // on the changing message context or workspace/external-link resolution.
      return (
        <a
          {...props}
          href={href || undefined}
          onClick={(event) => {
            props.onClick?.(event);
            if (href) handleMarkdownFragmentClick(event, href);
          }}
        >
          {children}
        </a>
      );
    }
    const {
      canOperateHost,
      canOperatePreview,
      cwd,
      environmentId,
      imageBaseDir,
      markdownFileLinkMetaByHref,
      threadRef,
      openMarkdownMedia,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      linkTargetPreference,
      openExternalLinkInPreview,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      pullRequestsEnabled,
      updateThreadPullRequestLink,
      fileLinkChip,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownSourceContext);
    const citation = href ? parseAssistantCitationHref(href) : null;
    if (citation)
      return (
        <span data-smooth-atomic="">
          <AssistantCitationChip citation={citation} />
        </span>
      );
    // A thread link names a thread in this message's environment and opens it in the app.
    const linkedThreadId = href ? parseThreadLinkHref(href) : null;
    if (linkedThreadId) {
      const label = hastPlainTextDeep(node) || linkedThreadId;
      return environmentId ? (
        <MarkdownThreadLink environmentId={environmentId} threadId={linkedThreadId} label={label} />
      ) : (
        <span>{label}</span>
      );
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        <span data-smooth-atomic="">{renderContextReference({ ...contextReference, label })}</span>
      ) : (
        <span>{label}</span>
      );
    }
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    const fileLinkMeta = markdownAnchorFileMeta(href, {
      cwd,
      imageBaseDir,
      markdownFileLinkMetaByHref,
    });
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const hasText = hastHasText(node);
      const pullRequestAutolink = String(
        (props as Record<string, unknown>)["data-pull-request-autolink"] ?? "",
      );
      const pullRequestCopy =
        pullRequestAutolink === "commit"
          ? /\/commit\/([0-9a-f]{40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href ? pullRequestCandidateUrlFromReferenceAutolink(href) : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled,
            url: pullRequestCandidateUrl,
          })
        : null;
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const canOpenInPreview =
        canOperatePreview && Boolean(threadRef && isPreviewAvailableFor(threadRef.environmentId));
      const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
      const link = (
        <a
          {...props}
          className={cn(props.className, pullRequestAutolink === "commit" && "font-mono")}
          data-markdown-copy={pullRequestCopy}
          data-markdown-image-link={!hasText || undefined}
          data-smooth-atomic={isPullRequestAutolink ? "" : undefined}
          href={href || undefined}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);
            if (isSameDocumentLink && href) {
              handleMarkdownFragmentClick(event, href);
              return;
            }
            if (
              href &&
              faviconHost !== null &&
              mediaKindFromPath(href) !== null &&
              !event.defaultPrevented &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              event.stopPropagation();
              openMarkdownMedia(
                href,
                undefined,
                event.target instanceof HTMLImageElement
                  ? event.target
                  : event.currentTarget.querySelector("img"),
              );
              return;
            }
            if (
              !href ||
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined)
            ) {
              return;
            }
            if (event.defaultPrevented) return;
            if (
              resolveLinkTarget({
                url: href,
                event,
                preference: linkTargetPreference,
                canOpenInApp: canOpenInPreview,
              }) !== "app"
            ) {
              // Chromium turns an Option/Alt-click into a download that never reaches the
              // shell. On desktop, open the link here while the key is still down, so link
              // routers such as Finicky can still read it.
              if (isElectron && event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                void readLocalApi()
                  ?.shell.openExternal(href)
                  .catch((cause) =>
                    reportMarkdownActionFailure(
                      { operation: "open-link-external", target: href },
                      cause,
                    ),
                  );
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            void openExternalLinkInPreview(href).then((result) => {
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
              reportMarkdownActionFailure(
                { operation: "open-link-in-preview", target: href },
                result.cause,
              );
              if (squashAtomCommandFailure(result) instanceof BrowserSettingsReadError) return;
              void readLocalApi()?.shell.openExternal(href);
            });
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();
            if (!api) return;
            const threadLinkAction = !canOperateHost
              ? undefined
              : linkedThreadPullRequestFor(href) !== null
                ? "unlink-from-thread"
                : resolveThreadPullRequest(href) === null
                  ? undefined
                  : "link-to-thread";
            void showExternalLinkContextMenu({
              href,
              canOpenInPreview,
              threadLinkAction,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) => {
                const result = await openExternalLinkInPreview(target);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  reportMarkdownActionFailure(
                    { operation: "open-link-in-preview", target },
                    result.cause,
                  );
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, "link"),
              updateThreadLink: updateThreadPullRequestLink,
              reportFailure: (operation, cause) => {
                reportMarkdownActionFailure({ operation, target: href }, cause);
                if (
                  operation === "link-pull-request-to-thread" ||
                  operation === "unlink-pull-request-from-thread"
                ) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title:
                        operation === "link-pull-request-to-thread"
                          ? "Unable to link pull request"
                          : "Unable to unlink pull request",
                      description: cause instanceof Error ? cause.message : "The request failed.",
                    }),
                  );
                }
              },
            });
          }}
        >
          {(faviconHost || href === "") && hasText && !isPullRequestAutolink ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {linkChildren}
            </MarkdownExternalLinkContent>
          ) : (
            linkChildren
          )}
        </a>
      );
      if (href !== "" && (!faviconHost || !href)) {
        return link;
      }
      if (pullRequestPreviewTarget !== null) {
        return (
          <PullRequestLinkPreview
            link={link}
            originalUrl={href}
            target={pullRequestPreviewTarget}
            confirmBeforeOpen={confirmBeforeOpen}
            onOpenPullRequest={(targetUrl) =>
              openChangeRequestLink(
                {
                  metaKey: false,
                  ctrlKey: false,
                  preventDefault: () => undefined,
                  stopPropagation: () => undefined,
                },
                targetUrl,
                undefined,
                environmentId ?? undefined,
              )
            }
            onOpenFallback={openDeferredMarkdownLink}
          />
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">{href}</TooltipPopup>
        </Tooltip>
      );
    }

    const label = nodeToPlainText(children);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
    const copyMarkdown =
      source.startsWith("[") && source.includes("](")
        ? source
        : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
    const chip = fileLinkChip(fileLinkMeta, copyMarkdown, normalizedHref);
    return isMarkdownFileLinkLabel(label, normalizedHref) ? (
      chip
    ) : (
      <span data-markdown-copy={copyMarkdown}>
        {children} {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const { cwd, imageBaseDir, inlineCodeFileLinkMetaByText, fileLinkChip, mathEnabled, inline } =
      use(ChatMarkdownRendererContext);
    const math = mathEnabled ? mathKind(className) : null;
    if (math) {
      return (
        <MarkdownMath
          tex={nodeToPlainText(children)}
          display={math === "display"}
          focusable={!inline}
        />
      );
    }
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta = markdownInlineCodeFileMeta(codeText, {
        cwd,
        imageBaseDir,
        inlineCodeFileLinkMetaByText,
      });
      if (fileLinkMeta) {
        return fileLinkChip(
          fileLinkMeta,
          `\`${codeText}\``,
          inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
        );
      }
    }
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const {
      expandMedia,
      cwd,
      environmentId,
      githubMedia,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const localSrc = node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredSrc = typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const classifiedSrc =
      typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    // rehype-raw serializes custom data attributes when HTML shares the document.
    if (node?.properties?.dataStreamImagePending !== undefined) {
      return (
        <ChatMarkdownImage
          src={null}
          alt={altText}
          copyMarkdown={undefined}
          standalone={standalone}
          actionsSource={{ kind: "image", name: altText || "image", src: null }}
        />
      );
    }
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const kind = mediaKindFromPath(classifiedSrc) ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const githubMediaUrl =
      directUri === null ? null : githubMediaFetchUrl(resolveProtocolRelativeMediaUrl(directUri));
    if (
      githubMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      githubMediaUrl !== null
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{ _tag: "github-media", cwd, url: githubMediaUrl }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          fallbackSrc={githubMediaUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "Direct") {
      const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
      const originalUrl =
        resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
      const reference = mediaUrlReference(imageSource.uri);
      const actionsSource: MediaActionSource = {
        kind,
        name: altText || kind,
        src: mediaSrc,
        ...(reference ? { reference } : {}),
      };
      if (kind === "video") {
        return (
          <ChatMarkdownVideo
            src={mediaSrc}
            alt={altText}
            copyMarkdown={copyMarkdown}
            originalUrl={originalUrl}
            style={authoredSizeStyle}
            actionsSource={actionsSource}
          />
        );
      }
      return (
        <ChatMarkdownImage
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: threadRef.threadId,
            path: imageSource.path,
          }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          standalone={standalone}
          style={authoredSizeStyle}
          workspaceRoot={cwd}
          workspaceMutationId={workspaceMutationId}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  section: function MarkdownSection({ node, children, ...props }) {
    const smooth = use(SmoothMarkdownContext);
    const { isStreaming, smoothComplete } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownSourceContext);
    if (node?.properties?.dataFootnotes === undefined)
      return <section {...props}>{children}</section>;
    const stableChildren = React.Children.toArray(children).map((child) => {
      if (
        !React.isValidElement<ReactMarkdownExtraProps & { children?: ReactNode }>(child) ||
        child.props.node?.tagName !== "ol"
      )
        return child;
      return React.cloneElement(child, {
        children: React.Children.toArray(child.props.children).map((item) =>
          React.isValidElement<{ id?: string }>(item) && item.props.id
            ? React.cloneElement(item, { key: item.props.id })
            : item,
        ),
      });
    });
    const definitions = node.children.flatMap((list) =>
      list.type === "element" && list.tagName === "ol"
        ? list.children.flatMap((item) =>
            item.type === "element" && item.tagName === "li" ? [item] : [],
          )
        : [],
    );
    // Notes are numbered by first reference, but a run is about where they
    // were written: definitions with only whitespace between them in the source.
    const follows = new Map<HastElement, string>();
    const bySource = definitions
      .filter((item) => item.position?.start.offset !== undefined)
      .toSorted((a, b) => a.position!.start.offset! - b.position!.start.offset!);
    for (let index = 1; index < bySource.length; index++) {
      const previous = bySource[index - 1]!;
      const item = bySource[index]!;
      if (!/\S/u.test(text.slice(previous.position!.end.offset, item.position!.start.offset)))
        follows.set(item, String(previous.properties.id));
    }
    return (
      <StreamingMarkdownFootnotes
        {...props}
        {...smooth}
        items={definitions.map((item) => {
          const trailing = text.slice(item.position?.end.offset ?? text.length).trimStart();
          const playbackBaseline = smooth.playbackResume;
          const baselineMatches =
            playbackBaseline !== undefined && text.startsWith(playbackBaseline.baselineText);
          const historyLength = playbackBaseline
            ? Math.max(
                playbackBaseline.baselineText.length,
                text.startsWith(playbackBaseline.mountText ?? text)
                  ? (playbackBaseline.mountText ?? text).length
                  : 0,
              )
            : 0;
          // A split next-definition marker is not an authored prose boundary.
          const pendingDefinition = /^\[(?:\^(?:\\[^\r\n]|[^\]\\\r\n])*(?:\\|\])?)?$/.test(
            trailing,
          );
          return {
            id: String(item.properties.id),
            text: hastPlainTextDeep(item).trimEnd(),
            synchronized:
              playbackBaseline !== undefined &&
              (playbackBaseline.forceShow === true ||
                !baselineMatches ||
                (item.position?.end.offset ?? Infinity) <= historyLength),
            // Raw Markdown offsets cannot safely split the rendered glyphs of
            // a definition spanning history/live. Admit it to FIFO, but show
            // this one definition directly rather than replay its old prefix.
            historyContinuation:
              playbackBaseline !== undefined &&
              (item.position?.start.offset ?? Infinity) < historyLength &&
              (item.position?.end.offset ?? 0) > historyLength,
            navigationKey: footnoteNavigationKey(item),
            blocked:
              (item.data as StreamingFootnoteAdmissionData | undefined)
                ?.streamingFootnoteBlocked === true,
            hasContent: hasFootnoteContent(item),
            complete:
              !(isStreaming && !smoothComplete) || (trailing.length > 0 && !pendingDefinition),
            follows: follows.get(item) ?? null,
          };
        })}
      >
        {stableChildren}
      </StreamingMarkdownFootnotes>
    );
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const { smooth } = use(SmoothMarkdownContext);
    const {
      resolvedTheme,
      diffThemeName,
      expandMedia,
      isStreaming,
      smoothComplete,
      onRunShellCommand,
      inline,
      mathEnabled,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownSourceContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const language = extractFenceLanguage(codeBlock.className);
    if (
      mathEnabled &&
      language === "math" &&
      (!isStreaming ||
        mathKind(codeBlock.className) === "display" ||
        isClosedCodeFence(node, text, codeBlock.code))
    ) {
      return <MarkdownMath tex={codeBlock.code} display focusable={!inline} />;
    }
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
    const pendingCode =
      smooth && isStreaming && !smoothComplete && node?.properties.dataClosedCodeFence === false;
    const highlightedCode = (
      <RenderErrorBoundary
        resetKeys={[codeBlock.code, language, diffThemeName, isStreaming]}
        fallback={<pre {...props}>{children}</pre>}
      >
        <Suspense
          fallback={
            <pre
              {...props}
              className={smooth || smoothComplete ? undefined : "invisible"}
              aria-hidden={smooth || smoothComplete ? undefined : true}
              data-markdown-code-pending={smooth || smoothComplete ? undefined : ""}
            >
              {children}
            </pre>
          }
        >
          {pendingCode ? (
            <pre {...props}>{children}</pre>
          ) : (
            <SuspenseShikiCodeBlock
              className={codeBlock.className}
              code={codeBlock.code}
              themeName={diffThemeName}
              isStreaming={isStreaming}
            />
          )}
        </Suspense>
      </RenderErrorBoundary>
    );
    if (language === "mermaid") {
      return (
        <MarkdownMermaidCodeBlock
          code={codeBlock.code}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
          isStreaming={
            isStreaming &&
            !(node?.properties.dataClosedCodeFence ?? isClosedCodeFence(node, text, codeBlock.code))
          }
          onExpand={(src) => expandMedia({ images: [{ src, name: "Mermaid diagram" }], index: 0 })}
        >
          {highlightedCode}
        </MarkdownMermaidCodeBlock>
      );
    }
    return (
      <MarkdownCodeBlock
        historical={node?.properties.dataSmoothHistory !== undefined}
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        onRunShellCommand={
          onRunShellCommand &&
          !isStreaming &&
          (node?.properties.dataClosedCodeFence ?? isClosedCodeFence(node, text, codeBlock.code))
            ? onRunShellCommand
            : undefined
        }
        isStreaming={isStreaming}
        pendingCode={pendingCode}
      >
        {highlightedCode}
      </MarkdownCodeBlock>
    );
  },
} satisfies Components;

type HastElement = NonNullable<ReactMarkdownExtraProps["node"]>;
type HastRoot = Parameters<ReturnType<typeof rehypeRaw>>[0];

interface MarkdownBlockCacheEntry {
  signature: string;
  parsed?: MarkdownRootContent | undefined;
  child: ReactNode;
  children?: ReactNode[];
}

type MarkdownRetainedRun = Array<string | { key: string; entry: MarkdownBlockCacheEntry }>;

/** Build a new cache without mutating the last committed render's snapshot. */
function retainMarkdownChildren(
  children: ReactNode,
  previousBlocks: ReadonlyMap<string, MarkdownBlockCacheEntry>,
  retainedRuns: WeakMap<HastElement, MarkdownRetainedRun>,
  rootKeys: WeakMap<HastElement, string>,
  parsedByOffset: ReadonlyMap<number, MarkdownRootContent>,
) {
  const nextBlocks = new Map<string, MarkdownBlockCacheEntry>();
  const stableKey = (child: ReactNode) =>
    React.isValidElement<ReactMarkdownExtraProps>(child) &&
    child.props.node?.properties.dataFootnotes !== undefined
      ? React.cloneElement(child, { key: "stream-footnotes" })
      : child;
  // A later authored section changes ReactMarkdown's section-N key. Keep the
  // generated footnotes' owner alive while surrounding block types evolve.
  const groupChildren = (children: ReactNode[], path: string): ReactNode[] => {
    const result: ReactNode[] = [];
    let pending: ReactNode[] = [];
    let index = 0;
    const flush = () => {
      if (pending.length === 0) return;
      const key = `$group/${path}/${index++}`;
      const previous = previousBlocks.get(key);
      const group =
        previous?.children?.length === pending.length &&
        pending.every((child, index) => child === previous.children![index])
          ? previous
          : {
              signature: "",
              children: pending,
              child: <React.Fragment key={key}>{pending}</React.Fragment>,
            };
      nextBlocks.set(key, group);
      result.push(group.child);
      pending = [];
    };
    for (const child of children) {
      // Generated footnotes must stay outside the growing body groups. A new
      // paragraph can cross a group boundary without remounting their queue.
      if (React.isValidElement(child) && child.key === "stream-footnotes") {
        flush();
        result.push(child);
      } else {
        pending.push(child);
        if (pending.length === 32) flush();
      }
    }
    flush();
    return result;
  };
  const preserveBlock = (child: ReactNode, path = ""): ReactNode => {
    const keyed = stableKey(child);
    if (!React.isValidElement<ReactMarkdownExtraProps>(keyed) || !keyed.props.node) return keyed;
    const key = path + String(keyed.key);
    const previous = previousBlocks.get(key);
    const offset = keyed.props.node.position?.start.offset;
    const parsed = offset === undefined ? undefined : parsedByOffset.get(offset);
    if (["ul", "ol", "li", "table", "thead", "tbody", "tr"].includes(keyed.props.node.tagName)) {
      // A growing list/table is one top-level block. Retain completed rows as
      // well, so appending its last cell does not render every earlier row.
      const parent = keyed as React.ReactElement<
        ReactMarkdownExtraProps & { children?: ReactNode }
      >;
      const children = React.Children.toArray(parent.props.children).map((nested) =>
        preserveBlock(nested, `${key}/`),
      );
      const grouped = groupChildren(children, key);
      // Compare each subtree once. Serializing whole lists at every nesting
      // level repeats the same history and discards descendant caches on reuse.
      const signature = JSON.stringify({ ...keyed.props.node, children: undefined });
      const retained =
        previous?.signature === signature &&
        previous.children?.length === children.length &&
        children.every((child, index) => child === previous.children![index])
          ? previous.child
          : React.cloneElement(parent, { children: grouped });
      nextBlocks.set(key, { signature, child: retained, children, parsed });
      return retained;
    }
    const signature = JSON.stringify(keyed.props.node);
    const retained = previous?.signature === signature ? previous.child : keyed;
    nextBlocks.set(key, { signature, child: retained, parsed });
    return retained;
  };
  const retainedChildren = (Array.isArray(children) ? children : [children]).flatMap((child) => {
    if (React.isValidElement<ReactMarkdownExtraProps>(child) && child.props.node) {
      const run = retainedRuns.get(child.props.node);
      if (run)
        return run.map((item) => {
          if (typeof item === "string") return item;
          const { key, entry } = item;
          const retained =
            React.isValidElement<ReactMarkdownExtraProps>(entry.child) && entry.child.key !== key
              ? React.cloneElement(entry.child, { key })
              : entry.child;
          const offset = React.isValidElement<ReactMarkdownExtraProps>(retained)
            ? retained.props.node?.position?.start.offset
            : undefined;
          const parsed = offset === undefined ? undefined : parsedByOffset.get(offset);
          nextBlocks.set(key, { ...entry, child: retained, parsed });
          return retained;
        });
      const key = rootKeys.get(child.props.node);
      if (key !== undefined && child.key !== key) child = React.cloneElement(child, { key });
    }
    return [preserveBlock(child)];
  });
  // Equal blocks keep their children, and unchanged groups let reconciliation
  // skip whole stretches of history. Fragments add no DOM wrappers. References
  // still update changed blocks; context subscriptions retain live controls.
  return {
    blocks: nextBlocks,
    children: groupChildren(retainedChildren, "root"),
  };
}

interface FootnotePlaybackBoundary {
  start: number;
  end: number;
  ids: string[];
}

type MarkdownBodyPlayback = Parameters<typeof useSmoothText>[1] & {
  ref: React.RefObject<HTMLElement | null>;
  coordinate: boolean;
  live: boolean;
};

/** Only proven independent parser blocks bypass conversion. Everything else
 * resolves and sanitizes as one document before reusing unchanged JSX. */
function renderRetainedMarkdown(
  props: ReactMarkdownOptions,
  previousBlocks: ReadonlyMap<string, MarkdownBlockCacheEntry>,
  completedThrough = Infinity,
  historyThrough = -1,
  markBlocks = false,
) {
  const retainedRuns = new WeakMap<HastElement, MarkdownRetainedRun>();
  const rootKeys = new WeakMap<HastElement, string>();
  const parsedByOffset = new Map<number, MarkdownRootContent>();
  const retainedByOffset = new Map<number, MarkdownBlockCacheEntry>();
  const previousByOffset = new Map<number, MarkdownBlockCacheEntry>();
  for (const [key, entry] of previousBlocks) {
    if (key.includes("/") || !React.isValidElement<ReactMarkdownExtraProps>(entry.child)) continue;
    const offset = entry.child.props.node?.position?.start.offset;
    if (offset !== undefined) previousByOffset.set(offset, entry);
  }
  const retainParsedBlock = (node: MarkdownRootContent): MarkdownRootContent | undefined => {
    const offset = node.position?.start.offset;
    if (offset === undefined) return;
    parsedByOffset.set(offset, node);
    const previous = previousByOffset.get(offset);
    if (previous?.parsed !== node) return;
    const previousNode = React.isValidElement<ReactMarkdownExtraProps>(previous.child)
      ? previous.child.props.node
      : undefined;
    const crossesDefinition = (entry: MarkdownRootContent): boolean =>
      entry.type === "footnoteDefinition" ||
      ("children" in entry && entry.children.some(crossesDefinition));
    // A clipped container must be rebuilt when its next segment is admitted.
    if (
      (previousNode?.data as { streamingBodyClipped?: boolean } | undefined)
        ?.streamingBodyClipped ||
      (Number.isFinite(completedThrough) && (node.type === "html" || crossesDefinition(node)))
    )
      return;
    retainedByOffset.set(offset, previous);
    // Empty paragraphs survive the normal conversion/sanitizer without visiting
    // history. Restore the original sanitized tag before JSX keys are assigned.
    return {
      type: "paragraph",
      children: [],
      ...(node.position
        ? { position: { start: { ...node.position.start }, end: { ...node.position.end } } }
        : {}),
    };
  };
  let boundary: FootnotePlaybackBoundary | null = null;
  const limitBody: Plugin<[], HastRoot> = () => (tree) => {
    if (!Number.isFinite(completedThrough)) return;
    const definitions = tree.children
      .flatMap((section) =>
        section.type === "element" && section.properties.dataFootnotes !== undefined
          ? section.children.flatMap((list) =>
              list.type === "element" && list.tagName === "ol"
                ? list.children.filter(
                    (item): item is HastElement =>
                      item.type === "element" &&
                      item.tagName === "li" &&
                      item.position?.start.offset !== undefined,
                  )
                : [],
            )
          : [],
      )
      .toSorted((a, b) => a.position!.start.offset! - b.position!.start.offset!);
    const source = props.children ?? "";
    for (const item of definitions) {
      const start = item.position!.start.offset!;
      const end = item.position!.end.offset ?? source.length;
      if (end <= completedThrough) continue;
      if (boundary && /\S/u.test(source.slice(boundary.end, start))) break;
      if (!boundary) boundary = { start, end, ids: [] };
      boundary.end = end;
      boundary.ids.push(String(item.properties.id));
    }
    if (boundary) {
      const cutoff = boundary.start;
      const clip = <T extends HastRoot["children"][number]>(node: T): T | null => {
        if (node.type === "element" && node.properties.dataFootnotes !== undefined) return node;
        if ((node.position?.start.offset ?? 0) >= cutoff) return null;
        if (node.type !== "element") return node;
        const children = node.children.flatMap((child) => {
          const retained = clip(child);
          return retained ? [retained] : [];
        });
        const data: NonNullable<HastElement["data"]> & { streamingBodyClipped: boolean } = {
          ...node.data,
          streamingBodyClipped: true,
        };
        return children.length === node.children.length &&
          children.every((child, index) => child === node.children[index])
          ? node
          : ({ ...node, data, children } as T);
      };
      tree.children = tree.children.flatMap((node) => {
        const retained = clip(node);
        return retained ? [retained] : [];
      });
    }
  };
  const markLayoutBlocks: Plugin<[], HastRoot> = () => (tree) => {
    if (!markBlocks) return;
    const visit = (node: HastRoot | HastElement) => {
      if (
        node.type === "element" &&
        /^(?:p|li|h[1-6]|dt|dd)$/u.test(node.tagName) &&
        node.position?.start.offset !== undefined
      )
        node.properties.dataSmoothBlockStart = node.position.start.offset;
      for (const child of node.children) if (child.type === "element") visit(child);
    };
    visit(tree);
  };
  const reuseHistory: Plugin<[], HastRoot> = () => (tree) => {
    const children: HastRoot["children"] = [];
    const counts = new Map<string, number>();
    let run: MarkdownRetainedRun | undefined;
    for (const node of tree.children) {
      if (node.type !== "element") {
        if (run && node.type === "text") run.push(node.value);
        else {
          run = undefined;
          children.push(node);
        }
        continue;
      }
      const offset = node.position?.start.offset;
      const previous =
        offset === undefined || node.properties.dataFootnotes !== undefined
          ? undefined
          : previousByOffset.get(offset);
      const retained = offset === undefined ? undefined : retainedByOffset.get(offset);
      const reused =
        previous && (retained || previous.signature === JSON.stringify(node))
          ? previous
          : undefined;
      const original =
        reused && retained && React.isValidElement<ReactMarkdownExtraProps>(retained.child)
          ? (retained.child.props.node ?? node)
          : node;
      // The JSX runtime counts siblings per tag. Preserve the uncompressed
      // root keys; only this temporary pipeline tree has fewer siblings.
      const count = counts.get(original.tagName) ?? 0;
      const key = `${original.tagName}-${count}`;
      counts.set(original.tagName, count + 1);
      if (reused) {
        if (!run) {
          // One empty element represents a whole proven run through post/JSX.
          // Restore every original child and text separator before grouping so
          // no Fragment owner, key scope or DOM node moves with the run boundary.
          const stub = { ...original, children: [] };
          run = [];
          retainedRuns.set(stub, run);
          children.push(stub);
        }
        run.push({ key, entry: reused });
      } else {
        run = undefined;
        rootKeys.set(node, key);
        children.push(node);
      }
    }
    tree.children = children;
  };
  const markHistory: Plugin<[], HastRoot> = () => (tree) => {
    if (historyThrough <= 0) return;
    const visit = (node: HastRoot | HastElement) => {
      if (
        node.type === "element" &&
        ["pre", "img", "video", "audio", "iframe", "canvas"].includes(node.tagName) &&
        (node.position?.end.offset ?? Infinity) <= historyThrough
      )
        node.properties.dataSmoothHistory = "";
      for (const child of node.children) if (child.type === "element") visit(child);
    };
    visit(tree);
  };
  const markdown = ReactMarkdown({
    ...props,
    remarkPlugins: [
      ...(props.remarkPlugins ?? []),
      [remarkRetainIncrementalMarkdown, retainParsedBlock],
    ],
    rehypePlugins: [
      ...(props.rehypePlugins ?? []),
      rehypeStreamingFootnoteAdmission,
      limitBody,
      markHistory,
      markLayoutBlocks,
      reuseHistory,
    ],
  });
  const retained = React.isValidElement<{ children?: ReactNode }>(markdown)
    ? retainMarkdownChildren(
        markdown.props.children,
        previousBlocks,
        retainedRuns,
        rootKeys,
        parsedByOffset,
      )
    : null;
  const result = { markdown, retained, boundary: boundary as FootnotePlaybackBoundary | null };
  return result;
}

type MarkdownLayoutState = ReturnType<typeof useChatMarkdownState>["componentState"];
function markdownAnchorFileMeta(
  href: string | undefined,
  state: Pick<MarkdownLayoutState, "cwd" | "imageBaseDir" | "markdownFileLinkMetaByHref">,
) {
  const key = href ? normalizeMarkdownLinkHrefKey(href) : "";
  return key
    ? (state.markdownFileLinkMetaByHref.get(key) ??
        resolveMarkdownFileLinkMeta(key, state.cwd, state.imageBaseDir ?? state.cwd))
    : null;
}
function markdownInlineCodeFileMeta(
  text: string,
  state: Pick<MarkdownLayoutState, "cwd" | "imageBaseDir" | "inlineCodeFileLinkMetaByText">,
) {
  return (
    state.inlineCodeFileLinkMetaByText.get(text.trim()) ??
    resolveInlineCodeFileLinkMeta(text, state.cwd, state.imageBaseDir ?? state.cwd)
  );
}

function markdownFileChipLayout(
  state: MarkdownLayoutState,
  meta: MarkdownFileLinkMeta,
  copy: string,
  media?: string,
) {
  const description = state.fileLinkChip(meta, copy, media);
  if (!React.isValidElement<MarkdownFileLinkProps>(description)) return null;
  const props = description.props;
  const interactive = hasMarkdownFilePrimaryAction({
    canOpenInEditor:
      props.onOpen !== undefined || (props.threadRef !== undefined && Boolean(props.panelPath)),
    canOpenInBrowser: props.onOpenInBrowser !== undefined,
    canOpenInPanel: props.threadRef !== undefined && Boolean(props.panelPath),
    canOpenMedia: props.onOpenMedia !== undefined,
  });
  return {
    tag: interactive ? "a" : "button",
    label: props.label,
    className: cn(
      contextChipVariants({ kind: "mention" }),
      MARKDOWN_FILE_LINK_CLASS_NAME,
      !interactive && "select-text",
    ),
  };
}

type MarkdownLayoutSkills = NonNullable<ChatMarkdownProps["skills"]>;

// Retained JSX can keep its identity while a chip's context changes. Compare
// pure presentation decisions before deciding which historical blocks to stage.
function markdownLayoutIdentity(
  node: HastElement,
  state: MarkdownLayoutState,
  skills: MarkdownLayoutSkills,
) {
  const identity: unknown[] = [];
  const visit = (element: HastElement, skillText: boolean) => {
    if (element.tagName === "a") {
      const href =
        typeof element.properties.href === "string" ? element.properties.href : undefined;
      if (href && parseComposerContextHref(href))
        identity.push(element.position?.start.offset, state.renderContextReference);
      const meta = markdownAnchorFileMeta(href, state);
      if (meta)
        identity.push(
          element.position?.start.offset,
          JSON.stringify(markdownFileChipLayout(state, meta, "", href)),
        );
      return;
    }
    if (element.tagName === "code") {
      const text = hastPlainTextDeep(element);
      const meta = markdownInlineCodeFileMeta(text, state);
      if (meta)
        identity.push(
          element.position?.start.offset,
          JSON.stringify(markdownFileChipLayout(state, meta, "", text)),
        );
      return;
    }
    if (/^(?:img|video|audio|iframe|canvas|picture|source|object|embed)$/u.test(element.tagName)) {
      identity.push(state.expandMedia, state.githubMedia, state.renderContextReference);
      return;
    }
    for (const child of element.children) {
      if (child.type === "element") visit(child, skillText);
      else if (child.type === "text" && skillText)
        for (const match of skillInlineMatches(child.value, skills))
          identity.push(
            child.position?.start.offset,
            match.start,
            match.end,
            match.rawText,
            match.label,
          );
    }
  };
  visit(node, node.tagName === "p" || node.tagName === "li");
  return identity;
}

function unsupportedMarkdownLayout(node: HastElement, state: MarkdownLayoutState): boolean {
  if (/^(?:img|video|audio|iframe|canvas|picture|source|object|embed)$/u.test(node.tagName))
    return true;
  if (
    node.tagName === "a" &&
    state.renderContextReference &&
    typeof node.properties.href === "string" &&
    parseComposerContextHref(node.properties.href)
  )
    return true;
  return node.children.some(
    (child) => child.type === "element" && unsupportedMarkdownLayout(child, state),
  );
}

/** The sanitized inline tree is only a descriptor. Replace layout-sensitive
 * links/code with the live renderer's decisions, never its behavior/effects. */
function inertMarkdownBlock(
  node: HastElement,
  state: MarkdownLayoutState,
  skills: MarkdownLayoutSkills,
  document: Document,
) {
  const template = document.createElement("template");
  template.innerHTML = toHtml(node);
  const block = template.content.firstElementChild as HTMLElement;
  const inlineChip = (
    labelText: string,
    kind: "skill" | "citation" | "mention",
    tag = "span",
    labelClass?: string,
  ) => {
    const chip = document.createElement(tag);
    chip.className = cn(contextChipVariants({ kind }));
    chip.dataset.slot = "context-chip";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = cn(CONTEXT_CHIP_LABEL_CLASS_NAME, labelClass);
    label.dataset.slot = "context-chip-label";
    label.textContent = labelText;
    chip.append(icon, label);
    return chip;
  };
  const fileChip = (meta: MarkdownFileLinkMeta, copy: string, media?: string) => {
    const layout = markdownFileChipLayout(state, meta, copy, media);
    if (!layout) return null;
    const chip = inlineChip(layout.label, "mention", layout.tag);
    chip.className = layout.className;
    chip.dataset.smoothAtomic = "";
    chip.dataset.markdownCopy = copy;
    chip.querySelector("svg")!.setAttribute("class", "size-4 shrink-0");
    return chip;
  };
  // Match the live p/li recursion: links and code never tokenize skills.
  if (node.tagName === "p" || node.tagName === "li") {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (text) =>
        text.parentElement?.closest("a, code")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      const matches = skillInlineMatches(text.data, skills);
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of matches) {
        fragment.append(text.data.slice(cursor, match.start));
        const chip = inlineChip(match.label, "skill");
        chip.dataset.markdownCopy = match.rawText;
        const icon = document.createElement("span");
        icon.className = "contents";
        icon.setAttribute("aria-hidden", "true");
        icon.append(chip.firstChild!);
        chip.prepend(icon);
        fragment.append(chip);
        cursor = match.end;
      }
      fragment.append(text.data.slice(cursor));
      text.replaceWith(fragment);
    }
  }
  for (const link of block.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = link.getAttribute("href") ?? undefined;
    const citation = href ? parseAssistantCitationHref(href) : null;
    if (citation) {
      const atomic = document.createElement("span");
      atomic.dataset.smoothAtomic = "";
      const chip = inlineChip(assistantCitationLabel(citation), "citation", "button");
      chip.dataset.slot = "popover-trigger";
      atomic.append(chip);
      link.replaceWith(atomic);
      continue;
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const fallback = document.createElement("span");
      fallback.textContent = link.textContent || contextReference.contextId;
      link.replaceWith(fallback);
      continue;
    }
    const meta = markdownAnchorFileMeta(href, state);
    if (meta) {
      const chip = fileChip(meta, `[${meta.basename}](${href})`, href);
      if (chip) link.replaceWith(chip);
      continue;
    }
    const host = resolveExternalWebLinkHost(href);
    const autolink = link.dataset.pullRequestAutolink;
    if (autolink) {
      link.dataset.smoothAtomic = "";
      if (autolink === "commit") link.classList.add("font-mono");
      continue;
    }
    if ((host || href === "") && link.textContent) {
      const children = [...link.childNodes];
      const first = children[0];
      if (!first) continue;
      const plain = children.every((child) => child.nodeType === Node.TEXT_NODE);
      // Rich live link children arrive through MarkdownLinkContext as one
      // child: its whole contents share the icon's nowrap surface.
      const text = plain ? link.textContent : null;
      const atomic = document.createElement("span");
      atomic.dataset.smoothAtomic = "";
      atomic.className = "whitespace-nowrap";
      const icon = document.createElement("span");
      icon.className = MARKDOWN_LINK_FAVICON_BOX_CLASS_NAME;
      icon.setAttribute("aria-hidden", "true");
      atomic.append(icon);
      const suffix = document.createElement("span");
      suffix.className = "[overflow-wrap:anywhere]";
      if (text !== null) {
        const leading = leadingExternalLinkTextLength(text);
        atomic.append(text.slice(0, leading));
        suffix.textContent = text.slice(leading);
        link.replaceChildren(atomic, suffix, ...(plain ? [] : children.slice(1)));
      } else {
        atomic.append(...children);
        link.replaceChildren(atomic);
      }
    }
  }
  for (const code of block.querySelectorAll<HTMLElement>("code[data-inline-code]")) {
    const text = code.textContent ?? "";
    const meta = markdownInlineCodeFileMeta(text, state);
    if (meta) {
      const chip = fileChip(meta, `\`${text}\``, inlineCodeFilePathCandidate(text) ?? text.trim());
      if (chip) code.replaceWith(chip);
    }
  }
  // Template contents never initiate loads. Strip resource/navigation inputs
  // before attaching any part of this inert, short-lived block for layout.
  for (const element of [block, ...block.querySelectorAll("*")]) {
    element.removeAttribute("id");
    for (const attribute of element.getAttributeNames())
      if (
        /^(?:on|src|poster|autoplay)/iu.test(attribute) ||
        (attribute === "href" && element.tagName !== "A")
      )
        element.removeAttribute(attribute);
  }
  return block;
}

function reserveMarkdownCandidate(
  root: HTMLElement,
  previous: ReturnType<typeof renderRetainedMarkdown>,
  next: ReturnType<typeof renderRetainedMarkdown>,
  state: MarkdownLayoutState,
  previousState: MarkdownLayoutState,
  skills: MarkdownLayoutSkills,
  previousSkills: MarkdownLayoutSkills,
  visible: readonly SmoothTextVisibleNode[],
) {
  let bottom = 0;
  const shown = visible.filter((entry) => entry.end > 0);
  const lastVisible = shown.at(-1)?.node;
  if (!lastVisible) return bottom;
  const oldBlocks = [...root.querySelectorAll<HTMLElement>("[data-smooth-block-start]")];
  const byOffset = new Map(
    oldBlocks.map((block) => [Number(block.dataset.smoothBlockStart), block]),
  );
  const visibleByBlock = new Map<HTMLElement, SmoothTextVisibleNode[]>();
  for (const entry of shown) {
    const block = entry.node.parentElement?.closest<HTMLElement>("[data-smooth-block-start]");
    if (!block) continue;
    const entries = visibleByBlock.get(block);
    if (entries) entries.push(entry);
    else visibleByBlock.set(block, [entry]);
  }
  const changed = new Map<HTMLElement, HastElement>();
  const contextChanged = state !== previousState || skills !== previousSkills;
  for (const [key, entry] of next.retained?.blocks ?? []) {
    const previousChild = previous.retained?.blocks.get(key)?.child;
    const sameChild = previousChild === entry.child;
    if (sameChild && !contextChanged) continue;
    if (!React.isValidElement<ReactMarkdownExtraProps>(entry.child)) continue;
    const node = entry.child.props.node;
    if (!node || !/^(?:p|li|h[1-6]|dt|dd)$/u.test(node.tagName)) continue;
    // A nested list/container is handled by its changed leaf inline blocks.
    if (
      node.children.some(
        (child) => child.type === "element" && /^(?:p|ul|ol|li|pre|table)$/u.test(child.tagName),
      )
    )
      continue;
    const offset = node.position?.start.offset;
    if (offset === undefined) continue;
    const old = byOffset.get(offset);
    if (
      !old ||
      (!old.contains(lastVisible) &&
        (old.compareDocumentPosition(lastVisible) & Node.DOCUMENT_POSITION_FOLLOWING) === 0)
    )
      continue;
    if (sameChild) {
      const before = markdownLayoutIdentity(node, previousState, previousSkills);
      const after = markdownLayoutIdentity(node, state, skills);
      if (before.length === after.length && before.every((value, index) => value === after[index]))
        continue;
    }
    const oldNode = React.isValidElement<ReactMarkdownExtraProps>(previousChild)
      ? previousChild.props.node
      : undefined;
    // No guessed placeholder geometry for resource wrappers or injected React.
    // Delegate the whole update before staging anything, preserving their
    // existing live commit/load/effect/ResizeObserver lifecycle.
    if (
      unsupportedMarkdownLayout(node, state) ||
      (oldNode && unsupportedMarkdownLayout(oldNode, previousState))
    )
      return null;
    changed.set(old, node);
  }
  const changedEntries: Array<{
    old: HTMLElement;
    node: HastElement;
    visible: readonly SmoothTextVisibleNode[];
  }> = [];
  // DOM order and per-block visibility are indexed once, not rediscovered for
  // every changed block or visible Text node.
  for (const old of oldBlocks) {
    const node = changed.get(old);
    if (node) changedEntries.push({ old, node, visible: visibleByBlock.get(old) ?? [] });
  }
  const measured = measureSmoothTextBlocks(
    root,
    changedEntries.map(({ old, node, visible }) => ({
      oldBlock: old,
      candidate: inertMarkdownBlock(node, state, skills, root.ownerDocument),
      visible,
    })),
  );
  const changes: { old: HTMLElement; bottom: number; delta: number }[] = changedEntries.map(
    ({ old }, index) => ({ old, ...measured[index]! }),
  );
  let shift = 0;
  for (const change of changes) {
    if (change.bottom > 0) bottom = Math.max(bottom, change.bottom + shift);
    shift += change.delta;
  }
  // Unchanged visible suffixes move by the changed blocks' natural delta.
  // Measure only the last visible node of each unchanged region, without
  // cloning or reading layout throughout the historical document.
  const tails = new Map<number, { node: Text; end: number; shift: number }>();
  let region = 0;
  shift = 0;
  for (const entry of shown) {
    let change = changes[region];
    while (
      change &&
      !change.old.contains(entry.node) &&
      (change.old.compareDocumentPosition(entry.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    ) {
      shift += change.delta;
      change = changes[++region];
    }
    if (change?.old.contains(entry.node)) continue;
    if (region > 0 && shift > 0) tails.set(region, { ...entry, shift });
  }
  const range = root.ownerDocument.createRange();
  const top = root.getBoundingClientRect().top;
  for (const tail of tails.values()) {
    range.setStart(tail.node, 0);
    range.setEnd(tail.node, tail.end);
    for (const rect of range.getClientRects())
      if (rect.height > 0) bottom = Math.max(bottom, rect.bottom - top + tail.shift);
  }
  return bottom;
}

// The refs are optional caches of the last committed pipeline, not UI state.
// oxlint-disable react/refs
interface MarkdownSnapshot {
  rendered: ReturnType<typeof renderRetainedMarkdown>;
  source: string;
  parseInputs: readonly unknown[];
  historyThrough: number;
  configuration: Pick<
    ReactMarkdownOptions,
    "remarkPlugins" | "rehypePlugins" | "components" | "urlTransform" | "skipHtml"
  >;
  rendererState: React.ContextType<typeof ChatMarkdownRendererContext>;
  skills: MarkdownLayoutSkills;
  smoothContext: React.ContextType<typeof SmoothMarkdownContext>;
  bodyPlayback: MarkdownBodyPlayback;
  bodyProps: React.ComponentProps<"div">;
  coordinated: boolean;
}

function sameMarkdownRecord(left: object, right: object) {
  const previous = left as Record<string, unknown>;
  const current = right as Record<string, unknown>;
  const keys = Object.keys(previous);
  return (
    keys.length === Object.keys(current).length &&
    keys.every((key) => Object.is(previous[key], current[key]))
  );
}

function sameMarkdownResume(
  previous: SmoothTextResumeInput | undefined,
  current: SmoothTextResumeInput | undefined,
) {
  return (
    previous === current ||
    (previous !== undefined &&
      current !== undefined &&
      previous.key === current.key &&
      previous.generation === current.generation &&
      previous.baselineText === current.baselineText &&
      previous.mountText === current.mountText &&
      previous.synchronized === current.synchronized &&
      previous.forceShow === current.forceShow)
  );
}

function sameMarkdownPlayback(previous: MarkdownBodyPlayback, current: MarkdownBodyPlayback) {
  const { resume: previousResume, ...previousOptions } = previous;
  const { resume: currentResume, ...currentOptions } = current;
  return (
    sameMarkdownRecord(previousOptions, currentOptions) &&
    sameMarkdownResume(previousResume, currentResume)
  );
}

function sameMarkdownSmoothContext(
  previous: MarkdownSnapshot["smoothContext"],
  current: MarkdownSnapshot["smoothContext"],
) {
  const { playbackResume: previousResume, ...previousOptions } = previous;
  const { playbackResume: currentResume, ...currentOptions } = current;
  return (
    sameMarkdownRecord(previousOptions, currentOptions) &&
    sameMarkdownResume(previousResume, currentResume)
  );
}

function sameMarkdownSkills(previous: MarkdownLayoutSkills, current: MarkdownLayoutSkills) {
  return (
    previous.length === current.length &&
    previous.every(
      (skill, index) =>
        skill.name === current[index]?.name && skill.displayName === current[index]?.displayName,
    )
  );
}

function sameMarkdownSnapshot(previous: MarkdownSnapshot, current: MarkdownSnapshot) {
  return (
    previous === current ||
    (previous.rendered === current.rendered &&
      previous.source === current.source &&
      previous.historyThrough === current.historyThrough &&
      previous.coordinated === current.coordinated &&
      previous.parseInputs.length === current.parseInputs.length &&
      previous.parseInputs.every((input, index) => Object.is(input, current.parseInputs[index])) &&
      sameMarkdownRecord(previous.configuration, current.configuration) &&
      sameMarkdownRecord(previous.rendererState, current.rendererState) &&
      sameMarkdownSkills(previous.skills, current.skills) &&
      sameMarkdownSmoothContext(previous.smoothContext, current.smoothContext) &&
      sameMarkdownPlayback(previous.bodyPlayback, current.bodyPlayback) &&
      sameMarkdownRecord(previous.bodyProps, current.bodyProps))
  );
}

const MemoizedReactMarkdown = memo(function StableFootnoteMarkdown({
  inlineBufferPlugin,
  holdFootnoteAdmission,
  bodyPlayback,
  bodyProps,
  bodyOverlay,
  ...props
}: ReactMarkdownOptions & {
  inlineBufferPlugin: Plugin<[], MarkdownRoot> | undefined;
  holdFootnoteAdmission: boolean;
  bodyPlayback: MarkdownBodyPlayback;
  bodyProps: React.ComponentProps<"div">;
  bodyOverlay: ReactNode;
}) {
  const source = props.children ?? "";
  const resume = bodyPlayback.resume;
  const inFlight = useRef<{ snapshot: MarkdownSnapshot; request: SmoothTextCandidate } | null>(
    null,
  );
  let pendingCandidate = inFlight.current;
  const pendingResume = pendingCandidate?.snapshot.bodyPlayback.resume;
  if (
    !bodyPlayback.enabled ||
    resume?.forceShow ||
    pendingResume?.key !== resume?.key ||
    pendingResume?.generation !== resume?.generation ||
    pendingResume?.baselineText !== resume?.baselineText ||
    pendingResume?.forceShow !== resume?.forceShow ||
    pendingResume?.synchronized !== resume?.synchronized ||
    (pendingCandidate && !source.startsWith(pendingCandidate.snapshot.source))
  )
    pendingCandidate = null;
  const historyText = resume?.forceShow
    ? source
    : resume
      ? [resume.baselineText, resume.mountText ?? source]
          .filter((text) => source.startsWith(text))
          .reduce((longest, text) => (text.length > longest.length ? text : longest), "")
      : "";
  const historyThrough = resume ? historyText.length : -1;
  const [progress, setProgress] = useState({
    prefix: "",
    through: -1,
    reached: -1,
    live: bodyPlayback.live,
    manual: false,
  });
  if (!source.startsWith(progress.prefix))
    setProgress({
      prefix: "",
      through: -1,
      reached: -1,
      live: bodyPlayback.live,
      manual: false,
    });
  else if (bodyPlayback.live && !progress.live) setProgress({ ...progress, live: true });
  else if (progress.live && !bodyPlayback.coordinate && !progress.manual)
    setProgress({ ...progress, manual: true });
  const coordinated = bodyPlayback.coordinate && progress.live && !progress.manual;
  const blocks = useRef(new Map<string, MarkdownBlockCacheEntry>());
  const configuration = useRef(props);
  const previousHistoryThrough = useRef(historyThrough);
  const previousMarkBlocks = useRef(bodyPlayback.enabled);
  const rendererState = use(ChatMarkdownRendererContext);
  const skills = use(ChatMarkdownSkillsContext);
  const smoothContext = use(SmoothMarkdownContext);
  const parsedCandidate = useRef<{
    inputs: readonly unknown[];
    blocks: Map<string, MarkdownBlockCacheEntry> | null;
    rendered: ReturnType<typeof renderRetainedMarkdown>;
  } | null>(null);
  const parseInputs = [
    source,
    props.remarkPlugins,
    props.rehypePlugins,
    props.components,
    props.urlTransform,
    props.skipHtml,
    inlineBufferPlugin,
    holdFootnoteAdmission,
    coordinated,
    progress.through,
    historyThrough,
    bodyPlayback.enabled,
  ];
  const pendingSnapshot = pendingCandidate?.snapshot;
  if (
    pendingSnapshot &&
    (!bodyPlayback.streaming || bodyPlayback.complete) &&
    (pendingSnapshot.source !== source ||
      pendingSnapshot.parseInputs.length !== parseInputs.length ||
      pendingSnapshot.parseInputs.some((input, index) => input !== parseInputs[index]) ||
      !sameMarkdownRecord(pendingSnapshot.rendererState, rendererState) ||
      !sameMarkdownSkills(pendingSnapshot.skills, skills) ||
      !sameMarkdownSmoothContext(pendingSnapshot.smoothContext, smoothContext) ||
      !sameMarkdownPlayback(pendingSnapshot.bodyPlayback, bodyPlayback) ||
      !sameMarkdownRecord(pendingSnapshot.bodyProps, bodyProps))
  ) {
    // Prepare EOF against the committed tree. A suspended render must leave
    // the current observer's request valid until this replacement commits.
    pendingCandidate = null;
  }
  const currentPendingSnapshot = pendingCandidate?.snapshot;
  // Finalizing buffered syntax invalidates that transform, not independent
  // completed blocks. Playback-only commits reuse the full parse as well.
  const renderedCandidate = (() => {
    // A reserved candidate is immutable until its layout commit. Coalesce
    // later buffered arrivals before running the expensive Markdown pipeline.
    if (currentPendingSnapshot) return currentPendingSnapshot.rendered;
    if (
      parsedCandidate.current &&
      (parsedCandidate.current.blocks === null ||
        parsedCandidate.current.blocks === blocks.current ||
        parsedCandidate.current.rendered.retained?.blocks === blocks.current) &&
      parsedCandidate.current.inputs.every((input, index) => input === parseInputs[index])
    )
      return parsedCandidate.current.rendered;
    const previous = configuration.current;
    const samePipeline =
      previousMarkBlocks.current === bodyPlayback.enabled &&
      previousHistoryThrough.current === historyThrough &&
      previous.remarkPlugins === props.remarkPlugins &&
      previous.rehypePlugins === props.rehypePlugins &&
      previous.components === props.components &&
      previous.urlTransform === props.urlTransform &&
      previous.skipHtml === props.skipHtml;
    const rendered = renderRetainedMarkdown(
      {
        children: source,
        components: props.components,
        urlTransform: props.urlTransform,
        skipHtml: props.skipHtml,
        rehypePlugins: props.rehypePlugins,
        remarkPlugins: [
          ...(holdFootnoteAdmission ? [remarkStreamingFootnoteAdmission] : []),
          ...(inlineBufferPlugin ? [inlineBufferPlugin] : []),
          ...(props.remarkPlugins ?? []),
        ],
      },
      samePipeline ? blocks.current : new Map(),
      coordinated ? Math.max(progress.through, historyThrough) : Infinity,
      historyThrough,
      bodyPlayback.enabled,
    );
    // Only speculative EOF replacement can outlive the publication it was
    // prepared against. Ordinary playback keeps its existing parse reuse.
    parsedCandidate.current = {
      inputs: parseInputs,
      blocks: pendingSnapshot ? blocks.current : null,
      rendered,
    };
    return rendered;
  })();
  const nextSnapshot = (() =>
    currentPendingSnapshot ??
    ({
      rendered: renderedCandidate,
      source,
      parseInputs: [
        source,
        props.remarkPlugins,
        props.rehypePlugins,
        props.components,
        props.urlTransform,
        props.skipHtml,
        inlineBufferPlugin,
        holdFootnoteAdmission,
        coordinated,
        progress.through,
        historyThrough,
        bodyPlayback.enabled,
      ],
      historyThrough,
      configuration: {
        remarkPlugins: props.remarkPlugins,
        rehypePlugins: props.rehypePlugins,
        components: props.components,
        urlTransform: props.urlTransform,
        skipHtml: props.skipHtml,
      },
      rendererState,
      skills,
      smoothContext,
      bodyPlayback,
      bodyProps,
      coordinated,
    } satisfies MarkdownSnapshot))();
  const [committed, setCommitted] = useState(nextSnapshot);
  // 快照按内容提交；渲染时新建的对象本身不能触发下一次状态更新。
  const snapshotChanged = !sameMarkdownSnapshot(committed, nextSnapshot);
  const oldResume = committed.bodyPlayback.resume;
  const recovering =
    oldResume?.key !== resume?.key ||
    oldResume?.generation !== resume?.generation ||
    oldResume?.baselineText !== resume?.baselineText ||
    oldResume?.forceShow !== resume?.forceShow ||
    oldResume?.synchronized !== resume?.synchronized;
  const pendingForCommit = (() => {
    if (
      snapshotChanged &&
      (!bodyPlayback.enabled ||
        resume?.forceShow === true ||
        (!committed.bodyPlayback.live && !bodyPlayback.live) ||
        recovering ||
        (committed.rendered === nextSnapshot.rendered &&
          committed.rendererState.cwd === nextSnapshot.rendererState.cwd &&
          committed.rendererState.imageBaseDir === nextSnapshot.rendererState.imageBaseDir &&
          committed.rendererState.environmentId === nextSnapshot.rendererState.environmentId &&
          committed.rendererState.threadRef === nextSnapshot.rendererState.threadRef &&
          committed.rendererState.projects === nextSnapshot.rendererState.projects &&
          committed.rendererState.pullRequestsEnabled ===
            nextSnapshot.rendererState.pullRequestsEnabled &&
          committed.rendererState.resolvedTheme === nextSnapshot.rendererState.resolvedTheme &&
          committed.rendererState.linkTargetPreference ===
            nextSnapshot.rendererState.linkTargetPreference &&
          committed.rendererState.markdownFileLinkMetaByHref ===
            nextSnapshot.rendererState.markdownFileLinkMetaByHref &&
          committed.rendererState.inlineCodeFileLinkMetaByText ===
            nextSnapshot.rendererState.inlineCodeFileLinkMetaByText &&
          committed.skills === nextSnapshot.skills) ||
        !source.startsWith(committed.source))
    ) {
      setCommitted(nextSnapshot);
      return null;
    } else if (snapshotChanged && !pendingCandidate) {
      const pending = {
        snapshot: nextSnapshot,
        request: {
          measure(visible: readonly SmoothTextVisibleNode[]) {
            const root = bodyPlayback.ref.current;
            return root
              ? reserveMarkdownCandidate(
                  root,
                  committed.rendered,
                  nextSnapshot.rendered,
                  nextSnapshot.rendererState,
                  committed.rendererState,
                  nextSnapshot.skills,
                  committed.skills,
                  visible,
                )
              : 0;
          },
          commit() {
            if (inFlight.current === pending) {
              inFlight.current = null;
              // C may prepare during B's state update, before B's layout effect.
              // Its stable blocks already belong to this approved publication.
              configuration.current = pending.snapshot.configuration;
              previousHistoryThrough.current = pending.snapshot.historyThrough;
              previousMarkBlocks.current = pending.snapshot.bodyPlayback.enabled;
              if (pending.snapshot.rendered.retained)
                blocks.current = pending.snapshot.rendered.retained.blocks;
              setCommitted(pending.snapshot);
            }
          },
        },
      };
      return pending;
    }
    return pendingCandidate;
  })();
  const { markdown, retained, boundary } = committed.rendered;
  const committedSource = committed.source;
  const bodyDone = () => {
    if (boundary && committed.coordinated)
      setProgress((previous) =>
        previous.reached === boundary.start
          ? previous
          : {
              ...previous,
              reached: boundary.start,
              prefix: committedSource.slice(0, boundary.start),
            },
      );
    // A claimed initial snapshot stays live through its notes and ends with the final body suffix.
    else if (!inFlight.current && committedSource === bodyPlayback.sourceText)
      bodyPlayback.onPlaybackComplete?.();
  };
  // Arrival sampling and EOF belong to the source clock, even while the next
  // DOM snapshot is waiting for geometry. Never wait for Thinking to finish.
  const { ref, coordinate: _coordinate, live: _live, ...playbackOptions } = bodyPlayback;
  useLayoutEffect(() => {
    // Publish ownership before useSmoothText can measure or deliver a request.
    // Abandoned work-in-progress candidates never acquire the shared callback.
    inFlight.current = pendingForCommit;
  });
  useSmoothText(ref, {
    ...playbackOptions,
    candidate: pendingForCommit?.request,
    streaming: boundary ? false : bodyPlayback.streaming,
    complete: boundary ? false : bodyPlayback.complete,
    drainOnComplete: boundary ? false : bodyPlayback.drainOnComplete,
    retainOnComplete: boundary !== null,
    sourceText: boundary ? committedSource.slice(0, boundary.start) : bodyPlayback.sourceText,
    arrivalSourceText: bodyPlayback.sourceText,
    onPlaybackComplete: bodyDone,
  });
  const handoff = committed.coordinated
    ? {
        ids: boundary?.ids ?? [],
        ready: boundary !== null && progress.reached === boundary.start,
        complete: () => {
          if (!boundary) return;
          setProgress((previous) => ({
            ...previous,
            through: boundary.end,
            prefix: committedSource.slice(0, boundary.end),
            reached: -1,
          }));
        },
        takeOver: () => setProgress((previous) => ({ ...previous, manual: true })),
      }
    : null;
  useLayoutEffect(() => {
    configuration.current = committed.configuration;
    previousHistoryThrough.current = committed.historyThrough;
    previousMarkBlocks.current = committed.bodyPlayback.enabled;
    if (retained) blocks.current = retained.blocks;
  });
  const content =
    retained && React.isValidElement<{ children?: ReactNode }>(markdown)
      ? React.cloneElement(markdown, { children: retained.children })
      : markdown;
  return (
    <div data-smooth-text-frame={bodyPlayback.enabled ? "" : undefined}>
      <div
        {...committed.bodyProps}
        ref={(node) => {
          ref.current = node;
        }}
      >
        <ChatMarkdownRendererContext value={committed.rendererState}>
          <ChatMarkdownSkillsContext value={committed.skills}>
            <ChatMarkdownSourceContext value={committedSource}>
              <SmoothMarkdownContext value={committed.smoothContext}>
                <StreamingFootnotePlaybackContext value={handoff}>
                  {content}
                </StreamingFootnotePlaybackContext>
              </SmoothMarkdownContext>
            </ChatMarkdownSourceContext>
          </ChatMarkdownSkillsContext>
        </ChatMarkdownRendererContext>
        {bodyOverlay}
      </div>
    </div>
  );
});
// oxlint-enable react/refs

function ChatMarkdown({
  text,
  smoothStreaming = false,
  smoothOutputMode = "character",
  smoothOutputLineMode = "adaptive",
  smoothMarkdownPreload = true,
  smoothTextFadeDurationMs = 200,
  smoothTextYieldDurationMs = 200,
  footnotesAutoCollapse = false,
  registerFootnoteTail,
  smoothComplete = false,
  smoothTextResume,
  claimInitialSmoothText,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  ...props
}: ChatMarkdownProps) {
  const timelineFootnoteHost = use(StreamingFootnoteHostContext);
  const [mountSnapshot, setMountSnapshot] = useState({ key: smoothTextResume?.key, text });
  if (mountSnapshot.key !== smoothTextResume?.key)
    setMountSnapshot({ key: smoothTextResume?.key, text });
  const [fallbackSnapshot, setFallbackSnapshot] = useState<{
    key: string;
    generation: number | undefined;
    baselineText: string;
    mountText: string;
    text: string;
  } | null>(null);
  const mountText =
    smoothTextResume?.mountText ??
    (mountSnapshot.key === smoothTextResume?.key ? mountSnapshot.text : text);
  let fallbackText: string | undefined;
  if (
    smoothTextResume &&
    fallbackSnapshot?.key === smoothTextResume.key &&
    fallbackSnapshot.generation === smoothTextResume.generation &&
    fallbackSnapshot.baselineText === smoothTextResume.baselineText &&
    fallbackSnapshot.mountText === mountText &&
    text.startsWith(fallbackSnapshot.text)
  ) {
    fallbackText = fallbackSnapshot.text;
  } else if (
    smoothTextResume &&
    (!text.startsWith(smoothTextResume.baselineText) ||
      (mountText.length > smoothTextResume.baselineText.length && !text.startsWith(mountText)))
  ) {
    fallbackText = text;
    // Freeze the conservative range for this rewritten version. Body
    // clipping, notes and glyph playback must agree before the first paint;
    // later independent live appends remain outside that range.
    setFallbackSnapshot({
      key: smoothTextResume.key,
      generation: smoothTextResume.generation,
      baselineText: smoothTextResume.baselineText,
      mountText,
      text,
    });
  }
  // Timeline rows can receive a fresh resume object on every streamed update.
  // Keep the Markdown playback context stable when its actual values did not
  // change, so retained blocks do not re-render just because the row wrapper
  // allocated a new object.
  const hasResume = smoothTextResume !== undefined;
  const resumeKey = smoothTextResume?.key;
  const resumeGeneration = smoothTextResume?.generation;
  const resumeSynchronized = smoothTextResume?.synchronized;
  const resumeForceShow = smoothTextResume?.forceShow;
  const resumeBaselineText = smoothTextResume?.baselineText;
  const normalizedBaselineText = hasResume ? (fallbackText ?? resumeBaselineText!) : undefined;
  const normalizedMountText = hasResume ? (fallbackText ?? mountText) : undefined;
  const playbackResume = (() => {
    if (!hasResume) return undefined;
    const resume: SmoothTextResumeInput = {
      key: resumeKey!,
      baselineText: normalizedBaselineText!,
      mountText: normalizedMountText!,
      synchronized: resumeSynchronized!,
      ...(resumeGeneration === undefined ? {} : { generation: resumeGeneration }),
      ...(resumeForceShow === undefined ? {} : { forceShow: resumeForceShow }),
    };
    return resume;
  })();
  const [claimedEndedInitialText, setClaimedEndedInitialText] = useState<{
    key: string | undefined;
  } | null>(null);
  const claimInitialText = () => {
    const claimed = claimInitialSmoothText?.() ?? false;
    // A successful first-snapshot claim keeps an already-ended message live through its handoff.
    if (claimed && (props.isStreaming !== true || smoothComplete))
      setClaimedEndedInitialText({ key: playbackResume?.key });
    return claimed;
  };
  const claimedInitialLive =
    claimedEndedInitialText !== null &&
    playbackResume !== undefined &&
    claimedEndedInitialText.key === playbackResume.key &&
    playbackResume.synchronized !== true &&
    playbackResume.forceShow !== true;
  const [previousResume, setPreviousResume] = useState(playbackResume);
  const recoveryCommit =
    playbackResume !== undefined &&
    (previousResume?.key !== playbackResume.key ||
      previousResume?.generation !== playbackResume.generation ||
      previousResume?.baselineText !== playbackResume.baselineText ||
      previousResume?.forceShow !== playbackResume.forceShow);
  if (recoveryCommit) setPreviousResume(playbackResume);
  const footnoteScope = useId();
  const [localFootnoteHost, setLocalFootnoteHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!localFootnoteHost || !registerFootnoteTail) return;
    return registerFootnoteTail(localFootnoteHost);
  }, [localFootnoteHost, registerFootnoteTail]);
  const activePlayback = (props.isStreaming === true && !smoothComplete) || claimedInitialLive;
  const smoothContext = (() => ({
    host: timelineFootnoteHost ?? localFootnoteHost,
    inlineHost: localFootnoteHost,
    detached: activePlayback,
    streaming: activePlayback,
    smooth: smoothStreaming,
    mode: smoothOutputMode,
    lineMode: smoothOutputLineMode,
    scope: footnoteScope,
    autoCollapse: footnotesAutoCollapse,
    fadeDurationMs: smoothTextFadeDurationMs,
    yieldDurationMs: smoothTextYieldDurationMs,
    playbackResume,
  }))();
  const renderedText = useStreamingMarkdownText(
    text,
    smoothStreaming &&
      props.isStreaming === true &&
      !smoothComplete &&
      !playbackResume?.forceShow &&
      !recoveryCommit,
  );
  const {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  } = useChatMarkdownState({ text: renderedText, inline, smoothComplete, ...props });
  const onPlaybackComplete = () => {
    setClaimedEndedInitialText((previous) =>
      previous?.key === playbackResume?.key ? null : previous,
    );
  };
  const bodyPlayback = (() =>
    ({
      ref: markdownRef,
      coordinate: smoothStreaming && footnotesAutoCollapse,
      live: activePlayback,
      enabled: smoothStreaming,
      mode: smoothOutputMode,
      lineMode: smoothOutputLineMode,
      streaming: props.isStreaming === true,
      complete: smoothComplete,
      onPlaybackComplete,
      claimInitialText,
      sourceText: text,
      resume: playbackResume,
      // Match the FIFO's steady buffer horizon. A full second here creates
      // thousands of queued glyphs before a fast response can begin playing.
      initialBufferMs: SMOOTH_TEXT_BUFFER_MS,
      fadeDurationMs: smoothTextFadeDurationMs,
      yieldDurationMs: smoothTextYieldDurationMs,
    }) satisfies MarkdownBodyPlayback)();
  const [incrementalParser] = useState(() => createIncrementalMarkdownPlugin());
  const holdingInline =
    smoothStreaming && smoothMarkdownPreload && props.isStreaming === true && !smoothComplete;
  const [inlineBuffer] = useState(() => createInlineBufferPlugin());
  const inlineBufferPlugin = inlineBuffer.configure(holdingInline);
  useLayoutEffect(() => {
    inlineBuffer.commit();
  });
  const incrementalParsing =
    extraRemarkPlugins.length === 0 &&
    (smoothStreaming ||
      (props.isStreaming === true && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(renderedText)));
  const remarkPlugins = (() => [
    ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
    ...(smoothStreaming ? [remarkStableTaskCheckboxes] : []),
    ...(componentState.mathEnabled
      ? [
          [remarkMath, { singleDollarTextMath: true }] as [
            typeof remarkMath,
            { singleDollarTextMath: boolean },
          ],
        ]
      : []),
    ...extraRemarkPlugins,
    ...(incrementalParsing ? [incrementalParser] : []),
  ])();
  const bodyProps = (() =>
    ({
      className: cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      ),
      "data-streaming": componentState.isStreaming && !smoothStreaming ? "" : undefined,
      "data-smooth-streaming": smoothStreaming ? "" : undefined,
      "data-markdown-footnote-scope": footnoteScope,
      onCopy: handleCopy,
    }) as React.ComponentProps<"div">)();

  if (inline) {
    return (
      <span
        ref={(node) => {
          markdownRef.current = node;
        }}
        className={cn(
          "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
          className,
        )}
        onCopy={handleCopy}
      >
        <ChatMarkdownRendererContext value={componentState}>
          <ChatMarkdownSkillsContext value={props.skills ?? EMPTY_MARKDOWN_SKILLS}>
            <ChatMarkdownSourceContext value={renderedText}>
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={
                  parseRawHtml
                    ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
                    : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS
                }
                skipHtml={false}
                components={CHAT_MARKDOWN_COMPONENTS}
                urlTransform={markdownUrlTransform}
              >
                {renderedText}
              </ReactMarkdown>
            </ChatMarkdownSourceContext>
          </ChatMarkdownSkillsContext>
        </ChatMarkdownRendererContext>
        {localMediaPreview ? (
          <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
        ) : null}
      </span>
    );
  }
  return (
    <>
      <ChatMarkdownRendererContext value={componentState}>
        <ChatMarkdownSkillsContext value={props.skills ?? EMPTY_MARKDOWN_SKILLS}>
          <ChatMarkdownSourceContext value={renderedText}>
            <SmoothMarkdownContext value={smoothContext}>
              <MemoizedReactMarkdown
                key={playbackResume?.key}
                bodyPlayback={bodyPlayback}
                bodyProps={bodyProps}
                bodyOverlay={
                  localMediaPreview ? (
                    <ExpandedImageDialog
                      preview={localMediaPreview}
                      onClose={closeLocalMediaPreview}
                    />
                  ) : null
                }
                inlineBufferPlugin={smoothStreaming ? inlineBufferPlugin : undefined}
                holdFootnoteAdmission={smoothStreaming && footnotesAutoCollapse && activePlayback}
                remarkPlugins={remarkPlugins}
                rehypePlugins={
                  parseRawHtml
                    ? smoothStreaming && extraRemarkPlugins.length === 0
                      ? SMOOTH_MARKDOWN_RENDER_REHYPE_PLUGINS
                      : CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
                    : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS
                }
                skipHtml={false}
                components={CHAT_MARKDOWN_COMPONENTS}
                urlTransform={markdownUrlTransform}
              >
                {renderedText}
              </MemoizedReactMarkdown>
            </SmoothMarkdownContext>
          </ChatMarkdownSourceContext>
        </ChatMarkdownSkillsContext>
      </ChatMarkdownRendererContext>
      <div ref={setLocalFootnoteHost} data-stream-footnote-local-host="" />
    </>
  );
}

export default memo(ChatMarkdown);
