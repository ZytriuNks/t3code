import { toHtml } from "hast-util-to-html";
import { getSharedHighlighter, type SupportedLanguages } from "@pierre/diffs";
import * as NodeWorkerThreads from "node:worker_threads";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createCodeHighlightCoordinator, type CodeHighlightResult } from "./asyncCodeHighlighting";

const workerUrl = new URL("./syntaxHighlight.worker.ts", import.meta.url).href;
const workers: NodeWorkerThreads.Worker[] = [];

function realWorker() {
  const worker = new NodeWorkerThreads.Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
     globalThis.self = new WorkerGlobalScope();
     globalThis.self.addEventListener = function(type, listener) {
       if (type === "message") parentPort.on("message", data => listener({ data }));
     };
     globalThis.postMessage = data => parentPort.postMessage(data);
     import(workerData.url);`,
    { eval: true, workerData: { url: workerUrl }, execArgv: [] },
  );
  workers.push(worker);
  return {
    postMessage: (message: unknown) => worker.postMessage(message, []),
    addEventListener: (type: "message", listener: (event: MessageEvent) => void) => {
      if (type === "message") worker.on("message", (data) => listener({ data } as MessageEvent));
    },
  } as Worker;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

describe("asynchronous code highlighting", () => {
  it("uses the real WASM worker, coalesces updates, and preserves completed lines", async () => {
    const coordinator = createCodeHighlightCoordinator(realWorker());
    const highlighter = await getSharedHighlighter({
      langs: ["javascript"],
      themes: ["pierre-dark"],
      preferredHighlighter: "shiki-wasm",
    });
    const results: Array<{ code: string; root: ReturnType<typeof highlighter.codeToHast> }> = [];
    const completed = new Promise<void>((resolve, reject) => {
      const session = coordinator.open("javascript", "pierre-dark", (result) => {
        if (result.error) return reject(new Error(result.error));
        if (!result.root) return reject(new Error("Missing highlighted root"));
        results.push({ code: result.code, root: result.root });
        if (result.code === "const a = 1;\nconst b = 2;") resolve();
      });
      session.update("const a = 1;\n");
      session.update("const a = 1;\nconst b =");
      session.update("const a = 1;\nconst b = 2;");
    });
    await completed;
    expect(results.map(({ code }) => code)).toEqual(["const a = 1;\nconst b = 2;"]);
    expect(toHtml(results[0]!.root)).toBe(
      highlighter.codeToHtml("const a = 1;\nconst b = 2;", {
        lang: "javascript",
        theme: "pierre-dark",
      }),
    );
    coordinator.close();
  });

  it("ignores a released document and applies the requested theme to restored code", async () => {
    const coordinator = createCodeHighlightCoordinator(realWorker());
    const discarded: CodeHighlightResult[] = [];
    const oldSession = coordinator.open("javascript", "pierre-dark", (result) =>
      discarded.push(result),
    );
    oldSession.update("/* unfinished\ncomment */\nconst stale = true;");
    oldSession.close();

    const code = "/* unfinished\ncomment */\nconst current = true;";
    const result = await new Promise<CodeHighlightResult>((resolve) => {
      const session = coordinator.open("javascript", "pierre-light", resolve);
      session.update(code);
    });
    expect(discarded).toEqual([]);
    expect(result.error).toBeUndefined();
    const highlighter = await getSharedHighlighter({
      langs: ["javascript"],
      themes: ["pierre-light"],
      preferredHighlighter: "shiki-wasm",
    });
    expect(toHtml(result.root!)).toBe(
      highlighter.codeToHtml(code, { lang: "javascript", theme: "pierre-light" }),
    );
    coordinator.close();
  });

  it.each(["js", "jsx", "ts", "typescript", "tsx"])(
    "attaches the %s grammar inside a real worker context",
    async (language) => {
      const coordinator = createCodeHighlightCoordinator(realWorker());
      const code = "const result = input.map((value) => value + 1);";
      const result = await new Promise<CodeHighlightResult>((resolve) => {
        const session = coordinator.open(language, "pierre-dark", resolve);
        session.update(code);
      });
      expect(result.error).toBeUndefined();
      const highlighter = await getSharedHighlighter({
        langs: [language as SupportedLanguages],
        themes: ["pierre-dark"],
        preferredHighlighter: "shiki-wasm",
      });
      expect(toHtml(result.root!)).toBe(
        highlighter.codeToHtml(code, { lang: language, theme: "pierre-dark" }),
      );
      coordinator.close();
    },
  );
});
