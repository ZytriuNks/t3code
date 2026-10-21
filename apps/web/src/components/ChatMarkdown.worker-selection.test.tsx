// @vitest-environment jsdom
import { getSharedHighlighter } from "@pierre/diffs";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CodeHighlightResult } from "../lib/asyncCodeHighlighting";

const workerState = vi.hoisted(() => ({
  callback: null as ((result: CodeHighlightResult) => void) | null,
  code: "",
  closed: false,
}));

vi.mock("../lib/asyncCodeHighlighting", () => ({
  getCodeHighlightCoordinator: () => ({
    open: (_language: string, _theme: string, callback: (result: CodeHighlightResult) => void) => {
      workerState.callback = callback;
      workerState.closed = false;
      return {
        update: (code: string) => {
          workerState.code = code;
        },
        close: () => {
          workerState.closed = true;
        },
      };
    },
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  shouldOpenPullRequestLinkInBrowser: () => false,
  useOpenChangeRequestLink: () => vi.fn(),
}));
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});

import ChatMarkdown from "./ChatMarkdown";

let root: Root;
let page: HTMLDivElement;
async function mount(suffix: string) {
  const source = `Before code.\n\n\`\`\`javascript\nconst selectedValue${suffix} = 42;\n\`\`\`\n\nAfter code.`;
  await act(async () => root.render(<ChatMarkdown cwd={undefined} text={source} />));
  const code = page.querySelector<HTMLElement>(".chat-markdown-shiki code");
  expect(code).not.toBeNull();
  expect(workerState.code).toBe(code!.textContent);
  return code!;
}

