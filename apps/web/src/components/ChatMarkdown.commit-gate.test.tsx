// @vitest-environment jsdom
import {
  act,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, className }: { children: ReactNode; className: string }) => (
    <a className={className}>{children}</a>
  ),
}));
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
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { useSmoothText } from "../hooks/useSmoothText";
import { registerSmoothTextLayoutScope } from "../lib/smoothTextLayout";

class TestHighlight extends Set<AbstractRange> {}
let root: Root;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let now: number;
let bypass = false;
let width = 402;
let fontExtra = 0;
let measuredChips: string[];
let measuredBodies: string[];
let presentationWrap: ((body: Element) => boolean) | undefined;
let fontEvents: EventTarget;
const source =
  "## Animation audit\n\nThis is a longer paragraph spanning several physical lines when viewed in the narrower document width. It contains a [reference](https://example.com) and inline `code`, then another sentence before the note[^a].";

// jsdom has no line layout. This fixture models the confirmed 17px displacement
// only when the real mixed link/code presentation is present, including its
// atomic favicon prefix and wrapping suffix. Candidate natural height includes
// additional NEW rows which must not be reserved for already visible words.
function mixed(root: Element) {
  return root.querySelector("a[href='https://example.com']") !== null;
}
function wrapped(root: Element) {
  if (presentationWrap) return presentationWrap(root);
  if (mixed(root)) {
    const link = root.querySelector("a")!;
    expect(link.querySelector("[data-smooth-atomic].whitespace-nowrap")).not.toBeNull();
    if (link.querySelector("strong")) {
      expect(link.children).toHaveLength(1);
      expect(link.querySelector("[data-smooth-atomic]")?.textContent).toBe(link.textContent);
    } else expect(link.querySelector("span[class*='overflow-wrap']")).not.toBeNull();
    return (
      (!root.querySelector("code") &&
        (root.querySelector("p")?.textContent?.includes("`co") ?? false)) ||
      root.querySelector("code")?.textContent === "code" ||
      (root.querySelector(".chat-markdown-file-link")?.textContent?.includes("main.ts") ?? false)
    );
  }
  return (root.querySelector("p")?.textContent?.length ?? root.textContent?.length ?? 0) > 8;
}
function bodyOf(node: Node) {
  return (
    (node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement
    )?.closest<HTMLElement>(".chat-markdown") ?? null
  );
}
function rectFor(range: Range) {
  const body = bodyOf(range.startContainer);
  if (!body || !range.toString().trim()) return new DOMRect();
  if (body.dataset.smoothTextMeasure !== undefined) {
    const chip = body.querySelector(".chat-markdown-file-link");
    if (chip) measuredChips.push(chip.outerHTML);
  }
  const bottom = wrapped(body) ? 86.375 + fontExtra : 69.375;
  return new DOMRect(0, bottom - 14, 100, 14);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames = new Map();
  now = 0;
  bypass = false;
  width = 402;
  fontExtra = 0;
  measuredChips = [];
  measuredBodies = [];
  presentationWrap = undefined;
  fontEvents = new EventTarget();
  let id = 0;
  Object.defineProperty(document, "fonts", { configurable: true, value: fontEvents });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return bypass;
    },
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const body = this.matches(".chat-markdown")
      ? this
      : this.querySelector<HTMLElement>(".chat-markdown");
    const staging = this.closest<HTMLElement>("[data-smooth-text-measure]");
    if (staging) measuredBodies.push(staging.innerHTML);
    const height =
      this.matches("[data-smooth-text-frame]") && this.style.height
        ? Number.parseFloat(this.style.height)
        : body
          ? wrapped(body)
            ? 120
            : 69.375
          : 69.375;
    return new DOMRect(0, 0, width, height);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return rectFor(this);
    },
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      return [rectFor(this)];
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, "fonts");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(text: string, extra: Partial<ComponentProps<typeof ChatMarkdown>> = {}) {
  await act(() =>
    root.render(
      <ChatMarkdown
        cwd="C:/workspace"
        text={text}
        smoothStreaming
        isStreaming
        smoothTextFadeDurationMs={0}
        smoothTextYieldDurationMs={150}
        {...extra}
      />,
    ),
  );
  now += 32;
  await act(() => vi.advanceTimersByTime(32));
}
async function step(ms = 8) {
  now += ms;
  const batch = [...frames.values()];
  frames.clear();
  await act(() => {
    vi.advanceTimersByTime(ms);
    batch.forEach((cb) => cb(now));
  });
}
function liveBody() {
  return container.querySelector<HTMLElement>(".chat-markdown")!;
}
function frameHeight() {
  return Number.parseFloat(
    container.querySelector<HTMLElement>("[data-smooth-text-frame]")!.style.height || "69.375",
  );
}
async function drain() {
  for (let i = 0; i < 600 && frames.size; i++) await step();
}

