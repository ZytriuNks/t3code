import { getSharedHighlighter } from "@pierre/diffs";
import { act, render as renderScreen, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
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
import ChatMarkdown from "./ChatMarkdown";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  let page: HTMLDivElement;
  async function mount(suffix: string) {
    const source = `Before code.\n\n\`\`\`javascript\nconst selectedValue${suffix} = 42;\n\`\`\`\n\nAfter code.`;
    await act(async () => screen.rerender(<ChatMarkdown cwd={undefined} text={source} />));
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

  stack.defer(() => {
    document.getSelection()?.removeAllRanges();
    page.remove();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
  });

  resources.use(stubGlobal("Worker", function MockWorker() {}));
  workerState.callback = null;
  workerState.code = "";
  workerState.closed = false;
  page = document.createElement("div");
  document.body.append(page);

  resources.use(
    stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    ),
  );
  // 夹具自行推进播放时钟；这里验证独立内容生命周期，不需要路由调度。
  const screen = stack.use(await renderScreen(null, { container: page, router: false }));
  const owned = stack.move();
  return { page, mount, deliver, screen, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
describe("worker code selection", () => {
  it("keeps root text nodes, block keys and selected code as history runs grow and split", async () => {
    await using fixture = await setup();
    const { page, deliver, screen } = fixture;
    const history =
      "# History\n\n" +
      Array.from({ length: 34 }, (_, index) => `Paragraph ${index}.`).join("\n\n") +
      "\n\n```javascript\nconst selectedValue = 42;\n```\n\n" +
      "| Name | Value |\n| --- | --- |\n| settled | cell |\n\n# Boundary\n\nLookup [target][ref].\n\n";
    const view = (text: string) => (
      <ChatMarkdown cwd={undefined} text={text} smoothStreaming smoothComplete />
    );
    await act(async () => screen.rerender(view(history + "Tail")));
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
      await act(async () => screen.rerender(view(history + suffix)));
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
    await using fixture = await setup();
    const { page, mount, deliver } = fixture;
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
    await using fixture = await setup();
    const { page, mount, deliver } = fixture;
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
    await using fixture = await setup();
    const { page, mount, deliver } = fixture;
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
    await using fixture = await setup();
    const { page, mount, deliver, screen } = fixture;
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
    await act(async () => screen.rerender(<ChatMarkdown cwd={undefined} text={next} />));
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
    await using fixture = await setup();
    const { page, mount, deliver } = fixture;
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