async function deliver(error?: string) {
  const callback = workerState.callback;
  expect(callback).not.toBeNull();
  const highlighter = await getSharedHighlighter({
    langs: ["javascript"],
    themes: ["pierre-dark"],
    preferredHighlighter: "shiki-wasm",
  });
  await act(async () =>
    callback!({
      documentId: 1,
      requestId: 1,
      code: workerState.code,
      ...(error
        ? { error }
        : {
            root: highlighter.codeToHast(workerState.code, {
              lang: "javascript",
              theme: "pierre-dark",
            }),
          }),
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("Worker", function MockWorker() {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  workerState.callback = null;
  workerState.code = "";
  workerState.closed = false;
  page = document.createElement("div");
  document.body.append(page);
  root = createRoot(page);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.getSelection()?.removeAllRanges();
  page.remove();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker code selection", () => {
  it("keeps root text nodes, block keys and selected code as history runs grow and split", async () => {
    const history =
      "# History\n\n" +
      Array.from({ length: 34 }, (_, index) => `Paragraph ${index}.`).join("\n\n") +
      "\n\n```javascript\nconst selectedValue = 42;\n```\n\n" +
      "| Name | Value |\n| --- | --- |\n| settled | cell |\n\n# Boundary\n\nLookup [target][ref].\n\n";
    const view = (text: string) => (
      <ChatMarkdown cwd={undefined} text={text} smoothStreaming smoothComplete />
    );
    await act(async () => root.render(view(history + "Tail")));
    const body = page.querySelector<HTMLElement>(".chat-markdown")!;
    const code = body.querySelector(".chat-markdown-shiki code")!;
    const selectedNode = code.firstChild as Text;
    const stableNodes = [...body.childNodes].slice(0, -1);
    const tail = body.lastChild;
    const range = document.createRange();
    range.setStart(body.querySelector("p")!.firstChild!, 0);
    range.setEnd(selectedNode, 19);
    const selection = document.getSelection()!;
    selection.addRange(range);
    const selectedText = selection.toString();
    expect(selectedText).toContain("Paragraph 33.");

    for (const suffix of [
      "Tail grows",
      "Tail grows\n\nNew paragraph.",
      "Tail grows\n\nNew paragraph.\n\n[ref]: /resolved\n\nLast paragraph.",
      "Tail grows\n\nNew paragraph.\n\n[ref]: /resolved\n\nLast paragraph.\n\n# New heading\n\nFinal paragraph.",
    ]) {
      await act(async () => root.render(view(history + suffix)));
      stableNodes.forEach((node, index) => expect(body.childNodes[index]).toBe(node));
      expect(tail?.isConnected).toBe(true);
      expect(selection.toString()).toBe(selectedText);
      expect(body.querySelector(".chat-markdown-shiki code")?.firstChild).toBe(selectedNode);
      for (const paragraph of body.querySelectorAll<HTMLElement>("p[data-smooth-block-start]")) {
        const offset = Number(paragraph.dataset.smoothBlockStart);
        expect((history + suffix).slice(offset)).toMatch(
          /^Paragraph |^Tail |^New |^Last |^Final |^Lookup /u,
        );
      }
    }

    await deliver();
    expect(selectedNode.isConnected).toBe(true);
    expect(selection.toString()).toBe(selectedText);
    selection.removeAllRanges();
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    expect(body.querySelector(".chat-markdown-shiki .line")).not.toBeNull();
    expect(body.querySelector(".chat-markdown-shiki code")?.textContent).toBe(workerState.code);
  });

  it("keeps a selected native code text node and its Range until selection leaves", async () => {
    const code = await mount("Range");
    const selectedNode = code.firstChild as Text;
    const range = document.createRange();
    range.setStart(selectedNode, 6);
    range.setEnd(selectedNode, 19);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();
    expect(selectedText).toBe("selectedValue");

    await deliver();
    expect(selectedNode.isConnected).toBe(true);
    expect(selection.toString()).toBe(selectedText);
    expect(page.querySelector(".chat-markdown-shiki code")?.firstChild).toBe(selectedNode);

    selection.removeAllRanges();
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    expect(page.querySelector(".chat-markdown-shiki .line")).not.toBeNull();
    expect(page.querySelector(".chat-markdown-shiki code")?.textContent).toBe(workerState.code);
  });

  it("protects a selection spanning prose and code, including an error fallback", async () => {
    const code = await mount("Across");
    const prose = page.querySelector(".chat-markdown p")?.firstChild;
    const codeText = code.firstChild as Text;
    expect(prose?.nodeType).toBe(Node.TEXT_NODE);
    const range = document.createRange();
    range.setStart(prose!, 0);
    range.setEnd(codeText, 20);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();
    expect(selectedText).toContain("selected");

    await deliver("worker failed");
    expect(codeText.isConnected).toBe(true);
    expect(selection.toString()).toBe(selectedText);
    expect(workerState.closed).toBe(false);

    selection.removeAllRanges();
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    expect(workerState.closed).toBe(true);
    expect(page.querySelector(".chat-markdown-shiki code")?.textContent).toBe(workerState.code);
  });

  it("keeps only the latest delayed result and copies the original code", async () => {
    const code = await mount("Copy");
    const selectedNode = code.firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(selectedNode);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await deliver();
    await deliver("latest worker failure");
    expect(selectedNode.isConnected).toBe(true);
    expect(workerState.closed).toBe(false);
    const copyButton = page.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
    expect(copyButton).not.toBeNull();
    await act(async () => copyButton!.click());
    expect(writeText).toHaveBeenCalledWith(workerState.code);

    selection.removeAllRanges();
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    expect(workerState.closed).toBe(true);
    expect(page.querySelector(".chat-markdown-shiki code")?.textContent).toBe(workerState.code);
  });

  it("ignores a delayed result after the fence language changes", async () => {
    const code = await mount("OldLanguage");
    const oldCallback = workerState.callback!;
    const oldCode = workerState.code;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await deliver();

    const next = "```typescript\nconst newLanguageValue = true;\n```";
    await act(async () => root.render(<ChatMarkdown cwd={undefined} text={next} />));
    const nextCode = page.querySelector(".chat-markdown-shiki code");
    expect(nextCode?.textContent).toContain("newLanguageValue");
    await act(async () =>
      oldCallback({ documentId: 1, requestId: 2, code: oldCode, error: "late failure" }),
    );
    selection.removeAllRanges();
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    expect(page.querySelector(".chat-markdown-shiki code")?.textContent).toContain(
      "newLanguageValue",
    );
  });

  it("applies the worker result while selection is outside this code block", async () => {
    const code = await mount("Outside");
    const originalCodeNode = code.firstChild;
    const prose = page.querySelector(".chat-markdown p")?.firstChild;
    const range = document.createRange();
    range.selectNodeContents(prose!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();

    await deliver();
    expect(page.querySelector(".chat-markdown-shiki .line")).not.toBeNull();
    expect(originalCodeNode?.isConnected).toBe(false);
    expect(selection.toString()).toBe(selectedText);
  });
});