function CompletionProbe({
  pending,
  onComplete,
  history = false,
}: {
  pending: boolean;
  onComplete: () => void;
  history?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [released, setReleased] = useState(false);
  const request = useMemo(() => ({ measure: () => 86.375, commit: () => setReleased(true) }), []);
  const text = released ? "H abcdefghijklmn" : "H abcdef";
  useSmoothText(ref, {
    enabled: true,
    streaming: !pending,
    complete: pending,
    sourceText: text,
    candidate: pending && !released ? request : undefined,
    yieldDurationMs: 150,
    fadeDurationMs: 0,
    onPlaybackComplete: onComplete,
    resume: history
      ? {
          key: "review1-direct-history",
          baselineText: "H abcdef",
          mountText: "H abcdef",
          synchronized: true,
          generation: 1,
        }
      : undefined,
  });
  return (
    <div data-smooth-text-frame="">
      <div className="chat-markdown" ref={ref}>
        <p>{text}</p>
      </div>
    </div>
  );
}

describe("pre-commit reservation for visible word reflow", () => {
  it.each(["character", "token"] as const)(
    "holds the actual mixed prefix184 DOM until the visible words fit (%s)",
    async (mode) => {
      await render(source.slice(0, 184), { smoothOutputMode: mode });
      const body = liveBody();
      const old = body.innerHTML;
      const paragraph = body.querySelector("p");
      await render(source.slice(0, 192), { smoothOutputMode: mode });
      expect(body.innerHTML).toBe(old);
      expect(body.querySelector("p")).toBe(paragraph);
      expect(frameHeight()).toBe(69.375);
      const samples: number[] = [];
      for (let i = 0; i < 200 && body.querySelector("code")?.textContent !== "code"; i++) {
        await step();
        samples.push(frameHeight());
        if (body.innerHTML !== old) expect(frameHeight()).toBeGreaterThanOrEqual(86.375);
      }
      expect(body.querySelector("code")?.textContent).toBe("code");
      expect(samples.some((h) => h > 69.375 && h < 86.375)).toBe(true);
      expect(Math.max(...samples)).toBeLessThan(120);
      await drain();
      expect(frames.size).toBe(0);
    },
  );

  it("reserves ordinary tail-word extension before replacing the text node's data", async () => {
    await render("H abcdef");
    const body = liveBody();
    const old = body.innerHTML;
    await render("H abcdefghijklmn");
    expect(body.innerHTML).toBe(old);
    for (let i = 0; i < 100 && body.innerHTML === old; i++) {
      await step();
      if (body.innerHTML !== old) expect(frameHeight()).toBeGreaterThanOrEqual(86.375);
    }
    expect(body.textContent).toBe("H abcdefghijklmn");
    await drain();
    expect(frames.size).toBe(0);
  });

  it("gates EOF-only finalization of the incomplete inline code without a new source delta", async () => {
    const text = source.slice(0, 184);
    await render(text);
    const old = liveBody().innerHTML;
    expect(liveBody().querySelector("code")?.textContent).toBe("co");
    await render(text, { isStreaming: false, smoothComplete: true });
    expect(liveBody().innerHTML).toBe(old);
    for (let i = 0; i < 200 && liveBody().querySelector("code"); i++) {
      await step();
      if (!liveBody().querySelector("code")) expect(frameHeight()).toBeGreaterThanOrEqual(86.375);
    }
    expect(liveBody().textContent).toContain("`co");
    expect(liveBody().querySelector("code")).toBeNull();
    await drain();
    expect(frames.size).toBe(0);
  });

  it("locks a reservation across continuous appends and then commits the latest source at EOF", async () => {
    await render(source.slice(0, 184));
    const old = liveBody().innerHTML;
    await render(source.slice(0, 192));
    expect(liveBody().innerHTML).toBe(old);
    for (const end of [200, 208, 216, 224]) {
      await step(16);
      await render(source.slice(0, end));
    }
    await render(source, { isStreaming: false, smoothComplete: true });
    await drain();
    expect(liveBody().textContent).toContain("then another sentence before the note");
    expect(frames.size).toBe(0);
    expect(container.querySelector("[data-smooth-text-measure]")).toBeNull();
  });

  it("waits for the Timeline publication before releasing the candidate", async () => {
    const commits: (() => void)[] = [];
    const unregister = registerSmoothTextLayoutScope(container, {
      frame(cb) {
        const id = now + frames.size + 1000;
        frames.set(id, cb);
        return () => {
          frames.delete(id);
        };
      },
      afterCommit(_element, cb) {
        commits.push(cb);
        return () => {
          const i = commits.indexOf(cb);
          if (i >= 0) commits.splice(i, 1);
        };
      },
    });
    await render("H abcdef");
    const old = liveBody().innerHTML;
    await render("H abcdefghijklmn");
    for (let i = 0; i < 60; i++) await step();
    expect(frameHeight()).toBeGreaterThanOrEqual(86.375);
    expect(liveBody().innerHTML).toBe(old);
    expect(commits.length).toBeGreaterThan(0);
    await act(() => commits.splice(0).forEach((cb) => cb()));
    expect(liveBody().textContent).toBe("H abcdefghijklmn");
    unregister();
    await drain();
  });

  it("bypasses motion and removes pending work on teardown", async () => {
    await render("H abcdef");
    await render("H abcdefghijklmn");
    expect(liveBody().textContent).toBe("H abcdef");
    await act(() => root.unmount());
    expect(frames.size).toBe(0);
    root = createRoot(container);
    bypass = true;
    await render(source.slice(0, 184));
    await render(source.slice(0, 192));
    expect(liveBody().querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("[data-smooth-text-measure]")).toBeNull();
  });

  it("preserves the rich link's real nowrap grouping while inline code completes", async () => {
    const prefix = "H [**reference** and label](https://example.com) and inline `co";
    await render(prefix);
    const old = liveBody().innerHTML;
    await render(prefix + "de`");
    expect(liveBody().innerHTML).toBe(old);
    await drain();
    expect(liveBody().querySelector("code")?.textContent).toBe("code");
    const template = document.createElement("template");
    template.innerHTML = measuredBodies.find((html) => html.includes("<strong>"))!;
    const measuredLink = template.content.querySelector("a")!;
    const liveLink = liveBody().querySelector("a")!;
    for (const link of [liveLink, measuredLink]) {
      const atomic = link.querySelector("[data-smooth-atomic]")!;
      expect(atomic.className).toBe("whitespace-nowrap");
      expect(atomic.textContent).toBe("reference and label");
      expect(atomic.querySelector("strong")?.textContent).toBe("reference");
      expect(atomic.nextSibling).toBeNull();
    }
    expect(frames.size).toBe(0);
  });

  it("preflights the first live append after a fully displayed recovered prefix", async () => {
    const resume = {
      key: "review1-history-first-append",
      baselineText: "H abcdef",
      mountText: "H abcdef",
      synchronized: true,
      generation: 1,
    };
    await render("H abcdef", { smoothTextResume: resume });
    await drain();
    expect(frames.size).toBe(0);
    const old = liveBody().innerHTML;
    await render("H abcdefghijklmn", { smoothTextResume: resume });
    expect(liveBody().innerHTML).toBe(old);
    await drain();
    expect(liveBody().textContent).toBe("H abcdefghijklmn");
    expect(frames.size).toBe(0);
  });

  it("does not use the observer's static-history shortcut to release a live candidate", async () => {
    const complete = vi.fn();
    await act(() => root.render(<CompletionProbe pending={false} onComplete={complete} history />));
    expect(liveBody().textContent).toBe("H abcdef");
    await act(() => root.render(<CompletionProbe pending onComplete={complete} history />));
    expect(liveBody().textContent).toBe("H abcdef");
    await drain();
    expect(liveBody().textContent).toBe("H abcdefghijklmn");
    expect(frames.size).toBe(0);
  });

  it.each(["discover", "rename"])(
    "reserves a same-source skill %s before changing its live chip",
    async (kind) => {
      const text = "H $review tail";
      const short = [{ name: "review", displayName: "R" }];
      const long = [{ name: "review", displayName: "Review the whole workspace" }];
      presentationWrap = (body) =>
        body.querySelector("[data-slot='context-chip-label']")?.textContent ===
        long[0]!.displayName;
      await render(text, { skills: kind === "discover" ? [] : short });
      const old = liveBody().innerHTML;
      await render(text, { skills: long });
      expect(liveBody().innerHTML).toBe(old);
      await drain();
      expect(liveBody().querySelector("[data-slot='context-chip-label']")?.textContent).toBe(
        long[0]!.displayName,
      );
      expect(measuredBodies.some((html) => html.includes(long[0]!.displayName))).toBe(true);
      expect(frames.size).toBe(0);
    },
  );

  it("reserves same-source file resolution when workspace context becomes available", async () => {
    const text = "H `./src/main.ts` tail";
    presentationWrap = (body) => body.querySelector(".chat-markdown-file-link") !== null;
    await render(text, { cwd: undefined });
    expect(liveBody().querySelector("code")?.textContent).toBe("./src/main.ts");
    const old = liveBody().innerHTML;
    await render(text, { cwd: "C:/workspace" });
    expect(liveBody().innerHTML).toBe(old);
    await drain();
    expect(liveBody().querySelector(".chat-markdown-file-link")?.textContent).toBe("main.ts");
    expect(measuredBodies.some((html) => html.includes("chat-markdown-file-link"))).toBe(true);
    expect(frames.size).toBe(0);
  });

  it("distinguishes same-label skills moving between rich text nodes", async () => {
    const text = "H **$foo** and *$bar* tail";
    presentationWrap = (body) => body.querySelector("em [data-slot='context-chip']") !== null;
    await render(text, { skills: [{ name: "foo", displayName: "Shared label" }] });
    const old = liveBody().innerHTML;
    await render(text, { skills: [{ name: "bar", displayName: "Shared label" }] });
    expect(liveBody().innerHTML).toBe(old);
    await drain();
    expect(liveBody().querySelector("em [data-slot='context-chip-label']")?.textContent).toBe(
      "Shared label",
    );
    expect(liveBody().querySelector("strong [data-slot='context-chip']")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("keeps changed-region traversal linear when late definitions affect many visible blocks", async () => {
    const count = 40;
    const prefix = Array.from(
      { length: count },
      (_, index) => `Paragraph ${index} [ref][r${index}] tail.`,
    ).join("\n\n");
    const definitions = Array.from(
      { length: count },
      (_, index) => `[r${index}]: https://example.org/${index}`,
    ).join("\n");
    await render(prefix);
    await drain();
    const contains = Node.prototype.contains;
    const position = Node.prototype.compareDocumentPosition;
    let checks = 0;
    const tracked = (node: Node) =>
      node instanceof HTMLElement &&
      node.hasAttribute("data-smooth-block-start") &&
      !node.parentElement?.hasAttribute("data-smooth-text-measure");
    vi.spyOn(Node.prototype, "contains").mockImplementation(function (this: Node, other) {
      if (tracked(this)) checks++;
      return contains.call(this, other);
    });
    vi.spyOn(Node.prototype, "compareDocumentPosition").mockImplementation(function (
      this: Node,
      other,
    ) {
      if (tracked(this)) checks++;
      return position.call(this, other);
    });
    await render(`${prefix}\n\n${definitions}\n\n`);
    await drain();
    expect(liveBody().querySelectorAll("a")).toHaveLength(count);
    expect(checks).toBeLessThan(count * 20);
    // A context object refresh caused by unrelated appends must not clone all
    // those now resolved historical blocks again.
    measuredBodies = [];
    await render(`${prefix}\n\n${definitions}\n\nNew paragraph`);
    await drain();
    expect(measuredBodies).toHaveLength(0);
    expect(frames.size).toBe(0);
  });

  it.each(["skill", "citation", "context fallback"])(
    "uses the live %s geometry before completing adjacent code",
    async (kind) => {
      const citation = serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("fixture-env"),
        threadId: ThreadId.make("fixture-thread"),
        messageId: MessageId.make("fixture-message"),
        text: "source quote",
        comment: "  A long comment " + "with whitespace ".repeat(6),
        start: 0,
        end: 12,
        prefix: "",
        suffix: "",
      });
      const inline =
        kind === "skill"
          ? "$review"
          : kind === "citation"
            ? citation
            : "[**Terminal** output](t3-context://v1/terminal/term-1)";
      const options = { skills: [{ name: "review", displayName: "Review" }] };
      presentationWrap = (body) => {
        const shape =
          kind === "skill"
            ? body.querySelector("[data-markdown-copy='$review'] [data-slot='context-chip-label']")
                ?.textContent === "Review"
            : kind === "citation"
              ? body
                  .querySelector(
                    "[data-smooth-atomic] [data-assistant-citation-chip] [data-slot='context-chip-label']",
                  )
                  ?.textContent?.endsWith("…") === true
              : body.querySelector("p > span")?.textContent === "Terminal output" &&
                !body.querySelector("a");
        return shape && body.querySelector("code")?.textContent === "code";
      };
      const prefix = `H ${inline} and inline \`co`;
      await render(prefix, options);
      const old = liveBody().innerHTML;
      await render(prefix + "de`", options);
      expect(liveBody().innerHTML).toBe(old);
      await drain();
      expect(liveBody().querySelector("code")?.textContent).toBe("code");
      const template = document.createElement("template");
      template.innerHTML = measuredBodies.at(-1)!;
      const liveChip = liveBody().querySelector("[data-slot='context-chip']");
      const measuredChip = template.content.querySelector("[data-slot='context-chip']");
      if (liveChip) {
        expect(measuredChip?.className).toBe(liveChip.className);
        expect(measuredChip?.textContent).toBe(liveChip.textContent);
        expect(measuredChip?.querySelector("[data-slot='context-chip-label']")?.className).toBe(
          liveChip.querySelector("[data-slot='context-chip-label']")?.className,
        );
      } else expect(template.content.querySelector("a")).toBeNull();
      expect(frames.size).toBe(0);
    },
  );

  it("never stages arbitrary context renderers and preserves their mounted lifecycle", async () => {
    const mounted = vi.fn();
    const disposed = vi.fn();
    function Context({ label }: { label: string }) {
      useEffect(() => {
        mounted();
        return disposed;
      }, []);
      return <button>{label}</button>;
    }
    const reference = ({ label }: { label: string }) => <Context label={label} />;
    const prefix = "H [Terminal output](t3-context://v1/terminal/term-1) tail";
    await render(prefix, { renderContextReference: reference });
    const button = liveBody().querySelector("button");
    await render(prefix + " appended", { renderContextReference: reference });
    await drain();
    expect(measuredBodies).toHaveLength(0);
    expect(liveBody().querySelector("button")).toBe(button);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
    await render(prefix + " appended", {
      renderContextReference: ({ label }) => <Context label={`New ${label}`} />,
    });
    await drain();
    expect(liveBody().querySelector("button")?.textContent).toBe("New Terminal output");
    expect(measuredBodies).toHaveLength(0);
    await act(() => root.unmount());
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    root = createRoot(container);
  });

  it("leaves media blocks on their existing lifecycle without staging stripped resources", async () => {
    const prefix = "H ![fixture](https://example.com/image.png) tail";
    await render(prefix);
    const image = liveBody().querySelector("img");
    expect(image).not.toBeNull();
    await render(prefix + " appended");
    await drain();
    expect(measuredBodies).toHaveLength(0);
    expect(liveBody().querySelector("img")).toBe(image);
    expect(image?.getAttribute("src")).toBe("https://example.com/image.png");
    await render(prefix + " appended", { isStreaming: false, smoothComplete: true });
    await drain();
    expect(container.querySelector("[data-smooth-text-measure]")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("measures inline file code with the same chip label and geometry recipe as the live DOM", async () => {
    const prefix = "H [reference](https://example.com) and inline `./src/ma";
    const next = prefix + "in.ts`";
    await render(prefix);
    const old = liveBody().innerHTML;
    await render(next);
    expect(liveBody().innerHTML).toBe(old);
    await drain();
    const live = liveBody().querySelector<HTMLElement>(".chat-markdown-file-link")!;
    expect(live.textContent).toContain("main.ts");
    expect(measuredChips.length).toBeGreaterThan(0);
    const template = document.createElement("template");
    template.innerHTML = measuredChips[0]!;
    const measured = template.content.firstElementChild!;
    expect(measured.className).toBe(live.className);
    expect(measured.querySelector("[data-slot='context-chip-label']")?.className).toBe(
      live.querySelector("[data-slot='context-chip-label']")?.className,
    );
    expect(measured.textContent).toBe(live.textContent);
    expect(measured.querySelector("img, [src], use[href]")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("holds EOF completion and old glyph ownership while reserved space is still in flight", async () => {
    const complete = vi.fn();
    await act(() => root.render(<CompletionProbe pending={false} onComplete={complete} />));
    await act(() => root.render(<CompletionProbe pending onComplete={complete} />));
    for (let i = 0; i < 8; i++) await step();
    expect(frameHeight()).toBeGreaterThan(69.375);
    expect(frameHeight()).toBeLessThan(86.375);
    expect(liveBody().textContent).toBe("H abcdef");
    expect(complete).not.toHaveBeenCalled();
    for (let i = 0; i < 200 && liveBody().textContent === "H abcdef"; i++) await step();
    for (const hidden of CSS.highlights.get("t3-smooth-hidden") ?? []) {
      expect(hidden.startOffset).toBeGreaterThanOrEqual(8);
    }
    await drain();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it.each(["width", "font"])("rejects the old Timeline permit after a %s change", async (kind) => {
    const commits: (() => void)[] = [];
    let id = 0;
    const unregister = registerSmoothTextLayoutScope(container, {
      frame(cb) {
        frames.set(++id, cb);
        return () => {
          frames.delete(id);
        };
      },
      afterCommit(_element, cb) {
        commits.push(cb);
        return () => {
          const i = commits.indexOf(cb);
          if (i >= 0) commits.splice(i, 1);
        };
      },
    });
    await render("H abcdef");
    await render("H abcdefghijklmn");
    for (let i = 0; i < 60; i++) await step();
    const stale = commits.shift()!;
    expect(stale).toBeTypeOf("function");
    fontExtra = 17;
    if (kind === "width") width = 300;
    await act(() => {
      if (kind === "font") fontEvents.dispatchEvent(new Event("loadingdone"));
      stale();
    });
    expect(liveBody().textContent).toBe("H abcdef");
    for (let i = 0; i < 60; i++) await step();
    expect(frameHeight()).toBeGreaterThanOrEqual(103.375);
    await act(() => commits.splice(0).forEach((cb) => cb()));
    expect(liveBody().textContent).toBe("H abcdefghijklmn");
    unregister();
    await drain();
    expect(frames.size).toBe(0);
  });

  it("preserves the footnote handoff when the source ends during the mixed reservation", async () => {
    const options = { footnotesAutoCollapse: true };
    await render(source.slice(0, 184), options);
    const old = liveBody().innerHTML;
    const final = source + "\n\n[^a]: A complete note for the final handoff.";
    await render(final, options);
    expect(liveBody().innerHTML).toBe(old);
    expect(container.querySelector("[data-stream-footnotes]")).toBeNull();
    await render(final, { ...options, isStreaming: false, smoothComplete: true });
    await drain();
    expect(liveBody().textContent).toContain("then another sentence before the note");
    expect(container.textContent).toContain("A complete note for the final handoff.");
    expect(container.querySelector("[data-smooth-text-measure]")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("discards a pending permit at recovery without replaying the recovered source", async () => {
    const resume = {
      key: "old-wrap-recovery",
      baselineText: "H abcdef",
      mountText: "H abcdef",
      synchronized: true,
      generation: 1,
    };
    await render("H abcdef", { smoothTextResume: resume });
    await render("H abcdefghijklmn", { smoothTextResume: resume });
    expect(liveBody().textContent).toBe("H abcdef");
    await render("Recovered history", {
      smoothTextResume: { ...resume, generation: 2, forceShow: true },
    });
    expect(liveBody().textContent).toBe("Recovered history");
    await drain();
    expect(frames.size).toBe(0);
  });

  it("reserves a visible unchanged suffix when a source-only link definition grows an earlier block", async () => {
    const resolved = (element: Element) =>
      element.querySelector("a[href='https://example.com']") !== null;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement,
    ) {
      const body = this.matches(".chat-markdown")
        ? this
        : (this.closest<HTMLElement>(".chat-markdown") ??
          this.querySelector<HTMLElement>(".chat-markdown"));
      const grown = body ? resolved(body) : false;
      if (this.matches("[data-smooth-text-frame]") && this.style.height)
        return new DOMRect(0, 0, 402, Number.parseFloat(this.style.height));
      if (this.tagName === "P")
        return this.textContent?.includes("Old suffix")
          ? new DOMRect(0, grown ? 66 : 49, 402, 20)
          : new DOMRect(0, 0, 402, grown ? 37 : 20);
      return new DOMRect(0, 0, 402, grown ? 86.375 : 69.375);
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const body = bodyOf(this.startContainer)!;
        const suffix = this.startContainer.parentElement
          ?.closest("p")
          ?.textContent?.includes("Old suffix");
        const bottom = suffix ? (resolved(body) ? 86.375 : 69.375) : resolved(body) ? 31 : 14;
        return [new DOMRect(0, bottom - 14, 100, 14)];
      },
    });
    await render("[reference][r]\n\nOld suffix");
    const old = liveBody().innerHTML;
    expect(frameHeight()).toBe(69.375);
    await render("[reference][r]\n\nOld suffix\n\n[r]: https://example.com\n\n");
    expect(liveBody().innerHTML).toBe(old);
    for (
      let i = 0;
      i < 100 && liveBody().querySelector("a")?.getAttribute("href") !== "https://example.com";
      i++
    ) {
      await step();
      if (liveBody().querySelector("a")?.getAttribute("href") === "https://example.com")
        expect(frameHeight()).toBeGreaterThanOrEqual(86.375);
    }
    expect(liveBody().querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    await drain();
    expect(frames.size).toBe(0);
  });

  it.each(["hidden", "zero width", "missing highlight API"])(
    "releases safely for %s without retained measuring DOM",
    async (kind) => {
      if (kind === "missing highlight API") vi.stubGlobal("CSS", undefined);
      await render("H abcdef");
      if (kind === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      if (kind === "zero width") width = 0;
      await render("H abcdefghijklmn");
      expect(liveBody().textContent).toBe("H abcdefghijklmn");
      expect(container.querySelector("[data-smooth-text-measure]")).toBeNull();
      await drain();
      expect(frames.size).toBe(0);
    },
  );

  it("keeps the newest source when a pending frame disconnects and cancels its work on unmount", async () => {
    await render("H abcdef");
    await render("H abcdefghijklmn");
    expect(liveBody().textContent).toBe("H abcdef");
    container.remove();
    await step();
    expect(liveBody().textContent).toBe("H abcdefghijklmn");
    expect(container.querySelector("[data-smooth-text-measure]")).toBeNull();
    await act(() => root.unmount());
    expect(frames.size).toBe(0);
    root = createRoot(container);
  });
});
